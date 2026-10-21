// SERVER ONLY. Import from "@serp/db/pg". Uses a direct Postgres connection (service-level
// access that bypasses RLS), so callers rely on PgRepository's explicit user_id scoping.
import { rootCertificates, type ConnectionOptions } from "node:tls";
import pg from "pg";
import type { SqlExecutor } from "./pg-repository.js";
import { SUPABASE_ROOT_CA } from "./supabase-ca.js";

type Env = Record<string, string | undefined>;

/**
 * TLS settings for the database connection.
 * - localhost: no TLS (local development and tests).
 * - everything else: the server certificate IS verified, against Node's trusted roots plus Supabase's public root CA.
 * - SUPABASE_DB_CA (PEM, "\n" allowed for line breaks) replaces the bundled CA, for a different provider or a rotated CA.
 * There is deliberately no switch to turn verification off.
 */
export function sslOptionsFor(host: string, env: Env = process.env): ConnectionOptions | undefined {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return undefined;
  const custom = env.SUPABASE_DB_CA?.replace(/\\n/g, "\n").trim();
  return { rejectUnauthorized: true, ca: [...rootCertificates, custom || SUPABASE_ROOT_CA] };
}

/**
 * Connections held open at once by this process. A long-running server (the MCP server on a VPS) can keep a few.
 * On Vercel every function instance has its own pool, so a small default keeps the total under the database pooler's
 * client limit. DB_POOL_MAX overrides both.
 */
export function poolSizeFor(env: Env = process.env): number {
  const configured = Number(env.DB_POOL_MAX);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 50) return configured;
  return env.VERCEL ? 2 : 5;
}

export function createPgExecutor(connectionString: string): SqlExecutor & { close(): Promise<void> } {
  const host = new URL(connectionString).hostname;
  const pool = new pg.Pool({ connectionString, ssl: sslOptionsFor(host), max: poolSizeFor(), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    close: () => pool.end(),
  };
}

export function readDatabaseUrl(env: Env = process.env): string {
  const url = env.SUPABASE_DB_URL;
  if (!url) throw new Error("Database is not configured: set SUPABASE_DB_URL.");
  return url;
}
