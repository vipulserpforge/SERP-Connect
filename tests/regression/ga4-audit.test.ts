/**
 * GA4 audit round: totals, presets, comparison, realtime, data-quality warnings, filter compatibility.
 * DATA SOURCE: MOCK (MockGa4ApiClient behind the real adapter and the real report service). No Google call is made.
 */
import { describe, expect, it } from "vitest";
import { GoogleGa4Adapter, MockGa4ApiClient, type Ga4RunReportResponse } from "@serp/provider-ga4";
import { mergeGa4Comparison } from "@serp/reporting";
import type { NormalizedReportResult } from "@serp/contracts";
import { NOON, USER_A, harness, ga4Query } from "../reporting-layer/fixture.js";

const now = () => new Date(NOON);
const accounts = [{ accountId: "1", displayName: "Co", properties: [{ propertyId: "100", displayName: "Site 100", propertyType: "PROPERTY_TYPE_ORDINARY" }, { propertyId: "200", displayName: "Site 200", propertyType: "PROPERTY_TYPE_ORDINARY" }] }];

function setup() {
  const client = new MockGa4ApiClient({ accounts, now, timeZones: { "100": "Pacific/Auckland", "200": "America/New_York" } });
  const adapter = new GoogleGa4Adapter({ client, now, getAccessToken: async () => "t" });
  const h = harness({ deps: { ga4: adapter as never } });
  const q = (over: Record<string, unknown> = {}) => {
    const args: Record<string, unknown> = ga4Query({ propertyId: "200", ...over });
    // lastDays replaces explicit dates; keep the two forms from being sent together.
    if (over.lastDays !== undefined) delete args.startDate, delete args.endDate;
    return h.service.queryGa4(h.principal(USER_A), args, "r");
  };
  const rt = (over: Record<string, unknown> = {}) => h.service.queryGa4Realtime(h.principal(USER_A), { propertyId: "200", ...over }, "r");
  const reports = () => client.calls.filter((c) => c.op === "runReport");
  return { client, h, q, rt, reports };
}

describe("GA4: the plain report that used to fail", () => {
  it("pagePath + activeUsers works and never sends fields the user did not ask for", async () => {
    const { client, q } = setup();
    const r = await q({ dimensions: ["pagePath"], metrics: ["activeUsers"], lastDays: 28 });
    expect(r.rows.length).toBeGreaterThan(0);
    const compat = client.calls.find((c) => c.op === "checkCompatibility")!.request as { dimensions: string[]; metrics: string[] };
    expect(compat).toEqual({ dimensions: ["pagePath"], metrics: ["activeUsers"] });
  });

  it("checks filter fields for compatibility too, and names the offending field", async () => {
    const { client, q } = setup();
    await q({ dimensions: ["landingPage"], metrics: ["sessions"], dimensionFilters: [{ field: "sessionDefaultChannelGroup", matchType: "EXACT", value: "Organic Search" }] });
    const compat = client.calls.find((c) => c.op === "checkCompatibility")!.request as { dimensions: string[] };
    expect(compat.dimensions).toEqual(["landingPage", "sessionDefaultChannelGroup"]);
    await expect(q({ dimensions: ["itemName"], metrics: ["sessions"], dimensionFilters: [{ field: "landingPage", matchType: "CONTAINS", value: "/" }] })).rejects.toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
  });
});

describe("GA4: totals, labels, summary, next step", () => {
  it("returns whole-range totals (distinct users, not a row sum), readable labels, a summary and a next step", async () => {
    const { q } = setup();
    const r = await q({ dimensions: ["pagePath"], metrics: ["activeUsers", "sessions", "engagementRate"], limit: 3 });
    expect(r.totals).toMatchObject({ activeUsers: expect.any(Number), sessions: expect.any(Number) });
    expect(r.totals!.sessions!).toBeGreaterThanOrEqual(r.rows.reduce((n, x) => n + Number(x.sessions), 0));
    expect(r.summary).toMatch(/: \d+ row\(s\) from 2026-09-01 to 2026-09-28/);
    expect(r.summary).toMatch(/Totals: Active users [\d,]+, Sessions [\d,]+, Engagement rate \d+\.\d%/);
    expect(r.summary).toMatch(/Top row: /);
    expect(r.providerMetadata!.fieldLabels).toMatchObject({ activeUsers: "Active users", pagePath: "Page path + query string" });
    expect(r.nextStep).toMatch(/offset 3|compareTo/);
    expect(r.warnings.map((w) => w.code)).toContain("UNIQUE_METRICS_NOT_ADDITIVE");
  });

  it("tells the reader the next offset when more rows exist", async () => {
    const { q } = setup();
    const r = await q({ dimensions: ["pagePath"], metrics: ["sessions"], limit: 2 });
    expect(r.nextStep).toBe("Ask for the next page with offset 2.");
  });
});

describe("GA4: presets", () => {
  it("organic_landing_pages = landingPage x active users, Organic Search only, best first", async () => {
    const { q, reports } = setup();
    const r = await q({ preset: "organic_landing_pages", lastDays: 28, dimensions: ["country"], metrics: ["eventCount"] });
    const req = reports().at(-1)!.request as { dimensions: Array<{ name: string }>; metrics: Array<{ name: string }>; dimensionFilter: unknown; orderBys: Array<{ metric: { metricName: string } }> };
    expect(req.dimensions).toEqual([{ name: "landingPage" }]);
    expect(req.metrics.map((m) => m.name)).toEqual(["activeUsers", "sessions", "engagementRate", "keyEvents"]);
    expect(JSON.stringify(req.dimensionFilter)).toContain("Organic Search");
    expect(req.orderBys[0]!.metric.metricName).toBe("activeUsers");
    expect(r.summary).toMatch(/^Top organic landing pages by active users\./);
    const users = r.rows.map((x) => Number(x.activeUsers));
    expect(users).toEqual([...users].sort((a, b) => b - a));
  });

  it.each(["sessions_by_channel", "key_events_by_page", "new_vs_returning", "traffic_trend", "organic_landing_pages"] as const)("%s runs for 7, 28 and 90 days", async (preset) => {
    const { q } = setup();
    for (const lastDays of [7, 28, 90]) {
      const r = await q({ preset, lastDays });
      expect(r.report.period).toMatchObject({ lastDays });
      expect(r.summary).toBeTruthy();
    }
  });

  it("traffic_trend is oldest-first by day and fits a 90 day window", async () => {
    const { q } = setup();
    const r = await q({ preset: "traffic_trend", lastDays: 90 });
    const dates = r.rows.map((x) => String(x.date));
    expect(dates).toEqual([...dates].sort());
    expect(r.completeness).toBe("complete");
  });

  it("keeps the caller's own filters on top of the preset's", async () => {
    const { q, reports } = setup();
    await q({ preset: "sessions_by_channel", dimensionFilters: [{ field: "country", matchType: "EXACT", value: "India" }] });
    expect(JSON.stringify((reports().at(-1)!.request as { dimensionFilter: unknown }).dimensionFilter)).toContain("India");
  });
});

describe("GA4: period comparison", () => {
  it("fetches the equal-length previous range and adds previous/change columns and a plain summary", async () => {
    const { q, reports } = setup();
    const r = await q({ dimensions: ["pagePath"], metrics: ["sessions", "activeUsers"], compareTo: "previous_period", limit: 5 });
    expect(reports().map((c) => (c.request as { dateRanges: Array<{ startDate: string }> }).dateRanges[0]!.startDate)).toEqual(["2026-09-01", "2026-08-04"]);
    const row = r.rows[0]!;
    expect(row).toHaveProperty("previousSessions");
    expect(row).toHaveProperty("sessionsChange");
    expect(row).toHaveProperty("activeUsersChangePct");
    expect(r.comparison).toMatchObject({ startDate: "2026-08-04", endDate: "2026-08-31" });
    expect(r.comparison!.change).toHaveProperty("sessionsPct");
    expect(r.summary).toMatch(/Compared with the previous period \(2026-08-04 to 2026-08-31\): Sessions [+-]?[\d.]+% /);
    expect(r.nextStep).toMatch(/sessionsChange/);
  });

  it("previous_year compares the same dates one year back", async () => {
    const { q, reports } = setup();
    await q({ compareTo: "previous_year" });
    expect((reports().at(-1)!.request as { dateRanges: Array<{ startDate: string; endDate: string }> }).dateRanges[0]).toEqual({ startDate: "2025-09-01", endDate: "2025-09-28" });
  });

  it("by date, only the totals are compared", async () => {
    const { q } = setup();
    const r = await q({ preset: "traffic_trend", compareTo: "previous_period" });
    expect(r.warnings.map((w) => w.code)).toContain("COMPARISON_TOTALS_ONLY");
    expect(r.comparison).toBeDefined();
  });

  it("a failed comparison keeps the current data and says why", async () => {
    const { q, client } = setup();
    const real = client.runReport.bind(client);
    let n = 0;
    client.runReport = async (...a: Parameters<typeof real>) => {
      if (++n >= 2) throw new Error("boom"); // every retry fails too
      return real(...a);
    };
    const r = await q({ compareTo: "previous_period" });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.comparison).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toContain("COMPARISON_UNAVAILABLE");
  });

  it("explains a comparison range before GA4 existed", async () => {
    const { q } = setup();
    const r = await q({ startDate: "2015-08-20", endDate: "2015-09-20", compareTo: "previous_period" });
    expect(r.warnings.find((w) => w.code === "COMPARISON_UNAVAILABLE")?.message).toMatch(/before GA4 has any data/);
  });

  it("merge: rows with no earlier match get empty previous values, never zero", () => {
    const base = { provider: "ga4", rows: [{ page: "/a", sessions: 10 }, { page: "/new", sessions: 4 }], warnings: [], totals: { sessions: 14 }, rowCountReportedByProvider: 2, rowCountReturned: 2, summary: "S." } as unknown as NormalizedReportResult;
    const prev = { ...base, rows: [{ page: "/a", sessions: 5 }], totals: { sessions: 7 }, rowCountReturned: 1, rowCountReportedByProvider: 1 } as unknown as NormalizedReportResult;
    const out = mergeGa4Comparison(base, prev, ["page"], ["sessions"], { label: "the previous period", startDate: "a", endDate: "b" });
    expect(out.rows[0]).toMatchObject({ previousSessions: 5, sessionsChange: 5, sessionsChangePct: 100 });
    expect(out.rows[1]).toMatchObject({ previousSessions: null, sessionsChange: null, sessionsChangePct: null });
    expect(out.comparison!.change).toMatchObject({ sessions: 7, sessionsPct: 100 });
  });
});

describe("GA4: multi-dimension reports with metric filters and paging", () => {
  it("pages without overlap and filters on a metric", async () => {
    const { q } = setup();
    const args = { dimensions: ["country", "deviceCategory"], metrics: ["sessions", "activeUsers"], metricFilters: [{ field: "sessions", operator: "GREATER_THAN", value: 5 }], limit: 4 };
    const p1 = await q(args);
    const p2 = await q({ ...args, offset: 4 });
    const keys = [...p1.rows, ...p2.rows].map((r) => `${r.country}|${r.deviceCategory}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...p1.rows, ...p2.rows].every((r) => Number(r.sessions) > 5)).toBe(true);
    expect(p1.warnings.map((w) => w.code)).toContain("MORE_ROWS_AVAILABLE");
  });

  it("country and device splits work with one query each", async () => {
    const { q } = setup();
    for (const dim of ["country", "deviceCategory"]) expect((await q({ dimensions: [dim], metrics: ["sessions"] })).rows.length).toBeGreaterThan(0);
  });
});

describe("GA4: caching", () => {
  it("serves a repeat from cache; fresh=true asks Google again", async () => {
    const { q, reports } = setup();
    await q();
    await q();
    expect(reports()).toHaveLength(1);
    const again = await q({ fresh: true });
    expect(reports()).toHaveLength(2);
    expect(again.cache.hit).toBe(false);
  });
});

describe("GA4: data-quality warnings in plain English", () => {
  const withRows = (rows: Ga4RunReportResponse["rows"], extra: Partial<Ga4RunReportResponse> = {}) => ({ rows, rowCount: rows.length, totals: rows[0] ? rows[0].metrics : null, ...extra });
  it('flags "(not set)" and "(other)" rows', async () => {
    const { q, client } = setup();
    client.override = withRows([{ dimensions: ["(not set)"], metrics: ["5"] }, { dimensions: ["(other)"], metrics: ["2"] }]);
    const r = await q({ dimensions: ["pagePath"], metrics: ["sessions"] });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("NOT_SET_VALUES");
    expect(codes).toContain("OTHER_ROW_PRESENT");
  });

  it("reports thresholding, sampling and the grouped (other) row, and marks the result partial", async () => {
    const { q, client } = setup();
    client.override = withRows([{ dimensions: ["/a"], metrics: ["5"] }], { subjectToThresholding: true, dataLossFromOtherRow: true, sampling: [{ samplesReadCount: "500", samplingSpaceSize: "1000" }] });
    const r = await q({ dimensions: ["pagePath"], metrics: ["sessions"] });
    expect(r.completeness).toBe("partial");
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["THRESHOLDING_APPLIED", "OTHER_ROW_AGGREGATION", "SAMPLED_DATA"]));
    expect(r.warnings.find((w) => w.code === "SAMPLED_DATA")!.message).toMatch(/50%/);
    expect(r.nextStep).toMatch(/Narrow the date range/);
  });

  it("an empty period says so", async () => {
    const { q, client } = setup();
    client.override = withRows([]);
    const r = await q();
    expect(r.warnings.map((w) => w.code)).toContain("NO_DATA");
    expect(r.summary).toMatch(/no rows/);
  });
});

describe("GA4: realtime", () => {
  it("answers who is on the site now, with totals, a summary and a not-final warning", async () => {
    const { rt } = setup();
    const r = await rt({ dimensions: ["country"], metrics: ["activeUsers", "screenPageViews"], minutes: 30 });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.totals).toMatchObject({ activeUsers: expect.any(Number) });
    expect(r.summary).toMatch(/: \d+ row\(s\) \(the last 30 minutes\)\. Totals: Active users \d+, Views \d+\./);
    expect(r.warnings.map((w) => w.code)).toContain("REALTIME_NOT_FINAL");
    expect(r.report).toMatchObject({ startDate: null, endDate: null });
  });

  it("is never served from the cache", async () => {
    const { rt, client } = setup();
    await rt();
    await rt();
    expect(client.calls.filter((c) => c.op === "runRealtimeReport")).toHaveLength(2);
  });

  it("sends the minute window to Google", async () => {
    const { rt, client } = setup();
    await rt({ minutes: 5 });
    expect((client.calls.find((c) => c.op === "runRealtimeReport")!.request as { minuteRanges: unknown }).minuteRanges).toEqual([{ startMinutesAgo: 4, endMinutesAgo: 0 }]);
  });

  it("rejects standard-report fields with the list of valid ones", async () => {
    const { rt, client } = setup();
    await expect(rt({ dimensions: ["pagePath"] })).rejects.toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE", message: expect.stringMatching(/pagePath/) });
    expect(client.calls.filter((c) => c.op === "runRealtimeReport")).toHaveLength(0);
  });

  it("cannot read a property the user does not own", async () => {
    const { h } = setup();
    await expect(h.service.queryGa4Realtime(h.principal(USER_A), { propertyId: "999" }, "r")).rejects.toMatchObject({ code: expect.stringMatching(/PROPERTY/) });
  });
});
