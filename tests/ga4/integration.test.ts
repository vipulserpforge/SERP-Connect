import { describe, expect, it } from "vitest";
import { MemoryReportCache } from "@serp/cache";
import { loadSharedEnv } from "@serp/contracts";
import { PropertyDiscoveryService } from "@serp/credentials";
import { createLogger } from "@serp/observability";
import { MemoryClarityQuotaStore, createClarityAdapter } from "@serp/provider-clarity";
import { Ga4ApiError, GoogleGa4Adapter, MockGa4ApiClient, discoverGa4Properties, mapAccountSummaries } from "@serp/provider-ga4";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import { MockGscApiClient, createGscAdapter } from "@serp/provider-gsc";
import { ReportService } from "@serp/reporting";
import { USER_1, USER_2, makeStack } from "../security/helpers.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const env = { ...loadSharedEnv({}), LOG_LEVEL: "error" as const };

/** Whole server-side chain with no Google: connect (mock OAuth) -> discover -> authorize -> token -> API -> report. */
function world() {
  const s = makeStack();
  const api = new MockGa4ApiClient({ now: () => NOW });
  const discovery = new PropertyDiscoveryService({ repo: s.repo, credentials: s.credentials, gsc: new MockGscApiClient(), ga4: api, logger: s.logger });
  const ga4 = new GoogleGa4Adapter({
    client: api,
    now: () => NOW,
    getAccessToken: async (ctx) => (await s.credentials.getAccessToken(ctx.userId, ctx.connection.id, ctx.requestId)).accessToken,
    onAuthRejected: (ctx) => s.credentials.markNeedsAttention(ctx.userId, ctx.connection.id, "AUTH_EXPIRED"),
  });
  const reports = new ReportService({
    repo: s.repo,
    cache: new MemoryReportCache(),
    clarityQuota: new MemoryClarityQuotaStore(),
    gsc: createGscAdapter("mock"),
    ga4,
    clarity: createClarityAdapter("mock"),
    env,
    logger: createLogger({ level: "error" }),
    now: () => NOW,
  });
  const connectGa4 = async (userId: string, email: string) => {
    s.google.grantedScopes = [GOOGLE_SCOPES.ga4];
    return s.connect(userId, email, "ga4");
  };
  return { ...s, api, discovery, reports, connectGa4 };
}
const principal = (userId: string) => ({ userId, scopes: [] as string[] });
const query = { propertyId: "123456789", startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["pagePath"], metrics: ["activeUsers", "sessions"], limit: 10 };

describe("GA4 discovery", () => {
  it("stores supported properties with account labels and reporting time zones, and skips roll-ups", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    const r = await w.discovery.syncGa4(USER_1, connectionId);
    expect(r).toMatchObject({ added: 4, updated: 0, removed: 0, total: 4, dataApiVerified: true, timeZoneUnknown: 0 });
    expect(r.skipped).toEqual([{ propertyId: "555000111", reason: "unsupported_type" }]);

    const props = await w.repo.listProperties(USER_1, { provider: "ga4" });
    const byId = Object.fromEntries(props.map((p) => [p.externalPropertyId, p]));
    expect(Object.keys(byId).sort()).toEqual(["111222333", "123456789", "444555666", "987654321"]);
    expect(byId["123456789"]).toMatchObject({ displayName: "Example GA4 (Example Co)", propertyType: "ga4_property", timezone: "America/New_York", enabledForMcp: true });
    expect(byId["987654321"]!.timezone).toBe("Asia/Kolkata");
    expect(byId["444555666"]!.displayName).toBe("Other site (Other Co)");
    // used the stored, decrypted token for each call
    expect(w.api.calls.every((c) => /^mock-access-token-/.test(c.accessToken))).toBe(true);
  });

  it("GSC and GA4 properties from one Google connection coexist and are synced independently", async () => {
    const w = world();
    w.google.grantedScopes = [GOOGLE_SCOPES.gsc, GOOGLE_SCOPES.ga4];
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await w.discovery.syncGsc(USER_1, connectionId);
    await w.discovery.syncGa4(USER_1, connectionId);
    expect((await w.repo.listProperties(USER_1, { provider: "gsc" })).length).toBe(3);
    expect((await w.repo.listProperties(USER_1, { provider: "ga4" })).length).toBe(4);
    w.api.accounts = [];
    const r = await w.discovery.syncGa4(USER_1, connectionId);
    expect(r).toMatchObject({ removed: 4, total: 0 });
    expect(r.message).toMatch(/no Google Analytics 4 properties/);
    expect((await w.repo.listProperties(USER_1, { provider: "gsc" })).length).toBe(3); // GSC untouched
  });

  it("re-sync keeps the user's enable/disable choice and drops properties the account lost", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    await w.discovery.syncGa4(USER_1, connectionId);
    const p = (await w.repo.listProperties(USER_1)).find((x) => x.externalPropertyId === "987654321")!;
    await w.repo.setPropertyEnabled(USER_1, p.id, false);
    w.api.accounts = w.api.accounts.map((a) => ({ ...a, properties: a.properties.filter((x) => x.propertyId !== "444555666") }));
    const r = await w.discovery.syncGa4(USER_1, connectionId);
    expect(r).toMatchObject({ added: 0, updated: 3, removed: 1 });
    expect((await w.repo.listProperties(USER_1)).find((x) => x.id === p.id)!.enabledForMcp).toBe(false);
  });

  it("an unreadable time zone is tolerated and counted; the property is still stored", async () => {
    const w = world();
    w.api.timeZones = {};
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    const r = await w.discovery.syncGa4(USER_1, connectionId);
    expect(r.timeZoneUnknown).toBe(4);
    expect((await w.repo.listProperties(USER_1, { provider: "ga4" })).every((p) => p.timezone === null)).toBe(true);
  });

  it("another user cannot sync someone else's connection; a Search Console-only grant cannot sync GA4", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    await expect(w.discovery.syncGa4(USER_2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    const gscOnly = world();
    const g = await gscOnly.connect(USER_1, "gsc@example.com");
    await expect(gscOnly.discovery.syncGa4(USER_1, g.connectionId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.api.calls).toEqual([]);
    expect(gscOnly.api.calls).toEqual([]);
  });

  it.each([
    ["unauthenticated", "AUTH_EXPIRED", "needs_attention"],
    ["insufficient_scope", "FORBIDDEN", "connected"],
    ["api_disabled", "PROVIDER_CAPABILITY_UNAVAILABLE", "connected"],
    ["quota", "PROVIDER_RATE_LIMITED", "connected"],
    ["unavailable", "PROVIDER_UNAVAILABLE", "connected"],
  ] as const)("Admin API failure %s -> %s, connection stays %s, stored properties untouched", async (kind, code, status) => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    await w.discovery.syncGa4(USER_1, connectionId);
    w.api.failures = [new Ga4ApiError(kind, 403)];
    await expect(w.discovery.syncGa4(USER_1, connectionId)).rejects.toMatchObject({ code });
    expect((await w.repo.getConnection(USER_1, connectionId))!.status).toBe(status);
    expect(await w.repo.listProperties(USER_1, { provider: "ga4" })).toHaveLength(4);
  });

  it("a disabled Data API is surfaced at connect time instead of failing later at the first report", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    w.api.getMetadata = async () => {
      throw new Ga4ApiError("api_disabled", 403);
    };
    await expect(w.discovery.syncGa4(USER_1, connectionId)).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });

  it("a single property the account cannot open does not fail discovery, and is reported as unverified", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    w.api.getMetadata = async () => {
      throw new Ga4ApiError("no_resource_access", 403);
    };
    const r = await w.discovery.syncGa4(USER_1, connectionId);
    expect(r.total).toBe(4);
    expect(r.dataApiVerified).toBe(false);
  });

  it("audit records the sync without tokens, property names or emails", async () => {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    await w.discovery.syncGa4(USER_1, connectionId);
    w.api.failures = [new Ga4ApiError("quota", 429)];
    await w.discovery.syncGa4(USER_1, connectionId).catch(() => undefined);
    expect(w.repo.auditLog.filter((e) => e.eventType.startsWith("properties.")).map((e) => e.eventType)).toEqual(["properties.synced", "properties.sync_failed"]);
    const dump = JSON.stringify(w.repo.auditLog) + w.logs.join("\n");
    expect(dump).not.toMatch(/mock-access-token|mock-refresh-token|Example|alice/);
  });

  it("maps odd account summaries safely and de-duplicates", () => {
    const { candidates, skipped } = mapAccountSummaries([
      { accountId: "1", displayName: "", properties: [{ propertyId: "10", displayName: "Ten", propertyType: "PROPERTY_TYPE_ORDINARY" }, { propertyId: "10", displayName: "Dup", propertyType: "PROPERTY_TYPE_ORDINARY" }, { propertyId: "x/../y", displayName: "bad", propertyType: "PROPERTY_TYPE_ORDINARY" }, { propertyId: "11", displayName: "Roll", propertyType: "PROPERTY_TYPE_ROLLUP" }] },
    ]);
    expect(candidates).toEqual([{ id: "10", name: "Ten" }]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["malformed", "unsupported_type"]);
  });

  it("discoverGa4Properties works directly against the client", async () => {
    const d = await discoverGa4Properties(new MockGa4ApiClient(), "tok");
    expect(d.properties).toHaveLength(4);
  });
});

describe("GA4 reports through the full server-side chain", () => {
  async function ready() {
    const w = world();
    const { connectionId } = await w.connectGa4(USER_1, "alice@example.com");
    await w.discovery.syncGa4(USER_1, connectionId);
    return { w, connectionId };
  }

  it("returns data for an authorized property using the owner's own token, then serves a cache hit", async () => {
    const { w } = await ready();
    const r = await w.reports.queryGa4(principal(USER_1), query, "r1");
    expect(r.rows).toHaveLength(10);
    expect(r.report.dateSemantics).toContain("America/New_York");
    const last = w.api.calls.at(-1)!;
    expect(last).toMatchObject({ op: "runReport", propertyId: "123456789" });
    expect(last.accessToken).toMatch(/^mock-access-token-/);
    const before = w.api.calls.length;
    expect((await w.reports.queryGa4(principal(USER_1), query, "r2")).cache.hit).toBe(true);
    expect(w.api.calls.length).toBe(before);
  });

  it("each user's queries use only that user's connection", async () => {
    const w = world();
    const a = await w.connectGa4(USER_1, "alice@example.com");
    const b = await w.connectGa4(USER_2, "bob@example.com");
    await w.discovery.syncGa4(USER_1, a.connectionId);
    await w.discovery.syncGa4(USER_2, b.connectionId);
    await w.reports.queryGa4(principal(USER_1), query, "r1");
    await w.reports.queryGa4(principal(USER_2), query, "r2");
    const tokens = w.api.calls.filter((c) => c.op === "runReport").map((c) => c.accessToken);
    expect(new Set(tokens).size).toBe(2);
  });

  it("a user without the property, or with it disabled, cannot query it and nothing reaches Google", async () => {
    const { w } = await ready();
    const before = w.api.calls.length;
    await expect(w.reports.queryGa4(principal(USER_2), query, "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    const p = (await w.repo.listProperties(USER_1)).find((x) => x.externalPropertyId === "123456789")!;
    await w.repo.setPropertyEnabled(USER_1, p.id, false);
    await expect(w.reports.queryGa4(principal(USER_1), query, "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(w.api.calls.length).toBe(before);
  });

  it("validates dates in the property's time zone before calling Google", async () => {
    const { w } = await ready();
    const before = w.api.calls.length;
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, endDate: "2026-12-31" }, "r")).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, startDate: "2010-01-01" }, "r")).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, startDate: "2026-09-30", endDate: "2026-09-01" }, "r")).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(w.api.calls.length).toBe(before);
  });

  it("warns about days GA4 is still processing", async () => {
    const { w } = await ready();
    const r = await w.reports.queryGa4(principal(USER_1), { ...query, startDate: "2026-10-15", endDate: "2026-10-19" }, "r");
    expect(r.warnings.map((x) => x.code)).toEqual(expect.arrayContaining(["RECENT_DATA_INCOMPLETE", "PARTIAL_DAY"]));
  });

  it("rejects unknown fields and incompatible combinations with actionable errors", async () => {
    const { w } = await ready();
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, metrics: ["bogusMetric"] }, "r")).rejects.toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
    const err = await w.reports.queryGa4(principal(USER_1), { ...query, dimensions: ["itemName"], metrics: ["sessions"] }, "r").catch((e) => e);
    expect(err).toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
    expect(err.message).toMatch(/itemName/);
  });

  it("a token Google rejects flips the connection to needs_attention and later calls fail fast", async () => {
    const { w, connectionId } = await ready();
    w.api.failures = [new Ga4ApiError("unauthenticated", 401)];
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, limit: 3 }, "r")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await w.repo.getConnection(USER_1, connectionId))!.status).toBe("needs_attention");
    const calls = w.api.calls.length;
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, limit: 4 }, "r")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(w.api.calls.length).toBe(calls);
  });

  it("an expired access token is refreshed transparently; a revoked refresh token becomes AUTH_REVOKED", async () => {
    const { w } = await ready();
    w.time.now += 3 * 3600_000;
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, limit: 2 }, "r")).resolves.toMatchObject({ rowCountReturned: 2 });
    expect(w.google.refreshCalls).toBe(1);
    w.time.now += 3 * 3600_000;
    w.google.failRefreshWith = "invalid_grant";
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, limit: 3 }, "r")).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  });

  it("quota exhaustion is retryable and does not disturb the connection", async () => {
    const { w, connectionId } = await ready();
    w.api.failures = [new Ga4ApiError("quota", 429)];
    await expect(w.reports.queryGa4(principal(USER_1), { ...query, limit: 5 }, "r")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect((await w.repo.getConnection(USER_1, connectionId))!.status).toBe("connected");
  });

  it("get_supported_metrics is property-specific and authorization-checked", async () => {
    const { w } = await ready();
    const generic = (await w.reports.getSupportedMetrics(principal(USER_1), { provider: "ga4" })) as { dimensions: string[]; notes: string[] };
    expect(generic.dimensions).toContain("pagePath");
    const specific = (await w.reports.getSupportedMetrics(principal(USER_1), { provider: "ga4", propertyId: "123456789" })) as { dimensions: Array<{ name: string; custom: boolean }>; metrics: Array<{ name: string }> };
    expect(specific.dimensions.find((d) => d.name === "customEvent:signup_plan")).toMatchObject({ custom: true });
    expect(specific.metrics.map((m) => m.name)).toContain("customEvent:signup_count");
    const other = (await w.reports.getSupportedMetrics(principal(USER_1), { provider: "ga4", propertyId: "987654321" })) as { dimensions: Array<{ name: string }> };
    expect(other.dimensions.map((d) => d.name)).not.toContain("customEvent:signup_plan");
    await expect(w.reports.getSupportedMetrics(principal(USER_2), { provider: "ga4", propertyId: "123456789" })).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("logs and audit rows from the whole chain contain no tokens", async () => {
    const { w } = await ready();
    await w.reports.queryGa4(principal(USER_1), query, "r");
    expect(JSON.stringify(w.repo.auditLog) + w.logs.join("\n")).not.toMatch(/mock-access-token|mock-refresh-token/);
  });
});
