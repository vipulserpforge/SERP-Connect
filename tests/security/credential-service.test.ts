import { describe, expect, it } from "vitest";
import { safeAuditMetadata } from "@serp/credentials";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import { KeyRingProvider, generateLocalMasterKey } from "@serp/secrets";
import { SECRET_PATTERNS, USER_1, USER_2, makeStack } from "./helpers.js";

const everything = (s: ReturnType<typeof makeStack>) =>
  JSON.stringify([...s.repo.secrets.values()]) + JSON.stringify(s.repo.auditLog) + s.logs.join("\n");

describe("OAuth connect flow", () => {
  it("stores tokens encrypted, marks the connection connected, and masks the account label", async () => {
    const s = makeStack();
    const { connectionId, accountLabel } = await s.connect(USER_1, "alice@example.com");
    expect(accountLabel).toBe("a***@example.com");

    const conn = await s.repo.getConnection(USER_1, connectionId);
    expect(conn).toMatchObject({ status: "connected", provider: "google", providerAccountId: "mock-sub-alice@example.com" });
    expect(conn!.grantedScopes).toEqual([GOOGLE_SCOPES.gsc]);

    const stored = s.repo.secrets.get(connectionId)!;
    expect(Object.keys(stored).sort()).toEqual(["authTag", "ciphertext", "keyVersion", "nonce", "wrappedDek"]);
    for (const p of SECRET_PATTERNS) expect(JSON.stringify(stored)).not.toMatch(p);
  });

  it("never leaks tokens, codes, state or verifiers into logs, audit rows or storage", async () => {
    const s = makeStack();
    const { state } = await s.connect(USER_1, "alice@example.com");
    await s.credentials.getAccessToken(USER_1, (await s.repo.listConnections(USER_1))[0]!.id);
    s.time.now += 2 * 3600_000;
    await s.credentials.getAccessToken(USER_1, (await s.repo.listConnections(USER_1))[0]!.id);
    const dump = everything(s);
    for (const p of SECRET_PATTERNS) expect(dump).not.toMatch(p);
    expect(dump).not.toContain(state);
    expect(dump).not.toContain("mock-code:");
    expect(s.repo.auditLog.map((e) => e.eventType)).toEqual(expect.arrayContaining(["oauth.started", "oauth.completed", "credential.refreshed"]));
  });

  it("reconnecting the same Google account updates one connection instead of duplicating it", async () => {
    const s = makeStack();
    const a = await s.connect(USER_1, "alice@example.com");
    // Incremental authorization: Google returns the earlier grant merged with the new one.
    s.google.grantedScopes = [GOOGLE_SCOPES.gsc, GOOGLE_SCOPES.ga4, "openid", "email"];
    const b = await s.connect(USER_1, "alice@example.com", "ga4");
    expect(b.connectionId).toBe(a.connectionId);
    expect(await s.repo.listConnections(USER_1)).toHaveLength(1);
    expect((await s.repo.getConnection(USER_1, a.connectionId))!.grantedScopes).toEqual([GOOGLE_SCOPES.gsc, GOOGLE_SCOPES.ga4]);
  });

  it("keeps two different Google accounts separate for one user (accounts B and C)", async () => {
    const s = makeStack();
    const b = await s.connect(USER_1, "b@example.com", "gsc");
    s.google.grantedScopes = [GOOGLE_SCOPES.ga4, "openid", "email"];
    const c = await s.connect(USER_1, "c@example.com", "ga4");
    expect(b.connectionId).not.toBe(c.connectionId);
    expect((await s.repo.listConnections(USER_1)).map((x) => x.accountLabel).sort()).toEqual(["b***@example.com", "c***@example.com"]);
  });

  describe("state handling", () => {
    it("state is single use", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      const params = { state, code: "mock-code:alice@example.com", error: null };
      await s.oauth.complete(USER_1, params);
      await expect(s.oauth.complete(USER_1, params)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    });

    it("a different user cannot use (or burn) someone else's state", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      const params = { state, code: "mock-code:evil@example.com", error: null };
      await expect(s.oauth.complete(USER_2, params)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await s.repo.listConnections(USER_2)).toEqual([]);
      // The rightful owner can still finish.
      await expect(s.oauth.complete(USER_1, { ...params, code: "mock-code:alice@example.com" })).resolves.toBeTruthy();
    });

    it("expired, unknown and missing state are rejected", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      s.time.now += 11 * 60_000;
      await expect(s.oauth.complete(USER_1, { state, code: "mock-code:a@b.co", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(s.oauth.complete(USER_1, { state: "forged", code: "mock-code:a@b.co", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await expect(s.oauth.complete(USER_1, { state: null, code: "mock-code:a@b.co", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await s.repo.listConnections(USER_1)).toEqual([]);
    });

    it("state is stored hashed, with the PKCE verifier encrypted", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      const dump = JSON.stringify([...s.repo.oauthStates.entries()]);
      expect(dump).not.toContain(state);
      expect(dump).toContain("ciphertext");
    });
  });

  describe("consent outcomes", () => {
    it("user denying access creates nothing", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      await expect(s.oauth.complete(USER_1, { state, code: null, error: "access_denied" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await s.repo.listConnections(USER_1)).toEqual([]);
    });

    it("insists on the product scope when the user unticks it (granular consent)", async () => {
      const s = makeStack();
      s.google.grantedScopes = ["openid", "email"];
      await expect(s.connect(USER_1, "alice@example.com")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(await s.repo.listConnections(USER_1)).toEqual([]);
      expect(s.repo.secrets.size).toBe(0);
    });

    it("rejects a code Google does not accept", async () => {
      const s = makeStack();
      const { authorizationUrl } = await s.oauth.begin(USER_1, "gsc");
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      await expect(s.oauth.complete(USER_1, { state, code: "garbage", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(s.repo.auditLog.at(-1)).toMatchObject({ eventType: "oauth.failed" });
    });
  });
});

describe("access tokens and refresh", () => {
  async function connected() {
    const s = makeStack();
    const { connectionId } = await s.connect(USER_1, "alice@example.com");
    return { s, connectionId };
  }

  it("returns the stored token without calling Google while it is fresh", async () => {
    const { s, connectionId } = await connected();
    const t = await s.credentials.getAccessToken(USER_1, connectionId);
    expect(t.accessToken).toMatch(/^mock-access-token-/);
    expect(s.google.refreshCalls).toBe(0);
  });

  it("refreshes shortly before expiry and persists the new token, keeping the refresh token", async () => {
    const { s, connectionId } = await connected();
    const first = await s.credentials.getAccessToken(USER_1, connectionId);
    s.time.now += 3600_000 - 30_000; // inside the 60s safety margin
    const second = await s.credentials.getAccessToken(USER_1, connectionId);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(s.google.refreshCalls).toBe(1);
    // Still usable (and not refreshed again) on the next call.
    expect((await s.credentials.getAccessToken(USER_1, connectionId)).accessToken).toBe(second.accessToken);
    expect(s.google.refreshCalls).toBe(1);
    s.time.now += 2 * 3600_000;
    await s.credentials.getAccessToken(USER_1, connectionId); // proves the refresh token survived
    expect(s.google.refreshCalls).toBe(2);
  });

  it("concurrent callers share one refresh", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    s.google.refreshDelayMs = 20;
    const tokens = await Promise.all(Array.from({ length: 12 }, () => s.credentials.getAccessToken(USER_1, connectionId)));
    expect(s.google.refreshCalls).toBe(1);
    expect(new Set(tokens.map((t) => t.accessToken)).size).toBe(1);
  });

  it("revoked grant: marks the connection, reports AUTH_REVOKED, and never retries again", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    s.google.failRefreshWith = "invalid_grant";
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(await s.repo.getConnection(USER_1, connectionId)).toMatchObject({ status: "needs_attention", lastErrorCode: "AUTH_REVOKED" });
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(s.google.refreshCalls).toBe(1);
  });

  it("transient Google failure is retryable and does not damage the connection", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    s.google.failRefreshWith = "transient";
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect((await s.repo.getConnection(USER_1, connectionId))!.status).toBe("connected");
    s.google.failRefreshWith = null;
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).resolves.toBeTruthy();
  });

  it("our own client misconfiguration does not lock the user's connection", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    s.google.failRefreshWith = "invalid_client";
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((await s.repo.getConnection(USER_1, connectionId))!.status).toBe("connected");
  });

  it("another user cannot obtain a token for this connection, and Google is never called", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    await expect(s.credentials.getAccessToken(USER_2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    await expect(s.credentials.getAccessToken(USER_2, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(s.google.refreshCalls).toBe(0);
  });

  it("a secret copied onto another connection will not decrypt (row swapping is detected)", async () => {
    const s = makeStack();
    const a = await s.connect(USER_1, "alice@example.com");
    const b = await s.connect(USER_2, "bob@example.com");
    s.repo.secrets.set(b.connectionId, { ...s.repo.secrets.get(a.connectionId)! });
    await expect(s.credentials.getAccessToken(USER_2, b.connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await s.repo.getConnection(USER_2, b.connectionId))!.lastErrorCode).toBe("CREDENTIAL_UNREADABLE");
    expect(s.repo.auditLog.some((e) => e.eventType === "credential.unreadable")).toBe(true);
  });

  it("a missing secret needs reconnection rather than crashing", async () => {
    const { s, connectionId } = await connected();
    s.repo.secrets.delete(connectionId);
    await expect(s.credentials.getAccessToken(USER_1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("a lost optimistic-concurrency race uses the winner's token instead of overwriting it", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 2 * 3600_000;
    s.google.refreshDelayMs = 20;
    const pending = s.credentials.getAccessToken(USER_1, connectionId);
    // Another instance stores a fresh token while our refresh is in flight.
    await new Promise((r) => setTimeout(r, 5));
    const winner = await s.credentials.storeTokens(USER_1, connectionId, { accessToken: "winner-access", refreshToken: "mock-refresh-token-alice@example.com", expiresAt: s.time.now + 3600_000, scopes: [] }, null);
    expect(winner).not.toBeNull();
    expect((await pending).accessToken).toBe("winner-access");
  });
});

describe("disconnect, revoke and delete", () => {
  it("revokes at Google, destroys the secret, and removes the connection", async () => {
    const s = makeStack();
    const { connectionId } = await s.connect(USER_1, "alice@example.com");
    const result = await s.credentials.disconnect(USER_1, connectionId);
    expect(result).toEqual({ disconnected: true, revokedAtProvider: true });
    expect(s.google.revokeCalls).toEqual(["mock-refresh-token-alice@example.com"]);
    expect(s.repo.secrets.has(connectionId)).toBe(false);
    expect(await s.repo.getConnection(USER_1, connectionId)).toBeNull();
    expect(s.repo.auditLog.at(-1)).toMatchObject({ eventType: "connection.disconnected", metadata: { revokedAtProvider: true } });
  });

  it("still removes everything locally if Google is unreachable, and says so", async () => {
    const s = makeStack();
    const { connectionId } = await s.connect(USER_1, "alice@example.com");
    s.google.failRevokeWith = "transient";
    expect(await s.credentials.disconnect(USER_1, connectionId)).toEqual({ disconnected: true, revokedAtProvider: false });
    expect(s.repo.secrets.size).toBe(0);
    expect(await s.repo.listConnections(USER_1)).toEqual([]);
  });

  it("cannot disconnect another user's connection, and nothing is revoked", async () => {
    const s = makeStack();
    const { connectionId } = await s.connect(USER_1, "alice@example.com");
    expect(await s.credentials.disconnect(USER_2, connectionId)).toEqual({ disconnected: false, revokedAtProvider: false });
    expect(s.google.revokeCalls).toEqual([]);
    expect(s.repo.secrets.has(connectionId)).toBe(true);
    expect(await s.repo.getConnection(USER_1, connectionId)).not.toBeNull();
  });

  it("account deletion revokes and removes every connection the user owns, and only theirs", async () => {
    const s = makeStack();
    await s.connect(USER_1, "b@example.com");
    s.google.grantedScopes = [GOOGLE_SCOPES.ga4, "openid", "email"];
    await s.connect(USER_1, "c@example.com", "ga4");
    await s.connect(USER_2, "bob@example.com", "ga4");
    expect(await s.credentials.disconnectAll(USER_1)).toEqual({ total: 2, revokedAtProvider: 2 });
    expect(await s.repo.listConnections(USER_1)).toEqual([]);
    expect(await s.repo.listConnections(USER_2)).toHaveLength(1);
    expect(s.repo.secrets.size).toBe(1);
  });
});

describe("key rotation", () => {
  it("rewraps old data keys in batches; tokens keep working and the old key can be retired", async () => {
    const v1 = generateLocalMasterKey();
    const v2 = generateLocalMasterKey();
    const s = makeStack({ keys: new KeyRingProvider({ v1 }, "v1") });
    const { connectionId } = await s.connect(USER_1, "alice@example.com");
    expect(s.repo.secrets.get(connectionId)!.keyVersion).toBe("v1");

    // Operator adds v2 and makes it current.
    const rotated = makeStack({ repo: s.repo, keys: new KeyRingProvider({ v1, v2 }, "v2") });
    expect(await rotated.credentials.rewrapBatch()).toEqual({ rewrapped: 1, skipped: 0 });
    expect(s.repo.secrets.get(connectionId)!.keyVersion).toBe("v2");
    expect(await rotated.credentials.rewrapBatch()).toEqual({ rewrapped: 0, skipped: 0 });

    // v1 retired: still readable.
    const retired = makeStack({ repo: s.repo, keys: new KeyRingProvider({ v2 }, "v2") });
    await expect(retired.credentials.getAccessToken(USER_1, connectionId)).resolves.toBeTruthy();
  });
});

describe("audit metadata allowlist", () => {
  it("drops unknown keys and anything token-shaped", () => {
    const fake = ["ya29", "abcdefghijklmnop"].join(".");
    const out = safeAuditMetadata({
      product: "gsc",
      accessToken: "should-not-appear",
      reason: fake,
      errorKind: "invalid_grant",
      revokedAtProvider: true,
      count: 3,
      nested: { refreshToken: "x" },
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    expect(out).toEqual({
      product: "gsc",
      errorKind: "invalid_grant",
      revokedAtProvider: true,
      count: 3,
      scopes: "https://www.googleapis.com/auth/webmasters.readonly",
    });
    expect(JSON.stringify(out)).not.toMatch(/should-not-appear|ya29/);
  });

  it("a failing audit write never breaks the operation", async () => {
    const s = makeStack();
    s.repo.recordAudit = async () => {
      throw new Error("db down");
    };
    await expect(s.connect(USER_1, "alice@example.com")).resolves.toBeTruthy();
    expect(s.logs.join("")).toContain("audit.write_failed");
  });
});
