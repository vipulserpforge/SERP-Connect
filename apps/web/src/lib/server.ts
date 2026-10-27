import "server-only";
import { redirect } from "next/navigation";
import { BingConnectionService, ClarityConnectionService, CredentialService, OAuthFlowService, PropertyDiscoveryService, createLiveAdapters } from "@serp/credentials";
import { ConnectorException, isConnectorException } from "@serp/contracts";
import {
  MOCK_USER_A_ID,
  MockRepository,
  PgClarityQuotaStore,
  PgClaritySnapshotStore,
  PgCredentialRepository,
  PgReportCache,
  PgRepository,
  type CredentialRepository,
  type Repository,
} from "@serp/db";
import { createPgExecutor, readDatabaseUrl } from "@serp/db/pg";
import { createLogger } from "@serp/observability";
import {
  HttpGoogleOAuthClient,
  MOCK_CLIENT_ID,
  MockGoogleOAuthClient,
  type GoogleOAuthClient,
} from "@serp/provider-google";
import { HttpBingApiClient, HttpBingOAuthClient, MockBingApiClient, MockBingOAuthClient, type BingApiClient } from "@serp/provider-bing";
import { HttpGa4ApiClient, MockGa4ApiClient } from "@serp/provider-ga4";
import { HttpGscApiClient, MockGscApiClient } from "@serp/provider-gsc";
import { ReportService, createReportService } from "@serp/reporting";
import { MemoryClarityQuotaStore, type ClarityQuotaStore } from "@serp/provider-clarity";
import { createFingerprinterFromEnv, createKeyProviderFromEnv, type Fingerprinter } from "@serp/secrets";
import type { ReportCache } from "@serp/cache";
import { getEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const logger = createLogger({ bindings: { service: "web" } });

interface Services {
  repo: Repository;
  creds: CredentialRepository;
  credentials: CredentialService;
  oauth: OAuthFlowService;
  discovery: PropertyDiscoveryService;
  /** Microsoft Clarity tokens: encrypted storage, rename/reconnect, and the durable daily request budget. */
  clarity: ClarityConnectionService;
  clarityQuota: ClarityQuotaStore;
  /** Bing Webmaster: OAuth or API-key connections, token renewal, site discovery. */
  bing: BingConnectionService;
  /** The same reporting layer the MCP server uses: validation, caching, limits, timeouts and retries. */
  reports: ReportService;
  /** False in live mode until Google OAuth credentials exist. */
  googleConfigured: boolean;
}

// One set per process: the mock keeps its data, the pg pool and the (dev-ephemeral) key are reused.
const globalForServices = globalThis as unknown as { __serpServices?: Services };

/** Used in live mode until the operator's Google OAuth client is configured: every call fails closed. */
const unconfiguredGoogle: GoogleOAuthClient = {
  async exchangeCode() {
    throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Google connections are not configured yet.");
  },
  async refresh() {
    throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Google connections are not configured yet.");
  },
  async revoke() {
    throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Google connections are not configured yet.");
  },
};

function buildGoogleClient(): { client: GoogleOAuthClient; clientId: string; configured: boolean } {
  const env = getEnv();
  if (env.DATA_MODE === "mock") return { client: new MockGoogleOAuthClient(), clientId: MOCK_CLIENT_ID, configured: true };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return { client: unconfiguredGoogle, clientId: "unconfigured", configured: false };
  return {
    client: new HttpGoogleOAuthClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
    clientId: env.GOOGLE_CLIENT_ID,
    configured: true,
  };
}

/** Wires repositories, the key provider and the credential services. All sensitive work stays in here, server-side. */
export function getServices(): Services {
  // A set built by an older version of this file (dev hot reload) lacks newer services: rebuild instead of using it.
  if (globalForServices.__serpServices?.bing) return globalForServices.__serpServices;
  const env = getEnv();

  let repo: Repository;
  let creds: CredentialRepository;
  let cache: ReportCache | undefined;
  let clarityQuota: ClarityQuotaStore = new MemoryClarityQuotaStore(env.CLARITY_LOCAL_DAILY_BUDGET);
  let claritySnapshots: PgClaritySnapshotStore | undefined;
  if (env.DB_MODE === "postgres") {
    const db = createPgExecutor(readDatabaseUrl());
    repo = new PgRepository(db);
    creds = new PgCredentialRepository(db);
    cache = new PgReportCache(db);
    clarityQuota = new PgClarityQuotaStore(db, env.CLARITY_LOCAL_DAILY_BUDGET);
    claritySnapshots = new PgClaritySnapshotStore(db);
  } else {
    const mock = new MockRepository();
    repo = mock;
    creds = mock;
  }

  const { provider: keys, ephemeral } = createKeyProviderFromEnv(env);
  if (ephemeral) logger.warn("secrets.ephemeral_key", { hint: "SECRET_KEYS is not set: using a throwaway dev key; stored credentials will not survive a restart." });

  const { client: google, clientId, configured: googleConfigured } = buildGoogleClient();
  const credentials = new CredentialService({ creds, repo, keys, google, logger });
  const redirectUri = env.GOOGLE_REDIRECT_URI ?? `${env.NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`;
  const oauth = new OAuthFlowService({ creds, repo, keys, google, credentials, logger, config: { clientId, redirectUri } });

  const discovery = new PropertyDiscoveryService({
    repo,
    credentials,
    gsc: env.DATA_MODE === "mock" ? new MockGscApiClient() : new HttpGscApiClient(),
    ga4: env.DATA_MODE === "mock" ? new MockGa4ApiClient() : new HttpGa4ApiClient(),
    logger,
  });

  // Created on first use: a missing CREDENTIAL_FINGERPRINT_KEY must stop Clarity saves, not the whole app.
  let fingerprinter: Fingerprinter | undefined;
  const clarity = new ClarityConnectionService({ creds, repo, keys, logger, fingerprinter: () => (fingerprinter ??= createFingerprinterFromEnv(env)) });

  // Bing OAuth needs the operator's own registered client. Without it only the API-key option is offered.
  const bingApi: BingApiClient = env.DATA_MODE === "mock" ? new MockBingApiClient() : new HttpBingApiClient({ timeoutMs: env.PROVIDER_REQUEST_TIMEOUT_MS });
  const bingRedirectUri = env.BING_REDIRECT_URI ?? `${env.NEXT_PUBLIC_APP_URL}/api/oauth/bing/callback`;
  const bingOAuth =
    env.DATA_MODE === "mock"
      ? { client: new MockBingOAuthClient(), config: { clientId: "mock-bing-client", redirectUri: bingRedirectUri } }
      : env.BING_CLIENT_ID && env.BING_CLIENT_SECRET
        ? { client: new HttpBingOAuthClient({ clientId: env.BING_CLIENT_ID, clientSecret: env.BING_CLIENT_SECRET }), config: { clientId: env.BING_CLIENT_ID, redirectUri: bingRedirectUri } }
        : null;
  const bing = new BingConnectionService({ creds, repo, keys, api: bingApi, oauth: bingOAuth, fingerprinter: () => (fingerprinter ??= createFingerprinterFromEnv(env)), logger });

  const reports = createReportService(env, {
    repo,
    ...(cache && { cache }),
    clarityQuota,
    ...(claritySnapshots && { claritySnapshots }),
    logger,
    ...(env.DATA_MODE === "live" && createLiveAdapters(credentials, { timeoutMs: env.PROVIDER_REQUEST_TIMEOUT_MS, clarity: { connections: clarity, quota: clarityQuota }, bing: { connections: bing, client: bingApi } })),
  });

  return (globalForServices.__serpServices = { repo, creds, credentials, oauth, discovery, clarity, clarityQuota, bing, reports, googleConfigured });
}

/**
 * Server-side data access. With DB_MODE=postgres this is a direct connection that bypasses RLS,
 * so callers must only pass a userId obtained from getSessionUser(), never from request input.
 */
export function getRepository(): Repository {
  return getServices().repo;
}

export interface SessionUser {
  userId: string;
  email: string | null;
  mock: boolean;
}

/**
 * Resolves the caller from a verified session. Uses auth.getUser(), which validates the token with
 * the Auth server, rather than trusting cookie contents. Fails closed.
 */
export async function getSessionUser(): Promise<SessionUser> {
  const env = getEnv();
  if (env.AUTH_MODE === "mock") return { userId: MOCK_USER_A_ID, email: "demo@example.com", mock: true };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ConnectorException("AUTH_REQUIRED", "Sign in to continue.");
  return { userId: data.user.id, email: data.user.email ?? null, mock: false };
}

/** For pages and server actions: returns the user or redirects to /login. Call it in every protected page. */
export async function requireUser(nextPath = "/dashboard"): Promise<SessionUser> {
  try {
    return await getSessionUser();
  } catch (err) {
    if (isConnectorException(err) && err.code === "AUTH_REQUIRED") {
      redirect(`/login?next=${encodeURIComponent(nextPath)}`);
    }
    throw err;
  }
}
