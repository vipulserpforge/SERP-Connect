import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Principal, TokenVerifier } from "./index.js";

/** Why a bearer token was refused. Maps to RFC 6750 error codes and HTTP statuses at the transport. */
export type TokenFailureKind = "invalid_token" | "insufficient_scope" | "unavailable";

export class TokenVerificationError extends Error {
  constructor(
    readonly kind: TokenFailureKind,
    message: string,
    /** Scopes the caller needs (for `insufficient_scope`). */
    readonly requiredScopes: string[] = [],
    /** Machine-readable cause for logs only. Never shown to the caller. */
    readonly reason: string = kind,
  ) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

export interface JwtVerifierOptions {
  /** Exact `iss` value. Compared as a string, no normalization. */
  issuer: string;
  /** Values of which at least one must appear in `aud`. */
  audience: string[];
  /** Public keys. Provide either `jwksUri` or `keys` (tests, pinned keys). */
  jwksUri?: string;
  keys?: JWTVerifyGetKey;
  /** Every one of these must be granted (token `scope` string or `scp`). */
  requiredScopes?: string[];
  /** Require the OAuth `client_id` claim so ordinary user-session JWTs are not accepted as MCP tokens. Default true. */
  requireOAuthClient?: boolean;
  clockToleranceSeconds?: number;
  /** Asymmetric algorithms only: symmetric (HS*) and `none` can never be accepted. */
  algorithms?: string[];
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYMMETRIC = ["ES256", "ES384", "RS256", "RS384", "PS256", "EdDSA"];

function grantedScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

/**
 * Validates MCP access tokens issued by the OAuth authorization server (Supabase Auth or another OIDC provider).
 * The user id comes from the verified `sub` claim and nowhere else.
 */
export class JwtTokenVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly algorithms: string[];

  constructor(private readonly options: JwtVerifierOptions) {
    if (options.audience.length === 0) throw new Error("JwtTokenVerifier needs at least one accepted audience.");
    const algorithms = options.algorithms ?? ASYMMETRIC;
    if (algorithms.some((a) => !ASYMMETRIC.includes(a))) throw new Error("Only asymmetric signing algorithms are accepted.");
    this.algorithms = algorithms;
    if (options.keys) this.keys = options.keys;
    else if (options.jwksUri) {
      this.keys = createRemoteJWKSet(new URL(options.jwksUri), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    } else throw new Error("JwtTokenVerifier needs jwksUri or keys.");
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.algorithms,
        clockTolerance: this.options.clockToleranceSeconds ?? 5,
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch (err) {
      throw this.classify(err);
    }

    const userId = typeof payload.sub === "string" ? payload.sub.toLowerCase() : "";
    if (!USER_ID.test(userId)) throw new TokenVerificationError("invalid_token", "The access token is invalid.", [], "bad_subject");
    if (payload.is_anonymous === true) throw new TokenVerificationError("invalid_token", "The access token is invalid.", [], "anonymous_user");
    if (typeof payload.role === "string" && payload.role !== "authenticated") {
      throw new TokenVerificationError("invalid_token", "The access token is invalid.", [], "unexpected_role");
    }
    const clientId = typeof payload.client_id === "string" ? payload.client_id : undefined;
    if ((this.options.requireOAuthClient ?? true) && !clientId) {
      // A plain user-session JWT is not an MCP grant: the user never consented to a connector.
      throw new TokenVerificationError("invalid_token", "The access token is invalid.", [], "not_an_oauth_grant");
    }

    const scopes = grantedScopes(payload);
    const required = this.options.requiredScopes ?? [];
    const missing = required.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      throw new TokenVerificationError("insufficient_scope", "The access token does not grant the required scope.", required, "missing_scope");
    }
    return { userId, ...(clientId && { clientId }), scopes };
  }

  private classify(err: unknown): TokenVerificationError {
    if (err instanceof joseErrors.JWTExpired) return new TokenVerificationError("invalid_token", "The access token expired.", [], "expired");
    // Key-set problems are ours or the issuer's, not the caller's: do not make clients re-authenticate for them.
    // jose reports a non-200 key-set response as a generic JOSEError.
    if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid || (err instanceof joseErrors.JOSEError && err.code === "ERR_JOSE_GENERIC")) {
      return new TokenVerificationError("unavailable", "Token verification is temporarily unavailable.", [], "jwks_unavailable");
    }
    if (err instanceof TypeError || (err instanceof Error && /fetch|ECONN|ENOTFOUND|network/i.test(err.message) && !(err instanceof joseErrors.JOSEError))) {
      return new TokenVerificationError("unavailable", "Token verification is temporarily unavailable.", [], "jwks_unreachable");
    }
    const claim = err instanceof joseErrors.JWTClaimValidationFailed ? err.claim : undefined;
    return new TokenVerificationError("invalid_token", "The access token is invalid.", [], claim ? `claim_${claim}` : "invalid_jwt");
  }
}
