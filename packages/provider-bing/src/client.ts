import { z } from "zod";
import { BING_API_KEY_BASE_URL, BING_OAUTH_BASE_URL, type BingAuth } from "./constants.js";
import { parseBingDate } from "./dates.js";

export type BingApiErrorKind =
  | "unauthenticated" // credential rejected (expired/revoked token, wrong API key)
  | "forbidden" // credential fine, but this account may not do/see this
  | "not_found" // site unknown to the account
  | "throttled" // Bing is rate limiting; the numeric limits are not documented
  | "invalid_request"
  | "capability" // endpoint gone or deprecated
  | "unavailable" // network, timeout, 5xx
  | "bad_response";

/** Sanitized: kind and numbers only. The request URL (which can carry an API key) and upstream text are never attached. */
export class BingApiError extends Error {
  constructor(
    readonly kind: BingApiErrorKind,
    readonly httpStatus: number | null = null,
    /** Bing's own ApiErrorCode (documented enum), when it sent one. */
    readonly apiErrorCode: number | null = null,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Bing API request failed: ${kind}`);
    this.name = "BingApiError";
  }
}

export interface BingSite {
  url: string;
  /** Only what Bing states. null = the response did not say. */
  isVerified: boolean | null;
}

export interface BingTrafficRow {
  date: string;
  clicks: number | null;
  impressions: number | null;
}

export interface BingQueryRow extends BingTrafficRow {
  query: string;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

export interface BingCrawlRow {
  date: string;
  crawledPages: number | null;
  crawlErrors: number | null;
  inIndex: number | null;
  inLinks: number | null;
  code2xx: number | null;
  code301: number | null;
  code302: number | null;
  code4xx: number | null;
  code5xx: number | null;
  allOtherCodes: number | null;
  blockedByRobotsTxt: number | null;
  containsMalware: number | null;
}

/** Rows that were present but unusable (for example a date that could not be read). Reported, never invented. */
export interface BingRows<T> {
  rows: T[];
  skipped: number;
}

export interface BingApiClient {
  readonly mock: boolean;
  getUserSites(auth: BingAuth, signal?: AbortSignal): Promise<BingSite[]>;
  getRankAndTrafficStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingTrafficRow>>;
  getQueryStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingQueryRow>>;
  getCrawlStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingCrawlRow>>;
}

// ---- response parsing ------------------------------------------------------------------------

const num = z.number().finite().nullish();
const siteSchema = z.looseObject({ Url: z.string().min(1).max(2048), IsVerified: z.boolean().nullish() });
const trafficSchema = z.looseObject({ Date: z.string(), Clicks: num, Impressions: num });
const querySchema = trafficSchema.extend({ Query: z.string(), AvgClickPosition: num, AvgImpressionPosition: num });
const crawlSchema = z.looseObject({
  Date: z.string(),
  CrawledPages: num,
  CrawlErrors: num,
  InIndex: num,
  InLinks: num,
  Code2xx: num,
  Code301: num,
  Code302: num,
  Code4xx: num,
  Code5xx: num,
  AllOtherCodes: num,
  BlockedByRobotsTxt: num,
  ContainsMalware: num,
});

const n = (v: number | null | undefined) => (v === undefined ? null : v);

function parseList<S extends z.ZodType, T>(body: unknown, schema: S, map: (row: z.infer<S>, date: string) => T): BingRows<T> {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return { rows: [], skipped: 0 };
  if (!Array.isArray(d)) throw new BingApiError("bad_response", 200);
  const rows: T[] = [];
  let skipped = 0;
  for (const raw of d) {
    const parsed = schema.safeParse(raw);
    const date = parsed.success ? parseBingDate((parsed.data as { Date: string }).Date) : null;
    if (!parsed.success || !date) {
      skipped++;
      continue;
    }
    rows.push(map(parsed.data, date));
  }
  return { rows, skipped };
}

export const parseSites = (body: unknown): BingSite[] => {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return [];
  if (!Array.isArray(d)) throw new BingApiError("bad_response", 200);
  const out: BingSite[] = [];
  for (const raw of d) {
    // AuthenticationCode and DnsVerificationCode (ownership codes) are dropped here: nothing downstream can leak them.
    const s = siteSchema.safeParse(raw);
    if (s.success) out.push({ url: s.data.Url, isVerified: s.data.IsVerified ?? null });
  }
  return out;
};

export const parseTraffic = (body: unknown) =>
  parseList(body, trafficSchema, (r, date): BingTrafficRow => ({ date, clicks: n(r.Clicks), impressions: n(r.Impressions) }));

export const parseQueries = (body: unknown) =>
  parseList(
    body,
    querySchema,
    (r, date): BingQueryRow => ({ query: r.Query, date, clicks: n(r.Clicks), impressions: n(r.Impressions), avgClickPosition: n(r.AvgClickPosition), avgImpressionPosition: n(r.AvgImpressionPosition) }),
  );

export const parseCrawl = (body: unknown) =>
  parseList(
    body,
    crawlSchema,
    (r, date): BingCrawlRow => ({
      date,
      crawledPages: n(r.CrawledPages),
      crawlErrors: n(r.CrawlErrors),
      inIndex: n(r.InIndex),
      inLinks: n(r.InLinks),
      code2xx: n(r.Code2xx),
      code301: n(r.Code301),
      code302: n(r.Code302),
      code4xx: n(r.Code4xx),
      code5xx: n(r.Code5xx),
      allOtherCodes: n(r.AllOtherCodes),
      blockedByRobotsTxt: n(r.BlockedByRobotsTxt),
      containsMalware: n(r.ContainsMalware),
    }),
  );

/** Maps Bing's documented ApiErrorCode enum (see docs/BING.md). Unknown codes stay generic. */
export function kindForApiErrorCode(code: number): BingApiErrorKind {
  switch (code) {
    case 3: // InvalidApiKey
      return "unauthenticated";
    case 4: // ThrottleUser
    case 5: // ThrottleHost
      return "throttled";
    case 6: // UserBlocked
    case 10: // UserNotFound
      return "forbidden";
    case 13: // NotAllowed
    case 14: // NotAuthorized
    case 11: // NotFound
      return "not_found";
    case 7: // InvalidUrl
    case 8: // InvalidParameter
      return "invalid_request";
    case 16: // Deprecated
      return "capability";
    default: // InternalError, UnknownError, UnexpectedState, ...
      return "unavailable";
  }
}

// ---- HTTP client -----------------------------------------------------------------------------

export interface HttpBingApiOptions {
  timeoutMs?: number;
  /** Test seam: replaces both documented base URLs. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const MAX_BODY_CHARS = 25_000_000;

/**
 * Typed client for the JSON/HTTP (REST) protocol only. GET requests; credentials go in the documented place for each method
 * (Authorization: Bearer for OAuth, the `apikey` query parameter for an API key). It never retries and never switches
 * from one credential type to the other: the reporting layer owns retries, and the connection owns its method.
 */
export class HttpBingApiClient implements BingApiClient {
  readonly mock = false;
  private readonly timeoutMs: number;
  private readonly baseUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpBingApiOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async get(auth: BingAuth, endpoint: string, params: Record<string, string>, outer?: AbortSignal): Promise<unknown> {
    const base = this.baseUrl ?? (auth.method === "oauth" ? BING_OAUTH_BASE_URL : BING_API_KEY_BASE_URL);
    const url = new URL(endpoint, base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    // Microsoft documents the API key only as a query parameter; it is therefore the one credential that is part of a URL.
    // This URL stays inside this function: it is never logged, thrown, or attached to an error.
    if (auth.method === "api_key") url.searchParams.set("apikey", auth.apiKey);

    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", "content-type": "application/json; charset=utf-8", ...(auth.method === "oauth" && { authorization: `Bearer ${auth.accessToken}` }) },
        signal,
        redirect: "error",
      });
    } catch {
      throw new BingApiError("unavailable");
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new BingApiError("unavailable", res.status);
    }
    if (text.length > MAX_BODY_CHARS) throw new BingApiError("bad_response", res.status);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }

    const apiCode = typeof (body as { ErrorCode?: unknown } | null)?.ErrorCode === "number" ? ((body as { ErrorCode: number }).ErrorCode) : null;
    if (res.ok && apiCode === null && body !== undefined) return body;

    const retryAfter = Number(res.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined;
    if (apiCode !== null && apiCode !== 0) throw new BingApiError(kindForApiErrorCode(apiCode), res.status, apiCode, retryAfterSeconds);
    if (res.ok) throw new BingApiError("bad_response", res.status);
    if (res.status === 401) throw new BingApiError("unauthenticated", 401);
    if (res.status === 403) throw new BingApiError("forbidden", 403);
    if (res.status === 404) throw new BingApiError("capability", 404);
    if (res.status === 429) throw new BingApiError("throttled", 429, null, retryAfterSeconds);
    if (res.status === 400) throw new BingApiError("invalid_request", 400);
    throw new BingApiError("unavailable", res.status);
  }

  async getUserSites(auth: BingAuth, signal?: AbortSignal) {
    return parseSites(await this.get(auth, "GetUserSites", {}, signal));
  }
  async getRankAndTrafficStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseTraffic(await this.get(auth, "GetRankAndTrafficStats", { siteUrl }, signal));
  }
  async getQueryStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseQueries(await this.get(auth, "GetQueryStats", { siteUrl }, signal));
  }
  async getCrawlStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseCrawl(await this.get(auth, "GetCrawlStats", { siteUrl }, signal));
  }
}
