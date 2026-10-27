import { BingConnectionService, ClarityConnectionService, CredentialService, createLiveAdapters } from "@serp/credentials";
import type { McpEnv } from "@serp/contracts";
import { PgClarityQuotaStore, PgClaritySnapshotStore, PgCredentialRepository, PgRepository, PgReportCache } from "@serp/db";
import { createPgExecutor, readDatabaseUrl } from "@serp/db/pg";
import type { Logger } from "@serp/observability";
import { HttpBingApiClient, HttpBingOAuthClient } from "@serp/provider-bing";
import { HttpGoogleOAuthClient } from "@serp/provider-google";
import { createFingerprinterFromEnv, createKeyProviderFromEnv, type Fingerprinter } from "@serp/secrets";

/**
 * Live wiring: reports use each user's own encrypted Google credentials. Refuses to start without a database,
 * a real encryption key and the operator's Google client, so it can never fall back to shared or plaintext secrets.
 */
export function buildLiveReporting(env: McpEnv, logger: Logger) {
  if (env.DB_MODE !== "postgres") throw new Error("DATA_MODE=live requires DB_MODE=postgres.");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("DATA_MODE=live requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  const { provider: keys, ephemeral } = createKeyProviderFromEnv(env);
  if (ephemeral) throw new Error("DATA_MODE=live requires SECRET_KEYS: an ephemeral key cannot decrypt stored credentials.");

  const db = createPgExecutor(readDatabaseUrl());
  const repo = new PgRepository(db);
  const credentials = new CredentialService({
    creds: new PgCredentialRepository(db),
    repo,
    keys,
    google: new HttpGoogleOAuthClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
    logger,
  });
  // The MCP server only reads tokens; it needs the fingerprinter only to satisfy the shared service (saving happens in the web app).
  let fingerprinter: Fingerprinter | undefined;
  const clarity = new ClarityConnectionService({
    creds: new PgCredentialRepository(db),
    repo,
    keys,
    logger,
    fingerprinter: () => (fingerprinter ??= createFingerprinterFromEnv(env)),
  });
  const clarityQuota = new PgClarityQuotaStore(db, env.CLARITY_LOCAL_DAILY_BUDGET);
  // Bing: this server only reads credentials (and renews OAuth access tokens). Without the operator's OAuth client it can still
  // serve API-key connections; OAuth connections then report that renewal is unavailable instead of failing obscurely.
  const bingApi = new HttpBingApiClient({ timeoutMs: env.PROVIDER_REQUEST_TIMEOUT_MS });
  const bing = new BingConnectionService({
    creds: new PgCredentialRepository(db),
    repo,
    keys,
    api: bingApi,
    oauth:
      env.BING_CLIENT_ID && env.BING_CLIENT_SECRET
        ? {
            client: new HttpBingOAuthClient({ clientId: env.BING_CLIENT_ID, clientSecret: env.BING_CLIENT_SECRET }),
            config: { clientId: env.BING_CLIENT_ID, redirectUri: env.BING_REDIRECT_URI ?? "https://invalid.invalid/unused" },
          }
        : null,
    fingerprinter: () => (fingerprinter ??= createFingerprinterFromEnv(env)),
    logger,
  });
  const adapters = createLiveAdapters(credentials, { timeoutMs: env.PROVIDER_REQUEST_TIMEOUT_MS, clarity: { connections: clarity, quota: clarityQuota }, bing: { connections: bing, client: bingApi } });
  return { repo, cache: new PgReportCache(db), clarityQuota, claritySnapshots: new PgClaritySnapshotStore(db), ...adapters };
}
