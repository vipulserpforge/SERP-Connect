import { describe, expect, it } from "vitest";
import { MemoryReportCache, assertValidScope, type CacheScope } from "@serp/cache";
import { MockRepository } from "@serp/db";
import { canonicalQueryHash } from "@serp/query-planner";
import { USER_A, USER_B, ga4Query, gscQuery, harness, unavailable } from "./fixture.js";

const R = "req";

describe("cache separation", () => {
  it("never serves one customer's report to another, even for identical requests on the same provider-native property", async () => {
    const h = harness();
    const a = await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    const b = await h.service.queryGsc(h.principal(USER_B), gscQuery(), R);
    expect(b.cache.hit).toBe(false);
    expect(a.rows[0]).toMatchObject({ owner: USER_A, connection: "conn-a1", property: "prop-a1" });
    expect(b.rows[0]).toMatchObject({ owner: USER_B, connection: "conn-b1", property: "prop-b1" });
    // And each is served from its own entry afterwards.
    expect((await h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rows[0]).toMatchObject({ owner: USER_A });
    expect((await h.service.queryGsc(h.principal(USER_B), gscQuery(), R)).rows[0]).toMatchObject({ owner: USER_B });
    expect(h.gsc.calls).toHaveLength(2);
  });

  it("separates GA4 properties that share a native id but differ in owner and time zone", async () => {
    const h = harness();
    const q = { propertyId: "100", lastDays: 7, dimensions: ["pagePath"], metrics: ["sessions"] };
    const a = await h.service.queryGa4(h.principal(USER_A), q, R);
    const b = await h.service.queryGa4(h.principal(USER_B), q, R);
    expect(b.cache.hit).toBe(false);
    expect(a.report.period?.timeZone).toBe("Pacific/Auckland");
    expect(b.report.period?.timeZone).toBe("Asia/Kolkata");
    expect(b.rows[0]).toMatchObject({ owner: USER_B, property: "prop-b-ga4" });
  });

  it("separates by property, by report parameters and by date range", async () => {
    const h = harness();
    const p = h.principal(USER_A);
    await h.service.queryGsc(p, gscQuery(), R);
    const others = [
      gscQuery({ propertyId: "sc-domain:second.example" }), // other property (and connection)
      gscQuery({ dimensions: ["page"] }),
      gscQuery({ limit: 5 }),
      gscQuery({ type: "image" }),
      gscQuery({ startDate: "2026-09-02" }),
      gscQuery({ endDate: "2026-09-27" }),
      gscQuery({ dataState: "all" }),
    ];
    for (const q of others) expect((await h.service.queryGsc(p, q, R)).cache.hit).toBe(false);
    expect(h.gsc.calls).toHaveLength(1 + others.length);
    // The original is still its own hit.
    expect((await h.service.queryGsc(p, gscQuery(), R)).cache.hit).toBe(true);
  });

  it("separates GA4 parameters (dimensions, metrics, filters) and date range", async () => {
    const h = harness();
    const p = h.principal(USER_A);
    await h.service.queryGa4(p, ga4Query(), R);
    for (const q of [ga4Query({ metrics: ["activeUsers"] }), ga4Query({ dimensions: ["country"] }), ga4Query({ endDate: "2026-09-27" }), ga4Query({ dimensionFilters: [{ field: "pagePath", matchType: "CONTAINS", value: "/x" }] })]) {
      expect((await h.service.queryGa4(p, q, R)).cache.hit).toBe(false);
    }
  });

  it("a relative range does not leak across days: the next day is a different request", async () => {
    const h = harness();
    const p = h.principal(USER_A);
    const q = { propertyId: "sc-domain:shared.example", lastDays: 7 };
    await h.service.queryGsc(p, q, R);
    expect((await h.service.queryGsc(p, q, R)).cache.hit).toBe(true);
    h.clock.ms += 24 * 3600 * 1000;
    expect((await h.service.queryGsc(p, q, R)).cache.hit).toBe(false);
    expect(h.gsc.calls[1]!.query.endDate).not.toBe(h.gsc.calls[0]!.query.endDate);
  });

  it("the hash covers the time zone the dates were read in", () => {
    const base = { query: { startDate: "2026-09-01", endDate: "2026-09-07" } };
    expect(canonicalQueryHash({ ...base, timeZone: "Asia/Kolkata" })).not.toBe(canonicalQueryHash({ ...base, timeZone: "America/New_York" }));
    expect(canonicalQueryHash({ query: { b: 1, a: 2 }, timeZone: "UTC" })).toBe(canonicalQueryHash({ query: { a: 2, b: 1 }, timeZone: "UTC" }));
  });

  it("an unknown or other user's property is refused before the cache is consulted", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    await expect(h.service.queryGsc(h.principal(USER_B), gscQuery({ propertyId: "sc-domain:second.example" }), R)).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(h.gsc.calls).toHaveLength(1);
  });

  it("callers get their own copy: mutating a result cannot change what others receive", async () => {
    const h = harness();
    const p = h.principal(USER_A);
    const first = await h.service.queryGsc(p, gscQuery(), R);
    first.rows[0]!.owner = "tampered";
    first.warnings.push({ code: "X", message: "x" });
    const second = await h.service.queryGsc(p, gscQuery(), R);
    expect(second.rows[0]!.owner).toBe(USER_A);
    expect(second.warnings.find((w) => w.code === "X")).toBeUndefined();

    // Two cache hits are independent of each other too.
    const [x, y] = [await h.service.queryGsc(p, gscQuery(), R), await h.service.queryGsc(p, gscQuery(), R)];
    x.rows[0]!.owner = "tampered";
    x.warnings.push({ code: "Y", message: "y" });
    expect(y.rows[0]!.owner).toBe(USER_A);
    expect(y.warnings.find((w) => w.code === "Y")).toBeUndefined();
    expect((await h.service.queryGsc(p, gscQuery(), R)).rows[0]!.owner).toBe(USER_A);
  });

  it("stays isolated even if two tenants' internal ids collided (defense in depth)", async () => {
    const same = { id: "dup", provider: "gsc" as const, externalPropertyId: "sc-domain:shared.example", displayName: "dup", propertyType: null, timezone: null, enabledForMcp: true, connectionId: "dup-conn" };
    const mk = (userId: string) => ({
      connections: [{ id: "dup-conn", userId, provider: "google" as const, providerAccountId: null, accountLabel: null, status: "connected" as const, grantedScopes: [], lastValidatedAt: null, lastErrorCode: null }],
      properties: [{ ...same, userId }],
    });
    const seeds = { [USER_A]: mk(USER_A), [USER_B]: mk(USER_B) };
    const merged = { connections: [...seeds[USER_A].connections, ...seeds[USER_B].connections], properties: [...seeds[USER_A].properties, ...seeds[USER_B].properties] };
    const h = harness({ deps: { repo: new MockRepository(merged) } });
    const g = (() => {
      let open!: () => void;
      return { opened: new Promise<void>((r) => (open = r)), open };
    })();
    h.gsc.behave = async (call) => {
      await g.opened;
      return h.gsc.ok(call);
    };
    const a = h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    const b = h.service.queryGsc(h.principal(USER_B), gscQuery(), R);
    await new Promise((r) => setTimeout(r, 20));
    g.open();
    expect((await a).rows[0]!.owner).toBe(USER_A);
    expect((await b).rows[0]!.owner).toBe(USER_B);
    expect(h.gsc.calls).toHaveLength(2);
    expect((await h.service.queryGsc(h.principal(USER_B), gscQuery(), R)).rows[0]!.owner).toBe(USER_B);
  });
});

describe("MemoryReportCache scope guarantees", () => {
  const scope: CacheScope = { userId: "u1", provider: "gsc", connectionId: "c1", propertyId: "p1" };
  const hash = "a".repeat(64);

  it("each scope part is an independent address", async () => {
    const c = new MemoryReportCache();
    await c.set(scope, hash, { v: 1 }, 60);
    expect(await c.get({ ...scope, userId: "u2" }, hash)).toBeNull();
    expect(await c.get({ ...scope, provider: "ga4" }, hash)).toBeNull();
    expect(await c.get({ ...scope, connectionId: "c2" }, hash)).toBeNull();
    expect(await c.get({ ...scope, propertyId: "p2" }, hash)).toBeNull();
    expect(await c.get(scope, "b".repeat(64))).toBeNull();
    expect((await c.get<{ v: number }>(scope, hash))?.value).toEqual({ v: 1 });
  });

  it("keeps users apart on their own, with no help from the other id parts", async () => {
    const c = new MemoryReportCache();
    await c.set({ ...scope, userId: "u1" }, hash, "one", 60);
    await c.set({ ...scope, userId: "u2" }, hash, "two", 60);
    expect((await c.get({ ...scope, userId: "u1" }, hash))?.value).toBe("one");
    expect((await c.get({ ...scope, userId: "u2" }, hash))?.value).toBe("two");
  });

  it("refuses scope parts that could forge another key", async () => {
    const c = new MemoryReportCache();
    for (const bad of ["", "a:b", "a b", "../x", "x".repeat(65)]) {
      expect(() => assertValidScope({ ...scope, userId: bad }, hash)).toThrow();
      await expect(c.get({ ...scope, userId: bad }, hash)).rejects.toThrow();
    }
    await expect(c.get(scope, "not-a-hash")).rejects.toThrow();
  });

  it("expires entries by the clock and serves stale only on request, within a limit", async () => {
    let now = 1_000_000;
    const c = new MemoryReportCache({ now: () => now });
    await c.set(scope, hash, "v", 60);
    now += 59_000;
    expect(await c.get(scope, hash)).not.toBeNull();
    now += 2_000;
    expect(await c.get(scope, hash)).toBeNull();
    expect((await c.get(scope, hash, { allowStale: true }))?.value).toBe("v");
    expect(await c.get(scope, hash, { allowStale: true, maxStaleSeconds: 0 })).toBeNull();
  });

  it("one user filling their quota evicts only their own entries", async () => {
    const c = new MemoryReportCache({ maxEntriesPerUser: 3 });
    await c.set({ ...scope, userId: "other" }, hash, "theirs", 60);
    for (let i = 0; i < 6; i++) await c.set(scope, `${i}`.repeat(32).replace(/[^a-f0-9]/g, "a"), i, 60);
    expect((await c.get({ ...scope, userId: "other" }, hash))?.value).toBe("theirs");
  });

  it("invalidates by user, connection and property without touching others", async () => {
    const c = new MemoryReportCache();
    await c.set(scope, hash, 1, 60);
    await c.set({ ...scope, propertyId: "p2" }, hash, 2, 60);
    await c.set({ ...scope, connectionId: "c2" }, hash, 3, 60);
    await c.set({ ...scope, userId: "u2" }, hash, 4, 60);
    expect(await c.invalidate({ userId: "u1", connectionId: "c1" })).toBe(2);
    expect(await c.get({ ...scope, connectionId: "c2" }, hash)).not.toBeNull();
    expect(await c.get({ ...scope, userId: "u2" }, hash)).not.toBeNull();
  });
});

describe("expiry, invalidation and stale-if-error through the service", () => {
  it("expires recent data sooner than old data", async () => {
    const h = harness();
    const p = h.principal(USER_A);
    const recent = gscQuery({ startDate: "2026-10-10", endDate: "2026-10-17" });
    await h.service.queryGsc(p, recent, R);
    await h.service.queryGsc(p, gscQuery(), R);
    h.clock.ms += 30 * 60_000; // 30 minutes
    expect((await h.service.queryGsc(p, recent, R)).cache.hit).toBe(false); // recent: 20 min TTL
    expect((await h.service.queryGsc(p, gscQuery(), R)).cache.hit).toBe(true); // settled: hours
  });

  it("reports the age of a cached result", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    h.clock.ms += 90_000;
    expect((await h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).cache).toEqual({ hit: true, ageSeconds: 90 });
  });

  it("drops a disconnected connection's reports immediately and leaves other tenants alone", async () => {
    const h = harness();
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    await h.service.queryGsc(h.principal(USER_B), gscQuery(), R);
    expect(await h.service.invalidateConnection(USER_A, "conn-a1")).toBe(1);
    expect((await h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).cache.hit).toBe(false);
    expect((await h.service.queryGsc(h.principal(USER_B), gscQuery(), R)).cache.hit).toBe(true);
  });

  it("serves the last saved report with a warning when the provider is down, never for auth or validation failures", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 0 } });
    const p = h.principal(USER_A);
    await h.service.queryGsc(p, gscQuery({ startDate: "2026-10-10", endDate: "2026-10-17" }), R);
    h.clock.ms += 2 * 3600_000; // expired, but within the stale window
    h.gsc.behave = () => {
      throw unavailable();
    };
    const stale = await h.service.queryGsc(p, gscQuery({ startDate: "2026-10-10", endDate: "2026-10-17" }), R);
    expect(stale.cache).toMatchObject({ hit: true, stale: true });
    expect(stale.warnings.map((w) => w.code)).toContain("STALE_CACHE");
    expect(stale.rows[0]).toMatchObject({ owner: USER_A });

    h.gsc.behave = () => {
      throw Object.assign(new Error("x"), {});
    };
    // An unexpected failure is not masked by old data.
    await expect(h.service.queryGsc(p, gscQuery({ startDate: "2026-10-10", endDate: "2026-10-17" }), R)).rejects.toBeDefined();
  });

  it("does not serve data older than the stale limit, and another user never gets a stale copy", async () => {
    const h = harness({ env: { REPORT_MAX_RETRIES: 0, REPORT_MAX_STALE_SECONDS: 3600 } });
    await h.service.queryGsc(h.principal(USER_A), gscQuery(), R);
    h.clock.ms += 30 * 3600_000;
    h.gsc.behave = () => {
      throw unavailable();
    };
    await expect(h.service.queryGsc(h.principal(USER_A), gscQuery(), R)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(h.service.queryGsc(h.principal(USER_B), gscQuery(), R)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("incomplete-data warnings survive the cache", async () => {
    const h = harness();
    h.gsc.behave = (call) => h.gsc.ok(call, { completeness: "partial", warnings: [{ code: "ANONYMIZED_QUERIES_OMITTED", message: "m" }] });
    await h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2026-10-10", endDate: "2026-10-18" }), R);
    const hit = await h.service.queryGsc(h.principal(USER_A), gscQuery({ startDate: "2026-10-10", endDate: "2026-10-18" }), R);
    expect(hit.cache.hit).toBe(true);
    expect(hit.completeness).toBe("partial");
    expect(hit.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["ANONYMIZED_QUERIES_OMITTED", "RECENT_DATA_INCOMPLETE"]));
  });
});
