import type { PGlite } from "@electric-sql/pglite";
import { loadSharedEnv } from "@serp/contracts";
import { BingConnectionService, ClarityConnectionService, CredentialService, OAuthFlowService, PropertyDiscoveryService, createLiveAdapters } from "@serp/credentials";
import { PgClarityQuotaStore, PgCredentialRepository, PgReportCache, PgRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { HttpBingApiClient, HttpBingOAuthClient } from "@serp/provider-bing";
import { HttpGa4ApiClient } from "@serp/provider-ga4";
import { MOCK_CLIENT_ID, MockGoogleOAuthClient, type GoogleTokenSet } from "@serp/provider-google";
import { HttpGscApiClient } from "@serp/provider-gsc";
import { createReportService } from "@serp/reporting";
import { KeyRingProvider, createFingerprinterFromEnv, generateLocalMasterKey } from "@serp/secrets";
import { FakeBing } from "../bing/fake-bing.js";
import { FakeClarityClient } from "../clarity/fake-clarity.js";
import { createTestDatabase, pgliteExecutor } from "../db/harness.js";
import { startStack, type Stack } from "../mcp/harness.js";
import { FakeGoogle, type Owner } from "./fake-google.js";

export const ALICE_ID = "00000000-0000-4000-8000-00000000000a";
export const BOB_ID = "00000000-0000-4000-8000-00000000000b";
export const ID_OF: Record<Owner, string> = { alice: ALICE_ID, bob: BOB_ID };
export const NOW = new Date("2026-10-19T12:00:00Z");

/** The mock consent screen, plus a record of which Google account each access token belongs to. */
class TaggingOAuth extends MockGoogleOAuthClient {
  constructor(private readonly google: FakeGoogle, clock: () => number) {
    super(clock);
  }
  private tag(t: GoogleTokenSet, owner: string) {
    this.google.tokens.set(t.accessToken, owner as Owner);
    return t;
  }
  override async exchangeCode(input: Parameters<MockGoogleOAuthClient["exchangeCode"]>[0]) {
    const t = await super.exchangeCode(input);
    return this.tag(t, t.refreshToken!.replace("mock-refresh-token-", "").split("@")[0]!);
  }
  override async refresh(refreshToken: string) {
    const t = await super.refresh(refreshToken);
    return this.tag(t, refreshToken.replace("mock-refresh-token-", "").split("@")[0]!);
  }
}

/**
 * The real server-side composition (as apps/web and apps/mcp-server build it): migrated Postgres, envelope-encrypted
 * credentials, live HTTP Google clients, Postgres report cache, and the MCP server behind signed OAuth tokens.
 * Only Google itself (and the Google consent screen) is replaced.
 */
export async function buildWorld() {
  const db: PGlite = await createTestDatabase();
  await db.exec(`insert into auth.users (id, email) values ('${ALICE_ID}', 'alice@saas.test'), ('${BOB_ID}', 'bob@saas.test')`);
  const exec = pgliteExecutor(db);
  const repo = new PgRepository(exec);
  const creds = new PgCredentialRepository(exec);
  const cache = new PgReportCache(exec);
  const keys = new KeyRingProvider({ v1: generateLocalMasterKey() }, "v1");
  const google = new FakeGoogle();
  await google.start();

  const time = { now: NOW.getTime() };
  const clock = () => time.now;
  const oauthClient = new TaggingOAuth(google, clock);
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const credentials = new CredentialService({ creds, repo, keys, google: oauthClient, logger, clock });
  const oauth = new OAuthFlowService({ creds, repo, keys, google: oauthClient, credentials, logger, clock, config: { clientId: MOCK_CLIENT_ID, redirectUri: "http://localhost/cb" } });

  const gscClient = new HttpGscApiClient({ ...google.clientOptions.gsc, timeoutMs: 2000, maxRetries: 0 });
  const ga4Client = new HttpGa4ApiClient({ ...google.clientOptions.ga4, timeoutMs: 2000, maxRetries: 0 });
  const discovery = new PropertyDiscoveryService({ repo, credentials, gsc: gscClient, ga4: ga4Client, logger });

  const fakeClarity = new FakeClarityClient();
  const clarityQuota = new PgClarityQuotaStore(exec, 8);
  const fingerprinter = createFingerprinterFromEnv({ NODE_ENV: "test" });
  const clarity = new ClarityConnectionService({ creds, repo, keys, logger, fingerprinter: () => fingerprinter });

  const fakeBing = new FakeBing();
  await fakeBing.start();
  const bingApi = new HttpBingApiClient({ baseUrl: fakeBing.apiBase, timeoutMs: 2000 });
  const bing = new BingConnectionService({
    creds,
    repo,
    keys,
    logger,
    clock,
    api: bingApi,
    fingerprinter: () => fingerprinter,
    oauth: {
      client: new HttpBingOAuthClient({ clientId: fakeBing.client.id, clientSecret: fakeBing.client.secret, tokenEndpoint: fakeBing.tokenEndpoint, now: clock }),
      config: { clientId: fakeBing.client.id, redirectUri: fakeBing.client.redirectUri },
    },
  });

  const env = { ...loadSharedEnv({ NODE_ENV: "test", DATA_MODE: "live", PROVIDER_BING_ENABLED: "true" }), LOG_LEVEL: "error" as const };
  const sleeps: number[] = [];
  const service = createReportService(env, {
    repo,
    cache,
    clarityQuota,
    logger: createLogger({ level: "error" }),
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    ...createLiveAdapters(credentials, { timeoutMs: 2000, gscClient, ga4Client, clarity: { connections: clarity, quota: clarityQuota, client: fakeClarity }, bing: { connections: bing, client: bingApi } }),
  });

  /** Connect a user's Google account for both products and discover its properties. */
  async function connect(owner: Owner) {
    const userId = ID_OF[owner];
    const email = `${owner}@saas.test`;
    let connectionId = "";
    for (const product of ["gsc", "ga4"] as const) {
      const { authorizationUrl } = await oauth.begin(userId, product);
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      ({ connectionId } = await oauth.complete(userId, { state, code: `mock-code:${email}#${product}`, error: null }));
    }
    await discovery.syncGsc(userId, connectionId);
    await discovery.syncGa4(userId, connectionId);
    return connectionId;
  }

  const stack: Stack = await startStack({ service, env: { PROVIDER_CLARITY_ENABLED: "true", PROVIDER_BING_ENABLED: "true" } });
  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;

  return {
    db, sql, repo, creds, cache, credentials, clarity, clarityQuota, fakeClarity, bing, fakeBing, oauth, google, oauthClient, time, logs, service, sleeps, stack, connect, keys,
    async close() {
      await stack.stop();
      await google.stop();
      await fakeBing.stop();
      await db.close();
    },
  };
}
export type World = Awaited<ReturnType<typeof buildWorld>>;
