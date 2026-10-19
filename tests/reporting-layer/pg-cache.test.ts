import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CacheScope } from "@serp/cache";
import { PgReportCache, PgRepository } from "@serp/db";
import { CONN_A_GA4, CONN_A_GSC, CONN_B_GSC, PROP_A_GA4, PROP_A_GSC, PROP_B_GSC, USER_A, USER_B, createTestDatabase, pgliteExecutor, seedTenants } from "../db/harness.js";
import { FakeAdapter, gscQuery, harness } from "./fixture.js";

let db: PGlite;
let cache: PgReportCache;
const hash = "c".repeat(64);
const scopeA: CacheScope = { userId: USER_A, provider: "gsc", connectionId: CONN_A_GSC, propertyId: PROP_A_GSC };
const scopeB: CacheScope = { userId: USER_B, provider: "gsc", connectionId: CONN_B_GSC, propertyId: PROP_B_GSC };

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTenants(db);
  cache = new PgReportCache(pgliteExecutor(db));
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("delete from public.report_cache");
});

describe("PgReportCache", () => {
  it("round-trips a report and keeps entries separate per scope", async () => {
    await cache.set(scopeA, hash, { rows: [{ who: "a" }] }, 600, { startDate: "2026-09-01", endDate: "2026-09-07", rowCount: 1 });
    await cache.set(scopeB, hash, { rows: [{ who: "b" }] }, 600);
    expect((await cache.get<{ rows: unknown[] }>(scopeA, hash))?.value).toEqual({ rows: [{ who: "a" }] });
    expect((await cache.get<{ rows: unknown[] }>(scopeB, hash))?.value).toEqual({ rows: [{ who: "b" }] });
    // The same hash under any other scope part misses.
    expect(await cache.get({ ...scopeA, userId: USER_B }, hash)).toBeNull();
    expect(await cache.get({ ...scopeA, connectionId: CONN_A_GA4 }, hash)).toBeNull();
    expect(await cache.get({ ...scopeA, propertyId: PROP_A_GA4 }, hash)).toBeNull();
    expect(await cache.get({ ...scopeA, provider: "ga4" }, hash)).toBeNull();
    expect(await cache.get(scopeA, "d".repeat(64))).toBeNull();
  });

  it("upserts: a second write replaces the first without duplicating rows", async () => {
    await cache.set(scopeA, hash, { v: 1 }, 600);
    await cache.set(scopeA, hash, { v: 2 }, 600);
    expect((await cache.get<{ v: number }>(scopeA, hash))?.value).toEqual({ v: 2 });
    expect((await db.query("select count(*)::int as n from public.report_cache")).rows[0]).toEqual({ n: 1 });
  });

  it("expires entries, and serves them as stale only on request and within the limit", async () => {
    await cache.set(scopeA, hash, { v: 1 }, 600);
    await db.exec("update public.report_cache set expires_at = now() - interval '30 minutes'");
    expect(await cache.get(scopeA, hash)).toBeNull();
    expect((await cache.get<{ v: number }>(scopeA, hash, { allowStale: true, maxStaleSeconds: 3600 }))?.value).toEqual({ v: 1 });
    expect(await cache.get(scopeA, hash, { allowStale: true, maxStaleSeconds: 60 })).toBeNull();
    expect(await cache.purgeExpired(3600)).toBe(0);
    expect(await cache.purgeExpired(60)).toBe(1);
  });

  it("the database itself refuses an entry that mixes tenants", async () => {
    // User A's property under user B's connection (or the reverse) violates the composite foreign keys.
    await expect(cache.set({ ...scopeA, connectionId: CONN_B_GSC }, hash, { v: 1 }, 60)).rejects.toThrow();
    await expect(cache.set({ ...scopeA, propertyId: PROP_B_GSC }, hash, { v: 1 }, 60)).rejects.toThrow();
    await expect(cache.set({ ...scopeB, userId: USER_A }, hash, { v: 1 }, 60)).rejects.toThrow();
  });

  it("invalidates by user, connection and property, leaving other tenants' rows", async () => {
    await cache.set(scopeA, hash, 1, 600);
    await cache.set({ ...scopeA, provider: "ga4", connectionId: CONN_A_GA4, propertyId: PROP_A_GA4 }, hash, 2, 600);
    await cache.set(scopeB, hash, 3, 600);
    expect(await cache.invalidate({ userId: USER_A, connectionId: CONN_A_GSC })).toBe(1);
    expect(await cache.invalidate({ userId: USER_A, propertyId: PROP_B_GSC })).toBe(0); // another tenant's property id removes nothing
    expect((await cache.get(scopeB, hash))?.value).toBe(3);
    expect(await cache.invalidate({ userId: USER_A })).toBe(1);
    expect((await cache.get(scopeB, hash))?.value).toBe(3);
  });

  it("is removed with the connection or user (no orphaned customer data)", async () => {
    await cache.set(scopeB, hash, 1, 600);
    let remaining = -1;
    await db.transaction(async (tx) => {
      await tx.query("delete from public.provider_connections where id = $1", [CONN_B_GSC]);
      remaining = ((await tx.query<{ n: number }>("select count(*)::int as n from public.report_cache")).rows[0] as { n: number }).n;
      await tx.rollback(); // leave the seed data intact for the other tests
    });
    expect(remaining).toBe(0);
  });

  it("is not reachable by browser roles", async () => {
    await cache.set(scopeA, hash, { secretish: "report data" }, 600);
    for (const role of ["anon", "authenticated"]) {
      await expect(db.transaction(async (tx) => { await tx.query(`set local role ${role}`); await tx.query("select * from public.report_cache"); })).rejects.toThrow();
    }
  });

  it("refuses to store an oversized report rather than failing the request", async () => {
    await cache.set(scopeA, hash, { blob: "x".repeat(3 * 1024 * 1024) }, 600);
    expect(await cache.get(scopeA, hash)).toBeNull();
  });
});

describe("ReportService on PostgreSQL (repository + cache)", () => {
  function pgHarness() {
    const exec = pgliteExecutor(db);
    const h = harness({ cache: new PgReportCache(exec), deps: { repo: new PgRepository(exec) } });
    return h;
  }
  const q = (property: string) => gscQuery({ propertyId: property });

  it("caches per user and connection against real rows, and refuses another tenant's property", async () => {
    await db.exec("delete from public.report_cache");
    const h = pgHarness();
    const a = await h.service.queryGsc(h.principal(USER_A), q("sc-domain:a.example"), "r");
    const b = await h.service.queryGsc(h.principal(USER_B), q("sc-domain:b.example"), "r");
    expect(a.rows[0]).toMatchObject({ owner: USER_A, connection: CONN_A_GSC, property: PROP_A_GSC });
    expect(b.rows[0]).toMatchObject({ owner: USER_B, connection: CONN_B_GSC, property: PROP_B_GSC });
    expect((await h.service.queryGsc(h.principal(USER_A), q("sc-domain:a.example"), "r")).cache.hit).toBe(true);
    await expect(h.service.queryGsc(h.principal(USER_B), q("sc-domain:a.example"), "r")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    expect(h.gsc.calls).toHaveLength(2);
    expect((await db.query("select count(*)::int as n from public.report_cache")).rows[0]).toEqual({ n: 2 });
  });

  it("a second server instance sharing the database serves the first instance's cached report", async () => {
    await db.exec("delete from public.report_cache");
    const one = pgHarness();
    const two = pgHarness();
    await one.service.queryGsc(one.principal(USER_A), q("sc-domain:a.example"), "r");
    const hit = await two.service.queryGsc(two.principal(USER_A), q("sc-domain:a.example"), "r");
    expect(hit.cache.hit).toBe(true);
    expect(two.gsc.calls).toHaveLength(0);
    // ...and disconnecting through either instance clears it for both.
    expect(await two.service.invalidateConnection(USER_A, CONN_A_GSC)).toBe(1);
    expect((await one.service.queryGsc(one.principal(USER_A), q("sc-domain:a.example"), "r")).cache.hit).toBe(false);
  });

  it("FakeAdapter is exercised against the real schema without leaking between tests", () => {
    expect(new FakeAdapter("ga4").calls).toHaveLength(0);
  });
});
