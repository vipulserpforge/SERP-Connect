// SERVER ONLY. Import from "@serp/db/supabase" in trusted server code, never in browser bundles.
// The service-role client bypasses RLS, so callers must always scope queries by an
// authenticated user id (see the Repository contract).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseServerConfig {
  url: string;
  serviceRoleKey: string;
}

export function readSupabaseServerConfig(env: Record<string, string | undefined> = process.env): SupabaseServerConfig {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return { url, serviceRoleKey };
}

export function createServiceClient(config: SupabaseServerConfig = readSupabaseServerConfig()): SupabaseClient {
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
