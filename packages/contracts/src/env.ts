import { z } from "zod";

const flag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

const sharedShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** `mock` serves fixture data; `live` requires real provider credentials (final phase). */
  DATA_MODE: z.enum(["mock", "live"]).default("mock"),
  /** `mock` uses the in-memory fixture repository; `postgres` uses SUPABASE_DB_URL. */
  DB_MODE: z.enum(["mock", "postgres"]).default("mock"),
  /** Escape hatch for local smoke tests of production builds. Never set in real deployments. */
  ALLOW_MOCK_IN_PRODUCTION: flag("false"),
  /** `<version>:<base64 32-byte key>[,...]` key-encryption keys, injected from a secret manager. Required in production. */
  SECRET_KEYS: z.string().min(1).optional(),
  /** Which version in SECRET_KEYS wraps new data. Defaults to the last entry. */
  SECRET_CURRENT_KEY_VERSION: z.string().min(1).max(32).optional(),
  /**
   * Base64 32-byte key for keyed fingerprints of provider tokens (Clarity quota grouping and duplicate detection).
   * Separate from SECRET_KEYS so rotating encryption keys does not change fingerprints. Required in production to save a Clarity token.
   */
  CREDENTIAL_FINGERPRINT_KEY: z.string().min(1).optional(),
  /**
   * This app's own per-project, per-UTC-day budget for Clarity Data Export requests. The provider allows 10;
   * the default leaves headroom for the project owner's own use of the same token.
   */
  CLARITY_LOCAL_DAILY_BUDGET: z.coerce.number().int().min(1).max(1000).default(1000),
  /** Operator-owned Google OAuth client. Only needed when DATA_MODE=live. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  /**
   * Operator-owned Bing Webmaster OAuth client (Bing Webmaster Tools -> Settings -> API Access -> OAuth Client).
   * Optional: customers can still connect with their own Bing API key without these.
   */
  BING_CLIENT_ID: z.string().min(1).optional(),
  BING_CLIENT_SECRET: z.string().min(1).optional(),
  /** Must match the Redirect URI registered with Bing exactly. Defaults to `${NEXT_PUBLIC_APP_URL}/api/oauth/bing/callback`. */
  BING_REDIRECT_URI: z.string().url().optional(),
  PROVIDER_GSC_ENABLED: flag("true"),
  PROVIDER_GA4_ENABLED: flag("true"),
  PROVIDER_CLARITY_ENABLED: flag("true"),
  PROVIDER_BING_ENABLED: flag("false"),
  REPORT_CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(0).default(900),
  /** Total time budget for one provider report, including retries. */
  PROVIDER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(20_000),
  /** Extra attempts for transient provider failures (the HTTP clients do not retry reports themselves). */
  REPORT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Provider calls one user may start per minute (cache hits are free). */
  REPORT_RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /** Provider calls per connected Google account per minute, to protect that account's quota. */
  REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Longest an expired cached report may be served when the provider is failing. */
  REPORT_MAX_STALE_SECONDS: z.coerce.number().int().min(0).default(86_400),
  MAX_MCP_CONCURRENT_REPORTS_PER_USER: z.coerce.number().int().min(1).default(3),
  MAX_REPORT_ROWS_DEFAULT: z.coerce.number().int().min(1).default(25),
  MAX_REPORT_ROWS_HARD_LIMIT: z.coerce.number().int().min(1).default(1000),
};

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(/[\s,]+/).filter(Boolean) : []));

const mcpShape = {
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Public origin of this server, e.g. https://mcp.example.com. The MCP endpoint is `${MCP_PUBLIC_URL}/mcp`. */
  MCP_PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  /** Issuer of the OAuth authorization server, exactly as it appears in the tokens' `iss` (Supabase: https://<ref>.supabase.co/auth/v1). */
  MCP_OAUTH_ISSUER_URL: z.string().url().optional(),
  /** JWKS location. Defaults to `${issuer}/.well-known/jwks.json`. */
  MCP_JWKS_URL: z.string().url().optional(),
  /** Value that must appear in the token's `aud`. Defaults to the MCP endpoint URL (the RFC 8707 resource). */
  MCP_RESOURCE_AUDIENCE: z.string().min(1).optional(),
  /** Accept Supabase's default `aud` of "authenticated". Weaker than audience binding: see docs/MCP.md before enabling. */
  MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** Scopes a token must carry, space or comma separated. Leave empty when the issuer cannot mint custom scopes (Supabase). */
  MCP_REQUIRED_SCOPES: csv,
  /** Browser origins allowed to call the MCP endpoint (e.g. MCP Inspector). Requests with no Origin header are unaffected. */
  MCP_ALLOWED_ORIGINS: csv,
  /** `mock` accepts `Bearer mock:<userId>`; `oauth` validates JWT access tokens from the configured issuer. */
  MCP_AUTH_MODE: z.enum(["mock", "oauth"]).default("mock"),
};

const webShape = {
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  /** `mock` uses a fixed demo user; `supabase` uses Supabase Auth sessions (later phase). */
  AUTH_MODE: z.enum(["mock", "supabase"]).default("mock"),
  /** Public MCP endpoint shown on the dashboard for adding the connector in Claude, e.g. https://mcp.example.com/mcp. */
  NEXT_PUBLIC_MCP_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  /** Publishable (anon) key. Safe for browsers; never put the service-role key here. */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
};

const sharedSchema = z.object(sharedShape);
const mcpSchema = z.object({ ...sharedShape, ...mcpShape });
const webSchema = z.object({ ...sharedShape, ...webShape });

export type SharedEnv = z.infer<typeof sharedSchema>;
export type McpEnv = z.infer<typeof mcpSchema>;
export type WebEnv = z.infer<typeof webSchema>;

type RawEnv = Record<string, string | undefined>;

function assertSafeForProduction(env: SharedEnv, mockAuth: boolean): void {
  if (env.NODE_ENV !== "production" || env.ALLOW_MOCK_IN_PRODUCTION) return;
  const problems: string[] = [];
  if (env.DATA_MODE === "mock") problems.push("DATA_MODE=mock");
  if (env.DB_MODE === "mock") problems.push("DB_MODE=mock");
  if (mockAuth) problems.push("mock authentication");
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production with ${problems.join(" and ")}.`);
  }
}

/** Throws a readable error listing every invalid variable (names only, never values). */
function parse<T extends z.ZodType>(schema: T, raw: RawEnv): z.infer<T> {
  // A variable that is present but blank (copied from .env.example, or left empty in a hosting dashboard) means "not set".
  const present = Object.fromEntries(Object.entries(raw).filter(([, v]) => v === undefined || v.trim() !== ""));
  const result = schema.safeParse(present);
  if (!result.success) {
    const names = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  return result.data;
}

export function loadSharedEnv(raw: RawEnv = process.env): SharedEnv {
  return parse(sharedSchema, raw);
}

/** The canonical MCP resource URI (RFC 8707 / RFC 9728): what clients enter and what tokens are issued for. */
export function mcpResourceUrl(env: Pick<McpEnv, "MCP_PUBLIC_URL">): string {
  return `${env.MCP_PUBLIC_URL.replace(/\/+$/, "")}/mcp`;
}

export function loadMcpEnv(raw: RawEnv = process.env): McpEnv {
  const env = parse(mcpSchema, raw);
  assertSafeForProduction(env, env.MCP_AUTH_MODE === "mock");
  if (env.MCP_AUTH_MODE === "oauth") {
    if (!env.MCP_OAUTH_ISSUER_URL) throw new Error("MCP_AUTH_MODE=oauth requires MCP_OAUTH_ISSUER_URL.");
    const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env.MCP_PUBLIC_URL);
    if (env.NODE_ENV === "production" && !loopback) {
      if (!env.MCP_PUBLIC_URL.startsWith("https://")) throw new Error("MCP_PUBLIC_URL must be https in production.");
      if (!env.MCP_OAUTH_ISSUER_URL.startsWith("https://")) throw new Error("MCP_OAUTH_ISSUER_URL must be https in production.");
    }
    const audience = env.MCP_RESOURCE_AUDIENCE ?? mcpResourceUrl(env);
    if (audience === "authenticated" && !env.MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE) {
      throw new Error('MCP_RESOURCE_AUDIENCE "authenticated" is not bound to this server; set MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE=true to accept that risk knowingly.');
    }
  }
  return env;
}

export function loadWebEnv(raw: RawEnv = process.env): WebEnv {
  const env = parse(webSchema, raw);
  assertSafeForProduction(env, env.AUTH_MODE === "mock");
  if (env.AUTH_MODE === "supabase" && (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
    throw new Error("AUTH_MODE=supabase requires NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return env;
}
