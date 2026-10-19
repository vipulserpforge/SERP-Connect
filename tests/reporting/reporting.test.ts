import { describe, expect, it } from "vitest";
import { loadSharedEnv } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import { MemoryClarityQuotaStore } from "@serp/provider-clarity";
import { createMockReportService } from "@serp/reporting";

const env = loadSharedEnv({});
const now = () => new Date("2026-10-19T12:00:00Z");
const user = { userId: MOCK_USER_A_ID, scopes: [] };

describe("GSC / GA4 reports (mock)", () => {
  it("returns sorted, limited rows with provenance, then serves a cache hit", async () => {
    const s = createMockReportService(env, { now });
    const q = { propertyId: "sc-domain:example.com", startDate: "2026-09-29", endDate: "2026-10-10", limit: 20 };
    const first = await s.queryGsc(user, q, "r1");
    expect(first.rows).toHaveLength(20);
    expect(first.rows[0]!.clicks).toBeGreaterThanOrEqual(Number(first.rows[1]!.clicks));
    expect(first.mock).toBe(true);
    expect(first.report.dateSemantics).toMatch(/Pacific/);
    expect(first.cache.hit).toBe(false);
    expect((await s.queryGsc(user, q, "r2")).cache.hit).toBe(true);
  });

  it("rejects unknown GA4 fields before any provider call", async () => {
    const s = createMockReportService(env, { now });
    await expect(
      s.queryGa4(user, { propertyId: "123456789", startDate: "2026-09-01", endDate: "2026-09-30", metrics: ["bogusMetric"] }, "r"),
    ).rejects.toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
  });

  it("returns GA4 rows for a supported query", async () => {
    const s = createMockReportService(env, { now });
    const r = await s.queryGa4(user, { propertyId: "123456789", startDate: "2026-09-01", endDate: "2026-09-30", limit: 30 }, "r");
    expect(r.rows).toHaveLength(30);
  });
});

describe("Clarity budget", () => {
  const q = { propertyId: "clarity-demo-project", numOfDays: 1 as const };

  it("refuses 30-day windows", async () => {
    const s = createMockReportService(env, { now });
    await expect(s.getClarityInsights(user, { ...q, numOfDays: 30 }, "r")).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("never makes an 11th upstream call: repeats are cached, new shapes hit the budget", async () => {
    const budget = new MemoryClarityQuotaStore(10);
    const s = createMockReportService(env, { now, clarityQuota: budget });
    for (let i = 0; i < 5; i++) expect((await s.getClarityInsights(user, q, "r")).cache.hit).toBe(i > 0);
    for (const dim of ["Browser", "Device", "OS", "Source", "Medium", "Channel", "URL", "Campaign", "Country/Region"]) {
      await s.getClarityInsights(user, { ...q, dimensions: [dim] }, "r").catch(() => undefined);
    }
    expect((await budget.reserve({ projectKey: "clarity-demo-project", userId: "u", connectionId: null, now: now() })).allowed).toBe(false);
    await expect(s.getClarityInsights(user, { ...q, numOfDays: 2 }, "r")).rejects.toMatchObject({ code: "CLARITY_DAILY_BUDGET_EXHAUSTED" });
  });

  it("budget is atomic under concurrency", async () => {
    const budget = new MemoryClarityQuotaStore(10);
    const results = await Promise.all(Array.from({ length: 25 }, () => budget.reserve({ projectKey: "p", userId: "u", connectionId: null, now: now() })));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});
