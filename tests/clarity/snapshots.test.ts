/** Clarity pull history. Memory store and real migrations on PGlite. DATA SOURCE: no provider is called. */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedReportResult } from "@serp/contracts";
import { PgClaritySnapshotStore } from "@serp/db";
import { MemoryClaritySnapshotStore, buildClarityResult, parseClarityResponse, type ClaritySnapshotStore } from "@serp/provider-clarity";
import { USER_A, USER_B, createTestDatabase, pgliteExecutor } from "../db/harness.js";

let db: PGlite;
let connA: string;
beforeAll(async () => {
  db = await createTestDatabase();
  await db.exec(`insert into auth.users (id, email) values ('${USER_A}', 'a@x.test'), ('${USER_B}', 'b@x.test')`);
  const r = await db.query<{ id: string }>(`insert into public.provider_connections (user_id, provider, provider_account_id, status) values ('${USER_A}', 'clarity', 'fp-1', 'connected') returning id`);
  connA = r.rows[0]!.id;
});
afterAll(async () => db.close());

const result = (at: string, dims: string[]): NormalizedReportResult =>
  buildClarityResult({
    parsed: parseClarityResponse([{ metricName: "Traffic", information: [{ totalSessionCount: 5, totalBotSessionCount: 1, ...Object.fromEntries(dims.map((d) => [d, "x"])) }] }], dims)!,
    numOfDays: 1,
    dimensions: dims,
    property: { id: "p1", name: "Site" },
    requestId: "r",
    now: new Date(at),
    mock: false,
  });

const stores: Array<[string, () => ClaritySnapshotStore, () => string]> = [
  ["memory", () => new MemoryClaritySnapshotStore(), () => "conn-x"],
  ["postgres", () => new PgClaritySnapshotStore(pgliteExecutor(db)), () => connA],
];

describe.each(stores)("snapshot store (%s)", (_n, make, conn) => {
  it("keeps pulls newest first with their pulled-at time, filtered by shape, scoped to the user", async () => {
    const s = make();
    const save = (at: string, dims: string[], user = USER_A) => s.save({ userId: user, connectionId: conn(), projectKey: "p1", numOfDays: 1, dimensions: dims, result: result(at, dims) });
    await save("2026-10-25T10:00:00Z", ["Device"]);
    await save("2026-10-27T10:00:00Z", ["Device"]);
    await save("2026-10-26T10:00:00Z", []);
    const dev = await s.list(USER_A, "p1", { dimensions: ["Device"], limit: 10 });
    expect(dev.map((x) => x.pulledAt)).toEqual(["2026-10-27T10:00:00.000Z", "2026-10-25T10:00:00.000Z"]);
    expect(dev[0]!.result.rows[0]).toMatchObject({ totalSessionCount: 5 });
    expect(await s.list(USER_A, "p1", { limit: 10 })).toHaveLength(3);
    expect(await s.list(USER_A, "p1", { dimensions: ["Device"], limit: 1 })).toHaveLength(1);
    expect(await s.list(USER_B, "p1", { limit: 10 })).toEqual([]);
    expect(await s.list(USER_A, "other", { limit: 10 })).toEqual([]);
  });
});

describe("postgres only", () => {
  it("is not readable by browser roles and disappears with its connection", async () => {
    await expect(db.exec("set role authenticated; select * from public.clarity_snapshots").finally(() => db.exec("reset role"))).rejects.toThrow();
    await db.exec(`delete from public.provider_connections where id = '${connA}'`);
    expect((await db.query("select 1 from public.clarity_snapshots")).rows).toHaveLength(0);
  });
});
