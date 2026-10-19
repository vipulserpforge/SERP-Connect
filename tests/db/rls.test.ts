import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONN_A_GA4,
  CONN_A_GSC,
  CONN_B_GSC,
  PROP_A_GSC,
  PROP_B_GSC,
  USER_A,
  USER_B,
  asRole,
  createTestDatabase,
  seedTenants,
} from "./harness.js";

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTenants(db);
});
afterAll(async () => {
  await db.close();
});

const ids = (rows: Record<string, unknown>[], key = "id") => rows.map((r) => r[key]).sort();

describe("migrations", () => {
  it("enable RLS on every public table", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("signup trigger creates a profile, independent of any Google account", async () => {
    const { rows } = await db.query("select user_id from public.profiles order by user_id");
    expect(rows.map((r) => r.user_id)).toEqual([USER_A, USER_B]);
  });
});

describe("RLS: row isolation as an authenticated user", () => {
  it("each user sees only their own rows in every readable table", async () => {
    await asRole(db, USER_A, async (q) => {
      expect(ids(await q("select user_id from public.profiles"), "user_id")).toEqual([USER_A]);
      expect(ids(await q("select id from public.provider_connections"))).toEqual([CONN_A_GA4, CONN_A_GSC].sort());
      expect((await q("select user_id from public.properties")).every((r) => r.user_id === USER_A)).toBe(true);
      expect((await q("select user_id from public.audit_events")).map((r) => r.user_id)).toEqual([USER_A]);
    });
    await asRole(db, USER_B, async (q) => {
      expect(ids(await q("select id from public.provider_connections"))).toEqual([CONN_B_GSC]);
    });
  });

  it("direct lookup of another tenant's row returns nothing", async () => {
    await asRole(db, USER_A, async (q) => {
      expect(await q("select id from public.properties where id = $1", [PROP_B_GSC])).toEqual([]);
      expect(await q("select id from public.provider_connections where id = $1", [CONN_B_GSC])).toEqual([]);
    });
  });

  it("anon can read nothing", async () => {
    for (const table of ["profiles", "properties", "provider_connections", "mcp_connection_profiles", "audit_events"]) {
      // One statement per transaction: a permission error aborts the whole transaction.
      await asRole(db, null, async (q) => {
        await expect(q(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("a user with no claim (auth.uid() null) matches no rows", async () => {
    await db.transaction(async (tx) => {
      await tx.query("set local role authenticated");
      expect((await tx.query("select * from public.properties")).rows).toEqual([]);
      await tx.rollback();
    });
  });
});

describe("RLS: server-only tables and columns", () => {
  it("secrets, cache and budgets are unreachable from the Data API roles", async () => {
    for (const table of ["provider_secrets", "report_cache", "provider_request_budgets"]) {
      await asRole(db, USER_A, async (q) => {
        await expect(q(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      });
      await asRole(db, null, async (q) => {
        await expect(q(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("users cannot read credential_version or audit metadata", async () => {
    await asRole(db, USER_A, async (q) => {
      await expect(q("select credential_version from public.provider_connections")).rejects.toThrow(/permission denied/);
    });
    await asRole(db, USER_A, async (q) => {
      await expect(q("select metadata from public.audit_events")).rejects.toThrow(/permission denied/);
    });
  });

  it("users cannot forge or edit connections or audit rows", async () => {
    await asRole(db, USER_A, async (q) => {
      await expect(
        q("insert into public.provider_connections (user_id, provider, status) values ($1, 'google', 'connected')", [USER_A]),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole(db, USER_A, async (q) => {
      await expect(q("update public.provider_connections set status = 'connected' where id = $1", [CONN_A_GSC])).rejects.toThrow(
        /permission denied/,
      );
    });
    await asRole(db, USER_A, async (q) => {
      await expect(q("insert into public.audit_events (user_id, event_type) values ($1, 'x')", [USER_A])).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describe("RLS: writes", () => {
  it("user can toggle their own property but not someone else's", async () => {
    await asRole(db, USER_A, async (q) => {
      expect(await q("update public.properties set enabled_for_mcp = false where id = $1 returning id", [PROP_A_GSC])).toHaveLength(1);
      expect(await q("update public.properties set enabled_for_mcp = false where id = $1 returning id", [PROP_B_GSC])).toHaveLength(0);
    });
  });

  it("user cannot reassign ownership or edit other property columns", async () => {
    await asRole(db, USER_A, async (q) => {
      await expect(q("update public.properties set user_id = $1 where id = $2", [USER_B, PROP_A_GSC])).rejects.toThrow(/permission denied/);
    });
    await asRole(db, USER_A, async (q) => {
      await expect(q("update public.properties set external_property_id = 'x' where id = $1", [PROP_A_GSC])).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("user can manage own MCP profiles but cannot create them for another user", async () => {
    await asRole(db, USER_A, async (q) => {
      expect(await q("insert into public.mcp_connection_profiles (user_id, name) values ($1, 'main') returning id", [USER_A])).toHaveLength(1);
    });
    await asRole(db, USER_A, async (q) => {
      await expect(q("insert into public.mcp_connection_profiles (user_id, name) values ($1, 'evil')", [USER_B])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("a profile cannot allowlist another tenant's property (composite FK + RLS)", async () => {
    await asRole(db, USER_A, async (q) => {
      const [profile] = await q("insert into public.mcp_connection_profiles (user_id, name) values ($1, 'p') returning id", [USER_A]);
      expect(await q("insert into public.mcp_profile_properties (profile_id, property_id, user_id) values ($1, $2, $3) returning property_id", [profile!.id, PROP_A_GSC, USER_A])).toHaveLength(1);
      await expect(
        q("insert into public.mcp_profile_properties (profile_id, property_id, user_id) values ($1, $2, $3)", [profile!.id, PROP_B_GSC, USER_A]),
      ).rejects.toThrow(/foreign key/);
    });
  });
});

describe("database-enforced ownership (as the privileged server role)", () => {
  it("rejects a property that points at another tenant's connection", async () => {
    await expect(
      db.query(
        "insert into public.properties (user_id, connection_id, provider, external_property_id, display_name) values ($1, $2, 'gsc', 'sc-domain:x', 'x')",
        [USER_A, CONN_B_GSC],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("allows different Google accounts per provider for one SaaS user (A/B/C scenario)", async () => {
    const { rows } = await db.query(
      "select provider_account_id from public.provider_connections where user_id = $1 order by 1",
      [USER_A],
    );
    expect(rows.map((r) => r.provider_account_id)).toEqual(["google-sub-B", "google-sub-C"]);
  });

  it("blocks connecting the same external account twice for one user, but not for two users", async () => {
    await expect(
      db.query("insert into public.provider_connections (user_id, provider, provider_account_id) values ($1, 'google', 'google-sub-B')", [USER_A]),
    ).rejects.toThrow(/duplicate key/);
    await db.transaction(async (tx) => {
      await tx.query("insert into public.provider_connections (user_id, provider, provider_account_id) values ($1, 'google', 'google-sub-B')", [USER_B]);
      await tx.rollback();
    });
  });

  it("disconnect cascades to properties and secrets", async () => {
    await db.transaction(async (tx) => {
      await tx.query("delete from public.provider_connections where id = $1", [CONN_A_GSC]);
      expect((await tx.query("select 1 from public.properties where connection_id = $1", [CONN_A_GSC])).rows).toHaveLength(0);
      expect((await tx.query("select 1 from public.provider_secrets where connection_id = $1", [CONN_A_GSC])).rows).toHaveLength(0);
      await tx.rollback();
    });
  });

  it("deleting a user removes all of their data", async () => {
    await db.transaction(async (tx) => {
      await tx.query("delete from auth.users where id = $1", [USER_B]);
      for (const t of ["profiles", "provider_connections", "properties", "provider_secrets", "audit_events"]) {
        const col = t === "provider_secrets" ? "connection_id" : "user_id";
        const where = t === "provider_secrets" ? `${col} = '${CONN_B_GSC}'` : `${col} = '${USER_B}'`;
        expect((await tx.query(`select 1 from public.${t} where ${where}`)).rows).toHaveLength(0);
      }
      await tx.rollback();
    });
  });
});

describe("private.consume_provider_budget", () => {
  it("never allows more than the limit, and is not callable by API roles", async () => {
    let allowed = 0;
    for (let i = 0; i < 15; i++) {
      const { rows } = await db.query("select * from private.consume_provider_budget('clarity', 'proj-1', '2026-10-19', 10)");
      allowed += rows.length;
    }
    expect(allowed).toBe(10);
    await asRole(db, USER_A, async (q) => {
      await expect(q("select * from private.consume_provider_budget('clarity', 'p', '2026-10-19', 10)")).rejects.toThrow(/permission denied/);
    });
  });
});
