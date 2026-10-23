/**
 * GA4 Reports areas: Acquisition, Engagement, Audience, Retention, Monetization. Filters (AND/OR/NOT/regex/list), every preset
 * across 7/28/90 days with and without comparison, the purchase funnel, and cohort retention.
 * DATA SOURCE: MOCK (MockGa4ApiClient behind the real adapter and report service). No Google call is made.
 */
import { describe, expect, it } from "vitest";
import { GA4_PRESETS, Ga4FilterSchema, QueryGa4CohortSchema, QueryGa4Schema } from "@serp/contracts";
import { GA4_PRESET_DEFS, GoogleGa4Adapter, MockGa4ApiClient, planCohorts } from "@serp/provider-ga4";
import { NOON, USER_A, harness, ga4Query } from "../reporting-layer/fixture.js";

const now = () => new Date(NOON);
const accounts = [{ accountId: "1", displayName: "Co", properties: [{ propertyId: "200", displayName: "Site 200", propertyType: "PROPERTY_TYPE_ORDINARY" }] }];

function setup() {
  const client = new MockGa4ApiClient({ accounts, now, timeZones: { "200": "America/New_York" } });
  const h = harness({ deps: { ga4: new GoogleGa4Adapter({ client, now, getAccessToken: async () => "t" }) as never } });
  const q = (over: Record<string, unknown> = {}) => {
    const args: Record<string, unknown> = ga4Query({ propertyId: "200", ...over });
    if (over.lastDays !== undefined) delete args.startDate, delete args.endDate;
    return h.service.queryGa4(h.principal(USER_A), args, "r");
  };
  const cohort = (over: Record<string, unknown> = {}) => h.service.queryGa4Cohort(h.principal(USER_A), { propertyId: "200", ...over }, "r");
  const lastReport = () => client.calls.filter((c) => c.op === "runReport").at(-1)!.request as Record<string, unknown>;
  return { client, q, cohort, lastReport };
}

describe("filters: AND / OR / NOT / regex / list", () => {
  const f = (over: Record<string, unknown>) => ({ field: "country", matchType: "EXACT", value: "India", ...over });

  it("OR matches any filter; the default still needs all", async () => {
    const { q, lastReport } = setup();
    const filters = [f({}), f({ value: "Canada" })];
    const any = await q({ dimensions: ["country"], metrics: ["sessions"], dimensionFilters: filters, filterMode: "or" });
    expect(any.rows.map((r) => r.country).sort()).toEqual(["Canada", "India"]);
    expect(Object.keys(lastReport().dimensionFilter as object)).toEqual(["orGroup"]);
    const all = await q({ dimensions: ["country"], metrics: ["sessions"], dimensionFilters: filters });
    expect(all.rows).toHaveLength(0);
  });

  it("exclude keeps only rows that do NOT match", async () => {
    const { q } = setup();
    const r = await q({ dimensions: ["sessionDefaultChannelGroup"], metrics: ["sessions"], dimensionFilters: [f({ field: "sessionDefaultChannelGroup", value: "Direct", exclude: true })] });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.map((x) => x.sessionDefaultChannelGroup)).not.toContain("Direct");
  });

  it("supports whole-value and partial regular expressions", async () => {
    const { q } = setup();
    const full = await q({ dimensions: ["pagePath"], metrics: ["sessions"], dimensionFilters: [f({ field: "pagePath", matchType: "FULL_REGEXP", value: "/blog/post-\\d+" })] });
    expect(full.rows.length).toBeGreaterThan(0);
    expect(full.rows.every((r) => /^\/blog\/post-\d+$/.test(String(r.pagePath)))).toBe(true);
    const part = await q({ dimensions: ["pagePath"], metrics: ["sessions"], dimensionFilters: [f({ field: "pagePath", matchType: "PARTIAL_REGEXP", value: "seo|link" })] });
    expect(part.rows.map((r) => r.pagePath).sort()).toEqual(["/blog/link-building", "/blog/seo-basics"]);
  });

  it("IN_LIST matches any listed value", async () => {
    const { q } = setup();
    const r = await q({ dimensions: ["deviceCategory"], metrics: ["sessions"], dimensionFilters: [{ field: "deviceCategory", matchType: "IN_LIST", values: ["mobile", "tablet"] }] });
    expect(r.rows.map((x) => x.deviceCategory).sort()).toEqual(["mobile", "tablet"]);
  });

  it("rejects an invalid regular expression with a plain message, before calling Google", async () => {
    const { q, client } = setup();
    await expect(q({ dimensionFilters: [f({ field: "pagePath", matchType: "PARTIAL_REGEXP", value: "([" })] })).rejects.toMatchObject({ code: "INVALID_QUERY", message: expect.stringMatching(/regular expression/) });
    expect(client.calls.filter((c) => c.op === "runReport")).toHaveLength(0);
  });

  it("the schema enforces value for text matches and values for IN_LIST", () => {
    expect(Ga4FilterSchema.safeParse({ field: "country", matchType: "IN_LIST", value: "x" }).success).toBe(false);
    expect(Ga4FilterSchema.safeParse({ field: "country", matchType: "EXACT" }).success).toBe(false);
    expect(Ga4FilterSchema.safeParse({ field: "country", matchType: "IN_LIST", values: ["a"] }).success).toBe(true);
  });
});

describe("every preset: 7, 28 and 90 days, with and without comparison and a filter", () => {
  const combos = GA4_PRESETS.flatMap((p) => [7, 28, 90].map((d) => [p, d] as const));
  it.each(combos)("%s over %i days", async (preset, lastDays) => {
    const { q } = setup();
    const plain = await q({ preset, lastDays });
    expect(plain.summary).toBeTruthy();
    expect(plain.nextStep).toBeTruthy();
    expect(plain.report.period).toMatchObject({ lastDays });
    const def = GA4_PRESET_DEFS[preset];
    if (def.note) expect(plain.warnings.map((w) => w.code)).toContain("PRESET_NOTE");

    const compared = await q({ preset, lastDays, compareTo: "previous_period" });
    expect(compared.warnings.map((w) => w.code)).not.toContain("COMPARISON_UNAVAILABLE");
    if (preset !== "ecommerce_funnel") expect(compared.summary).toMatch(/Compared with the previous period/);
    expect(compared.comparison).toBeDefined();

    const filtered = await q({ preset, lastDays, dimensionFilters: [{ field: "country", matchType: "IN_LIST", values: ["India", "Canada"] }] }).catch((e) => e);
    // A preset whose dimension cannot be combined with a country filter is refused with a clear error, never a wrong answer.
    if (filtered instanceof Error) expect((filtered as { code?: string }).code).toBe("DIMENSION_METRIC_INCOMPATIBLE");
    else expect(filtered.summary).toBeTruthy();
  });
});

describe("report areas", () => {
  it("Acquisition: channel and medium together, first-touch users, source / medium, campaigns", async () => {
    const { q } = setup();
    const cm = await q({ preset: "traffic_by_channel_medium" });
    expect(cm.rows[0]).toHaveProperty("sessionDefaultChannelGroup");
    expect(cm.rows[0]).toHaveProperty("sessionMedium");
    expect((await q({ preset: "traffic_by_source_medium" })).rows[0]).toHaveProperty("sessionSourceMedium");
    expect((await q({ preset: "user_acquisition_by_channel" })).rows[0]).toHaveProperty("firstUserDefaultChannelGroup");
    expect((await q({ preset: "traffic_by_campaign" })).rows[0]).toHaveProperty("sessionCampaignName");
    expect((await q({ preset: "new_vs_returning" })).rows.map((r) => r.newVsReturning).sort()).toEqual(["new", "returning"]);
  });

  it("Engagement: pages, events, landing pages and engagement time", async () => {
    const { q } = setup();
    const pages = await q({ preset: "engagement_by_page", compareTo: "previous_period", limit: 5 });
    expect(pages.rows[0]).toMatchObject({ screenPageViews: expect.any(Number), userEngagementDuration: expect.any(Number) });
    expect(pages.rows[0]).toHaveProperty("screenPageViewsChangePct");
    expect((await q({ preset: "events_overview" })).rows[0]).toHaveProperty("eventName");
    expect((await q({ preset: "landing_pages" })).rows[0]).toHaveProperty("landingPage");
  });

  it("Audience: device, country, city, age and gender breakdowns (demographics carry a plain caveat)", async () => {
    const { q } = setup();
    for (const [preset, dim] of [["device_breakdown", "deviceCategory"], ["country_breakdown", "country"], ["city_breakdown", "city"], ["age_breakdown", "userAgeBracket"], ["gender_breakdown", "userGender"]] as const) {
      expect((await q({ preset })).rows[0]).toHaveProperty(dim);
    }
    const age = await q({ preset: "age_breakdown" });
    expect(age.warnings.find((w) => w.code === "PRESET_NOTE")!.message).toMatch(/Google signals/);
  });

  it("Retention: stickiness shows DAU/MAU as percentages", async () => {
    const { q } = setup();
    const r = await q({ preset: "user_stickiness" });
    expect(r.rows).toHaveLength(1);
    expect(r.summary).toMatch(/DAU \/ MAU \d+\.\d%/);
  });

  it("Monetization: revenue by product, category, channel, promotions and lifetime value", async () => {
    const { q } = setup();
    const products = await q({ preset: "revenue_by_product", compareTo: "previous_year", limit: 3 });
    expect(products.rows[0]).toMatchObject({ itemName: expect.any(String), itemRevenue: expect.any(Number) });
    expect(products.rows[0]).toHaveProperty("itemRevenueChangePct");
    const revenue = products.rows.map((r) => Number(r.itemRevenue));
    expect(revenue).toEqual([...revenue].sort((a, b) => b - a));
    expect((await q({ preset: "revenue_by_category" })).rows[0]).toHaveProperty("itemCategory");
    expect((await q({ preset: "revenue_by_channel" })).rows[0]).toHaveProperty("totalRevenue");
    expect((await q({ preset: "promotions_performance" })).rows[0]).toHaveProperty("itemPromotionName");
    const ltv = await q({ preset: "lifetime_value_by_channel" });
    expect(ltv.warnings.find((w) => w.code === "PRESET_NOTE")!.message).toMatch(/Data API/);
  });

  it("Purchase journey: ordered steps with continue-rates and the biggest drop", async () => {
    const { q } = setup();
    const r = await q({ preset: "ecommerce_funnel", lastDays: 28 });
    expect(r.rows.map((x) => x.step)).toEqual(["Sessions", "Items viewed", "Add to carts", "Checkouts", "Ecommerce purchases"]);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toMatchObject({ fromPreviousPct: null, fromFirstPct: null });
    expect(r.rows[2]!.fromPreviousPct).toBeGreaterThan(0);
    expect(r.rows[4]!.fromFirstPct).toBeLessThan(r.rows[1]!.fromFirstPct as number);
    expect(r.summary).toMatch(/^Purchase journey: .* The biggest drop is before/);
    expect(r.warnings.find((w) => w.code === "PRESET_NOTE")!.message).toMatch(/events/);
  });

  it("Custom and ad-hoc fields still work: any metric GA4 lists, with a filter, order and paging", async () => {
    const { q } = setup();
    const r = await q({ dimensions: ["itemBrand", "itemName"], metrics: ["itemRevenue", "itemsViewed"], metricFilters: [{ field: "itemRevenue", operator: "GREATER_THAN", value: 0 }], orderBy: { field: "itemRevenue", direction: "desc" }, limit: 4 });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(4);
  });
});

describe("cohort retention", () => {
  it("plans complete Sunday-to-Saturday weeks that end before today", () => {
    for (const today of ["2026-10-19", "2026-10-17", "2026-10-18", "2026-10-24"]) {
      const weeks = planCohorts("WEEKLY", 4, today);
      expect(weeks).toHaveLength(4);
      weeks.forEach((w, i) => {
        expect(new Date(`${w.startDate}T00:00:00Z`).getUTCDay()).toBe(0);
        expect(new Date(`${w.endDate}T00:00:00Z`).getUTCDay()).toBe(6);
        expect((Date.parse(w.endDate) - Date.parse(w.startDate)) / 86_400_000).toBe(6);
        if (i > 0) expect((Date.parse(w.startDate) - Date.parse(weeks[i - 1]!.endDate)) / 86_400_000).toBe(1);
      });
      expect(weeks.at(-1)!.endDate < today).toBe(true);
      expect((Date.parse(today) - Date.parse(weeks.at(-1)!.endDate)) / 86_400_000).toBeLessThanOrEqual(7);
    }
  });

  it("plans whole calendar months and single days, never including today", () => {
    expect(planCohorts("MONTHLY", 3, "2026-10-19")).toEqual([
      { name: "2026-07", startDate: "2026-07-01", endDate: "2026-07-31" },
      { name: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31" },
      { name: "2026-09", startDate: "2026-09-01", endDate: "2026-09-30" },
    ]);
    expect(planCohorts("MONTHLY", 1, "2026-01-05")[0]).toMatchObject({ startDate: "2025-12-01", endDate: "2025-12-31" });
    const days = planCohorts("DAILY", 3, "2026-10-19");
    expect(days.map((d) => d.startDate)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
  });

  it("asks Google for cohorts without date ranges and shows retention against period 0", async () => {
    const { cohort, lastReport } = setup();
    const r = await cohort({ granularity: "WEEKLY", cohorts: 4, periods: 5 });
    const req = lastReport() as { dateRanges?: unknown; cohortSpec: { cohortsRange: unknown; cohorts: unknown[] }; dimensions: Array<{ name: string }> };
    expect(req.dateRanges).toBeUndefined();
    expect(req.cohortSpec.cohorts).toHaveLength(4);
    expect(req.cohortSpec.cohortsRange).toEqual({ granularity: "WEEKLY", startOffset: 0, endOffset: 4 });
    expect(req.dimensions.map((d) => d.name)).toEqual(["cohort", "cohortNthWeek"]);
    expect(r.rows).toHaveLength(20);
    expect(r.rows.filter((x) => x.week === 0).every((x) => x.retentionPct === 100)).toBe(true);
    const w1 = r.rows.filter((x) => x.week === 1).map((x) => Number(x.retentionPct));
    expect(w1.every((p) => p > 0 && p < 100)).toBe(true);
    expect(r.summary).toMatch(/4 weekly cohort\(s\).*were still active in week 1/);
    expect(r.providerMetadata!.averageRetention).toHaveProperty("1");
  });

  it("warns that the newest cohorts are still maturing", async () => {
    const { cohort } = setup();
    expect((await cohort({ granularity: "WEEKLY", cohorts: 2, periods: 6 })).warnings.map((w) => w.code)).toContain("COHORTS_STILL_MATURING");
  });

  it("works for daily and monthly cohorts and for the cohort-size metric", async () => {
    const { cohort } = setup();
    const d = await cohort({ granularity: "DAILY", cohorts: 3, periods: 3 });
    expect(d.rows[0]).toHaveProperty("day");
    const m = await cohort({ granularity: "MONTHLY", cohorts: 2, periods: 2, metric: "cohortTotalUsers" });
    expect(m.rows[0]).toHaveProperty("cohortTotalUsers");
    expect(m.rows[0]).not.toHaveProperty("retentionPct");
  });

  it("rejects out-of-range requests", () => {
    expect(QueryGa4CohortSchema.safeParse({ propertyId: "1", cohorts: 40 }).success).toBe(false);
    expect(QueryGa4Schema.safeParse({ propertyId: "1", lastDays: 7, preset: "nope" }).success).toBe(false);
  });
});
