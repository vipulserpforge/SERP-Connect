/**
 * Clarity across the real server composition: migrated Postgres (PGlite), envelope-encrypted tokens, the durable request
 * budget, the Postgres report cache, the reporting service and the MCP server behind signed OAuth tokens, with two customers.
 *
 * DATA SOURCE: MOCK. Clarity itself is replaced by FakeClarityClient (responses shaped like Microsoft's documented
 * sample). Nothing here talks to clarity.ms or spends real quota. See docs/CLARITY.md for the manual live test.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClarityApiError } from "@serp/provider-clarity";
import { connectWithToken } from "../mcp/harness.js";
import type { Owner } from "../system/fake-google.js";
import { ID_OF, buildWorld, type World } from "../system/world.js";
import { SAMPLE_BODY, fakeToken } from "./fake-clarity.js";

let w: World;
const clients: Client[] = [];

beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await w.close();
});
beforeEach(async () => {
  await w.sql("delete from public.provider_connections where provider = 'clarity'");
  await w.sql("delete from public.provider_request_reservations");
  await w.sql("delete from public.provider_request_budgets");
  await w.sql("delete from public.audit_events");
  w.fakeClarity.calls.length = 0;
  w.fakeClarity.default = SAMPLE_BODY;
  w.fakeClarity.delayMs = 0;
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
async function save(owner: Owner, token: string, name = "Shop site") {
  const { connectionId } = await w.clarity.connect(ID_OF[owner], { name, token });
  const [p] = await w.repo.listProperties(ID_OF[owner], { provider: "clarity", connectionId });
  return { connectionId, propertyId: p!.externalPropertyId, token };
}
const insights = (propertyId: string, extra: Record<string, unknown> = {}) => ({ propertyId, numOfDays: 1, dimensions: ["OS"], ...extra });
const statusOf = async (owner: Owner, connectionId: string) => (await w.repo.getConnection(ID_OF[owner], connectionId))!;

describe("saving and first use (fake Clarity)", () => {
  it("a saved token is awaiting verification, spends no quota, and is verified by its first real request", async () => {
    const { connectionId, propertyId, token } = await save("alice", fakeToken("alice"));
    expect(w.fakeClarity.calls).toHaveLength(0);
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "pending", lastValidatedAt: null });
    expect((await w.clarityQuota.status(propertyId, new Date())).appTrackedUsed).toBe(0);

    const a = await as("alice");
    const listed = await call(a, "list_clarity_projects");
    expect(listed.out.properties).toMatchObject([{ id: propertyId, name: "Shop site", type: "clarity_project", timezone: "UTC" }]);
    expect(w.fakeClarity.calls).toHaveLength(0);

    const r = await call(a, "get_clarity_insights", insights(propertyId));
    expect(r.isError).toBe(false);
    expect(r.out).toMatchObject({ provider: "clarity", mock: false, cache: { hit: false }, report: { dimensions: ["OS"], period: { timeZone: "UTC" } } });
    expect(r.out.rows[0]).toMatchObject({ metricName: "Traffic", totalSessionCount: 9554, OS: "Other" });
    expect(w.fakeClarity.calls).toEqual([{ token, request: { numOfDays: 1, dimensions: ["OS"] } }]);
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "connected", lastErrorCode: null });
    expect((await statusOf("alice", connectionId)).lastValidatedAt).toBeTruthy();
  });

  it("answers the repeat from the saved result without another provider call, and keeps different shapes separate", async () => {
    const { propertyId } = await save("alice", fakeToken("cache"));
    const a = await as("alice");
    expect((await call(a, "get_clarity_insights", insights(propertyId))).out.cache.hit).toBe(false);
    const again = await call(a, "get_clarity_insights", insights(propertyId));
    expect(again.out.cache).toMatchObject({ hit: true });
    expect(w.fakeClarity.calls).toHaveLength(1);

    await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Device"] }));
    await call(a, "get_clarity_insights", insights(propertyId, { numOfDays: 2 }));
    expect(w.fakeClarity.calls).toHaveLength(3);
    const q = (await call(a, "get_clarity_quota_status", { propertyId })).out;
    expect(q.quota).toMatchObject({ appTrackedUsed: 3, localBudget: 8, localRemaining: 5, providerDailyLimit: 10, counts: { succeeded: 3 } });
    expect(q.quota.lastSuccessAt).toBeTruthy();
    expect(q.notes.join(" ")).toMatch(/not .*authoritative|counted by this application/i);
  });

  it("identical concurrent requests share one provider call", async () => {
    const { propertyId } = await save("alice", fakeToken("flight"));
    w.fakeClarity.delayMs = 60;
    const a = await as("alice");
    const results = await Promise.all(Array.from({ length: 3 }, () => call(a, "get_clarity_insights", insights(propertyId))));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(w.fakeClarity.calls).toHaveLength(1);
    expect((await w.clarityQuota.status(propertyId, new Date())).appTrackedUsed).toBe(1);
  });

  it("concurrent DIFFERENT requests can never push the project past the local budget", async () => {
    const { propertyId } = await save("alice", fakeToken("burst"));
    w.fakeClarity.delayMs = 10;
    const a = await as("alice");
    const dims = ["Browser", "Device", "OS", "Source", "Medium", "Campaign", "Channel", "URL", "Country/Region"];
    const results = await Promise.all(dims.flatMap((d) => [1, 2].map((n) => call(a, "get_clarity_insights", insights(propertyId, { dimensions: [d], numOfDays: n })))));
    expect(w.fakeClarity.calls.length).toBeLessThanOrEqual(8);
    expect(results.filter((r) => !r.isError)).toHaveLength(w.fakeClarity.calls.length);
    expect(results.filter((r) => r.isError).every((r) => r.out.error.code === "CLARITY_DAILY_BUDGET_EXHAUSTED" || r.out.error.code === "RATE_LIMITED")).toBe(true);
  });
});

describe("budget and stale data", () => {
  it("stops at the local budget without calling Clarity, still serves saved results, and serves stale data labelled as such", async () => {
    const { propertyId } = await save("alice", fakeToken("budget"));
    const a = await as("alice");
    const days = [1, 2, 3] as const;
    const dims = [["Browser"], ["Device"], ["OS"]];
    for (const [i, d] of dims.entries()) for (const n of days) {
      if (i * 3 + (n - 1) < 8) expect((await call(a, "get_clarity_insights", insights(propertyId, { dimensions: d, numOfDays: n }))).isError).toBe(false);
    }
    expect(w.fakeClarity.calls).toHaveLength(8);

    const blocked = await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["OS"], numOfDays: 3 }));
    expect(blocked.isError).toBe(true);
    expect(blocked.out.error).toMatchObject({ code: "CLARITY_DAILY_BUDGET_EXHAUSTED", retryable: false });
    expect(w.fakeClarity.calls).toHaveLength(8);

    expect((await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Browser"], numOfDays: 1 }))).out.cache.hit).toBe(true);

    await w.sql("update public.report_cache set expires_at = now() - interval '1 hour' where provider = 'clarity'");
    const stale = await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Browser"], numOfDays: 1 }));
    expect(stale.isError).toBe(false);
    expect(stale.out.cache).toMatchObject({ hit: true, stale: true });
    expect(stale.out.warnings.map((x: Out) => x.code)).toContain("STALE_CACHE");
    expect(w.fakeClarity.calls).toHaveLength(8);
  });

  it("a different day gets a fresh budget window", async () => {
    const { propertyId } = await save("alice", fakeToken("window"));
    for (let i = 0; i < 8; i++) await w.clarityQuota.reserve({ projectKey: propertyId, userId: ID_OF.alice, connectionId: null, now: new Date("2026-10-19T09:00:00Z") });
    expect((await w.clarityQuota.reserve({ projectKey: propertyId, userId: ID_OF.alice, connectionId: null, now: new Date("2026-10-19T23:59:00Z") })).allowed).toBe(false);
    expect((await w.clarityQuota.reserve({ projectKey: propertyId, userId: ID_OF.alice, connectionId: null, now: new Date("2026-10-20T00:00:30Z") })).allowed).toBe(true);
  });
});

describe("provider failures", () => {
  it("401 marks the connection as needing attention, tells the user to reconnect, and is never retried", async () => {
    const { connectionId, propertyId, token } = await save("alice", fakeToken("expired"));
    w.fakeClarity.when(token, new ClarityApiError("unauthorized", 401));
    const a = await as("alice");
    const r = await call(a, "get_clarity_insights", insights(propertyId));
    expect(r.out.error).toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    expect(r.out.error.suggestedAction).toMatch(/reconnect/i);
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "needs_attention", lastErrorCode: "AUTH_EXPIRED" });

    const again = await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Device"] }));
    expect(again.out.error.code).toBe("AUTH_EXPIRED");
    expect(w.fakeClarity.calls).toHaveLength(1);

    w.fakeClarity.when(token, SAMPLE_BODY);
    await w.clarity.reconnect(ID_OF.alice, connectionId, { token });
    expect((await call(a, "get_clarity_insights", insights(propertyId))).isError).toBe(false);
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "connected" });
  });

  it("403 is reported as missing permission", async () => {
    const { connectionId, propertyId, token } = await save("alice", fakeToken("forbidden"));
    w.fakeClarity.when(token, new ClarityApiError("forbidden", 403));
    const r = await call(await as("alice"), "get_clarity_insights", insights(propertyId));
    expect(r.out.error).toMatchObject({ code: "FORBIDDEN" });
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "needs_attention", lastErrorCode: "FORBIDDEN" });
  });

  it("429 stops further calls for the window, keeps the token valid, and is not retried", async () => {
    const { connectionId, propertyId, token } = await save("alice", fakeToken("limited"));
    w.fakeClarity.when(token, new ClarityApiError("quota", 429));
    const a = await as("alice");
    const r = await call(a, "get_clarity_insights", insights(propertyId));
    expect(r.out.error).toMatchObject({ code: "CLARITY_DAILY_BUDGET_EXHAUSTED", retryable: false });
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "pending", lastErrorCode: "PROVIDER_RATE_LIMITED" });
    const q = (await call(a, "get_clarity_quota_status", { propertyId })).out.quota;
    expect(q).toMatchObject({ providerLimitReported: true, localRemaining: 0, counts: { providerLimited: 1 } });

    w.fakeClarity.when(token, SAMPLE_BODY);
    const next = await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Device"] }));
    expect(next.out.error.code).toBe("CLARITY_DAILY_BUDGET_EXHAUSTED");
    expect(w.fakeClarity.calls).toHaveLength(1);
  });

  it("a server error is retryable by the user but is not retried automatically, is not cached, and still counts as used", async () => {
    const { connectionId, propertyId, token } = await save("alice", fakeToken("down"));
    w.fakeClarity.when(token, new ClarityApiError("unavailable", 503));
    const a = await as("alice");
    const r = await call(a, "get_clarity_insights", insights(propertyId));
    expect(r.out.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(w.fakeClarity.calls).toHaveLength(1);
    expect((await w.sql("select count(*)::int as n from public.report_cache where provider = 'clarity'"))[0]).toEqual({ n: 0 });
    expect((await w.clarityQuota.status(propertyId, new Date())).counts).toMatchObject({ failed: 1 });
    expect(await statusOf("alice", connectionId)).toMatchObject({ status: "pending", lastErrorCode: null });
  });

  it("an unexpected response shape is a clean provider error, not a crash or fabricated data", async () => {
    const { propertyId, token } = await save("alice", fakeToken("weird"));
    w.fakeClarity.when(token, { unexpected: "object" });
    const r = await call(await as("alice"), "get_clarity_insights", insights(propertyId));
    expect(r.out.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(r.text).not.toContain('"unexpected":');
  });

  it("an empty answer is reported as empty, with a warning, and is cached like any real answer", async () => {
    const { propertyId } = await save("alice", fakeToken("empty"));
    w.fakeClarity.default = [];
    const r = await call(await as("alice"), "get_clarity_insights", insights(propertyId));
    expect(r.out).toMatchObject({ rowCountReturned: 0, completeness: "unknown_or_provider_limited" });
    expect(r.out.warnings.map((x: Out) => x.code)).toContain("EMPTY_RESULT");
  });
});

describe("invalid input never reaches Clarity", () => {
  it.each([
    ["30 days", { numOfDays: 30 }],
    ["4 dimensions", { dimensions: ["OS", "Device", "Browser", "URL"] }],
    ["unknown dimension", { dimensions: ["Revenue"] }],
    ["duplicate dimension", { dimensions: ["OS", "OS"] }],
    ["a user id", { userId: "someone-else" }],
  ])("%s", async (_n, extra) => {
    const { propertyId } = await save("alice", fakeToken("invalid"));
    const r = await call(await as("alice"), "get_clarity_insights", insights(propertyId, extra));
    expect(r.isError).toBe(true);
    expect(w.fakeClarity.calls).toHaveLength(0);
    expect((await w.clarityQuota.status(propertyId, new Date())).appTrackedUsed).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("Bob cannot see, query, read the quota of, or read cached data from Alice's project", async () => {
    const alice = await save("alice", fakeToken("alice-private"), "Alice shop");
    const a = await as("alice");
    await call(a, "get_clarity_insights", insights(alice.propertyId));

    const b = await as("bob");
    expect((await call(b, "list_clarity_projects")).out.count).toBe(0);
    expect((await call(b, "get_connection_status")).out.connections.filter((c: Out) => c.provider === "clarity")).toEqual([]);
    for (const [tool, args] of [
      ["get_clarity_insights", insights(alice.propertyId)],
      ["get_clarity_quota_status", { propertyId: alice.propertyId }],
    ] as const) {
      const r = await call(b, tool, args);
      expect(r.out.error, tool).toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    }
    expect(w.fakeClarity.calls).toHaveLength(1);
    await expect(w.service.peekClarityCache({ userId: ID_OF.bob, clientId: "c", scopes: [] }, insights(alice.propertyId), "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    await expect(w.clarity.getToken(ID_OF.bob, alice.connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    await expect(w.clarity.rename(ID_OF.bob, alice.connectionId, "Pwned")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("two customers using the same Clarity project share its quota but never each other's saved results or tokens", async () => {
    const shared = fakeToken("shared-project");
    const alice = await save("alice", shared, "Alice view");
    const bob = await save("bob", shared, "Bob view");
    expect(alice.propertyId).toBe(bob.propertyId);

    await call(await as("alice"), "get_clarity_insights", insights(alice.propertyId));
    const second = await call(await as("bob"), "get_clarity_insights", insights(bob.propertyId));
    expect(second.out.cache.hit).toBe(false);
    expect(w.fakeClarity.calls).toHaveLength(2);
    expect((await w.clarityQuota.status(alice.propertyId, new Date())).appTrackedUsed).toBe(2);
    expect((await w.sql("select count(*)::int as n from public.report_cache where provider = 'clarity'"))[0]).toEqual({ n: 2 });
  });

  it("browser roles cannot read secrets or connections of another customer", async () => {
    const alice = await save("alice", fakeToken("rls"), "Alice shop");
    const { asRole } = await import("../db/harness.js");
    await asRole(w.db, ID_OF.bob, async (q) => {
      expect(await q("select id from public.provider_connections where id = $1", [alice.connectionId])).toEqual([]);
      expect(await q("select id from public.properties where connection_id = $1", [alice.connectionId])).toEqual([]);
    });
    await asRole(w.db, ID_OF.alice, async (q) => {
      expect((await q("select id from public.provider_connections where id = $1", [alice.connectionId])).length).toBe(1);
    });
    await asRole(w.db, ID_OF.alice, async (q) => void (await expect(q("select * from public.provider_secrets")).rejects.toThrow(/permission denied/)));
  });
});

describe("disconnect and secrecy", () => {
  it("a disconnected connection cannot be used, its secret and saved results are gone, and quota history is kept", async () => {
    const { connectionId, propertyId } = await save("alice", fakeToken("bye"));
    const a = await as("alice");
    await call(a, "get_clarity_insights", insights(propertyId));
    expect((await w.sql("select count(*)::int as n from public.report_cache where provider = 'clarity'"))[0]).toEqual({ n: 1 });

    expect((await w.credentials.disconnect(ID_OF.alice, connectionId)).disconnected).toBe(true);
    expect((await w.sql("select count(*)::int as n from public.provider_secrets where connection_id = $1", [connectionId]))[0]).toEqual({ n: 0 });
    expect((await w.sql("select count(*)::int as n from public.report_cache where provider = 'clarity'"))[0]).toEqual({ n: 0 });
    const after = await call(a, "get_clarity_insights", insights(propertyId));
    expect(after.out.error.code).toBe("PROPERTY_NOT_CONNECTED");
    expect(w.fakeClarity.calls).toHaveLength(1);
    expect((await w.sql("select count(*)::int as n from public.provider_request_reservations where connection_id is null"))[0]).toEqual({ n: 1 });
  });

  it("the token never appears in the database, logs, audit rows, cached reports or tool output", async () => {
    const token = fakeToken("must-not-leak");
    const { propertyId } = await save("alice", token);
    const a = await as("alice");
    const outputs = [(await call(a, "get_clarity_insights", insights(propertyId))).text, (await call(a, "get_clarity_quota_status", { propertyId })).text, (await call(a, "list_clarity_projects")).text, (await call(a, "get_connection_status")).text];
    w.fakeClarity.when(token, new ClarityApiError("unauthorized", 401));
    outputs.push((await call(a, "get_clarity_insights", insights(propertyId, { dimensions: ["Device"] }))).text);

    const dump = JSON.stringify([
      outputs,
      w.logs,
      await w.sql("select * from public.audit_events"),
      await w.sql("select * from public.report_cache"),
      await w.sql("select * from public.provider_connections where provider = 'clarity'"),
      await w.sql("select * from public.properties where provider = 'clarity'"),
      await w.sql("select * from public.provider_secrets"),
      await w.sql("select * from public.provider_request_reservations"),
      await w.sql("select * from public.provider_request_budgets"),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("must-not-leak");
  });
});
