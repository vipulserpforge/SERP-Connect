/**
 * Shared plumbing for Google REST APIs (Search Console, Analytics Admin/Data). One implementation of
 * timeouts, bounded retry, redirect refusal, size caps and error classification, so every Google integration
 * fails the same safe way. Server-side only: it handles bearer tokens.
 */

/** Why a Google call failed, as a closed set. Raw upstream text is never kept. */
export type GoogleApiErrorKind =
  | "unauthenticated" // 401: token rejected
  | "insufficient_scope" // 403: token lacks the product scope
  | "no_resource_access" // 403/404: account has no access to that site/property
  | "quota" // 429, or 403/RESOURCE_EXHAUSTED rate/quota reasons
  | "api_disabled" // API not enabled in the operator's Cloud project
  | "invalid_request" // 400
  | "unavailable" // 5xx, timeouts, network
  | "bad_response"; // 2xx with an unexpected body

export class GoogleApiError extends Error {
  constructor(
    readonly kind: GoogleApiErrorKind,
    readonly httpStatus: number | null,
    readonly retryAfterSeconds?: number,
    /** Google's short machine reason (e.g. "rateLimitExceeded"), allow-listed. Never free text. */
    readonly reason?: string,
  ) {
    super(`Google API error: ${kind}`);
    this.name = "GoogleApiError";
  }
}

const SAFE_REASON = /^[A-Za-z]{3,40}$/;
const QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDEDMETHOD"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const API_DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED", "API_KEY_SERVICE_BLOCKED"]);

/** Reads only Google's structured reason/status; free-text messages are ignored on purpose. */
export function classifyGoogleError(status: number, body: unknown, retryAfterHeader: string | null): GoogleApiError {
  const err = (body as { error?: { status?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> } } | null)?.error;
  const rawReasons = [
    ...(Array.isArray(err?.errors) ? err.errors : []).map((e) => e?.reason),
    ...(Array.isArray(err?.details) ? err.details : []).map((d) => d?.reason),
    err?.status,
  ].filter((r): r is string => typeof r === "string" && SAFE_REASON.test(r.replaceAll("_", "")));
  const reason = rawReasons[0];
  const has = (set: Set<string>) => rawReasons.some((r) => set.has(r));
  const retryAfter = retryAfterHeader && /^\d{1,5}$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;

  if (status === 401) return new GoogleApiError("unauthenticated", status, undefined, reason);
  if (status === 429 || has(QUOTA_REASONS)) return new GoogleApiError("quota", status, retryAfter, reason);
  if (status === 403) {
    if (has(API_DISABLED_REASONS)) return new GoogleApiError("api_disabled", status, undefined, reason);
    if (has(SCOPE_REASONS)) return new GoogleApiError("insufficient_scope", status, undefined, reason);
    return new GoogleApiError("no_resource_access", status, undefined, reason);
  }
  if (status === 404) return new GoogleApiError("no_resource_access", status, undefined, reason);
  if (status === 400) return new GoogleApiError("invalid_request", status, undefined, reason);
  return new GoogleApiError("unavailable", status, retryAfter, reason);
}

export interface GoogleRestOptions {
  timeoutMs?: number;
  /** Extra attempts for retryable failures. Only use for idempotent reads (all of ours are). */
  maxRetries?: number;
  /** Retry 429/quota errors that carry no (or a short) Retry-After. Off for APIs where quota is hourly/daily. */
  retryQuota?: boolean;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_BACKOFF_MS = 4000;

export class GoogleRestClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryQuota: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleRestOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryQuota = opts.retryQuota ?? true;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call(method: "GET" | "POST", url: string, accessToken: string, body?: unknown, outer?: AbortSignal): Promise<unknown> {
    let lastError: GoogleApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const hinted = lastError?.retryAfterSeconds !== undefined ? lastError.retryAfterSeconds * 1000 : 0;
        await this.sleep(Math.min(MAX_BACKOFF_MS, Math.max(hinted, 400 * 2 ** (attempt - 1))));
      }
      try {
        return await this.once(method, url, accessToken, body, outer);
      } catch (err) {
        if (!(err instanceof GoogleApiError)) throw err;
        lastError = err;
        const shortQuota = this.retryQuota && err.kind === "quota" && (err.retryAfterSeconds ?? 0) <= MAX_BACKOFF_MS / 1000;
        if (!(err.kind === "unavailable" || shortQuota) || outer?.aborted) throw err;
      }
    }
    throw lastError ?? new GoogleApiError("unavailable", null);
  }

  private async once(method: "GET" | "POST", url: string, accessToken: string, body: unknown, outer?: AbortSignal): Promise<unknown> {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        redirect: "error", // never forward the bearer token to another host
        signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GoogleApiError("unavailable", null); // timeout, DNS, refused, redirect
    }

    if (Number(res.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) throw new GoogleApiError("bad_response", res.status);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new GoogleApiError("unavailable", res.status);
    }
    if (text.length > MAX_RESPONSE_BYTES) throw new GoogleApiError("bad_response", res.status);

    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new GoogleApiError("bad_response", res.status);
    }
    if (!res.ok) throw classifyGoogleError(res.status, json, res.headers.get("retry-after"));
    return json ?? {};
  }
}
