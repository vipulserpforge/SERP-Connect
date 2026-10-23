import type { AuthorizedQueryContext } from "@serp/contracts";
import { HttpGa4ApiClient, createGa4Adapter, type Ga4ApiClient } from "@serp/provider-ga4";
import { HttpGscApiClient, createGscAdapter, type GscApiClient } from "@serp/provider-gsc";
import { HttpClarityApiClient, createClarityAdapter, type ClarityApiClient, type ClarityQuotaStore } from "@serp/provider-clarity";
import { createBingAdapter, HttpBingApiClient, type BingApiClient } from "@serp/provider-bing";
import type { BingConnectionService } from "./bing.js";
import type { ClarityConnectionService } from "./clarity.js";
import type { CredentialService } from "./service.js";

export interface LiveAdapterOptions {
  /** Per-attempt HTTP timeout. The reporting layer also enforces one overall deadline. */
  timeoutMs: number;
  gscClient?: GscApiClient;
  ga4Client?: Ga4ApiClient;
  /** Clarity uses per-project API tokens (not Google OAuth) and a durable request budget. */
  clarity: { connections: ClarityConnectionService; quota: ClarityQuotaStore; client?: ClarityApiClient; /** Clock for quota windows; tests only. */ now?: () => Date };
  /** Bing Webmaster: per-connection credentials (OAuth or API key), chosen by the connection, never by the caller. */
  bing: { connections: BingConnectionService; client?: BingApiClient };
}

/**
 * Report adapters that authenticate with each user's own stored credentials. Shared by the dashboard and the MCP
 * server. The HTTP clients do not retry: the reporting layer owns retries so there is exactly one policy.
 */
export function createLiveAdapters(credentials: CredentialService, options: LiveAdapterOptions) {
  const tokens = {
    // The token is fetched for the connection the authorization step already resolved: never a caller-supplied id.
    getAccessToken: async (ctx: AuthorizedQueryContext) => (await credentials.getAccessToken(ctx.userId, ctx.connection.id, ctx.requestId)).accessToken,
    refreshAccessToken: async (ctx: AuthorizedQueryContext) => (await credentials.forceRefreshAccessToken(ctx.userId, ctx.connection.id, ctx.requestId)).accessToken,
    onAuthRejected: (ctx: AuthorizedQueryContext) => credentials.markNeedsAttention(ctx.userId, ctx.connection.id, "AUTH_EXPIRED", ctx.requestId),
  };
  return {
    gsc: createGscAdapter("live", { ...tokens, client: options.gscClient ?? new HttpGscApiClient({ timeoutMs: options.timeoutMs, maxRetries: 0 }) }),
    clarity: createClarityAdapter("live", {
      client: options.clarity.client ?? new HttpClarityApiClient({ timeoutMs: options.timeoutMs }),
      quota: options.clarity.quota,
      getToken: (ctx: AuthorizedQueryContext) => options.clarity.connections.getToken(ctx.userId, ctx.connection.id),
      hooks: options.clarity.connections.hooks,
      ...(options.clarity.now && { now: options.clarity.now }),
    }),
    bing: createBingAdapter({
      client: options.bing.client ?? new HttpBingApiClient({ timeoutMs: options.timeoutMs }),
      getAuth: (ctx: AuthorizedQueryContext) => options.bing.connections.getAuth(ctx.userId, ctx.connection.id),
      hooks: options.bing.connections.hooks,
    }),
    ga4: createGa4Adapter("live", { ...tokens, client: options.ga4Client ?? new HttpGa4ApiClient({ timeoutMs: options.timeoutMs, maxRetries: 0 }) }),
  };
}
