import { describe, expect, it } from "vitest";
import { FakeAdapter, USER_A, ga4Query, gscQuery, harness } from "./fixture.js";

const R = "req";

describe("date normalization", () => {
  it("resolves lastDays for Search Console in Pacific Time, ending on the last finalized day", async () => {
    // 2026-10-19 03:00Z is still the evening of 2026-10-18 in Pacific Time.
    const h = harness();
    h.clock.ms = Date.parse("2026-10-19T03:00:00Z");
    const r = await h.service.queryGsc(h.principal(USER_A), { propertyId: "sc-domain:shared.example", lastDays: 7 }, R);
    expect(h.gsc.calls[0]!.query).toMatchObject({ startDate: "2026-10-10", endDate: "2026-10-16" });
    expect(h.gsc.calls[0]!.query).not.toHaveProperty("lastDays");
    expect(r.report.period).toEqual({ resolvedFrom: "lastDays", lastDays: 7, timeZone: "America/Los_Angeles" });
  });

  it("lets Search Console include the still-changing latest day only when dataState is all", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), { propertyId: "sc-domain:shared.example", lastDays: 3, dataState: "all" }, R);
    expect(h.gsc.calls[0]!.query).toMatchObject({ startDate: "2026-10-16", endDate: "2026-10-18" });
  });

  it("resolves lastDays for GA4 in each property's own time zone", async () => {
    // At 2026-10-19 03:00Z it is the 19th in Auckland (16:00) but still the evening of the 18th in New York (23:00).
    const h = harness();
    h.clock.ms = Date.parse("2026-10-19T03:00:00Z");
    const nz = await h.service.queryGa4(h.principal(USER_A), { propertyId: "100", lastDays: 7, dimensions: ["pagePath"], metrics: ["sessions"] }, R);
    const ny = await h.service.queryGa4(h.principal(USER_A), { propertyId: "200", lastDays: 7, dimensions: ["pagePath"], metrics: ["sessions"] }, R);
    expect(h.ga4.calls[0]!.query).toMatchObject({ startDate: "2026-10-12", endDate: "2026-10-18" });
    expect(h.ga4.calls[1]!.query).toMatchObject({ startDate: "2026-10-11", endDate: "2026-10-17" });
    expect(nz.report.period).toMatchObject({ timeZone: "Pacific/Auckland" });
    expect(ny.report.period).toMatchObject({ timeZone: "America/New_York" });
  });

  it("passes explicit dates through unchanged and reports them as explicit", async () => {
    const h = harness();
    const r = await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    expect(h.gsc.calls[0]!.query).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-28" });
    expect(r.report.period).toEqual({ resolvedFrom: "explicit", timeZone: "America/Los_Angeles" });
  });

  it.each([
    ["both forms", { lastDays: 7 }],
    ["neither form", { startDate: undefined, endDate: undefined }],
    ["only a start date", { endDate: undefined }],
    ["reversed dates", { startDate: "2026-09-28", endDate: "2026-09-01" }],
    ["lastDays of zero", { startDate: undefined, endDate: undefined, lastDays: 0 }],
    ["fractional lastDays", { startDate: undefined, endDate: undefined, lastDays: 2.5 }],
    ["lastDays over the cap", { startDate: undefined, endDate: undefined, lastDays: 501 }],
    ["an impossible calendar date", { startDate: "2026-02-31" }],
  ])("rejects %s before any provider call", async (_name, over) => {
    const h = harness();
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(over), R)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_QUERY|DATE_RANGE_UNSUPPORTED/) });
    expect(h.gsc.calls).toHaveLength(0);
  });

  it("keeps the different availability rules: GSC 16-month retention vs GA4 history, and no future days", async () => {
    const h = harness();
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2024-01-01" }), R)).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
    // The same old range is fine for GA4 (it keeps history back to 2015).
    await expect(h.service.queryGa4(h.principal(USER_A), ga4Query({ startDate: "2024-01-01" }), R)).resolves.toMatchObject({ rowCountReturned: 1 });
    await expect(h.service.queryGa4(h.principal(USER_A), ga4Query({ endDate: "2026-10-25" }), R)).rejects.toMatchObject({ code: "DATE_RANGE_UNSUPPORTED" });
  });

  it("flags incomplete recent data differently per provider", async () => {
    const h = harness();
    const gsc = await h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2026-10-10", endDate: "2026-10-18" }), R);
    expect(gsc.warnings.map((w) => w.code)).toContain("RECENT_DATA_INCOMPLETE");
    const ga4 = await h.service.queryGa4(h.principal(USER_A), ga4Query({ startDate: "2026-10-10", endDate: "2026-10-19", propertyId: "200" }), R);
    expect(ga4.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["PARTIAL_DAY"]));
  });
});

describe("filter normalization", () => {
  it("treats equivalent filters as one request: reordered, repeated and differently-cased", async () => {
    const h = harness();
    const f1 = [
      { dimension: "country", operator: "equals", expression: "usa" },
      { dimension: "device", operator: "equals", expression: "mobile" },
    ];
    const f2 = [
      { dimension: "device", operator: "equals", expression: " MOBILE " },
      { dimension: "country", operator: "equals", expression: "USA" },
      { dimension: "country", operator: "equals", expression: "usa" },
    ];
    const first = await h.service.queryGsc(h.principal(USER_A), gscQuery({ filters: f1 }), R);
    const second = await h.service.queryGsc(h.principal(USER_A), gscQuery({ filters: f2 }), R);
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(h.gsc.calls).toHaveLength(1);
    expect((h.gsc.calls[0]!.query as { filters: unknown[] }).filters).toHaveLength(2);
  });

  it("does not merge genuinely different filters", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), gscQuery({ filters: [{ dimension: "country", operator: "equals", expression: "usa" }] }), R);
    await h.service.queryGsc(h.principal(USER_A), gscQuery({ filters: [{ dimension: "country", operator: "equals", expression: "can" }] }), R);
    expect(h.gsc.calls).toHaveLength(2);
  });

  it("normalizes GA4 filters the same way", async () => {
    const h = harness();
    const a = [{ field: "pagePath", matchType: "CONTAINS", value: " /blog " }];
    const b = [{ field: "pagePath", matchType: "CONTAINS", value: "/blog" }, { field: "pagePath", matchType: "CONTAINS", value: "/blog" }];
    await h.service.queryGa4(h.principal(USER_A), ga4Query({ dimensionFilters: a }), R);
    expect((await h.service.queryGa4(h.principal(USER_A), ga4Query({ dimensionFilters: b }), R)).cache.hit).toBe(true);
    expect(h.ga4.calls).toHaveLength(1);
  });

  it("caps the row limit at the server maximum", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), gscQuery({ limit: 1000 }), R);
    h.gsc.calls.length = 0;
    const small = harness({ env: { MAX_REPORT_ROWS_HARD_LIMIT: 50 } });
    await small.service.queryGsc(small.principal(USER_A), gscQuery({ limit: 1000 }), R);
    expect(small.gsc.calls[0]!.query.limit).toBe(50);
  });
});

describe("consistent results", () => {
  it("every provider returns the same envelope", async () => {
    const h = harness();
    const a = await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    const b = await h.service.queryGa4(h.principal(USER_A), ga4Query(), R);
    const shape = (r: object) => Object.keys(r).sort();
    expect(shape(a)).toEqual(shape(b));
    expect(a.requestId).toBe(R);
    expect(a.cache).toEqual({ hit: false, ageSeconds: 0 });
  });

  it("fake adapter sanity: FakeAdapter is reused across tests without shared state", () => {
    expect(new FakeAdapter("gsc").calls).toEqual([]);
  });
});
