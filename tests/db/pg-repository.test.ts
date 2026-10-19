import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgRepository } from "@serp/db";
import { authorizeProperty } from "@serp/auth";
import { CONN_A_GSC, CONN_B_GSC, PROP_A_GSC, PROP_B_GSC, USER_A, USER_B, createTestDatabase, pgliteExecutor, seedTenants } from "./harness.js";

let db: PGlite;
let repo: PgRepository;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTenants(db);
  repo = new PgRepository(pgliteExecutor(db));
});
afterAll(async () => {
  await db.close();
});

describe("PgRepository explicit ownership scoping (RLS bypassed, as on a direct server connection)", () => {
  it("lists only the caller's connections and properties", async () => {
    expect((await repo.listConnections(USER_A)).map((c) => c.id).sort()).toHaveLength(2);
    expect((await repo.listConnections(USER_B)).map((c) => c.id)).toEqual([CONN_B_GSC]);
    expect((await repo.listProperties(USER_B)).map((p) => p.id)).toEqual([PROP_B_GSC]);
  });

  it("never returns another user's connection or property by id", async () => {
    expect(await repo.getConnection(USER_A, CONN_B_GSC)).toBeNull();
    expect(await repo.findEnabledProperty(USER_A, "gsc", "sc-domain:b.example")).toBeNull();
  });

  it("maps rows to domain records without secrets", async () => {
    const conn = await repo.getConnection(USER_A, CONN_A_GSC);
    expect(conn).toMatchObject({ userId: USER_A, provider: "google", providerAccountId: "google-sub-B", status: "connected" });
    expect(JSON.stringify(conn)).not.toMatch(/ciphertext|wrapped/);
  });

  it("filters by provider and enabled state", async () => {
    expect((await repo.listProperties(USER_A, { provider: "ga4" })).map((p) => p.externalPropertyId)).toEqual(["111"]);
    expect(await repo.setPropertyEnabled(USER_A, PROP_A_GSC, false)).toBe(true);
    expect(await repo.listProperties(USER_A, { provider: "gsc", enabledOnly: true })).toEqual([]);
    expect(await repo.findEnabledProperty(USER_A, "gsc", "sc-domain:a.example")).toBeNull();
    await repo.setPropertyEnabled(USER_A, PROP_A_GSC, true);
  });

  it("refuses to mutate another tenant's property or connection", async () => {
    expect(await repo.setPropertyEnabled(USER_A, PROP_B_GSC, false)).toBe(false);
    expect(await repo.disconnectConnection(USER_A, CONN_B_GSC)).toBe(false);
    expect(await repo.getConnection(USER_B, CONN_B_GSC)).not.toBeNull();
    expect((await repo.listProperties(USER_B, { enabledOnly: true })).map((p) => p.id)).toEqual([PROP_B_GSC]);
  });

  it("authorizeProperty works end to end against Postgres and hides foreign properties", async () => {
    const principalA = { userId: USER_A, scopes: [] };
    await expect(authorizeProperty(repo, principalA, "gsc", "sc-domain:a.example")).resolves.toMatchObject({
      connection: { id: CONN_A_GSC },
    });
    await expect(authorizeProperty(repo, principalA, "gsc", "sc-domain:b.example")).rejects.toMatchObject({
      code: "PROPERTY_NOT_CONNECTED",
    });
  });

  it("disconnect removes the caller's own connection and its properties", async () => {
    expect(await repo.disconnectConnection(USER_A, CONN_A_GSC)).toBe(true);
    expect(await repo.getConnection(USER_A, CONN_A_GSC)).toBeNull();
    expect((await repo.listProperties(USER_A, { provider: "gsc" }))).toEqual([]);
  });

  it("records audit events scoped to the user", async () => {
    await repo.recordAudit({ userId: USER_A, eventType: "connection.disconnected", provider: "google", metadata: { reason: "user" } });
    const { rows } = await db.query("select user_id, event_type from public.audit_events where event_type = 'connection.disconnected'");
    expect(rows).toEqual([{ user_id: USER_A, event_type: "connection.disconnected" }]);
  });
});
