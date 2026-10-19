/**
 * Clarity request budget. Memory store: unit semantics. Postgres store (real migrations on PGlite): atomicity under
 * concurrency, ledger, isolation and privileges. DATA SOURCE: no provider is called.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgClarityQuotaStore } from "@serp/db";
import { MemoryClarityQuotaStore, type ClarityQuotaStore } from "@serp/provider-clarity";
import { USER_A, USER_B, asRole, createTestDatabase, pgliteExecutor } from "../db/harness.js";

const DAY1 = new Date("2026-10-19T10:00:00Z");
const DAY2 = new Date("2026-10-20T00:00:01Z");

let db: PGlite;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(`insert into auth.users (id, email) values ('${USER_A}', 'a@x.test'), ('${USER_B}', 'b@x.test')`);
});
afterAll(async () => db.close());

const stores: Array<[string, () => ClarityQuotaStore]> = [
  ["memory", () => new MemoryClarityQuotaStore(8)],
  ["postgres", () => new PgClarityQuotaStore(pgliteExecutor(db), 8)],
];

describe.each(stores)("%s quota store", (name, make) => {
  const key = (suffix: string) => `proj-${name}-${suffix}`;
  const reserve = (s: ClarityQuotaStore, project: string, now = DAY1, user = USER_A) => s.reserve({ projectKey: project, userId: user, connectionId: null, now });

  it("allows exactly the local budget, then refuses", async () => {
    const s = make();
    const p = key("basic");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await reserve(s, p));
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
    expect(results[8]).toMatchObject({ allowed: false, localBudget: 8 });
    expect((await s.status(p, DAY1)).localRemaining).toBe(0);
  });

  it("never exceeds the budget under heavy concurrency", async () => {
    const s = make();
    const p = key("race");
    const results = await Promise.all(Array.from({ length: 40 }, () => reserve(s, p)));
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
    const status = await s.status(p, DAY1);
    expect(status.appTrackedUsed).toBe(8);
  });

  it("two store instances sharing one database cannot jointly exceed it (multi-instance)", async () => {
    if (name === "memory") return; // a per-process store cannot coordinate instances: that is why production uses Postgres
    const p = key("multi");
    const a = make();
    const b = make();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => reserve(i % 2 ? a : b, p)));
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
  });

  it("projects have separate budgets, and the window rolls over at UTC midnight", async () => {
    const s = make();
    for (let i = 0; i < 8; i++) await reserve(s, key("p1"));
    expect((await reserve(s, key("p1"))).allowed).toBe(false);
    expect((await reserve(s, key("p2"))).allowed).toBe(true);
    expect((await reserve(s, key("p1"), DAY2)).allowed).toBe(true);
  });

  it("tracks outcomes and the last successful request; failures still count as used", async () => {
    const s = make();
    const p = key("ledger");
    const r1 = await reserve(s, p);
    const r2 = await reserve(s, p);
    const r3 = await reserve(s, p);
    if (!r1.allowed || !r2.allowed || !r3.allowed) throw new Error("expected reservations");
    await s.complete(r1.reservationId, "succeeded", 200, new Date("2026-10-19T10:00:05Z"));
    await s.complete(r2.reservationId, "failed", 500, DAY1);
    const status = await s.status(p, DAY1);
    expect(status).toMatchObject({ appTrackedUsed: 3, localRemaining: 5, providerDailyLimit: 10, providerLimitReported: false });
    expect(status.counts).toEqual({ reserved: 1, succeeded: 1, failed: 1, providerLimited: 0 });
    expect(status.lastSuccessAt).toBe("2026-10-19T10:00:05.000Z");
    expect(status.window).toMatchObject({ start: "2026-10-19T00:00:00.000Z", end: "2026-10-20T00:00:00.000Z" });
  });

  it("a provider 429 spends the rest of the local budget for that window", async () => {
    const s = make();
    const p = key("limited");
    const r = await reserve(s, p);
    if (!r.allowed) throw new Error("expected reservation");
    await s.complete(r.reservationId, "provider_limited", 429, DAY1);
    expect((await reserve(s, p)).allowed).toBe(false);
    const status = await s.status(p, DAY1);
    expect(status).toMatchObject({ localRemaining: 0, providerLimitReported: true });
    expect((await reserve(s, p, DAY2)).allowed).toBe(true);
  });
});

describe("postgres ledger and privileges", () => {
  it("records who reserved each request and keeps the ledger when a connection is deleted", async () => {
    await db.exec(`insert into public.provider_connections (id, user_id, provider, provider_account_id, account_label, status)
                   values ('c1111111-1111-4111-8111-111111111111', '${USER_A}', 'clarity', 'fp-ledger', 'L', 'pending')`);
    const s = new PgClarityQuotaStore(pgliteExecutor(db), 8);
    await s.reserve({ projectKey: "clarity:ledger", userId: USER_A, connectionId: "c1111111-1111-4111-8111-111111111111", now: DAY1 });
    await db.exec(`delete from public.provider_connections where id = 'c1111111-1111-4111-8111-111111111111'`);
    const { rows } = await db.query<{ user_id: string; connection_id: string | null }>("select user_id, connection_id from public.provider_request_reservations where project_key = 'clarity:ledger'");
    expect(rows).toEqual([{ user_id: USER_A, connection_id: null }]);
  });

  it("the ledger and budget tables are unreachable from the browser roles", async () => {
    const statements = [
      "select * from public.provider_request_reservations",
      "select * from public.provider_request_budgets",
      `insert into public.provider_request_reservations (provider, project_key, user_id, period_start) values ('clarity','x','${USER_A}','2026-10-19')`,
    ];
    for (const userId of [USER_A, USER_B, null]) {
      for (const sql of statements) await asRole(db, userId, async (q) => void (await expect(q(sql)).rejects.toThrow(/permission denied/)));
    }
  });

  it("the reservation functions cannot be called by browser roles", async () => {
    await asRole(db, USER_A, async (q) => void (await expect(q(`select * from private.reserve_provider_request('clarity','p','2026-10-19',8,'${USER_A}',null)`)).rejects.toThrow(/permission denied/)));
    await asRole(db, USER_A, async (q) => void (await expect(q("select private.exhaust_provider_budget('clarity','p','2026-10-19',8)")).rejects.toThrow(/permission denied/)));
  });
});
