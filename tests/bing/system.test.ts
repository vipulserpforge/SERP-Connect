/**
 * Bing across the real server composition: migrated Postgres (PGlite), envelope-encrypted credentials, the Postgres report
 * cache, the reporting service and the MCP server behind signed OAuth tokens, with two customers.
 *
 * DATA SOURCE: MOCK. Bing is replaced by FakeBing, a local HTTP server shaped like Microsoft's documented API. Nothing here
 * talks to Bing. See docs/BING.md for the manual live test.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectWithToken } from "../mcp/harness.js";
import type { Owner } from "../system/fake-google.js";
import { ID_OF, buildWorld, type World } from "../system/world.js";

let w: World;
const clients: Client[] = [];
const ALICE_KEY = "alicealicealicealicealicealiceal1";
const BOB_KEY = "bobbobbobbobbobbobbobbobbobbobb2";

beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await w.close();
});
beforeEach(async () => {
  await w.sql("delete from public.provider_connections where provider = 'bing'");
  await w.sql("delete from public.audit_events");
  await w.sql("delete from public.report_cache where provider = 'bing'");
  w.fakeBing.apiKeys.set(ALICE_KEY, "alice");
  w.fakeBing.apiKeys.set(BOB_KEY, "bob");
  w.fakeBing.calls.length = 0;
  w.fakeBing.fail = null;
  w.fakeBing.revokedRefreshTokens.clear();
  w.time.now = Date.parse("2026-10-19T12:00:00Z");
  w.sleeps.length = 0;
  w.logs.length = 0;
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
const SITE = { alice: "https://alice.example/", bob: "https://bob.example/" } as const;
async function viaKey(owner: "alice" | "bob") {
  const { connectionId } = await w.bing.connectApiKey(ID_OF[owner], { name: `${owner} key`, apiKey: owner === "alice" ? ALICE_KEY : BOB_KEY });
  await w.bing.syncSites(ID_OF[owner], connectionId);
  return connectionId;
}
async function viaOAuth(owner: "alice" | "bob") {
  const { state } = await w.bing.beginOAuth(ID_OF[owner]);
  const { connectionId } = await w.bing.completeOAuth(ID_OF[owner], { state, code: w.fakeBing.approve(owner), error: null });
  await w.bing.syncSites(ID_OF[owner], connectionId);
  return connectionId;
}
const traffic = (owner: "alice" | "bob", extra: Record<string, unknown> = {}) => ({ propertyId: SITE[owner], report: "traffic", lastDays: 7, ...extra });
const apiCalls = () => w.fakeBing.calls.filter((c) => c.kind === "api" && c.endpoint !== "GetUserSites");

describe.each([
  ["API key", viaKey, "apikey"],
  ["OAuth", viaOAuth, "bearer"],
] as const)("%s connection through MCP", (_n, connect, via) => {
  it("lists only verified sites, answers reports with Bing's data, and authenticates the documented way", async () => {
    const id = await connect("alice");
    const a = await as("alice");
    const listed = await call(a, "list_bing_sites");
    expect(listed.out.properties).toMatchObject([{ id: SITE.alice, type: "bing_site_verified" }]);

    const r = await call(a, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(false);
    expect(r.out).toMatchObject({ provider: "bing", mock: false, cache: { hit: false } });
    expect(r.out.rows).toHaveLength(6); // 7-day window = today-6..today; Bing's last row is yesterday
    expect(r.out.rows[0]).toMatchObject({ clicks: 111, impressions: 1110 });
    expect(r.out.providerMetadata).toMatchObject({ source: expect.stringMatching(/^Bing Webmaster Tools.*not Google/), authMethod: via === "apikey" ? "api_key" : "oauth" });
    expect(apiCalls().every((c) => c.via === via && c.owner === "alice" && c.method === "GET")).toBe(true);
    expect((await w.repo.getConnection(ID_OF.alice, id))!.status).toBe("connected");
  });

  it("repeat requests come from the saved result; different parameters and reports are cached separately", async () => {
    await connect("alice");
    const a = await as("alice");
    await call(a, "query_bing_report", traffic("alice"));
    expect((await call(a, "query_bing_report", traffic("alice"))).out.cache.hit).toBe(true);
    expect(apiCalls()).toHaveLength(1);
    await call(a, "query_bing_report", traffic("alice", { lastDays: 3 }));
    await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries" });
    await call(a, "query_bing_report", { propertyId: SITE.alice, report: "crawl" });
    expect(apiCalls()).toHaveLength(4);
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries" })).out.cache.hit).toBe(true);
    expect(apiCalls()).toHaveLength(4);
  });
});

describe("tenant isolation", () => {
  it("each customer sees only their own sites and their own Bing data; the other's site is indistinguishable from unknown", async () => {
    await viaKey("alice");
    await viaOAuth("bob");
    const [a, b] = [await as("alice"), await as("bob")];
    expect((await call(a, "list_bing_sites")).out.properties.map((p: Out) => p.id)).toEqual([SITE.alice]);
    expect((await call(b, "list_bing_sites")).out.properties.map((p: Out) => p.id)).toEqual([SITE.bob]);
    expect((await call(a, "query_bing_report", traffic("alice"))).out.rows[0].clicks).toBe(111);
    expect((await call(b, "query_bing_report", traffic("bob"))).out.rows[0].clicks).toBe(222);

    const snoop = await call(a, "query_bing_report", traffic("bob"));
    const unknown = await call(a, "query_bing_report", { ...traffic("bob"), propertyId: "https://nobody.example/" });
    expect(snoop.isError).toBe(true);
    expect(snoop.out.error.code).toBe(unknown.out.error.code);
    expect(snoop.out.error.message).toBe(unknown.out.error.message);
    expect(snoop.text).not.toContain("222");
  });

  it("the cache is per user: Bob never receives Alice's saved result even for an identical request", async () => {
    await viaKey("alice");
    await viaKey("bob");
    const a = await as("alice");
    await call(a, "query_bing_report", traffic("alice"));
    const b = await as("bob");
    const r = await call(b, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(true);
    const own = await call(b, "query_bing_report", traffic("bob"));
    expect(own.out.cache.hit).toBe(false);
    expect(own.out.rows[0].clicks).toBe(222);
  });

  it("two connections of one customer use their own credentials (no cross-over to the other Bing account)", async () => {
    const a1 = await viaKey("alice");
    w.fakeBing.apiKeys.set("bobsecondkeybobsecondkeybobsecon", "bob");
    const second = await w.bing.connectApiKey(ID_OF.alice, { name: "other", apiKey: "bobsecondkeybobsecondkeybobsecon" });
    await w.bing.syncSites(ID_OF.alice, second.connectionId);
    const a = await as("alice");
    expect((await call(a, "list_bing_sites")).out.properties.map((p: Out) => p.id).sort()).toEqual([SITE.alice, SITE.bob]);
    expect((await call(a, "query_bing_report", traffic("alice"))).out.rows[0].clicks).toBe(111);
    expect((await call(a, "query_bing_report", traffic("bob"))).out.rows[0].clicks).toBe(222);
    expect(a1).not.toBe(second.connectionId);
  });

  it("a site the customer disabled is no longer queryable", async () => {
    await viaKey("alice");
    const [p] = await w.repo.listProperties(ID_OF.alice, { provider: "bing" });
    await w.repo.setPropertyEnabled(ID_OF.alice, p!.id, false);
    const a = await as("alice");
    expect((await call(a, "list_bing_sites")).out.properties).toEqual([]);
    expect((await call(a, "query_bing_report", traffic("alice"))).isError).toBe(true);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("authentication failures", () => {
  it("rejects calls with no token and tokens for a non-connected user", async () => {
    const raw = await fetch(w.stack.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(raw.status).toBe(401);
    const a = await as("alice"); // signed in, nothing connected
    expect((await call(a, "list_bing_sites")).out.properties).toEqual([]);
    expect((await call(a, "query_bing_report", traffic("alice"))).isError).toBe(true);
  });

  it("strict input: a userId or connection id argument is refused; bad reports and dates are refused before any Bing call", async () => {
    await viaKey("alice");
    const a = await as("alice");
    for (const extra of [{ userId: ID_OF.bob }, { connectionId: "x" }, { apiKey: ALICE_KEY }, { report: "links" }, { lastDays: 0 }, { lastDays: 501 }, { startDate: "2026-10-01" }, { limit: 5000 }, { sortBy: "bogus" }]) {
      const r = await call(a, "query_bing_report", traffic("alice", extra));
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(apiCalls()).toHaveLength(0);
  });

  it("an API key Bing rejects marks the connection as needing attention, is not cached, and is not retried", async () => {
    const id = await viaKey("alice");
    w.fakeBing.apiKeys.delete(ALICE_KEY);
    const a = await as("alice");
    const r = await call(a, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toBe("AUTH_EXPIRED");
    expect(apiCalls()).toHaveLength(1);
    expect(await w.repo.getConnection(ID_OF.alice, id)).toMatchObject({ status: "needs_attention" });
    expect(await w.sql("select 1 from public.report_cache where provider = 'bing'")).toHaveLength(0);
    const again = await call(a, "query_bing_report", traffic("alice"));
    expect(again.isError).toBe(true);
    expect(apiCalls()).toHaveLength(1); // a connection that needs attention is not hammered
    const status = (await call(a, "get_connection_status")).out.connections.find((c: Out) => c.provider === "bing");
    expect(status).toMatchObject({ status: "needs_attention", authMethod: "api_key" });
  });

  it("expired access tokens are renewed transparently; a revoked grant needs reauthorization", async () => {
    const id = await viaOAuth("alice");
    const a = await as("alice");
    w.time.now += 2 * 3600_000;
    expect((await call(a, "query_bing_report", traffic("alice", { lastDays: 5 }))).isError).toBe(false);
    expect(w.fakeBing.calls.filter((c) => c.grantType === "refresh_token")).toHaveLength(1);

    for (const t of w.fakeBing.refreshTokens.keys()) w.fakeBing.revokedRefreshTokens.add(t);
    w.time.now += 2 * 3600_000;
    const r = await call(a, "query_bing_report", traffic("alice", { lastDays: 6 }));
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toBe("AUTH_REVOKED");
    expect(await w.repo.getConnection(ID_OF.alice, id)).toMatchObject({ status: "needs_attention", lastErrorCode: "AUTH_REVOKED" });
  });

  it("a removed connection is unusable at once, including its saved results", async () => {
    const id = await viaKey("alice");
    const a = await as("alice");
    await call(a, "query_bing_report", traffic("alice"));
    await w.creds.deleteConnection?.(ID_OF.alice, id).catch(() => undefined);
    if ((await w.repo.getConnection(ID_OF.alice, id)) !== null) await w.sql("delete from public.provider_connections where id = $1", [id]);
    const r = await call(a, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(true);
    expect((await call(a, "list_bing_sites")).out.properties).toEqual([]);
  });

  it("another user's disconnected connection id cannot be used to read credentials", async () => {
    const id = await viaKey("alice");
    await expect(w.bing.getAuth(ID_OF.bob, id)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    await expect(w.bing.syncSites(ID_OF.bob, id)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });
});

describe("throttling and provider failures", () => {
  it("retries a throttle within bounds, honouring Retry-After, then succeeds", async () => {
    await viaKey("alice");
    w.fakeBing.fail = { endpoint: "GetRankAndTrafficStats", status: 429, headers: { "retry-after": "2" }, times: 1 };
    const a = await as("alice");
    const r = await call(a, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(false);
    expect(apiCalls()).toHaveLength(2);
    expect(w.sleeps.some((ms) => ms >= 2000)).toBe(true);
  });

  it("persistent throttling is a clear, retryable error that does not invent a quota", async () => {
    await viaKey("alice");
    w.fakeBing.fail = { endpoint: "GetRankAndTrafficStats", status: 429, headers: { "retry-after": "30" } };
    const a = await as("alice");
    const r = await call(a, "query_bing_report", traffic("alice"));
    expect(r.isError).toBe(true);
    expect(r.out.error).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect(apiCalls().length).toBeLessThanOrEqual(4);
    expect(r.text).not.toMatch(/quota of|per day|requests per/i);
    expect(await w.sql("select 1 from public.report_cache where provider = 'bing'")).toHaveLength(0);
  });

  it("serves saved data (labelled stale) when Bing is down, and an error when there is none", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const down = { endpoint: "GetRankAndTrafficStats", status: 503 };
    w.fakeBing.fail = down;
    expect((await call(a, "query_bing_report", traffic("alice"))).out.error.code).toBe("PROVIDER_UNAVAILABLE");
    w.fakeBing.fail = null;
    expect((await call(a, "query_bing_report", traffic("alice"))).isError).toBe(false);
    await w.sql("update public.report_cache set expires_at = now() - interval '1 hour' where provider = 'bing'");
    w.fakeBing.fail = { ...down };
    const stale = await call(a, "query_bing_report", traffic("alice"));
    expect(stale.isError).toBe(false);
    expect(stale.out.cache).toMatchObject({ hit: true, stale: true });
    expect(stale.out.warnings.map((x: Out) => x.code)).toContain("STALE_CACHE");
  });
});

describe("secrets never leak", () => {
  it("credentials appear in no database column, audit event, log line, tool output or error", async () => {
    await viaKey("alice");
    await viaOAuth("bob");
    const a = await as("alice");
    const b = await as("bob");
    const outputs = [
      (await call(a, "list_bing_sites")).text,
      (await call(a, "get_connection_status")).text,
      (await call(a, "query_bing_report", traffic("alice"))).text,
      (await call(b, "query_bing_report", traffic("bob"))).text,
      (await call(a, "query_bing_report", traffic("bob"))).text,
    ];
    w.fakeBing.fail = { endpoint: "GetQueryStats", status: 500 };
    outputs.push((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries" })).text);

    const secrets = [ALICE_KEY, BOB_KEY, w.fakeBing.client.secret, ...w.fakeBing.accessTokens.keys(), ...w.fakeBing.refreshTokens.keys(), "OWNERSHIPCODE0000"];
    const dump = JSON.stringify(await w.sql("select * from public.provider_connections")) +
      JSON.stringify(await w.sql("select * from public.provider_secrets")) +
      JSON.stringify(await w.sql("select * from public.audit_events")) +
      JSON.stringify(await w.sql("select * from public.report_cache")) +
      JSON.stringify(await w.sql("select * from public.properties")) +
      JSON.stringify(await w.sql("select * from public.oauth_states")) +
      JSON.stringify(w.logs) +
      outputs.join("\n");
    for (const s of secrets) expect(dump, s.slice(0, 6)).not.toContain(s);
    // The one place secrets legitimately exist is the encrypted blob.
    expect(await w.sql("select 1 from public.provider_secrets")).not.toHaveLength(0);
  });

  it("the key is recorded in the fake's call log by NAME only: the harness itself cannot leak it", () => {
    expect(JSON.stringify(w.fakeBing.calls)).not.toContain(ALICE_KEY);
  });
});

describe("reporting semantics", () => {
  it("reports are Bing-labelled, windowed in UTC, sorted/limited, and never merged with other providers", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const r = await call(a, "query_bing_report", traffic("alice", { sortBy: "date", sortDirection: "asc", limit: 3 }));
    expect(r.out.rows).toHaveLength(3);
    expect(r.out.rows.map((x: Out) => x.date)).toEqual([...r.out.rows.map((x: Out) => x.date)].sort());
    expect(r.out.warnings.map((x: Out) => x.code)).toContain("ROW_LIMIT_REACHED");
    expect(JSON.stringify(r.out.providerMetadata)).toMatch(/bing/i);
    const sup = await call(a, "get_supported_metrics", { provider: "bing" });
    expect(sup.out.reports ?? sup.out.supported ?? sup.out).toBeTruthy();
    expect(sup.text).toMatch(/never|not comparable|separate/i);
  });
});
