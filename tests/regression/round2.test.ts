/**
 * Round 2 (audit fixes): paging, totals, summary, period comparison, cache bypass, softer auth failure.
 * DATA SOURCE: MOCK. No provider is called.
 */
import { describe, expect, it } from "vitest";
import { QueryGscSchema, type AuthorizedQueryContext } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import { GoogleGscAdapter, MockGscApiClient } from "@serp/provider-gsc";
import { mergeGscComparison, previousRange } from "@serp/reporting";
import { USER_A, harness, gscQuery } from "../reporting-layer/fixture.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const ctx: AuthorizedQueryContext = {
  userId: MOCK_USER_A_ID,
  requestId: "req-1",
  property: { id: "p1", userId: MOCK_USER_A_ID, connectionId: "c1", provider: "gsc", externalPropertyId: "sc-domain:example.com", displayName: "example.com", propertyType: "domain", timezone: "America/Los_Angeles", enabledForMcp: true },
  connection: { id: "c1", userId: MOCK_USER_A_ID, provider: "google", providerAccountId: "sub", accountLabel: "a***@x.test", status: "connected", grantedScopes: [], lastValidatedAt: null, lastErrorCode: null },
};
const parse = (over: Record<string, unknown> = {}) => QueryGscSchema.parse({ propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14", ...over });
const adapter = (client = new MockGscApiClient({ now: () => NOW })) => ({ client, a: new GoogleGscAdapter({ client, now: () => NOW, getAccessToken: async () => "t" }) });

describe("GSC adapter: totals, summary, paging", () => {
  it("adds whole-range totals from an ungrouped call and a plain-language summary", async () => {
    const { client, a } = adapter();
    const r = await a.query(parse({ dimensions: ["page"], limit: 5 }), ctx);
    const totalsCall = client.calls.filter((c) => c.op === "query").at(-1)!;
    expect(totalsCall.body!.dimensions).toEqual([]);
    expect(r.totals).toMatchObject({ clicks: expect.any(Number), impressions: expect.any(Number) });
    expect(Number(r.totals!.clicks)).toBeGreaterThanOrEqual(r.rows.reduce((n, x) => n + Number(x.clicks), 0));
    expect(r.summary).toMatch(/clicks from .* impressions/);
    expect(r.summary).toMatch(/page with the most clicks/);
    expect(r.nextStep).toBeTruthy();
  });

  it("keeps the rows when the totals call fails, and says so", async () => {
    const client = new MockGscApiClient({ now: () => NOW });
    const real = client.querySearchAnalytics.bind(client);
    client.querySearchAnalytics = async (t, s, body, sig) => {
      if (body.dimensions.length === 0) throw new Error("boom");
      return real(t, s, body, sig);
    };
    const r = await adapter(client).a.query(parse({ dimensions: ["page"], limit: 5 }), ctx);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.totals).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).toContain("TOTALS_UNAVAILABLE");
  });

  it("pages with offset (clicks order): page 2 continues where page 1 stopped", async () => {
    const { a } = adapter();
    const p1 = await a.query(parse({ dimensions: ["query"], limit: 3 }), ctx);
    const p2 = await a.query(parse({ dimensions: ["query"], limit: 3, offset: 3 }), ctx);
    const all = await a.query(parse({ dimensions: ["query"], limit: 6 }), ctx);
    expect([...p1.rows, ...p2.rows].map((r) => r.query)).toEqual(all.rows.map((r) => r.query));
    expect(p1.warnings.map((w) => w.message).join(" ")).toMatch(/offset=3/);
  });

  it("pages locally when sorting by impressions, and tells the caller the next offset", async () => {
    const { a } = adapter();
    const p1 = await a.query(parse({ dimensions: ["query"], limit: 3, sortBy: "impressions" }), ctx);
    const p2 = await a.query(parse({ dimensions: ["query"], limit: 3, offset: 3, sortBy: "impressions" }), ctx);
    expect(Number(p1.rows.at(-1)!.impressions)).toBeGreaterThanOrEqual(Number(p2.rows[0]!.impressions));
    expect(p1.warnings.map((w) => w.code)).toContain("MORE_ROWS_AVAILABLE");
  });

  it("reports an empty result in plain words", async () => {
    const client = new MockGscApiClient({ now: () => NOW });
    client.override = { rows: [] };
    const r = await adapter(client).a.query(parse(), ctx);
    expect(r.summary).toMatch(/no data/);
  });
});

describe("period comparison", () => {
  it("previous_period is the same number of days right before; previous_year is the same dates a year back", () => {
    expect(previousRange("2026-09-15", "2026-09-28", "previous_period")).toEqual({ startDate: "2026-09-01", endDate: "2026-09-14" });
    expect(previousRange("2026-09-01", "2026-09-28", "previous_year")).toEqual({ startDate: "2025-09-01", endDate: "2025-09-28" });
    expect(previousRange("2024-02-29", "2024-02-29", "previous_year")).toEqual({ startDate: "2023-02-28", endDate: "2023-02-28" });
  });

  const base = (rows: Array<Record<string, number | string>>, totals: Record<string, number>) => ({ provider: "gsc", rows, totals, warnings: [], summary: "S." }) as never;
  it("matches rows by key, computes change and flags unmatched rows (empty, not zero)", () => {
    const cur = base([{ query: "a", clicks: 20, impressions: 200, ctr: 0.1, position: 3 }, { query: "new", clicks: 5, impressions: 50, ctr: 0.1, position: 9 }], { clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    const prev = base([{ query: "a", clicks: 10, impressions: 100, ctr: 0.1, position: 5 }], { clicks: 80, impressions: 1000, ctr: 0.08, position: 6 });
    const out = mergeGscComparison(cur, prev, ["query"], { label: "the previous period", startDate: "2026-09-01", endDate: "2026-09-14" });
    expect(out.rows[0]).toMatchObject({ previousClicks: 10, clicksChange: 10, clicksChangePct: 100, positionChange: -2 });
    expect(out.rows[1]).toMatchObject({ previousClicks: null, clicksChange: null });
    expect(out.warnings.map((w) => w.code)).toContain("COMPARISON_ROWS_NOT_FOUND");
    expect(out.comparison!.change).toMatchObject({ clicks: 20, clicksPct: 25, position: -1 });
    expect(out.summary).toMatch(/clicks \+25%.*improved by 1/);
  });

  it("through the service: a second, earlier query is made and the change appears on the rows", async () => {
    const h = harness();
    h.gsc.behave = (call) =>
      h.gsc.ok(call, {
        rows: [{ query: "a", clicks: call.query.startDate === "2026-09-01" ? 30 : 10, impressions: 100, ctr: 0.1, position: 4 }],
        totals: { clicks: call.query.startDate === "2026-09-01" ? 30 : 10, impressions: 100, ctr: 0.1, position: 4 },
        summary: "S.",
      });
    const r = await h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2026-09-01", endDate: "2026-09-14", compareTo: "previous_period" }), "r");
    expect(h.gsc.calls.map((c) => c.query.startDate)).toEqual(["2026-09-01", "2026-08-18"]);
    expect(r.rows[0]).toMatchObject({ clicks: 30, previousClicks: 10, clicksChange: 20 });
  });

  it("a range with no earlier data keeps the current result and explains why", async () => {
    const h = harness();
    const r = await h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2025-07-01", endDate: "2025-07-14", compareTo: "previous_year" }), "r");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.warnings.map((w) => w.code)).toContain("COMPARISON_UNAVAILABLE");
  });
});

describe("fresh=true bypasses the cache", () => {
  it("asks the provider again, while a normal repeat is a cache hit", async () => {
    const h = harness();
    const q = gscQuery();
    await h.service.queryGsc(h.principal(USER_A), q, "r");
    await h.service.queryGsc(h.principal(USER_A), q, "r");
    expect(h.gsc.calls).toHaveLength(1);
    await h.service.queryGsc(h.principal(USER_A), { ...q, fresh: true }, "r");
    expect(h.gsc.calls).toHaveLength(2);
  });
});
