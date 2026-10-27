/** Clean Clarity report view, driven by three responses captured from the live API (tests/clarity/fixtures). No network. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLARITY_REPORT_PRESETS, CLARITY_REPORT_TYPES, buildClarityResult, parseClarityResponse, shapeClarityReport, type ClarityReportType } from "@serp/provider-clarity";

const NOW = new Date("2026-10-27T10:00:00Z");
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live-${name}.json`, import.meta.url), "utf8"));
const quota = { usedToday: 3, remainingToday: 5, dailyBudgetForThisApp: 8, resetsAtUtc: "2026-10-28T00:00:00.000Z" };

function shape(name: string, reportType: ClarityReportType, extra: Partial<Parameters<typeof shapeClarityReport>[0]> = {}) {
  const dims = CLARITY_REPORT_PRESETS[reportType].dimensions;
  const parsed = parseClarityResponse(fixture(name), dims)!;
  const result = buildClarityResult({ parsed, numOfDays: 1, dimensions: dims, property: { id: "p", name: "Site" }, requestId: "r", now: NOW, mock: false });
  return shapeClarityReport({ result, reportType, dimensions: dims, numOfDays: 1, limit: 25, quota, now: NOW, ...extra }) as Record<string, any>;
}

describe("clarity report presets", () => {
  it("maps every report type to at most three valid dimensions", () => {
    expect(Object.keys(CLARITY_REPORT_PRESETS).sort()).toEqual([...CLARITY_REPORT_TYPES].sort());
    for (const t of CLARITY_REPORT_TYPES) expect(CLARITY_REPORT_PRESETS[t].dimensions.length).toBeLessThanOrEqual(3);
    expect(CLARITY_REPORT_PRESETS.by_source.dimensions).toEqual(["Source", "Medium"]);
    expect(CLARITY_REPORT_PRESETS.frustration_by_page.dimensions).toEqual(["URL"]);
  });
});

describe("clean report from live-shaped data", () => {
  it("overview: totals and short breakdowns, numbers not strings, UTC window, live label", () => {
    const r = shape("overview", "overview");
    expect(r.totals).toMatchObject({ sessions: 236, botSessions: 147, distinctUsers: 198 });
    expect(r.breakdowns.devices.length).toBeGreaterThan(0);
    expect(r.source).toBe("live");
    expect(r.window).toMatchObject({ endUtc: expect.stringMatching(/Z$/), days: 1 });
    expect(r.quota.remainingToday).toBe(5);
    expect(JSON.stringify(r)).not.toContain("metricName");
  });

  it("by_device: one merged row per device; bot count is shown, never subtracted", () => {
    const r = shape("by_device", "by_device");
    const mobile = r.rows.find((x: any) => x.Device === "Mobile");
    expect(mobile).toMatchObject({ sessions: 12, botSessions: 65 });
    expect(mobile).not.toHaveProperty("humanSessions");
    expect(r.rowsReturned).toBe(r.rows.length);
    expect(r.rows[0].sessions).toBeGreaterThanOrEqual(r.rows[1].sessions);
  });

  it("by_page: respects the row limit and reports how many were available", () => {
    const r = shape("by_page", "by_page", { limit: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.rowsAvailable).toBe(113);
    expect(r.rows[0]).toHaveProperty("Url");
  });

  it("frustration_by_page: only pages with events, worst first; counts are events, percentages are shares of sessions", () => {
    const r = shape("by_page", "frustration_by_page");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(r.rowsAvailable + 1);
    const score = (x: any) => ["rageClick", "deadClick", "quickback", "errorClick"].reduce((n, k) => n + (x[`${k}Count`] ?? 0), 0);
    for (const row of r.rows) expect(score(row) > 0 || row.quickbackSessionsPercent > 0).toBe(true);
    expect(score(r.rows[0])).toBeGreaterThanOrEqual(score(r.rows[r.rows.length - 1]));
  });

  it("warns when quota is low and when it is gone", () => {
    expect(shape("by_device", "by_device", { quota: { ...quota, remainingToday: 2 } }).warnings.map((w: any) => w.code)).toContain("LOW_QUOTA");
    expect(shape("by_device", "by_device", { quota: { ...quota, remainingToday: 0 } }).warnings.map((w: any) => w.code)).toContain("QUOTA_EXHAUSTED_CACHE_ONLY");
    expect(shape("by_device", "by_device").warnings.map((w: any) => w.code)).not.toContain("LOW_QUOTA");
  });

  it("labels cached data with its age", () => {
    const parsed = parseClarityResponse(fixture("by_device"), ["Device"])!;
    const result = buildClarityResult({ parsed, numOfDays: 1, dimensions: ["Device"], property: { id: "p", name: "Site" }, requestId: "r", now: NOW, mock: false });
    result.cache = { hit: true, ageSeconds: 5400 };
    const r = shapeClarityReport({ result, reportType: "by_device", dimensions: ["Device"], numOfDays: 1, limit: 25, quota, now: NOW }) as Record<string, any>;
    expect(r).toMatchObject({ source: "cache", dataAgeMinutes: 90 });
    expect(r.warnings.map((w: any) => w.code)).toContain("SERVED_FROM_CACHE");
  });
});
