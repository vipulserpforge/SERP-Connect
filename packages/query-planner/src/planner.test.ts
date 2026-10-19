import { describe, expect, it } from "vitest";
import {
  addDays,
  buildCacheKey,
  resolveLastCompletedDays,
  stableStringify,
  validateClarityDays,
  validateGscDateRange,
} from "./index.js";

const NOW = new Date("2026-10-19T12:00:00Z");

describe("dates", () => {
  it("resolves last N completed days ending yesterday", () => {
    expect(resolveLastCompletedDays(20, "America/Los_Angeles", NOW)).toEqual({ startDate: "2026-09-29", endDate: "2026-10-18" });
  });

  it("uses the target time zone, not UTC", () => {
    // 02:00 UTC on the 19th is still the 18th in Los Angeles.
    const early = new Date("2026-10-19T02:00:00Z");
    expect(resolveLastCompletedDays(1, "America/Los_Angeles", early).endDate).toBe("2026-10-17");
  });

  it("rejects GSC ranges beyond 16 months and in the future", () => {
    expect(() => validateGscDateRange("2024-01-01", "2024-01-31", NOW)).toThrow(/months/);
    expect(() => validateGscDateRange("2026-10-01", "2026-12-01", NOW)).toThrow(/future/);
  });

  it("warns about incomplete recent GSC data", () => {
    expect(validateGscDateRange("2026-10-01", "2026-10-18", NOW).warnings[0]?.code).toBe("RECENT_DATA_INCOMPLETE");
    expect(validateGscDateRange("2026-09-01", "2026-09-30", NOW).warnings).toHaveLength(0);
  });

  it("rejects Clarity windows beyond 3 days", () => {
    expect(() => validateClarityDays(30)).toThrow(/1-3 days/);
    expect(() => validateClarityDays(3)).not.toThrow();
  });

  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("cache keys", () => {
  it("is independent of key order and partitioned by user", () => {
    const base = { provider: "gsc" as const, connectionId: "c", propertyId: "p" };
    const a = buildCacheKey({ ...base, userId: "u1", query: { a: 1, b: [1, 2] } });
    expect(buildCacheKey({ ...base, userId: "u1", query: { b: [1, 2], a: 1 } })).toBe(a);
    expect(buildCacheKey({ ...base, userId: "u2", query: { a: 1, b: [1, 2] } })).not.toBe(a);
    expect(stableStringify({ z: undefined, a: 1 })).toBe('{"a":1}');
  });
});
