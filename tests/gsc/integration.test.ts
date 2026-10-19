import { describe, expect, it } from "vitest";
import { MemoryReportCache } from "@serp/cache";
import { loadSharedEnv } from "@serp/contracts";
import { PropertyDiscoveryService } from "@serp/credentials";
import { createLogger } from "@serp/observability";
import { MemoryClarityQuotaStore } from "@serp/provider-clarity";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import { MockGa4ApiClient } from "@serp/provider-ga4";
import { GoogleGscAdapter, GscApiError, MockGscApiClient, mapSitesToProperties } from "@serp/provider-gsc";
import { ReportService } from "@serp/reporting";
import { createGa4Adapter } from "@serp/provider-ga4";
import { createClarityAdapter } from "@serp/provider-clarity";
import { USER_1, USER_2, makeStack } from "../security/helpers.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const env = { ...loadSharedEnv({}), LOG_LEVEL: "error" as const };

/** Full server-side chain with no Google: connect (mock OAuth) -> discover -> authorize -> token -> API -> report. */
function world() {
  const s = makeStack();
  const api = new MockGscApiClient({ now: () => NOW });
  const discovery = new PropertyDiscoveryService({ repo: s.repo, credentials: s.credentials, gsc: api, ga4: new MockGa4ApiClient(), logger: s.logger });
  const adapter = new GoogleGscAdapter({
    client: api,
    now: () => NOW,
    getAccessToken: async (ctx) => (await s.credentials.getAccessToken(ctx.userId, ctx.connection.id, ctx.requestId)).accessToken,
    onAuthRejected: (ctx) => s.credentials.markNeedsAttention(ctx.userId, ctx.connection.id, "AUTH_EXPIRED"),
  });
  const reports = new ReportService({
    repo: s.repo,
    cache: new MemoryReportCache(),
    clarityQuota: new MemoryClarityQuotaStore(),
    gsc: adapter,
    ga4: createGa4Adapter("mock"),
    clarity: createClarityAdapter("mock"),
    env,
    logger: createLogger({ level: "error" }),
    now: () => NOW,
  });
  return { ...s, api, discovery, reports };
}
const principal = (userId: string) => ({ userId, scopes: [] as string[] });
const query = { propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14", dimensions: ["query"], limit: 10 };

describe("discovery", () => {
  it("stores readable sites, skips unverified ones, and never invents properties", async () => {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    const r = await w.discovery.syncGsc(USER_1, connectionId);
    expect(r).toMatchObject({ added: 3, updated: 0, removed: 0, total: 3 });
    expect(r.skipped).toEqual([{ siteUrl: "https://not-verified.example.net/", reason: "unverified" }]);
    const props = await w.repo.listProperties(USER_1, { provider: "gsc" });
    expect(props.map((p) => p.externalPropertyId).sort()).toEqual(["https://restricted.example.com/", "https://www.example.com/", "sc-domain:example.com"]);
    expect(props.find((p) => p.externalPropertyId === "sc-domain:example.com")).toMatchObject({ displayName: "example.com", propertyType: "domain", timezone: "America/Los_Angeles", enabledForMcp: true });
    expect(w.api.calls[0]!.accessToken).toMatch(/^mock-access-token-/); // used the stored, decrypted token
  });

  it("re-sync keeps the user's enable/disable choice and drops sites the account lost", async () => {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await w.discovery.syncGsc(USER_1, connectionId);
    const www = (await w.repo.listProperties(USER_1)).find((p) => p.externalPropertyId === "https://www.example.com/")!;
    await w.repo.setPropertyEnabled(USER_1, www.id, false);

    w.api.sites = w.api.sites.filter((x) => x.siteUrl !== "https://restricted.example.com/");
    const r = await w.discovery.syncGsc(USER_1, connectionId);
    expect(r).toMatchObject({ added: 0, updated: 2, removed: 1, total: 2 });
    const after = await w.repo.listProperties(USER_1);
    expect(after.find((p) => p.id === www.id)!.enabledForMcp).toBe(false);
    expect(after.some((p) => p.externalPropertyId === "https://restricted.example.com/")).toBe(false);
  });

  it("an account with no Search Console access gets an honest empty result", async () => {
    const w = world();
    w.api.sites = [];
    const { connectionId } = await w.connect(USER_1, "nobody@example.com");
    const r = await w.discovery.syncGsc(USER_1, connectionId);
    expect(r).toMatchObject({ total: 0, added: 0 });
    expect(r.message).toMatch(/no Search Console properties/);
    expect(await w.repo.listProperties(USER_1, { provider: "gsc" })).toEqual([]);
  });

  it("another user cannot sync (or learn about) someone else's connection", async () => {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await expect(w.discovery.syncGsc(USER_2, connectionId)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(w.api.calls).toEqual([]);
  });

  it("refuses a connection that never granted Search Console", async () => {
    const w = world();
    w.google.grantedScopes = [GOOGLE_SCOPES.ga4];
    const { connectionId } = await w.connect(USER_1, "ga@example.com", "ga4");
    await expect(w.discovery.syncGsc(USER_1, connectionId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.api.calls).toEqual([]);
  });

  it.each([
    ["unauthenticated", "AUTH_EXPIRED", "needs_attention"],
    ["quota", "PROVIDER_RATE_LIMITED", "connected"],
    ["unavailable", "PROVIDER_UNAVAILABLE", "connected"],
    ["api_disabled", "PROVIDER_CAPABILITY_UNAVAILABLE", "connected"],
  ] as const)("API failure %s -> %s, connection stays %s, existing properties untouched", async (kind, code, status) => {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await w.discovery.syncGsc(USER_1, connectionId);
    w.api.failures = [new GscApiError(kind, 403)];
    await expect(w.discovery.syncGsc(USER_1, connectionId)).rejects.toMatchObject({ code });
    expect((await w.repo.getConnection(USER_1, connectionId))!.status).toBe(status);
    expect(await w.repo.listProperties(USER_1, { provider: "gsc" })).toHaveLength(3);
  });

  it("audit records the sync without tokens, site URLs or emails", async () => {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await w.discovery.syncGsc(USER_1, connectionId);
    w.api.failures = [new GscApiError("quota", 429)];
    await w.discovery.syncGsc(USER_1, connectionId).catch(() => undefined);
    const events = w.repo.auditLog.filter((e) => e.eventType.startsWith("properties."));
    expect(events.map((e) => e.eventType)).toEqual(["properties.synced", "properties.sync_failed"]);
    const dump = JSON.stringify(w.repo.auditLog) + w.logs.join("\n");
    expect(dump).not.toMatch(/mock-access-token|mock-refresh-token|example\.com|alice/);
  });

  it("maps malformed or odd site URLs safely", () => {
    const { properties, skipped } = mapSitesToProperties([
      { siteUrl: "sc-domain:ok.example", permissionLevel: "siteOwner" },
      { siteUrl: "sc-domain:ok.example", permissionLevel: "siteOwner" },
      { siteUrl: "javascript:alert(1)", permissionLevel: "siteOwner" },
      { siteUrl: "sc-domain:bad domain!", permissionLevel: "siteOwner" },
      { siteUrl: "https://u.example/", permissionLevel: "unknown" },
    ]);
    expect(properties.map((p) => p.externalPropertyId)).toEqual(["sc-domain:ok.example"]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(["malformed", "malformed", "unknown_permission"]);
  });
});

describe("reports through the full server-side chain", () => {
  async function ready() {
    const w = world();
    const { connectionId } = await w.connect(USER_1, "alice@example.com");
    await w.discovery.syncGsc(USER_1, connectionId);
    return { w, connectionId };
  }

  it("returns data for an authorized property using the owner's own token", async () => {
    const { w } = await ready();
    const r = await w.reports.queryGsc(principal(USER_1), query, "r1");
    expect(r.rows).toHaveLength(10);
    expect(w.api.calls.at(-1)).toMatchObject({ op: "query", siteUrl: "sc-domain:example.com" });
    expect(w.api.calls.at(-1)!.accessToken).toMatch(/^mock-access-token-/);
    expect((await w.reports.queryGsc(principal(USER_1), query, "r2")).cache.hit).toBe(true);
  });

  it("each user's queries use only that user's connection", async () => {
    const w = world();
    const a = await w.connect(USER_1, "alice@example.com");
    const b = await w.connect(USER_2, "bob@example.com");
    await w.discovery.syncGsc(USER_1, a.connectionId);
    await w.discovery.syncGsc(USER_2, b.connectionId);
    await w.reports.queryGsc(principal(USER_1), query, "r1");
    await w.reports.queryGsc(principal(USER_2), query, "r2");
    const tokens = w.api.calls.filter((c) => c.op === "query").map((c) => c.accessToken);
    expect(new Set(tokens).size).toBe(2);
  });

  it("a user with no connected property cannot query one, and nothing reaches Google", async () => {
    const { w } = await ready();
    const before = w.api.calls.length;
    await expect(w.reports.queryGsc(principal(USER_2), query, "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(w.api.calls.length).toBe(before);
  });

  it("a disabled property cannot be queried", async () => {
    const { w } = await ready();
    const p = (await w.repo.listProperties(USER_1)).find((x) => x.externalPropertyId === "sc-domain:example.com")!;
    await w.repo.setPropertyEnabled(USER_1, p.id, false);
    await expect(w.reports.queryGsc(principal(USER_1), query, "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("rejects out-of-range dates before calling Google", async () => {
    const { w } = await ready();
    const before = w.api.calls.length;
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, startDate: "2024-01-01" }, "r")).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, endDate: "2026-12-31" }, "r")).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, startDate: "2026-09-20", endDate: "2026-09-01" }, "r")).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(w.api.calls.length).toBe(before);
  });

  it("warns about recent days that are still settling", async () => {
    const { w } = await ready();
    const r = await w.reports.queryGsc(principal(USER_1), { ...query, startDate: "2026-10-10", endDate: "2026-10-19" }, "r");
    expect(r.warnings.map((x) => x.code)).toContain("RECENT_DATA_INCOMPLETE");
  });

  it("a token Google rejects flips the connection to needs_attention and later calls fail fast", async () => {
    const { w, connectionId } = await ready();
    w.api.failures = [new GscApiError("unauthenticated", 401)];
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, limit: 3 }, "r")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await w.repo.getConnection(USER_1, connectionId))!.status).toBe("needs_attention");
    const calls = w.api.calls.length;
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, limit: 4 }, "r")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(w.api.calls.length).toBe(calls); // the rejected connection is no longer used
  });

  it("Google revoking the refresh token surfaces as AUTH_REVOKED on the next report", async () => {
    const { w } = await ready();
    w.time.now += 3 * 3600_000; // access token expired -> refresh needed
    w.google.failRefreshWith = "invalid_grant";
    await expect(w.reports.queryGsc(principal(USER_1), { ...query, limit: 2 }, "r")).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  });

  it("logs and audit rows from the whole chain contain no tokens", async () => {
    const { w } = await ready();
    await w.reports.queryGsc(principal(USER_1), query, "r");
    const dump = JSON.stringify(w.repo.auditLog) + w.logs.join("\n");
    expect(dump).not.toMatch(/mock-access-token|mock-refresh-token/);
  });
});
