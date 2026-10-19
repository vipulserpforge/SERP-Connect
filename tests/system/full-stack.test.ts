/**
 * Whole-system tests: Postgres (real migrations) + encrypted credentials + live HTTP Google clients + Postgres report
 * cache + MCP server behind signed OAuth tokens, with two customers.
 *
 * DATA SOURCE: every Google response here comes from tests/system/fake-google.ts, a local stand-in that mimics
 * response shapes. Nothing in this file talks to real Google, and the Google consent screen is the mock one.
 * These tests prove our code's behaviour; they do not prove Google's behaviour.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole } from "../db/harness.js";
import { connectWithToken } from "../mcp/harness.js";
import type { Owner } from "./fake-google.js";
import { ALICE_ID, BOB_ID, ID_OF, buildWorld, type World } from "./world.js";

let w: World;
const clients: Client[] = [];
const conn: Record<Owner, string> = { alice: "", bob: "" };

beforeAll(async () => {
  w = await buildWorld();
  conn.alice = await w.connect("alice");
  conn.bob = await w.connect("bob");
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await w.close();
});
beforeEach(async () => {
  w.google.reset();
  w.sleeps.length = 0;
  w.time.now = Date.parse("2026-10-19T12:00:00Z");
  await w.sql("delete from public.report_cache");
});

async function as(owner: Owner): Promise<Client> {
  const c = await connectWithToken(w.stack, await w.stack.as.mint({ sub: ID_OF[owner], aud: w.stack.url }));
  clients.push(c);
  await c.listTools();
  return c;
}
type Out = Record<string, any>;
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: r.isError === true, text, out: JSON.parse(text) as Out };
}
const gsc = (site: string, extra: Record<string, unknown> = {}) => ({ propertyId: site, startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query"], limit: 5, ...extra });
const ga4 = (extra: Record<string, unknown> = {}) => ({ propertyId: "100", startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["pagePath"], metrics: ["sessions"], limit: 5, ...extra });
const SHARED = "sc-domain:shared.example";

describe("happy path through every layer (fake Google)", () => {
  it("connects, discovers properties, and answers tool calls with the caller's own data", async () => {
    const a = await as("alice");
    const status = await call(a, "get_connection_status");
    expect(status.out.connections.filter((c: Out) => c.provider === "google")).toHaveLength(1);
    expect((await call(a, "list_gsc_properties")).out.properties.map((p: Out) => p.id).sort()).toEqual(["sc-domain:alice-only.example", SHARED]);
    expect((await call(a, "list_ga4_properties")).out).toMatchObject({ count: 1, properties: [{ id: "100", timezone: "Pacific/Auckland" }] });

    const g = await call(a, "query_gsc_performance", gsc(SHARED));
    expect(g.isError).toBe(false);
    expect(g.out).toMatchObject({ provider: "gsc", mock: false, rowCountReturned: 1, cache: { hit: false } });
    expect(JSON.stringify(g.out.rows)).toContain("alice:query");
    const r = await call(a, "query_ga4_report", ga4());
    expect(r.isError).toBe(false);
    expect(JSON.stringify(r.out.rows)).toContain("alice:/home");
    expect(r.out.report.period.timeZone).toBe("Pacific/Auckland");
  });

  it("every upstream request used a token that belongs to the caller, never the other user's", async () => {
    await call(await as("alice"), "query_gsc_performance", gsc(SHARED));
    await call(await as("bob"), "query_gsc_performance", gsc(SHARED));
    const a = w.google.callsFor("alice", "searchAnalytics");
    const b = w.google.callsFor("bob", "searchAnalytics");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.token).not.toBe(b[0]!.token);
  });
});

describe("User A cannot reach User B's data", () => {
  it("listings and connection status contain only the caller's rows", async () => {
    const bob = await as("bob");
    const status = await call(bob, "get_connection_status");
    expect(status.text).not.toContain(conn.alice);
    expect(status.text).not.toContain("alice");
    expect((await call(bob, "list_gsc_properties")).out.properties.map((p: Out) => p.id)).not.toContain("sc-domain:alice-only.example");
    expect((await call(bob, "list_gsc_properties")).text).not.toContain(conn.alice);
    expect((await call(bob, "list_ga4_properties")).out.properties[0].timezone).toBe("Asia/Kolkata");
  });

  it("querying another user's property fails exactly like an unknown one, and nothing reaches Google", async () => {
    const bob = await as("bob");
    const theirs = await call(bob, "query_gsc_performance", gsc("sc-domain:alice-only.example"));
    const unknown = await call(bob, "query_gsc_performance", gsc("sc-domain:nobody.example"));
    expect(theirs.isError).toBe(true);
    expect(theirs.out.error.code).toBe("PROPERTY_NOT_CONNECTED");
    expect(unknown.out.error.code).toBe(theirs.out.error.code);
    expect(theirs.out.error.message.replace("nobody", "x")).toBe(unknown.out.error.message.replace("nobody", "x").replace("nobody", "x"));
    expect(w.google.calls.filter((c) => c.path.includes("searchAnalytics"))).toHaveLength(0);
  });

  it("internal ids (property or connection UUIDs) are not accepted in place of a provider property id", async () => {
    const bob = await as("bob");
    const [aliceProp] = await w.sql<{ id: string }>(`select id from public.properties where user_id = $1 and external_property_id = 'sc-domain:alice-only.example'`, [ALICE_ID]);
    for (const propertyId of [aliceProp!.id, conn.alice]) {
      const r = await call(bob, "query_gsc_performance", gsc(propertyId));
      expect(r.out.error?.code, propertyId).toMatch(/PROPERTY_NOT_CONNECTED|INVALID_QUERY/);
    }
    expect(w.google.calls).toHaveLength(0);
  });

  it("arguments that try to name a user, connection or token are rejected, even with a real id", async () => {
    const bob = await as("bob");
    for (const extra of [{ userId: ALICE_ID }, { user_id: ALICE_ID }, { connectionId: conn.alice }, { accessToken: "x" }, { authorization: "Bearer x" }]) {
      const r = await call(bob, "query_gsc_performance", gsc(SHARED, extra));
      expect(r.isError, JSON.stringify(extra)).toBe(true);
      expect(r.out.error.code).toBe("INVALID_QUERY");
    }
    expect(w.google.calls).toHaveLength(0);
  });

  it("two customers with the same Search Console site get separate upstream calls, separate answers and separate cache rows", async () => {
    const [alice, bob] = [await as("alice"), await as("bob")];
    const a1 = await call(alice, "query_gsc_performance", gsc(SHARED));
    const b1 = await call(bob, "query_gsc_performance", gsc(SHARED));
    expect(b1.out.cache.hit).toBe(false); // Alice's cached result was not offered to Bob
    expect(JSON.stringify(a1.out.rows)).toContain("alice:query");
    expect(JSON.stringify(b1.out.rows)).toContain("bob:query");
    expect(JSON.stringify(b1.out.rows)).not.toContain("alice");

    const rows = await w.sql<{ user_id: string; payload: unknown }>("select user_id, result_payload::text as payload from public.report_cache order by user_id");
    expect(rows.map((r) => r.user_id).sort()).toEqual([ALICE_ID, BOB_ID]);
    for (const r of rows) {
      const other = r.user_id === ALICE_ID ? "bob" : "alice";
      expect(String(r.payload)).not.toContain(other);
    }
    // Repeats hit each user's own entry and cost no upstream call.
    const before = w.google.calls.length;
    expect((await call(alice, "query_gsc_performance", gsc(SHARED))).out.cache.hit).toBe(true);
    expect((await call(bob, "query_gsc_performance", gsc(SHARED))).out.cache.hit).toBe(true);
    expect(w.google.calls.length).toBe(before);
  });

  it("the same GA4 property id under two accounts is reported in each account's own time zone", async () => {
    const a = await call(await as("alice"), "query_ga4_report", ga4({ lastDays: 7, startDate: undefined, endDate: undefined }));
    const b = await call(await as("bob"), "query_ga4_report", ga4({ lastDays: 7, startDate: undefined, endDate: undefined }));
    expect(a.out.report.period.timeZone).toBe("Pacific/Auckland");
    expect(b.out.report.period.timeZone).toBe("Asia/Kolkata");
    expect(JSON.stringify(b.out.rows)).not.toContain("alice");
    expect(b.out.cache.hit).toBe(false);
  });

  it("stored credentials are encrypted, per connection, and never readable through another user's identity", async () => {
    const secrets = await w.sql<{ connection_id: string; dump: string }>("select connection_id, to_json(s)::text as dump from public.provider_secrets s");
    expect(secrets.map((s) => s.connection_id).sort()).toEqual([conn.alice, conn.bob].sort());
    for (const s of secrets) expect(s.dump).not.toMatch(/mock-(access|refresh)-token/);
    // The service refuses to hand out one user's token for another's connection.
    await expect(w.credentials.getAccessToken(BOB_ID, conn.alice)).rejects.toMatchObject({ code: expect.stringMatching(/PROPERTY_NOT_CONNECTED|AUTH_REQUIRED|FORBIDDEN/) });
    expect(await w.repo.getConnection(BOB_ID, conn.alice)).toBeNull();
    expect((await w.repo.listConnections(BOB_ID)).map((c) => c.id)).toEqual([conn.bob]);
    expect(await w.repo.findEnabledProperty(BOB_ID, "gsc", "sc-domain:alice-only.example")).toBeNull();
  });

  it("Row Level Security: a signed-in user sees only their own rows in every table, and never the secrets", async () => {
    await call(await as("alice"), "query_gsc_performance", gsc(SHARED));
    await call(await as("bob"), "query_gsc_performance", gsc(SHARED));
    await asRole(w.db, BOB_ID, async (q) => {
      expect((await q("select user_id from public.provider_connections")).every((r) => r.user_id === BOB_ID)).toBe(true);
      expect((await q("select user_id from public.properties")).every((r) => r.user_id === BOB_ID)).toBe(true);
      await expect(q("select * from public.provider_secrets")).rejects.toThrow();
    });
    await asRole(w.db, BOB_ID, async (q) => {
      await expect(q("select * from public.report_cache")).rejects.toThrow();
    });
  });

  it("another user cannot disconnect, and the owner's data keeps working", async () => {
    const attempt = await w.credentials.disconnect(BOB_ID, conn.alice).catch((e) => e);
    expect(attempt instanceof Error || (attempt as { disconnected: boolean }).disconnected === false).toBe(true);
    expect(await w.repo.getConnection(ALICE_ID, conn.alice)).not.toBeNull();
    expect((await call(await as("alice"), "query_gsc_performance", gsc(SHARED))).isError).toBe(false);
  });

  it("logs and error text never contain access or refresh tokens", async () => {
    await call(await as("alice"), "query_gsc_performance", gsc(SHARED));
    w.google.fail = { path: "searchAnalytics", status: 500 };
    const r = await call(await as("alice"), "query_gsc_performance", gsc(SHARED, { limit: 4 }));
    expect(r.isError).toBe(true);
    for (const text of [r.text, ...w.logs, ...w.stack.logs]) expect(text).not.toMatch(/mock-(access|refresh)-token|upstream said secret/);
  });
});

describe("expired and revoked credentials, missing permissions, API failures", () => {
  it("refreshes an expired access token transparently and keeps the user signed in to Google", async () => {
    const a = await as("alice");
    await call(a, "query_gsc_performance", gsc(SHARED));
    const firstToken = w.google.callsFor("alice", "searchAnalytics")[0]!.token;
    w.time.now += 2 * 3600_000;
    const r = await call(a, "query_gsc_performance", gsc(SHARED, { limit: 4 }));
    expect(r.isError).toBe(false);
    expect(w.google.callsFor("alice", "searchAnalytics").at(-1)!.token).not.toBe(firstToken);
  });

  it("Google token rejected (401): safe error, connection flagged, nothing leaks, other user unaffected", async () => {
    const [a, b] = [await as("alice"), await as("bob")];
    const token = [...w.google.tokens].filter(([, o]) => o === "alice").map(([t]) => t).at(-1)!;
    w.google.revoked.add(token);
    const r = await call(a, "query_gsc_performance", gsc(SHARED, { limit: 3 }));
    expect(r.out.error.code).toMatch(/AUTH_EXPIRED|AUTH_REVOKED/);
    expect(r.text).not.toContain(token);
    const status = await call(a, "get_connection_status");
    expect(status.out.connections.find((c: Out) => c.provider === "google").status).toBe("needs_attention");
    expect((await call(b, "get_connection_status")).out.connections.find((c: Out) => c.provider === "google").status).toBe("connected");
    expect((await call(b, "query_gsc_performance", gsc(SHARED, { limit: 3 }))).isError).toBe(false);
    w.google.revoked.clear();
    await w.sql("update public.provider_connections set status = 'connected', last_error_code = null where id = $1", [conn.alice]);
  });

  it("refresh token revoked by the user at Google: clear reconnect guidance, no upstream data call", async () => {
    const a = await as("alice");
    w.time.now += 12 * 3600_000; // past every access token issued so far, including ones refreshed by earlier tests
    w.oauthClient.failRefreshWith = "invalid_grant";
    const r = await call(a, "query_gsc_performance", gsc(SHARED, { limit: 2 }));
    w.oauthClient.failRefreshWith = null;
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toMatch(/AUTH_REVOKED|AUTH_EXPIRED/);
    expect(r.out.error.suggestedAction).toMatch(/connect/i);
    expect(w.google.callsFor("alice", "searchAnalytics")).toHaveLength(0);
    expect((await call(a, "get_connection_status")).out.connections.find((c: Out) => c.provider === "google").status).toMatch(/needs_attention|revoked/);
    await w.sql("update public.provider_connections set status = 'connected', last_error_code = null where id = $1", [conn.alice]);
  });

  it.each([
    [403, { error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } }, "FORBIDDEN"],
    [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }] } }, "PROVIDER_RATE_LIMITED"],
  ])("Google %i is reported as %s without raw upstream text", async (status, body, code) => {
    w.google.fail = { path: "searchAnalytics", status, body, headers: status === 429 ? { "retry-after": "120" } : {} };
    const r = await call(await as("alice"), "query_gsc_performance", gsc(SHARED, { limit: 1 }));
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toBe(code);
    expect(r.text).not.toMatch(/PERMISSION_DENIED|RESOURCE_EXHAUSTED|rateLimitExceeded/);
    // Auth and quota failures are not retried: retrying cannot help and spends quota.
    expect(w.google.callsFor("alice", "searchAnalytics")).toHaveLength(1);
  });

  it("a Google outage is retried a bounded number of times, then reported as retryable", async () => {
    w.google.fail = { path: "searchAnalytics", status: 503 };
    const r = await call(await as("alice"), "query_gsc_performance", gsc(SHARED, { limit: 1 }));
    expect(r.out.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(r.out.error.retryable).toBe(true);
    const attempts = w.google.callsFor("alice", "searchAnalytics").length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it("a transient failure that clears is invisible to the user", async () => {
    w.google.fail = { path: "searchAnalytics", status: 503, times: 1 };
    const r = await call(await as("alice"), "query_gsc_performance", gsc(SHARED, { limit: 1 }));
    expect(r.isError).toBe(false);
  });

  it("a malformed Google response is refused rather than shown", async () => {
    w.google.fail = { path: "searchAnalytics", status: 200, body: { rows: [{ keys: ["only-one", "extra"], clicks: 1 }] } };
    const r = await call(await as("alice"), "query_gsc_performance", gsc(SHARED, { limit: 1 }));
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("only-one");
  });

  it("GA4: no access to the property is reported without detail, and is not cached", async () => {
    w.google.fail = { path: ":runReport", status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED" } } };
    const a = await as("alice");
    const r = await call(a, "query_ga4_report", ga4());
    expect(r.isError).toBe(true);
    w.google.fail = null;
    expect((await call(a, "query_ga4_report", ga4())).out.cache.hit).toBe(false); // the failure was not cached as a result
  });

  it("serves the last good report with a warning when Google is down, for the same user only", async () => {
    const [a, b] = [await as("alice"), await as("bob")];
    await call(a, "query_gsc_performance", gsc(SHARED));
    await w.sql("update public.report_cache set expires_at = now() - interval '5 minutes'");
    w.google.fail = { path: "searchAnalytics", status: 503 };
    const stale = await call(a, "query_gsc_performance", gsc(SHARED));
    expect(stale.isError).toBe(false);
    expect(stale.out.cache).toMatchObject({ hit: true, stale: true });
    expect(JSON.stringify(stale.out.warnings)).toMatch(/older|stale|unavailable|saved/i);
    // Bob has no saved report of his own, so he gets the error, not Alice's data.
    const other = await call(b, "query_gsc_performance", gsc(SHARED));
    expect(other.isError).toBe(true);
    expect(other.text).not.toContain("alice");
  });
});

describe("invalid inputs", () => {
  it.each([
    ["missing property", { startDate: "2026-09-01", endDate: "2026-09-02" }],
    ["impossible date", gsc(SHARED, { startDate: "2026-02-31", endDate: "2026-03-02" })],
    ["end before start", gsc(SHARED, { startDate: "2026-09-10", endDate: "2026-09-01" })],
    ["future end date", gsc(SHARED, { startDate: "2026-10-01", endDate: "2027-01-01" })],
    ["limit too large", gsc(SHARED, { limit: 1_000_000 })],
    ["negative limit", gsc(SHARED, { limit: -1 })],
    ["unknown dimension", gsc(SHARED, { dimensions: ["nope"] })],
    ["property not a string", { ...gsc(SHARED), propertyId: 123 }],
    ["injection-looking property", gsc("sc-domain:x.example'; drop table public.report_cache;--")],
    ["oversized property id", gsc("a".repeat(5000))],
  ])("rejects %s before any Google call", async (_name, args) => {
    const before = w.google.calls.length;
    const r = await call(await as("alice"), "query_gsc_performance", args as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/at .*\.(ts|js):\d+|SELECT|syntax error/i);
    expect(w.google.calls.length).toBe(before);
    expect(await w.sql("select 1 from information_schema.tables where table_name = 'report_cache'")).toHaveLength(1);
  });

  it("GA4 rejects unknown metrics and non-numeric property ids", async () => {
    const a = await as("alice");
    expect((await call(a, "query_ga4_report", ga4({ metrics: ["bogus"] }))).isError).toBe(true);
    expect((await call(a, "query_ga4_report", ga4({ propertyId: "../../admin" }))).isError).toBe(true);
  });
});

describe("disconnecting", () => {
  it("removes the connection, properties, encrypted secret and cached reports for that user only", async () => {
    const w2 = await buildWorld();
    try {
      const ca = await w2.connect("alice");
      const cb = await w2.connect("bob");
      const mint = async (o: Owner) => connectWithToken(w2.stack, await w2.stack.as.mint({ sub: ID_OF[o], aud: w2.stack.url }));
      const [a, b] = [await mint("alice"), await mint("bob")];
      clients.push(a, b);
      await call(a, "query_gsc_performance", gsc(SHARED));
      await call(b, "query_gsc_performance", gsc(SHARED));
      expect(await w2.sql("select 1 from public.report_cache")).toHaveLength(2);

      expect((await w2.credentials.disconnect(ALICE_ID, ca)).disconnected).toBe(true);
      expect(await w2.sql("select 1 from public.provider_secrets where connection_id = $1", [ca])).toHaveLength(0);
      expect(await w2.sql("select 1 from public.properties where user_id = $1", [ALICE_ID])).toHaveLength(0);
      expect((await w2.sql<{ user_id: string }>("select user_id from public.report_cache")).map((r) => r.user_id)).toEqual([BOB_ID]);
      expect(w2.oauthClient.revokeCalls.length).toBeGreaterThan(0);

      const after = await call(a, "query_gsc_performance", gsc(SHARED));
      expect(after.out.error.code).toBe("PROPERTY_NOT_CONNECTED");
      expect((await call(b, "query_gsc_performance", gsc(SHARED))).out.cache.hit).toBe(true);
      expect(await w2.sql("select 1 from public.provider_secrets where connection_id = $1", [cb])).toHaveLength(1);
    } finally {
      await w2.close();
    }
  });
});
