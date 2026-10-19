// SERVER ONLY. Import from "@serp/db/pg". Uses a direct Postgres connection (service-level
// access that bypasses RLS), so callers rely on PgRepository's explicit user_id scoping.
import pg from "pg";
import type { SqlExecutor } from "./pg-repository.js";

export function createPgExecutor(connectionString: string): SqlExecutor & { close(): Promise<void> } {
  // Remote databases (Supabase) are always reached over TLS. Supabase's CA is not in Node's trust store,
  // so the server certificate is not verified yet; pin its CA (ssl.ca) before handling real customer data.
  const host = new URL(connectionString).hostname;
  const ssl = host === "localhost" || host === "127.0.0.1" ? undefined : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString, ssl, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    close: () => pool.end(),
  };
}

export function readDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.SUPABASE_DB_URL;
  if (!url) throw new Error("Database is not configured: set SUPABASE_DB_URL.");
  return url;
}
