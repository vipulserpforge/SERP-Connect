import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { SqlExecutor } from "@serp/db";

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

/**
 * Minimal stand-in for the parts of a Supabase project our migrations rely on:
 * the auth schema, auth.uid(), the three API roles and Supabase's permissive default grants.
 * Keeping the default grants matters: it proves our REVOKEs, not the defaults, do the securing.
 */
const SUPABASE_SHIM = `
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const CONN_A_GSC = "a1111111-1111-4111-8111-111111111111";
export const CONN_A_GA4 = "a2222222-2222-4222-8222-222222222222";
export const CONN_B_GSC = "b1111111-1111-4111-8111-111111111111";
export const PROP_A_GSC = "a3333333-3333-4333-8333-333333333333";
export const PROP_A_GA4 = "a4444444-4444-4444-8444-444444444444";
export const PROP_B_GSC = "b3333333-3333-4333-8333-333333333333";

export async function createTestDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await db.exec(readFileSync(`${migrationsDir}/${file}`, "utf8"));
  return db;
}

/** Seeds two tenants. User A connects GSC via Google account B and GA4 via account C. */
export async function seedTenants(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@saas.test'), ('${USER_B}', 'b@saas.test');

    insert into public.provider_connections (id, user_id, provider, provider_account_id, account_label, status, granted_scopes) values
      ('${CONN_A_GSC}', '${USER_A}', 'google', 'google-sub-B', 'acct B', 'connected', '{https://www.googleapis.com/auth/webmasters.readonly}'),
      ('${CONN_A_GA4}', '${USER_A}', 'google', 'google-sub-C', 'acct C', 'connected', '{https://www.googleapis.com/auth/analytics.readonly}'),
      ('${CONN_B_GSC}', '${USER_B}', 'google', 'google-sub-X', 'acct X', 'connected', '{https://www.googleapis.com/auth/webmasters.readonly}');

    insert into public.properties (id, user_id, connection_id, provider, external_property_id, display_name) values
      ('${PROP_A_GSC}', '${USER_A}', '${CONN_A_GSC}', 'gsc', 'sc-domain:a.example', 'a.example'),
      ('${PROP_A_GA4}', '${USER_A}', '${CONN_A_GA4}', 'ga4', '111', 'A GA4'),
      ('${PROP_B_GSC}', '${USER_B}', '${CONN_B_GSC}', 'gsc', 'sc-domain:b.example', 'b.example');

    insert into public.provider_secrets (connection_id, ciphertext, nonce, auth_tag, wrapped_dek, key_version) values
      ('${CONN_A_GSC}', 'ct', 'n', 't', 'k', 'v1'),
      ('${CONN_B_GSC}', 'ct', 'n', 't', 'k', 'v1');

    insert into public.audit_events (user_id, event_type, metadata) values
      ('${USER_A}', 'connection.created', '{"secret_hint":"x"}'), ('${USER_B}', 'connection.created', '{}');
  `);
}

/**
 * Runs `fn` the way PostgREST would: inside a transaction, as the `authenticated` role,
 * with the user's id in the JWT claim that auth.uid() reads. `userId = null` means `anon`.
 * The transaction is always rolled back so tests cannot affect each other.
 */
export async function asRole<T>(
  db: PGlite,
  userId: string | null,
  fn: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const rollback = Symbol("rollback");
  let result!: T;
  try {
    await db.transaction(async (tx) => {
      await tx.query(`set local role ${userId ? "authenticated" : "anon"}`);
      if (userId) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      result = await fn(async (sql, params) => (await tx.query<Record<string, unknown>>(sql, params)).rows);
      await tx.rollback();
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
  return result;
}

/** Adapts PGlite to the repository's SqlExecutor (acts as the privileged server connection). */
export function pgliteExecutor(db: PGlite): SqlExecutor {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await db.query<T>(text, params)).rows;
    },
  };
}
