import { z } from "zod";
import { BING_AUTHORIZE_ENDPOINT, BING_READ_SCOPE, BING_TOKEN_ENDPOINT } from "./constants.js";

export interface BingAuthUrlInput {
  clientId: string;
  /** Must equal the Redirect URI registered with Bing character for character. */
  redirectUri: string;
  state: string;
}

/**
 * Authorization-code request, exactly the four parameters Microsoft documents: client_id, response_type=code, redirect_uri
 * and scope. `state` is added as standard OAuth 2.0 CSRF protection (RFC 6749 section 10.12); the page does not mention it,
 * so the live check confirms Bing returns it unchanged. No PKCE: Microsoft documents none for this provider.
 */
export function buildBingAuthUrl(input: BingAuthUrlInput): string {
  const url = new URL(BING_AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: BING_READ_SCOPE,
    state: input.state,
  }).toString();
  return url.toString();
}

export interface BingTokenSet {
  accessToken: string;
  /** Present on the first grant. A refresh response is documented without one: keep the stored token then. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type BingOAuthErrorKind =
  | "invalid_grant" // code expired/reused (valid for 5 minutes) or refresh token revoked: the user must reconnect
  | "invalid_client" // our own client id/secret/redirect is wrong: operator problem
  | "transient" // network, timeout, 429, 5xx
  | "bad_response";

/** Sanitized: a kind only. Upstream bodies, codes and tokens are never attached. */
export class BingOAuthError extends Error {
  constructor(readonly kind: BingOAuthErrorKind) {
    super(`Bing OAuth request failed: ${kind}`);
    this.name = "BingOAuthError";
  }
}

export interface BingOAuthClient {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<BingTokenSet>;
  refresh(refreshToken: string): Promise<BingTokenSet>;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(10).max(8192),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(10).max(8192).optional(),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
});

export interface HttpBingOAuthOptions {
  clientId: string;
  clientSecret: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Real client for the documented token endpoint.
 *
 * Microsoft's page contradicts itself on refreshing: the parameter table says grant_type must be `authorization_code`,
 * while its sample request (and RFC 6749 section 6) use `refresh_token`. This client follows the sample and the RFC.
 * That is unverified against the live server; `pnpm bing:check` exercises it, and the operator guide says so.
 */
export class HttpBingOAuthClient implements BingOAuthClient {
  private readonly opts: Required<Omit<HttpBingOAuthOptions, "fetch" | "now">> & { fetch: typeof fetch; now: () => number };

  constructor(options: HttpBingOAuthOptions) {
    this.opts = { tokenEndpoint: BING_TOKEN_ENDPOINT, timeoutMs: 10_000, fetch: globalThis.fetch, now: Date.now, ...options };
  }

  private async post(params: Record<string, string>): Promise<BingTokenSet> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...params, client_id: this.opts.clientId, client_secret: this.opts.clientSecret }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new BingOAuthError("transient");
    }
    if (!res.ok) throw await this.classify(res);
    let parsed;
    try {
      parsed = tokenResponseSchema.safeParse(await res.json());
    } catch {
      throw new BingOAuthError("bad_response");
    }
    if (!parsed.success) throw new BingOAuthError("bad_response");
    const t = parsed.data;
    return { accessToken: t.access_token, ...(t.refresh_token && { refreshToken: t.refresh_token }), expiresAt: this.opts.now() + t.expires_in * 1000 };
  }

  private async classify(res: Response): Promise<BingOAuthError> {
    if (res.status === 429 || res.status >= 500) return new BingOAuthError("transient");
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown }).error;
    } catch {
      /* not JSON */
    }
    if (error === "invalid_grant") return new BingOAuthError("invalid_grant");
    if (error === "invalid_client" || error === "unauthorized_client" || error === "invalid_request") return new BingOAuthError("invalid_client");
    // Without a recognisable OAuth error, a 400/401 on a code or refresh exchange is most likely a spent or revoked grant.
    return new BingOAuthError(res.status === 400 || res.status === 401 ? "invalid_grant" : "bad_response");
  }

  exchangeCode(input: { code: string; redirectUri: string }): Promise<BingTokenSet> {
    return this.post({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  }

  refresh(refreshToken: string): Promise<BingTokenSet> {
    return this.post({ grant_type: "refresh_token", refresh_token: refreshToken });
  }
}

export const MOCK_BING_CODE_PREFIX = "mock-bing-code:";

/** Development stand-in: no network. Codes look like `mock-bing-code:<anything>`; tokens are obviously fake. */
export class MockBingOAuthClient implements BingOAuthClient {
  refreshCalls = 0;
  exchangeCalls = 0;
  failRefreshWith: BingOAuthErrorKind | null = null;
  /** Make refresh responses include a new refresh token (Bing documents none). */
  rotateRefreshToken = false;
  refreshDelayMs = 0;
  private counter = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlSeconds = 3600,
  ) {}

  async exchangeCode(input: { code: string }): Promise<BingTokenSet> {
    this.exchangeCalls++;
    if (!input.code.startsWith(MOCK_BING_CODE_PREFIX)) throw new BingOAuthError("invalid_grant");
    return { accessToken: `mock-bing-access-${++this.counter}`, refreshToken: `mock-bing-refresh-${input.code.slice(MOCK_BING_CODE_PREFIX.length)}`, expiresAt: this.clock() + this.ttlSeconds * 1000 };
  }

  async refresh(refreshToken: string): Promise<BingTokenSet> {
    this.refreshCalls++;
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.failRefreshWith) throw new BingOAuthError(this.failRefreshWith);
    if (!refreshToken.startsWith("mock-bing-refresh-")) throw new BingOAuthError("invalid_grant");
    return {
      accessToken: `mock-bing-access-${++this.counter}`,
      ...(this.rotateRefreshToken && { refreshToken: `mock-bing-refresh-rotated-${this.counter}` }),
      expiresAt: this.clock() + this.ttlSeconds * 1000,
    };
  }
}
