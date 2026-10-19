/**
 * Clarity token storage and ownership. DATA SOURCE: in-memory repository, fake encryption keys, no network.
 */
import { describe, expect, it } from "vitest";
import { ClarityConnectionService, CredentialService, clarityProjectKey } from "@serp/credentials";
import { MockRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { MockGoogleOAuthClient } from "@serp/provider-google";
import { KeyRingProvider, createFingerprinterFromEnv, generateLocalMasterKey } from "@serp/secrets";
import { fakeToken } from "./fake-clarity.js";

const USER_1 = "11111111-1111-4111-8111-111111111111";
const USER_2 = "22222222-2222-4222-8222-222222222222";

function stack() {
  const repo = new MockRepository({ connections: [], properties: [] });
  const keys = new KeyRingProvider({ v1: generateLocalMasterKey() }, "v1");
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const fingerprinter = createFingerprinterFromEnv({ NODE_ENV: "test" });
  const clarity = new ClarityConnectionService({ creds: repo, repo, keys, logger, fingerprinter: () => fingerprinter });
  const credentials = new CredentialService({ creds: repo, repo, keys, google: new MockGoogleOAuthClient(), logger });
  const everything = () => JSON.stringify([...repo.secrets.values()]) + JSON.stringify(repo.auditLog) + JSON.stringify(logs) + JSON.stringify([...repo.secrets.keys()]);
  return { repo, keys, logs, clarity, credentials, fingerprinter, everything };
}

describe("saving a token", () => {
  it("stores it encrypted, awaiting verification, with one property keyed by a fingerprint (never the token)", async () => {
    const s = stack();
    const token = fakeToken("save");
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop site", token });
    const conn = (await s.repo.getConnection(USER_1, connectionId))!;
    expect(conn).toMatchObject({ provider: "clarity", status: "pending", accountLabel: "Shop site", lastValidatedAt: null });
    expect(conn.providerAccountId).toMatch(/^[0-9a-f]{64}$/);
    expect(conn.providerAccountId).not.toContain(token);

    const [prop] = await s.repo.listProperties(USER_1, { provider: "clarity" });
    expect(prop).toMatchObject({ displayName: "Shop site", propertyType: "clarity_project", timezone: "UTC", enabledForMcp: true });
    expect(prop!.externalPropertyId).toBe(clarityProjectKey(conn.providerAccountId!));
    expect(JSON.stringify([conn, prop])).not.toContain(token);

    const stored = s.repo.secrets.get(connectionId)!;
    expect(Object.keys(stored).sort()).toEqual(["authTag", "ciphertext", "keyVersion", "nonce", "wrappedDek"]);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(s.everything()).not.toContain(token);
    expect(s.repo.auditLog.map((e) => e.eventType)).toContain("clarity.connected");
  });

  it("decrypts the same token back, only for its owner", async () => {
    const s = stack();
    const token = fakeToken("roundtrip");
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop", token });
    expect(await s.clarity.getToken(USER_1, connectionId)).toBe(token);
    await expect(s.clarity.getToken(USER_2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("rejects malformed tokens and names before storing anything", async () => {
    const s = stack();
    await expect(s.clarity.connect(USER_1, { name: "Shop", token: "short" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(s.clarity.connect(USER_1, { name: "<b>", token: fakeToken("x") })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(await s.repo.listConnections(USER_1)).toEqual([]);
    expect(s.repo.secrets.size).toBe(0);
  });

  it("saving the same token again updates the one connection instead of duplicating it", async () => {
    const s = stack();
    const token = fakeToken("dup");
    const a = await s.clarity.connect(USER_1, { name: "First", token });
    const b = await s.clarity.connect(USER_1, { name: "Renamed", token });
    expect(b.connectionId).toBe(a.connectionId);
    expect(await s.repo.listConnections(USER_1)).toHaveLength(1);
    expect(await s.clarity.getToken(USER_1, a.connectionId)).toBe(token);
  });

  it("two customers may each save their own token; a shared token gets the same fingerprint (shared quota group)", async () => {
    const s = stack();
    const token = fakeToken("shared");
    const a = await s.clarity.connect(USER_1, { name: "Mine", token });
    const b = await s.clarity.connect(USER_2, { name: "Theirs", token });
    const pa = (await s.repo.listProperties(USER_1))[0]!;
    const pb = (await s.repo.listProperties(USER_2))[0]!;
    expect(pa.externalPropertyId).toBe(pb.externalPropertyId);
    expect(pa.id).not.toBe(pb.id);
    expect(await s.clarity.getToken(USER_2, b.connectionId)).toBe(token);
    expect(await s.repo.getConnection(USER_1, b.connectionId)).toBeNull();
    expect(a.connectionId).not.toBe(b.connectionId);
  });

  it("caps connections per user", async () => {
    const s = stack();
    for (let i = 0; i < 10; i++) await s.clarity.connect(USER_1, { name: `Project ${i}`, token: fakeToken(`n${i}`) });
    await expect(s.clarity.connect(USER_1, { name: "One more", token: fakeToken("n10") })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

describe("rename and reconnect", () => {
  it("renames the connection and its property, only for the owner", async () => {
    const s = stack();
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Old name", token: fakeToken("rn") });
    await s.clarity.rename(USER_1, connectionId, "New name");
    expect((await s.repo.getConnection(USER_1, connectionId))!.accountLabel).toBe("New name");
    expect((await s.repo.listProperties(USER_1))[0]!.displayName).toBe("New name");
    await expect(s.clarity.rename(USER_2, connectionId, "Hijacked")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect((await s.repo.getConnection(USER_1, connectionId))!.accountLabel).toBe("New name");
  });

  it("reconnecting replaces the token, resets to awaiting verification, and follows the new project key", async () => {
    const s = stack();
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop", token: fakeToken("old") });
    await s.repo.setConnectionStatus(USER_1, connectionId, "needs_attention", { errorCode: "AUTH_EXPIRED" });
    const before = (await s.repo.listProperties(USER_1))[0]!;

    const fresh = fakeToken("new");
    await s.clarity.reconnect(USER_1, connectionId, { token: fresh });
    const conn = (await s.repo.getConnection(USER_1, connectionId))!;
    expect(conn).toMatchObject({ status: "pending", lastErrorCode: null, accountLabel: "Shop" });
    expect(await s.clarity.getToken(USER_1, connectionId)).toBe(fresh);
    const after = (await s.repo.listProperties(USER_1))[0]!;
    expect(after.externalPropertyId).not.toBe(before.externalPropertyId);
    expect(s.everything()).not.toContain(fresh);
  });

  it("another user cannot reconnect or read someone else's connection", async () => {
    const s = stack();
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop", token: fakeToken("mine") });
    await expect(s.clarity.reconnect(USER_2, connectionId, { token: fakeToken("evil") })).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(await s.clarity.getToken(USER_1, connectionId)).toBe(fakeToken("mine"));
  });

  it("refuses to point a connection at a token another of the user's connections already uses", async () => {
    const s = stack();
    await s.clarity.connect(USER_1, { name: "Site A", token: fakeToken("a") });
    const b = await s.clarity.connect(USER_1, { name: "Site B", token: fakeToken("b") });
    await expect(s.clarity.reconnect(USER_1, b.connectionId, { token: fakeToken("a") })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("does not operate on a Google connection even when given its id", async () => {
    const s = stack();
    const { id } = await s.repo.upsertConnection({ userId: USER_1, provider: "google", providerAccountId: "g", accountLabel: "G", grantedScopes: [] });
    await expect(s.clarity.reconnect(USER_1, id, { token: fakeToken("x") })).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    await expect(s.clarity.getToken(USER_1, id)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });
});

describe("usability and disconnect", () => {
  it("does not hand out a token for a connection flagged as needing attention (no blind retries)", async () => {
    const s = stack();
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop", token: fakeToken("bad") });
    await s.repo.setConnectionStatus(USER_1, connectionId, "needs_attention", { errorCode: "AUTH_EXPIRED" });
    await expect(s.clarity.getToken(USER_1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("a ciphertext copied onto another connection cannot be decrypted there", async () => {
    const s = stack();
    const a = await s.clarity.connect(USER_1, { name: "Site A", token: fakeToken("aa") });
    const b = await s.clarity.connect(USER_1, { name: "Site B", token: fakeToken("bb") });
    s.repo.secrets.set(b.connectionId, { ...s.repo.secrets.get(a.connectionId)! });
    await expect(s.clarity.getToken(USER_1, b.connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await s.repo.getConnection(USER_1, b.connectionId))!.status).toBe("needs_attention");
  });

  it("disconnecting destroys the secret and the connection; the token is then unusable", async () => {
    const s = stack();
    const { connectionId } = await s.clarity.connect(USER_1, { name: "Shop", token: fakeToken("gone") });
    expect(await s.credentials.disconnect(USER_2, connectionId)).toMatchObject({ disconnected: false });
    expect(s.repo.secrets.has(connectionId)).toBe(true);
    expect(await s.credentials.disconnect(USER_1, connectionId)).toMatchObject({ disconnected: true });
    expect(s.repo.secrets.has(connectionId)).toBe(false);
    expect(await s.repo.listProperties(USER_1)).toEqual([]);
    await expect(s.clarity.getToken(USER_1, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });
});

describe("fail-safe configuration", () => {
  it("in production, saving is refused until CREDENTIAL_FINGERPRINT_KEY is set, with an actionable message", async () => {
    expect(() => createFingerprinterFromEnv({ NODE_ENV: "production" })).toThrow(/not configured/);
    try {
      createFingerprinterFromEnv({ NODE_ENV: "production" });
    } catch (e) {
      expect((e as { suggestedAction?: string }).suggestedAction).toMatch(/CREDENTIAL_FINGERPRINT_KEY/);
    }
    expect(() => createFingerprinterFromEnv({ NODE_ENV: "production", CREDENTIAL_FINGERPRINT_KEY: "dG9vLXNob3J0" })).toThrow(/32 bytes/);
  });

  it("fingerprints are keyed: same token + same key is stable, a different key differs, and the token is not recoverable", () => {
    const k1 = generateLocalMasterKey();
    const f1 = createFingerprinterFromEnv({ NODE_ENV: "production", CREDENTIAL_FINGERPRINT_KEY: k1 });
    const f1b = createFingerprinterFromEnv({ NODE_ENV: "production", CREDENTIAL_FINGERPRINT_KEY: k1 });
    const f2 = createFingerprinterFromEnv({ NODE_ENV: "production", CREDENTIAL_FINGERPRINT_KEY: generateLocalMasterKey() });
    const t = fakeToken("fp");
    expect(f1.fingerprint(t)).toBe(f1b.fingerprint(t));
    expect(f1.fingerprint(t)).not.toBe(f2.fingerprint(t));
    expect(f1.fingerprint(t)).not.toContain(t);
  });
});
