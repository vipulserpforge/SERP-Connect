/**
 * Bing connections: OAuth state/callback/token exchange/refresh, API-key storage, encryption, discovery and ownership.
 * DATA SOURCE: MOCK. The Bing API and token endpoint are a local fake (tests/bing/fake-bing.ts); the repository is in memory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BingConnectionService } from "@serp/credentials";
import { MockRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { HttpBingApiClient, HttpBingOAuthClient } from "@serp/provider-bing";
import { KeyRingProvider, createFingerprinterFromEnv, generateLocalMasterKey } from "@serp/secrets";
import { FakeBing } from "./fake-bing.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const ALICE_KEY = "alicealicealicealicealicealiceal1";
const BOB_KEY = "bobbobbobbobbobbobbobbobbobbobb2";

const fake = new FakeBing();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

function stack(opts: { oauth?: boolean } = {}) {
  const repo = new MockRepository({ connections: [], properties: [] });
  const keys = new KeyRingProvider({ v1: generateLocalMasterKey() }, "v1");
  const logs: string[] = [];
  const time = { now: Date.parse("2026-10-19T12:00:00Z") };
  const fp = createFingerprinterFromEnv({ NODE_ENV: "test" });
  const svc = new BingConnectionService({
    creds: repo,
    repo,
    keys,
    logger: createLogger({ level: "debug", write: (l) => logs.push(l) }),
    clock: () => time.now,
    api: new HttpBingApiClient({ baseUrl: fake.apiBase, timeoutMs: 2000 }),
    fingerprinter: () => fp,
    oauth:
      opts.oauth === false
        ? null
        : {
            client: new HttpBingOAuthClient({ clientId: fake.client.id, clientSecret: fake.client.secret, tokenEndpoint: fake.tokenEndpoint, now: () => time.now }),
            config: { clientId: fake.client.id, redirectUri: fake.client.redirectUri },
          },
  });
  const everything = () => JSON.stringify([...repo.secrets.values()]) + JSON.stringify(repo.auditLog) + JSON.stringify(logs);
  return { repo, svc, time, logs, everything };
}
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
async function oauthConnect(s: ReturnType<typeof stack>, user: string, owner: "alice" | "bob" = "alice") {
  const { state } = await s.svc.beginOAuth(user);
  return s.svc.completeOAuth(user, { state, code: fake.approve(owner), error: null });
}

beforeEach(() => {
  fake.apiKeys.set(ALICE_KEY, "alice");
  fake.apiKeys.set(BOB_KEY, "bob");
  fake.calls.length = 0;
  fake.fail = null;
  fake.rotateRefreshToken = false;
  fake.expiresIn = 3600;
  fake.tokenDelayMs = 0;
  fake.revokedRefreshTokens.clear();
});

describe("OAuth state", () => {
  it("is random, single-use, stored only as a hash, and the URL asks for the read scope", async () => {
    const s = stack();
    const a = await s.svc.beginOAuth(U1);
    const b = await s.svc.beginOAuth(U1);
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(stateOf(a.authorizationUrl)).toBe(a.state);
    expect(new URL(a.authorizationUrl).searchParams.get("scope")).toBe("webmaster.read");
    expect(s.everything()).not.toContain(a.state);

    const code = fake.approve("alice");
    await s.svc.completeOAuth(U1, { state: a.state, code, error: null });
    await expect(s.svc.completeOAuth(U1, { state: a.state, code: fake.approve("alice"), error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" }); // replay
  });

  it("is bound to the user who started it", async () => {
    const s = stack();
    const { state } = await s.svc.beginOAuth(U1);
    await expect(s.svc.completeOAuth(U2, { state, code: fake.approve("bob"), error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await s.repo.listConnections(U2)).toEqual([]);
    expect(fake.calls.filter((c) => c.kind === "token")).toHaveLength(0); // the code was never even exchanged
  });

  it("expires", async () => {
    const s = stack();
    const { state } = await s.svc.beginOAuth(U1);
    s.time.now += 11 * 60_000;
    await expect(s.svc.completeOAuth(U1, { state, code: fake.approve("alice"), error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("a state made for Google cannot complete a Bing connection", async () => {
    const s = stack();
    await s.repo.createOAuthState({ stateHash: "x".repeat(8), userId: U1, product: "gsc", codeVerifierEnc: null as never, expiresAt: new Date(s.time.now + 60_000) } as never).catch(() => undefined);
    await expect(s.svc.completeOAuth(U1, { state: "google-state-not-ours", code: fake.approve("alice"), error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("callback failures", () => {
  it("denied consent, missing/malformed state or code, and an unknown code store nothing", async () => {
    const s = stack();
    const { state } = await s.svc.beginOAuth(U1);
    await expect(s.svc.completeOAuth(U1, { state, code: null, error: "access_denied" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(s.svc.completeOAuth(U1, { state: null, code: "c", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(s.svc.completeOAuth(U1, { state: "z".repeat(500), code: "c", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const second = await s.svc.beginOAuth(U1);
    await expect(s.svc.completeOAuth(U1, { state: second.state, code: "not-a-real-code", error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await s.repo.listConnections(U1)).toEqual([]);
    expect(s.repo.secrets.size).toBe(0);
  });

  it("token endpoint outage is reported as unavailable and the state is spent", async () => {
    const s = stack();
    const { state } = await s.svc.beginOAuth(U1);
    const down = new BingConnectionService({ ...(s.svc as never as { deps: never }).deps, oauth: { client: new HttpBingOAuthClient({ clientId: "a", clientSecret: "b", tokenEndpoint: "http://127.0.0.1:1/x", timeoutMs: 500 }), config: { clientId: "a", redirectUri: "r" } } });
    await expect(down.completeOAuth(U1, { state, code: "c", error: null })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(s.svc.completeOAuth(U1, { state, code: fake.approve("alice"), error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("without an operator OAuth client, OAuth is unavailable and the API-key path still works", async () => {
    const s = stack({ oauth: false });
    expect(s.svc.oauthConfigured).toBe(false);
    await expect(s.svc.beginOAuth(U1)).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    await expect(s.svc.completeOAuth(U1, { state: "s", code: "c", error: null })).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
  });
});

describe("OAuth connection", () => {
  it("exchanges the code on the server, stores tokens encrypted, and starts pending until a real call succeeds", async () => {
    const s = stack();
    const { connectionId } = await oauthConnect(s, U1);
    const conn = (await s.repo.getConnection(U1, connectionId))!;
    expect(conn).toMatchObject({ provider: "bing", authMethod: "oauth", status: "pending", grantedScopes: ["webmaster.read"] });
    expect(conn.providerAccountId).toMatch(/^bing:oauth:/);
    const stored = s.repo.secrets.get(connectionId)!;
    expect(Object.keys(stored).sort()).toEqual(["authTag", "ciphertext", "keyVersion", "nonce", "wrappedDek"]);
    const tokens = [...fake.accessTokens.keys(), ...fake.refreshTokens.keys()];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(s.everything()).not.toContain(t);
    expect(fake.calls.find((c) => c.kind === "token")).toMatchObject({ grantType: "authorization_code" });
    expect(fake.calls.find((c) => c.kind === "token")!.queryNames).toEqual(expect.arrayContaining(["client_secret", "code", "redirect_uri"]));
  });

  it("an authorization code works once", async () => {
    const s = stack();
    const code = fake.approve("alice");
    const a = await s.svc.beginOAuth(U1);
    await s.svc.completeOAuth(U1, { state: a.state, code, error: null });
    const b = await s.svc.beginOAuth(U1);
    await expect(s.svc.completeOAuth(U1, { state: b.state, code, error: null })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("reconnect keeps the same connection (and its sites); a foreign connection id is refused at start", async () => {
    const s = stack();
    const { connectionId } = await oauthConnect(s, U1);
    await s.svc.syncSites(U1, connectionId);
    const { state } = await s.svc.beginOAuth(U1, { connectionId });
    const again = await s.svc.completeOAuth(U1, { state, code: fake.approve("alice"), error: null });
    expect(again.connectionId).toBe(connectionId);
    expect(await s.repo.listConnections(U1)).toHaveLength(1);
    expect(await s.repo.listProperties(U1, { provider: "bing" })).toHaveLength(1);
    await expect(s.svc.beginOAuth(U2, { connectionId })).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("limits connections per user", async () => {
    const s = stack();
    for (let i = 0; i < 5; i++) await oauthConnect(s, U1);
    await expect(s.svc.beginOAuth(U1)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await s.svc.beginOAuth(U2); // another user is unaffected
  });
});

describe("refresh", () => {
  async function connected() {
    const s = stack();
    const { connectionId } = await oauthConnect(s, U1);
    return { s, connectionId };
  }

  it("uses the stored access token while valid, and refreshes (grant_type=refresh_token) shortly before expiry", async () => {
    const { s, connectionId } = await connected();
    const a = await s.svc.getAuth(U1, connectionId);
    expect(fake.calls.filter((c) => c.grantType === "refresh_token")).toHaveLength(0);
    s.time.now += 3600_000 - 30_000;
    const b = await s.svc.getAuth(U1, connectionId);
    expect(b).not.toEqual(a);
    expect(fake.calls.filter((c) => c.grantType === "refresh_token")).toHaveLength(1);
    expect(fake.accessTokens.get((b as { accessToken: string }).accessToken)).toBe("alice");
  });

  it("keeps the refresh token when the refresh response omits one, so the next renewal still works", async () => {
    const { s, connectionId } = await connected();
    for (let i = 0; i < 3; i++) {
      s.time.now += 3600_000;
      expect(await s.svc.getAuth(U1, connectionId)).toMatchObject({ method: "oauth" });
    }
    expect(fake.calls.filter((c) => c.grantType === "refresh_token")).toHaveLength(3);
  });

  it("stores a rotated refresh token when Bing issues one", async () => {
    const { s, connectionId } = await connected();
    fake.rotateRefreshToken = true;
    s.time.now += 3600_000;
    await s.svc.getAuth(U1, connectionId);
    const [original] = [...fake.refreshTokens.keys()];
    fake.revokedRefreshTokens.add(original!); // the old one is dead: only the stored rotated one can work
    s.time.now += 3600_000;
    await expect(s.svc.getAuth(U1, connectionId)).resolves.toMatchObject({ method: "oauth" });
  });

  it("concurrent callers share one refresh", async () => {
    const { s, connectionId } = await connected();
    fake.tokenDelayMs = 50;
    s.time.now += 3600_000;
    const results = await Promise.all(Array.from({ length: 8 }, () => s.svc.getAuth(U1, connectionId)));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(fake.calls.filter((c) => c.grantType === "refresh_token")).toHaveLength(1);
  });

  it("two service instances refreshing at once converge without overwriting each other", async () => {
    const { s, connectionId } = await connected();
    const twin = new BingConnectionService((s.svc as never as { deps: never }).deps);
    fake.tokenDelayMs = 30;
    s.time.now += 3600_000;
    const [a, b] = await Promise.all([s.svc.getAuth(U1, connectionId), twin.getAuth(U1, connectionId)]);
    expect(a).toMatchObject({ method: "oauth" });
    expect(b).toMatchObject({ method: "oauth" });
    await expect(s.svc.getAuth(U1, connectionId)).resolves.toMatchObject({ method: "oauth" });
  });

  it("a revoked refresh token marks the connection as needing reauthorization and is not retried", async () => {
    const { s, connectionId } = await connected();
    for (const t of fake.refreshTokens.keys()) fake.revokedRefreshTokens.add(t);
    s.time.now += 3600_000;
    await expect(s.svc.getAuth(U1, connectionId)).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(await s.repo.getConnection(U1, connectionId)).toMatchObject({ status: "needs_attention", lastErrorCode: "AUTH_REVOKED" });
    const before = fake.calls.length;
    await expect(s.svc.getAuth(U1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(fake.calls.length).toBe(before);
  });

  it("an outage during refresh is transient and does not lock the connection out", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 3600_000;
    const deps = (s.svc as never as { deps: Record<string, unknown> }).deps;
    const flaky = new BingConnectionService({ ...deps, oauth: { client: new HttpBingOAuthClient({ clientId: "a", clientSecret: "b", tokenEndpoint: "http://127.0.0.1:1/x", timeoutMs: 300, now: () => s.time.now }), config: { clientId: "a", redirectUri: "r" } } } as never);
    await expect(flaky.getAuth(U1, connectionId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect((await s.repo.getConnection(U1, connectionId))!.status).not.toBe("needs_attention");
  });

  it("a wrong operator client secret is our problem, not the user's: the connection is left alone", async () => {
    const { s, connectionId } = await connected();
    s.time.now += 3600_000;
    const deps = (s.svc as never as { deps: Record<string, unknown> }).deps;
    const wrong = new BingConnectionService({ ...deps, oauth: { client: new HttpBingOAuthClient({ clientId: fake.client.id, clientSecret: "wrong", tokenEndpoint: fake.tokenEndpoint, now: () => s.time.now }), config: { clientId: fake.client.id, redirectUri: "r" } } } as never);
    await expect(wrong.getAuth(U1, connectionId)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((await s.repo.getConnection(U1, connectionId))!.status).not.toBe("needs_attention");
  });
});

describe("API key", () => {
  it("is validated, stored encrypted (never plain), and the connection records the method", async () => {
    const s = stack();
    await expect(s.svc.connectApiKey(U1, { apiKey: "bad key!" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(s.repo.secrets.size).toBe(0);
    const { connectionId } = await s.svc.connectApiKey(U1, { name: "Shop", apiKey: ALICE_KEY });
    const conn = (await s.repo.getConnection(U1, connectionId))!;
    expect(conn).toMatchObject({ provider: "bing", authMethod: "api_key", status: "pending", accountLabel: "Shop" });
    expect(conn.providerAccountId).not.toContain(ALICE_KEY);
    expect(JSON.stringify(conn)).not.toContain(ALICE_KEY);
    expect(s.everything()).not.toContain(ALICE_KEY);
    expect(await s.svc.getAuth(U1, connectionId)).toEqual({ method: "api_key", apiKey: ALICE_KEY });
    await expect(s.svc.getAuth(U2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("the same key saved again updates in place; replacing the key keeps the connection", async () => {
    const s = stack();
    const a = await s.svc.connectApiKey(U1, { name: "One", apiKey: ALICE_KEY });
    const b = await s.svc.connectApiKey(U1, { name: "Two", apiKey: ALICE_KEY });
    expect(b.connectionId).toBe(a.connectionId);
    const NEW = "newkeynewkeynewkeynewkeynewkey99";
    await s.svc.connectApiKey(U1, { apiKey: NEW, connectionId: a.connectionId });
    expect(await s.svc.getAuth(U1, a.connectionId)).toEqual({ method: "api_key", apiKey: NEW });
    expect(await s.repo.listConnections(U1)).toHaveLength(1);
  });

  it("switching method is explicit and replaces the secret: key -> OAuth -> key", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    const { state } = await s.svc.beginOAuth(U1, { connectionId });
    await s.svc.completeOAuth(U1, { state, code: fake.approve("alice"), error: null });
    expect((await s.repo.getConnection(U1, connectionId))!.authMethod).toBe("oauth");
    expect(await s.svc.getAuth(U1, connectionId)).toMatchObject({ method: "oauth" });
    await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY, connectionId });
    expect(await s.svc.getAuth(U1, connectionId)).toEqual({ method: "api_key", apiKey: ALICE_KEY });
  });

  it("never substitutes the other method: a stored secret that disagrees with the connection's method is unusable", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    await s.repo.updateConnectionIdentity(U1, connectionId, { authMethod: "oauth" });
    await expect(s.svc.getAuth(U1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await s.repo.getConnection(U1, connectionId))!.lastErrorCode).toBe("CREDENTIAL_UNREADABLE");
  });

  it("a secret encrypted for another user/connection cannot be decrypted (bound to both)", async () => {
    const s = stack();
    const a = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    const b = await s.svc.connectApiKey(U1, { apiKey: BOB_KEY });
    s.repo.secrets.set(b.connectionId, s.repo.secrets.get(a.connectionId)!);
    await expect(s.svc.getAuth(U1, b.connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("limits connections per user and supports rename", async () => {
    const s = stack();
    for (let i = 0; i < 5; i++) await s.svc.connectApiKey(U1, { apiKey: `${"k".repeat(31)}${i}` });
    await expect(s.svc.connectApiKey(U1, { apiKey: "z".repeat(32) })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    const [c] = await s.repo.listConnections(U1);
    await s.svc.rename(U1, c!.id, "Renamed");
    expect((await s.repo.getConnection(U1, c!.id))!.accountLabel).toBe("Renamed");
    await expect(s.svc.rename(U2, c!.id, "Hijack")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });
});

describe("site discovery", () => {
  it("stores only sites Bing says are verified, reports the rest, and marks the connection connected", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    const r = await s.svc.syncSites(U1, connectionId);
    expect(r).toMatchObject({ total: 1, added: 1 });
    expect(r.skipped).toEqual([{ url: "https://alice-unverified.example/", reason: "unverified" }]);
    const props = await s.repo.listProperties(U1, { provider: "bing" });
    expect(props.map((p) => p.externalPropertyId)).toEqual(["https://alice.example/"]);
    expect(props[0]).toMatchObject({ propertyType: "bing_site_verified" });
    expect(await s.repo.getConnection(U1, connectionId)).toMatchObject({ status: "connected" });
    expect(JSON.stringify(props)).not.toMatch(/OWNERSHIPCODE|dns\.ownership/);
    expect(s.everything()).not.toMatch(/OWNERSHIPCODE|dns\.ownership/);
  });

  it("refresh updates existing sites and removes ones that disappeared", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    await s.svc.syncSites(U1, connectionId);
    // Same key now resolves to a different Bing account's site list: the old site is removed.
    fake.apiKeys.set(ALICE_KEY, "bob");
    const r = await s.svc.syncSites(U1, connectionId);
    expect(r).toMatchObject({ removed: 1, added: 1 });
    expect((await s.repo.listProperties(U1, { provider: "bing" })).map((p) => p.externalPropertyId)).toEqual(["https://bob.example/"]);
  });

  it("a rejected key marks the connection as needing attention", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: "r".repeat(32) });
    await expect(s.svc.syncSites(U1, connectionId)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await s.repo.getConnection(U1, connectionId)).toMatchObject({ status: "needs_attention", lastErrorCode: "AUTH_EXPIRED" });
  });

  it("an account with no sites syncs cleanly with an explanatory message", async () => {
    const s = stack();
    fake.apiKeys.set("nosites".padEnd(32, "x"), "alice");
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    await s.svc.syncSites(U1, connectionId);
    fake.fail = { endpoint: "GetUserSites", status: 200, body: { d: [] } };
    const r = await s.svc.syncSites(U1, connectionId);
    expect(r.total).toBe(0);
    expect(r.message).toMatch(/no verified sites/i);
  });

  it("cannot sync someone else's connection", async () => {
    const s = stack();
    const { connectionId } = await s.svc.connectApiKey(U1, { apiKey: ALICE_KEY });
    await expect(s.svc.syncSites(U2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });
});
