/**
 * Regression tests for failures found while testing the connector against serpforge.io (round 1).
 * DATA SOURCE: MOCK. No provider is called.
 */
import { describe, expect, it } from "vitest";
import { GetClarityInsightsSchema, QueryGscSchema, QueryGa4Schema, type AuthorizedQueryContext, type ReportRow } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import { GoogleGscAdapter, GscApiError, MockGscApiClient, mergeFragmentDuplicates, stripUrlFragment } from "@serp/provider-gsc";
import { Ga4ApiError, GoogleGa4Adapter, MockGa4ApiClient } from "@serp/provider-ga4";
import { validateGscDateRange } from "@serp/query-planner";
import { buildClarityResult, parseClarityResponse, summarizeBotTraffic } from "@serp/provider-clarity";

const NOW = new Date("2026-10-19T12:00:00Z");
const ctx: AuthorizedQueryContext = {
  userId: MOCK_USER_A_ID,
  requestId: "req-1",
  property: { id: "p1", userId: MOCK_USER_A_ID, connectionId: "c1", provider: "gsc", externalPropertyId: "sc-domain:example.com", displayName: "example.com", propertyType: "domain", timezone: "America/New_York", enabledForMcp: true },
  connection: { id: "c1", userId: MOCK_USER_A_ID, provider: "google", providerAccountId: "sub", accountLabel: "a***@x.test", status: "connected", grantedScopes: [], lastValidatedAt: null, lastErrorCode: null },
};

describe("GSC: a 401 on a token that looked valid refreshes once instead of demanding a reconnect", () => {
  class Flaky extends MockGscApiClient {
    seen: string[] = [];
    constructor(private readonly rejectTokens: string[]) {
      super({ now: () => NOW });
    }
    override async querySearchAnalytics(token: string, ...rest: Parameters<MockGscApiClient["querySearchAnalytics"]> extends [string, ...infer R] ? R : never) {
      this.seen.push(token);
      if (this.rejectTokens.includes(token)) throw new GscApiError("unauthenticated", 401);
      return super.querySearchAnalytics(token, ...rest);
    }
  }
  const query = QueryGscSchema.parse({ propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14" });

  it("succeeds after the forced refresh and does not flag the connection", async () => {
    const client = new Flaky(["stale"]);
    const rejected: string[] = [];
    const adapter = new GoogleGscAdapter({ client, now: () => NOW, getAccessToken: async () => "stale", refreshAccessToken: async () => "fresh", onAuthRejected: async (c) => void rejected.push(c.connection.id) });
    const r = await adapter.query(query, ctx);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(client.seen).toEqual(["stale", "fresh", "fresh"]); // rows, retried with the fresh token, then the totals call
    expect(rejected).toEqual([]);
  });

  it("still returns AUTH_EXPIRED with a reconnect instruction when the refreshed token is rejected too", async () => {
    const client = new Flaky(["stale", "fresh"]);
    const rejected: string[] = [];
    const adapter = new GoogleGscAdapter({ client, now: () => NOW, getAccessToken: async () => "stale", refreshAccessToken: async () => "fresh", onAuthRejected: async (c) => void rejected.push(c.connection.id) });
    await expect(adapter.query(query, ctx)).rejects.toMatchObject({ code: "AUTH_EXPIRED", suggestedAction: expect.stringContaining("Reconnect") });
    expect(client.seen).toEqual(["stale", "fresh"]);
    expect(rejected).toEqual(["c1"]);
  });
});

describe("GA4: a 401 refreshes once and retries", () => {
  it("retries the report with the fresh token", async () => {
    class Flaky extends MockGa4ApiClient {
      tokens: string[] = [];
      override async getMetadata(token: string, ...rest: any[]) {
        this.tokens.push(token);
        if (token === "stale") throw new Ga4ApiError("unauthenticated", 401);
        return super.getMetadata(token, ...(rest as [string]));
      }
    }
    const client = new Flaky({ now: () => NOW });
    const adapter = new GoogleGa4Adapter({ client, now: () => NOW, getAccessToken: async () => "stale", refreshAccessToken: async () => "fresh" });
    const ga4ctx = { ...ctx, property: { ...ctx.property, provider: "ga4" as const, externalPropertyId: "123456789" } };
    const r = await adapter.query(QueryGa4Schema.parse({ propertyId: "123456789", startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["pagePath"], metrics: ["activeUsers"] }), ga4ctx);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(client.tokens.slice(0, 2)).toEqual(["stale", "fresh"]);
  });
});

describe("URL anchor duplicates (#elementor-toc)", () => {
  const rows: ReportRow[] = [
    { page: "https://serpforge.io/guide/", clicks: 10, impressions: 100, ctr: 0.1, position: 4 },
    { page: "https://serpforge.io/guide/#elementor-toc__heading-anchor-0", clicks: 5, impressions: 300, ctr: 5 / 300, position: 8 },
    { page: "https://serpforge.io/other/", clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
  ];

  it("strips only the fragment", () => {
    expect(stripUrlFragment("https://a.io/x/#y")).toBe("https://a.io/x/");
    expect(stripUrlFragment("https://a.io/x/?q=1")).toBe("https://a.io/x/?q=1");
  });

  it("merges rows, sums additive metrics, recomputes CTR and weights position by impressions", () => {
    const { rows: out, merged } = mergeFragmentDuplicates(rows, ["page"]);
    expect(merged).toBe(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ page: "https://serpforge.io/guide/", clicks: 15, impressions: 400, ctr: 0.0375, position: 7 });
  });

  it("does nothing without a page dimension", () => {
    expect(mergeFragmentDuplicates([{ query: "a#b", clicks: 1, impressions: 1, ctr: 1, position: 1 }], ["query"]).merged).toBe(0);
  });

  it("is reported to the caller through a warning", async () => {
    const client = new MockGscApiClient({ now: () => NOW });
    (client as { override?: unknown }).override = { rows: rows.map((r) => ({ keys: [r.page], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })) };
    const adapter = new GoogleGscAdapter({ client, now: () => NOW, getAccessToken: async () => "t" });
    const r = await adapter.query(QueryGscSchema.parse({ propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14", dimensions: ["page"] }), ctx);
    expect(r.warnings.map((w) => w.code)).toContain("URL_ANCHOR_DUPLICATES_MERGED");
    expect(r.rows.map((x) => x.page)).not.toContain(expect.stringContaining("#"));
  });
});

describe("GSC: recent-data warning follows the data state (no false alarm on lastDays)", () => {
  const codes = (end: string, dataState: "final" | "all") => validateGscDateRange("2026-10-01", end, NOW, dataState).warnings.map((w) => w.code);
  it("final data: a range ending at the newest finalized day (today-2) is complete", () => {
    expect(codes("2026-10-17", "final")).toEqual([]);
  });
  it("final data: a range ending after it warns that the newest days are missing", () => {
    expect(codes("2026-10-18", "final")).toEqual(["RECENT_DATA_INCOMPLETE"]);
  });
  it("fresh data: the last days are provisional", () => {
    expect(codes("2026-10-17", "all")).toEqual(["RECENT_DATA_INCOMPLETE"]);
    expect(codes("2026-10-16", "all")).toEqual([]);
  });
});

describe("Clarity: 72-hour limit and bot flag", () => {
  const body = [{ metricName: "Traffic", information: [{ totalSessionCount: "200", totalBotSessionCount: "50", distinctUserCount: "120", Device: "PC" }] }];
  const build = (b: unknown) => buildClarityResult({ parsed: parseClarityResponse(b, ["Device"])!, numOfDays: 3, dimensions: ["Device"], property: { id: "p", name: "n" }, requestId: "r", now: NOW, mock: false });

  it("rejects ranges beyond 3 days with a message that points to GSC and GA4", () => {
    const r = GetClarityInsightsSchema.safeParse({ propertyId: "p", numOfDays: 7 });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/query_gsc_performance|GSC/);
  });

  it("states the 72-hour limit on every result", () => {
    expect(build(body).warnings.map((w) => w.code)).toContain("CLARITY_LAST_72_HOURS_ONLY");
    expect(build(body).providerMetadata).toMatchObject({ maxHistoryHours: 72 });
  });

  it("flags bot sessions with the share and the human count", () => {
    expect(summarizeBotTraffic(parseClarityResponse(body, ["Device"])!.rows)).toEqual({ totalSessions: 200, botSessions: 50, humanSessions: 150, botSharePercent: 25 });
    const w = build(body).warnings.find((x) => x.code === "BOT_TRAFFIC_INCLUDED");
    expect(w?.message).toMatch(/50 of 200 sessions \(25%\)/);
  });

  it("says so when the response carries no bot count", () => {
    const w = build([{ metricName: "Traffic", information: [{ totalSessionCount: "10", Device: "PC" }] }]).warnings.map((x) => x.code);
    expect(w).toContain("BOT_TRAFFIC_UNKNOWN");
  });
});

describe("GA4: organic-only active users by landing page (the failing prompt from the report)", () => {
  it("returns rows for landingPage x activeUsers filtered to Organic Search, with a metric filter and paging", async () => {
    const adapter = new GoogleGa4Adapter({ client: new MockGa4ApiClient({ now: () => NOW }), now: () => NOW, getAccessToken: async () => "t" });
    const ga4ctx = { ...ctx, property: { ...ctx.property, provider: "ga4" as const, externalPropertyId: "123456789" } };
    const base = { propertyId: "123456789", startDate: "2026-10-01", endDate: "2026-10-18", dimensions: ["landingPage"], metrics: ["activeUsers", "sessions"], dimensionFilters: [{ field: "sessionDefaultChannelGroup", matchType: "EXACT", value: "Organic Search" }], metricFilters: [{ field: "activeUsers", operator: "GREATER_THAN", value: 0 }], orderBy: { field: "activeUsers", direction: "desc" }, limit: 3 };
    const p1 = await adapter.query(QueryGa4Schema.parse(base), ga4ctx);
    const p2 = await adapter.query(QueryGa4Schema.parse({ ...base, offset: 3 }), ga4ctx);
    expect(p1.rows.length).toBeGreaterThan(0);
    expect(p1.rows.map((r) => r.landingPage)).not.toEqual(p2.rows.map((r) => r.landingPage));
  });
});
