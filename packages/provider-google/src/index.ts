import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// No Google Cloud project is assumed. The OAuth client id/secret/redirect are injected by
// configuration in the final phase; until then MockGoogleOAuthClient stands in.

export const GOOGLE_SCOPES = {
  gsc: "https://www.googleapis.com/auth/webmasters.readonly",
  ga4: "https://www.googleapis.com/auth/analytics.readonly",
} as const;

export type GoogleProductKey = keyof typeof GOOGLE_SCOPES;

/** Identity scopes (non-sensitive) give a stable account id (`sub`) and a label to show the user. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

/** Scope string for one connect action: identity + exactly one read-only product scope. */
export function connectScope(product: GoogleProductKey): string {
  return [...GOOGLE_IDENTITY_SCOPES, GOOGLE_SCOPES[product]].join(" ");
}

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleAuthUrlInput {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

/**
 * Authorization-code + PKCE URL. Offline access with forced consent so a refresh token is issued.
 * include_granted_scopes=true merges a user's earlier grants for the SAME Google account into the new
 * token set (so connecting GA4 later does not drop GSC); it never adds scopes the user has not approved.
 */
export function buildGoogleAuthUrl(input: GoogleAuthUrlInput): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scope,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "select_account consent",
  }).toString();
  return url.toString();
}

const b64url = (b: Buffer) => b.toString("base64url");

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** High-entropy, URL-safe, single-use `state` value. */
export function createStateToken(): string {
  return b64url(randomBytes(32));
}

/** State is stored hashed so a database read alone cannot be replayed against the callback. */
export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

// ---------------------------------------------------------------------------
// Token endpoint contract
// ---------------------------------------------------------------------------

export interface GoogleTokenSet {
  accessToken: string;
  /** Present on the initial grant; Google normally omits it on refresh. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  idToken?: string;
}

export type GoogleOAuthErrorKind =
  | "invalid_grant" // refresh token revoked/expired or code reused: the user must reconnect
  | "invalid_client" // our own OAuth client credentials are wrong: operator problem
  | "transient" // network, timeout, 429, 5xx: safe to retry later
  | "bad_response"; // success status but unusable body

/** Sanitized: carries a kind only. Upstream bodies and tokens are never attached. */
export class GoogleOAuthError extends Error {
  constructor(readonly kind: GoogleOAuthErrorKind) {
    super(`Google OAuth request failed: ${kind}`);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleOAuthClient {
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenSet>;
  refresh(refreshToken: string): Promise<GoogleTokenSet>;
  /** Idempotent: revoking an already-revoked token succeeds. */
  revoke(token: string): Promise<void>;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(10).max(4096),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(10).max(4096).optional(),
  scope: z.string().max(4096).optional(),
  token_type: z.string().refine((t) => t.toLowerCase() === "bearer"),
  id_token: z.string().max(8192).optional(),
});

export interface HttpGoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Real client: plain HTTPS to Google's documented endpoints. Endpoints are overridable for tests. */
export class HttpGoogleOAuthClient implements GoogleOAuthClient {
  private readonly opts: Required<Omit<HttpGoogleOAuthOptions, "fetch" | "now">> & { fetch: typeof fetch; now: () => number };

  constructor(options: HttpGoogleOAuthOptions) {
    this.opts = {
      tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
      revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
      timeoutMs: 10_000,
      fetch: globalThis.fetch,
      now: Date.now,
      ...options,
    };
  }

  private async post(url: string, params: Record<string, string>): Promise<Response> {
    try {
      return await this.opts.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new GoogleOAuthError("transient");
    }
  }

  private async toTokenSet(res: Response): Promise<GoogleTokenSet> {
    if (!res.ok) throw await this.classifyFailure(res);
    let parsed;
    try {
      parsed = tokenResponseSchema.safeParse(await res.json());
    } catch {
      throw new GoogleOAuthError("bad_response");
    }
    if (!parsed.success) throw new GoogleOAuthError("bad_response");
    const t = parsed.data;
    return {
      accessToken: t.access_token,
      ...(t.refresh_token && { refreshToken: t.refresh_token }),
      expiresAt: this.opts.now() + t.expires_in * 1000,
      scopes: (t.scope ?? "").split(/\s+/).filter(Boolean),
      ...(t.id_token && { idToken: t.id_token }),
    };
  }

  private async classifyFailure(res: Response): Promise<GoogleOAuthError> {
    if (res.status === 429 || res.status >= 500) return new GoogleOAuthError("transient");
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown }).error;
    } catch {
      /* body is not JSON */
    }
    if (error === "invalid_grant") return new GoogleOAuthError("invalid_grant");
    if (error === "invalid_client" || error === "unauthorized_client") return new GoogleOAuthError("invalid_client");
    return new GoogleOAuthError("bad_response");
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleTokenSet> {
    const res = await this.post(this.opts.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    return this.toTokenSet(res);
  }

  async refresh(refreshToken: string): Promise<GoogleTokenSet> {
    const res = await this.post(this.opts.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    return this.toTokenSet(res);
  }

  async revoke(token: string): Promise<void> {
    const res = await this.post(this.opts.revokeEndpoint, { token });
    if (res.ok) return;
    // Already revoked/expired tokens return invalid_token: the goal state is reached.
    if (res.status === 400) return;
    throw await this.classifyFailure(res);
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface GoogleIdentity {
  /** Stable Google account id. The only value used to identify the provider account. */
  sub: string;
  email?: string;
}

const claimsSchema = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  email: z.string().email().optional(),
});

/**
 * Reads identity claims from an id_token received directly from Google's token endpoint over TLS.
 * OpenID Connect allows skipping signature verification in that case; issuer, audience and expiry
 * are still checked. Do NOT use this for tokens that arrive via the browser.
 */
export function parseIdToken(idToken: string, expected: { clientId: string; now?: number }): GoogleIdentity {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) throw new Error("malformed");
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (claims.aud !== expected.clientId) throw new Error("audience");
    if (claims.exp * 1000 < (expected.now ?? Date.now())) throw new Error("expired");
    return { sub: claims.sub, ...(claims.email && { email: claims.email }) };
  } catch {
    throw new GoogleOAuthError("bad_response");
  }
}

/** `alice@example.com` -> `a***@example.com`. For display only. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Development-only stand-in (no Google, no network)
// ---------------------------------------------------------------------------

export const MOCK_CLIENT_ID = "mock-google-client-id.apps.example.invalid";
export const MOCK_CODE_PREFIX = "mock-code:";

/**
 * Deterministic fake. Codes look like `mock-code:<email>`; tokens are obviously fake strings.
 * Tests can force failures and count calls.
 */
export class MockGoogleOAuthClient implements GoogleOAuthClient {
  refreshCalls = 0;
  revokeCalls: string[] = [];
  failRefreshWith: GoogleOAuthErrorKind | null = null;
  failRevokeWith: GoogleOAuthErrorKind | null = null;
  /** Scope string the "user" approved; defaults to whatever was requested via the code suffix. */
  grantedScopes: string[] = [GOOGLE_SCOPES.gsc, ...GOOGLE_IDENTITY_SCOPES];
  /** Refresh-token delay to make concurrency tests meaningful. */
  refreshDelayMs = 0;
  private counter = 0;
  /** Scopes already approved per mock account, so connecting a second product merges (include_granted_scopes). */
  private readonly approved = new Map<string, Set<string>>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlSeconds = 3600,
  ) {}

  private idToken(email: string): string {
    const body = { iss: "https://accounts.google.com", aud: MOCK_CLIENT_ID, sub: `mock-sub-${email}`, email, exp: Math.floor(this.clock() / 1000) + 3600 };
    return `${b64url(Buffer.from("{}"))}.${b64url(Buffer.from(JSON.stringify(body)))}.mock`;
  }

  async exchangeCode(input: { code: string }): Promise<GoogleTokenSet> {
    if (!input.code.startsWith(MOCK_CODE_PREFIX)) throw new GoogleOAuthError("invalid_grant");
    // `mock-code:<email>` approves `grantedScopes`; `mock-code:<email>#<gsc|ga4>` approves that product on top of
    // whatever the account approved before, like Google's incremental authorization.
    const [email = "", product] = input.code.slice(MOCK_CODE_PREFIX.length).split("#");
    let scopes = this.grantedScopes;
    if (product === "gsc" || product === "ga4") {
      const set = this.approved.get(email) ?? new Set<string>();
      set.add(GOOGLE_SCOPES[product]);
      this.approved.set(email, set);
      scopes = [...set, ...GOOGLE_IDENTITY_SCOPES];
    }
    return {
      accessToken: `mock-access-token-${++this.counter}`,
      refreshToken: `mock-refresh-token-${email}`,
      expiresAt: this.clock() + this.ttlSeconds * 1000,
      scopes,
      idToken: this.idToken(email),
    };
  }

  async refresh(refreshToken: string): Promise<GoogleTokenSet> {
    this.refreshCalls++;
    if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
    if (this.failRefreshWith) throw new GoogleOAuthError(this.failRefreshWith);
    if (!refreshToken.startsWith("mock-refresh-token-")) throw new GoogleOAuthError("invalid_grant");
    return { accessToken: `mock-access-token-${++this.counter}`, expiresAt: this.clock() + this.ttlSeconds * 1000, scopes: this.grantedScopes };
  }

  async revoke(token: string): Promise<void> {
    this.revokeCalls.push(token);
    if (this.failRevokeWith) throw new GoogleOAuthError(this.failRevokeWith);
  }
}
export * from "./rest.js";
export * from "./readiness.js";
