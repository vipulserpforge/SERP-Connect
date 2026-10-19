import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialService, OAuthFlowService } from "@serp/credentials";
import { PgCredentialRepository, PgRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { MOCK_CLIENT_ID, MockGoogleOAuthClient } from "@serp/provider-google";
import { KeyRingProvider, generateLocalMasterKey } from "@serp/secrets";
import { asRole, createTestDatabase, pgliteExecutor } from "./harness.js";

const U1 = "c1111111-1111-4111-8111-111111111111";
const U2 = "c2222222-2222-4222-8222-222222222222";

let db: PGlite;

function stack() {
  const exec = pgliteExecutor(db);
  const repo = new PgRepository(exec);
  const creds = new PgCredentialRepository(exec);
  const keys = new KeyRingProvider({ v1: generateLocalMasterKey() }, "v1");
  const time = { now: 1_800_000_000_000 };
  const clock = () => time.now;
  const google = new MockGoogleOAuthClient(clock);
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const credentials = new CredentialService({ creds, repo, keys, google, logger, clock });
  const oauth = new OAuthFlowService({
    creds, repo, keys, google, credentials, logger, clock,
    config: { clientId: MOCK_CLIENT_ID, redirectUri: "http://localhost/cb" },
  });
  const connect = async (userId: string, email: string) => {
    const { authorizationUrl } = await oauth.begin(userId, "gsc");
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    return { ...(await oauth.complete(userId, { state, code: `mock-code:${email}`, error: null })), state };
  };
  return { repo, creds, keys, time, google, logs, credentials, oauth, connect };
}

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec(`
    delete from auth.users;
    insert into auth.users (id, email) values ('${U1}', 'u1@saas.test'), ('${U2}', 'u2@saas.test');
  `);
});

describe("full credential lifecycle on Postgres", () => {
  it("connect stores only ciphertext in provider_secrets", async () => {
    const s = stack();
    const { connectionId, state } = await s.connect(U1, "alice@example.com");

    const secrets = (await db.query("select * from public.provider_secrets")).rows;
    expect(secrets).toHaveLength(1);
    const dump = JSON.stringify(secrets) + JSON.stringify((await db.query("select * from public.oauth_states")).rows) + JSON.stringify((await db.query("select * from public.audit_events")).rows) + s.logs.join("");
    expect(dump).not.toMatch(/mock-access-token|mock-refresh-token|mock-code/);
    expect(dump).not.toContain(state);

    const conn = await s.repo.getConnection(U1, connectionId);
    expect(conn).toMatchObject({ status: "connected", providerAccountId: "mock-sub-alice@example.com" });
    const { rows } = await db.query("select credential_version from public.provider_connections where id = $1", [connectionId]);
    expect(rows[0]!.credential_version).toBe(2); // 1 on create, bumped by the first secret write
  });

  it("refresh persists the new token and bumps the version", async () => {
    const s = stack();
    const { connectionId } = await s.connect(U1, "alice@example.com");
    const first = await s.credentials.getAccessToken(U1, connectionId);
    s.time.now += 2 * 3600_000;
    const second = await s.credentials.getAccessToken(U1, connectionId);
    expect(second.accessToken).not.toBe(first.accessToken);
    const { rows } = await db.query("select credential_version from public.provider_connections where id = $1", [connectionId]);
    expect(rows[0]!.credential_version).toBe(3);
  });

  it("disconnect revokes, destroys the secret and cascades through the database", async () => {
    const s = stack();
    const { connectionId } = await s.connect(U1, "alice@example.com");
    expect(await s.credentials.disconnect(U1, connectionId)).toEqual({ disconnected: true, revokedAtProvider: true });
    expect((await db.query("select 1 from public.provider_secrets")).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.provider_connections")).rows).toHaveLength(0);
    const audit = (await db.query("select event_type, metadata from public.audit_events where event_type = 'connection.disconnected'")).rows;
    expect(audit).toHaveLength(1);
  });

  it("deleting the user removes secrets, states and audit rows", async () => {
    const s = stack();
    await s.connect(U1, "alice@example.com");
    await s.oauth.begin(U1, "gsc");
    await db.query("delete from auth.users where id = $1", [U1]);
    for (const t of ["provider_secrets", "provider_connections", "oauth_states", "audit_events"]) {
      expect((await db.query(`select 1 from public.${t}`)).rows).toHaveLength(0);
    }
  });

  it("key rotation rewraps in SQL-backed storage", async () => {
    const s = stack();
    await s.connect(U1, "alice@example.com");
    const v2 = generateLocalMasterKey();
    const ringKeys = { v1: "x" };
    void ringKeys;
    // New process with an extended ring: read the old key out of the first provider by rebuilding both.
    const v1 = generateLocalMasterKey();
    const exec = pgliteExecutor(db);
    await db.exec("delete from auth.users; insert into auth.users (id) values ('" + U1 + "')");
    const oldKeys = new KeyRingProvider({ v1 }, "v1");
    const base = { creds: new PgCredentialRepository(exec), repo: new PgRepository(exec), google: new MockGoogleOAuthClient(), logger: createLogger({ write: () => undefined }) };
    const a = new CredentialService({ ...base, keys: oldKeys });
    const conn = await base.creds.upsertConnection({ userId: U1, provider: "google", providerAccountId: "sub", accountLabel: null, grantedScopes: [] });
    await a.storeTokens(U1, conn.id, { accessToken: "mock-access-token-9", refreshToken: "mock-refresh-token-9", expiresAt: Date.now() + 3600_000, scopes: [] }, null);
    await base.creds.setConnectionStatus(U1, conn.id, "connected");
    const b = new CredentialService({ ...base, keys: new KeyRingProvider({ v1, v2 }, "v2") });
    expect(await b.rewrapBatch()).toEqual({ rewrapped: 1, skipped: 0 });
    expect((await db.query("select key_version from public.provider_secrets")).rows[0]!.key_version).toBe("v2");
    const c = new CredentialService({ ...base, keys: new KeyRingProvider({ v2 }, "v2") });
    await expect(c.getAccessToken(U1, conn.id)).resolves.toMatchObject({ accessToken: "mock-access-token-9" });
  });
});

describe("PgCredentialRepository ownership and concurrency", () => {
  const secret = { ciphertext: "c", nonce: "n", authTag: "t", wrappedDek: "w", keyVersion: "v1" };

  async function conn(userId: string, sub: string) {
    return new PgCredentialRepository(pgliteExecutor(db)).upsertConnection({ userId, provider: "google", providerAccountId: sub, accountLabel: "x", grantedScopes: [] });
  }

  it("upsert is idempotent per (user, account) and separate per user", async () => {
    const a = await conn(U1, "sub-1");
    expect((await conn(U1, "sub-1")).id).toBe(a.id);
    expect((await conn(U2, "sub-1")).id).not.toBe(a.id);
  });

  it("compare-and-swap rejects stale writers without changing the stored secret", async () => {
    const creds = new PgCredentialRepository(pgliteExecutor(db));
    const { id, credentialVersion } = await conn(U1, "sub-1");
    expect(await creds.putSecret(U1, id, { ...secret, ciphertext: "first" }, credentialVersion)).toBe(credentialVersion + 1);
    expect(await creds.putSecret(U1, id, { ...secret, ciphertext: "stale" }, credentialVersion)).toBeNull();
    expect((await creds.getSecret(U1, id))!.secret.ciphertext).toBe("first");
    // Exactly one of two racing writers wins.
    const v = (await creds.getSecret(U1, id))!.credentialVersion;
    const results = await Promise.all([
      creds.putSecret(U1, id, { ...secret, ciphertext: "A" }, v),
      creds.putSecret(U1, id, { ...secret, ciphertext: "B" }, v),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("another user cannot read, overwrite, delete or change the status of the secret", async () => {
    const creds = new PgCredentialRepository(pgliteExecutor(db));
    const { id } = await conn(U1, "sub-1");
    await creds.putSecret(U1, id, secret, null);
    expect(await creds.getSecret(U2, id)).toBeNull();
    expect(await creds.putSecret(U2, id, { ...secret, ciphertext: "evil" }, null)).toBeNull();
    expect(await creds.deleteSecret(U2, id)).toBe(false);
    expect(await creds.setConnectionStatus(U2, id, "revoked")).toBe(false);
    expect((await creds.getSecret(U1, id))!.secret.ciphertext).toBe("c");
    expect((await db.query("select status from public.provider_connections where id = $1", [id])).rows[0]!.status).toBe("pending");
  });

  it("OAuth state is single-use, user-bound and expiring", async () => {
    const creds = new PgCredentialRepository(pgliteExecutor(db));
    const now = new Date("2026-10-19T12:00:00Z");
    await creds.createOAuthState({ stateHash: "h1", userId: U1, product: "gsc", codeVerifierEnc: secret, expiresAt: new Date(now.getTime() + 60_000) });
    expect(await creds.consumeOAuthState(U2, "h1", now)).toBeNull(); // wrong user does not burn it
    expect(await creds.consumeOAuthState(U1, "h1", now)).toMatchObject({ product: "gsc" });
    expect(await creds.consumeOAuthState(U1, "h1", now)).toBeNull(); // replay
    await creds.createOAuthState({ stateHash: "h2", userId: U1, product: "ga4", codeVerifierEnc: secret, expiresAt: new Date(now.getTime() - 1) });
    expect(await creds.consumeOAuthState(U1, "h2", now)).toBeNull(); // expired
    expect(await creds.purgeExpiredOAuthStates(now)).toBe(2);
  });
});

describe("RLS on the new server-only tables", () => {
  it("oauth_states and provider_secrets are unreachable from browser roles", async () => {
    await asRole(db, U1, async (q) => {
      await expect(q("select * from public.oauth_states")).rejects.toThrow(/permission denied/);
    });
    await asRole(db, null, async (q) => {
      await expect(q("select * from public.provider_secrets")).rejects.toThrow(/permission denied/);
    });
    await asRole(db, U1, async (q) => {
      await expect(q("insert into public.oauth_states (state_hash, user_id, product, code_verifier_enc, expires_at) values ('x', $1, 'gsc', '{}', now())", [U1])).rejects.toThrow(/permission denied/);
    });
  });

  it("every public table still has RLS enabled", async () => {
    const { rows } = await db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});

describe("property discovery on Postgres", () => {
  const d = (id: string, name = id) => ({ externalPropertyId: id, displayName: name, propertyType: "domain", timezone: "America/Los_Angeles" });
  const props = async (userId: string) => (await new PgRepository(pgliteExecutor(db)).listProperties(userId, { provider: "gsc" })).map((p) => p.externalPropertyId).sort();

  it("adds, refreshes (keeping the enabled switch) and removes, scoped to the owner", async () => {
    const s = stack();
    const repo = new PgRepository(pgliteExecutor(db));
    const { connectionId } = await s.connect(U1, "alice@example.com");

    expect(await repo.syncDiscoveredProperties(U1, connectionId, "gsc", [d("sc-domain:a.com"), d("sc-domain:b.com")])).toEqual({ added: 2, updated: 0, removed: 0 });
    const a = (await repo.listProperties(U1)).find((p) => p.externalPropertyId === "sc-domain:a.com")!;
    await repo.setPropertyEnabled(U1, a.id, false);

    expect(await repo.syncDiscoveredProperties(U1, connectionId, "gsc", [d("sc-domain:a.com", "A renamed"), d("sc-domain:c.com")])).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(await props(U1)).toEqual(["sc-domain:a.com", "sc-domain:c.com"]);
    const again = (await repo.listProperties(U1)).find((p) => p.id === a.id)!;
    expect(again).toMatchObject({ displayName: "A renamed", enabledForMcp: false });

    expect(await repo.syncDiscoveredProperties(U1, connectionId, "gsc", [])).toEqual({ added: 0, updated: 0, removed: 2 });
    expect(await props(U1)).toEqual([]);
  });

  it("refuses another tenant's connection and writes nothing", async () => {
    const s = stack();
    const repo = new PgRepository(pgliteExecutor(db));
    const { connectionId } = await s.connect(U1, "alice@example.com");
    expect(await repo.syncDiscoveredProperties(U2, connectionId, "gsc", [d("sc-domain:evil.com")])).toBeNull();
    expect((await db.query("select 1 from public.properties")).rows).toHaveLength(0);
  });

  it("the same site on two users' connections stays separate", async () => {
    const s = stack();
    const repo = new PgRepository(pgliteExecutor(db));
    const a = await s.connect(U1, "alice@example.com");
    const b = await s.connect(U2, "bob@example.com");
    await repo.syncDiscoveredProperties(U1, a.connectionId, "gsc", [d("sc-domain:shared.com")]);
    await repo.syncDiscoveredProperties(U2, b.connectionId, "gsc", [d("sc-domain:shared.com")]);
    await repo.syncDiscoveredProperties(U1, a.connectionId, "gsc", []);
    expect(await props(U1)).toEqual([]);
    expect(await props(U2)).toEqual(["sc-domain:shared.com"]);
  });

  it("disconnecting removes the discovered properties", async () => {
    const s = stack();
    const repo = new PgRepository(pgliteExecutor(db));
    const { connectionId } = await s.connect(U1, "alice@example.com");
    await repo.syncDiscoveredProperties(U1, connectionId, "gsc", [d("sc-domain:a.com")]);
    await s.credentials.disconnect(U1, connectionId);
    expect((await db.query("select 1 from public.properties")).rows).toHaveLength(0);
  });

  it("syncing one provider never touches the other provider's properties on the same connection", async () => {
    const s = stack();
    const repo = new PgRepository(pgliteExecutor(db));
    const { connectionId } = await s.connect(U1, "alice@example.com");
    await repo.syncDiscoveredProperties(U1, connectionId, "gsc", [d("sc-domain:a.com")]);
    await repo.syncDiscoveredProperties(U1, connectionId, "ga4", [{ externalPropertyId: "123", displayName: "GA", propertyType: "ga4_property", timezone: "Asia/Kolkata" }]);
    expect(await repo.syncDiscoveredProperties(U1, connectionId, "ga4", [])).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(await props(U1)).toEqual(["sc-domain:a.com"]);
    const ga = await repo.syncDiscoveredProperties(U1, connectionId, "ga4", [{ externalPropertyId: "123", displayName: "GA", propertyType: "ga4_property", timezone: "Asia/Kolkata" }]);
    expect(ga).toEqual({ added: 1, updated: 0, removed: 0 });
    expect((await repo.listProperties(U1, { provider: "ga4" }))[0]).toMatchObject({ timezone: "Asia/Kolkata", propertyType: "ga4_property" });
  });
});
