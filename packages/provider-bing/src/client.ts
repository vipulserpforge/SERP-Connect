import { readTextCapped } from "@serp/contracts";
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

/** GetPageStats / GetQueryPageStats / GetPageQueryStats answer with Microsoft's QueryStats class; for page reports its `Query` field carries the page address. */
export interface BingPageRow extends BingTrafficRow {
  page: string;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

export interface BingQueryPageDetailRow extends BingTrafficRow {
  position: number | null;
}

export interface BingCrawlIssueRow {
  url: string;
  httpCode: number | null;
  /** Bing's CrawlIssues bit flags, undecoded. */
  issues: number | null;
  inLinks: number | null;
}

export interface BingLinkCountsPage {
  links: Array<{ url: string; count: number | null }>;
  totalPages: number | null;
}

export interface BingLinkDetailsPage {
  details: Array<{ url: string; anchorText: string | null }>;
  totalPages: number | null;
}

export interface BingFeedRow {
  url: string;
  type: string | null;
  status: string | null;
  submitted: string | null;
  lastCrawled: string | null;
  urlCount: number | null;
  fileSize: number | null;
  compressed: boolean | null;
}

export interface BingUrlInfo {
  url: string;
  isPage: boolean | null;
  httpStatus: number | null;
  documentSize: number | null;
  anchorCount: number | null;
  totalChildUrlCount: number | null;
  discoveryDate: string | null;
  lastCrawledDate: string | null;
}

export interface BingUrlTrafficInfo {
  url: string;
  isPage: boolean | null;
  clicks: number | null;
  impressions: number | null;
}

export interface BingKeywordRow {
  query: string;
  date: string;
  impressions: number | null;
  broadImpressions: number | null;
}

export interface BingBlockedUrlRow {
  url: string;
  date: string | null;
  /** Bing's EntityType and RequestType enums, undecoded (their numbering is not in the documentation). */
  entityType: number | null;
  requestType: number | null;
}

export interface BingSubmissionQuota {
  dailyQuota: number | null;
  monthlyQuota: number | null;
}

export interface BingContentQuota {
  dailyQuota: number | null;
  monthlyQuota: number | null;
}

export interface BingQueryParameterRow {
  parameter: string;
  isEnabled: boolean | null;
  /** Bing's Source enum, undecoded. */
  source: number | null;
  date: string | null;
}

export interface BingSiteRoleRow {
  email: string | null;
  /** Bing's Role enum as a number. Only 2 (ReadWrite) is shown in Microsoft's sample. */
  role: number | null;
  site: string | null;
  verificationSite: string | null;
  delegatorEmail: string | null;
  delegatedCodeOwnerEmail: string | null;
  expired: boolean | null;
  date: string | null;
}

export interface BingCrawlSettings {
  /** Microsoft's sample has AjaxEnabled; the live API sends CrawlBoostAvailable and CrawlBoostEnabled instead. Whatever is absent stays null. */
  ajaxEnabled: boolean | null;
  crawlBoostAvailable: boolean | null;
  crawlBoostEnabled: boolean | null;
  /** One value per slot Bing sent (24 in Microsoft's sample). What each slot stands for is not documented. */
  crawlRate: number[];
}

/** A row whose shape Microsoft does not document: every plain field as Bing sent it, ownership and delegation codes removed. */
export type BingLooseRow = Record<string, string | number | null>;

export interface BingKeywordPoint {
  query: string | null;
  date: string | null;
  impressions: number | null;
  broadImpressions: number | null;
}

export interface BingUrlFilter {
  crawlDate?: number;
  discoveredDate?: number;
  docFlags?: number;
  httpCode?: number;
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
  getPageStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingPageRow>>;
  getQueryPageStats(auth: BingAuth, siteUrl: string, query: string, signal?: AbortSignal): Promise<BingRows<BingPageRow>>;
  getPageQueryStats(auth: BingAuth, siteUrl: string, page: string, signal?: AbortSignal): Promise<BingRows<BingQueryRow>>;
  getQueryPageDetailStats(auth: BingAuth, siteUrl: string, query: string, page: string, signal?: AbortSignal): Promise<BingRows<BingQueryPageDetailRow>>;
  getCrawlIssues(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingCrawlIssueRow>>;
  getBlockedUrls(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingBlockedUrlRow>>;
  getLinkCounts(auth: BingAuth, siteUrl: string, page: number, signal?: AbortSignal): Promise<BingLinkCountsPage>;
  getUrlLinks(auth: BingAuth, siteUrl: string, link: string, page: number, signal?: AbortSignal): Promise<BingLinkDetailsPage>;
  getFeeds(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingFeedRow>>;
  getUrlInfo(auth: BingAuth, siteUrl: string, url: string, signal?: AbortSignal): Promise<BingUrlInfo | null>;
  getUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string, signal?: AbortSignal): Promise<BingUrlTrafficInfo | null>;
  getUrlSubmissionQuota(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingSubmissionQuota | null>;
  getKeywordStats(auth: BingAuth, query: string, country: string, language: string, signal?: AbortSignal): Promise<BingRows<BingKeywordRow>>;
  getQueryTrafficStats(auth: BingAuth, siteUrl: string, query: string, signal?: AbortSignal): Promise<BingRows<BingTrafficRow>>;
  getChildrenUrlInfo(auth: BingAuth, siteUrl: string, url: string, page: number, filter: BingUrlFilter, signal?: AbortSignal): Promise<BingRows<BingUrlInfo>>;
  getChildrenUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string, page: number, signal?: AbortSignal): Promise<BingRows<BingUrlTrafficInfo>>;
  getCrawlSettings(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingCrawlSettings | null>;
  getFeedDetails(auth: BingAuth, siteUrl: string, feedUrl: string, signal?: AbortSignal): Promise<BingRows<BingFeedRow>>;
  getDeepLinkBlocks(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingLooseRow>>;
  getActivePagePreviewBlocks(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingLooseRow>>;
  getCountryRegionSettings(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingLooseRow>>;
  getQueryParameters(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingQueryParameterRow>>;
  getConnectedPages(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingLooseRow>>;
  getSiteMoves(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingRows<BingLooseRow>>;
  getSiteRoles(auth: BingAuth, siteUrl: string, includeAllSubdomains: boolean, signal?: AbortSignal): Promise<BingRows<BingSiteRoleRow>>;
  getContentSubmissionQuota(auth: BingAuth, siteUrl: string, signal?: AbortSignal): Promise<BingContentQuota | null>;
  getKeyword(auth: BingAuth, query: string, country: string, language: string, startDate: string, endDate: string, signal?: AbortSignal): Promise<BingRows<BingKeywordPoint>>;
  getRelatedKeywords(auth: BingAuth, query: string, country: string, language: string, startDate: string, endDate: string, signal?: AbortSignal): Promise<BingRows<BingKeywordPoint>>;
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

// ---- parsers for the additional read methods (shapes from Microsoft's per-method samples) -------------

const str = z.string().nullish();
const bool = z.boolean().nullish();
const s = (v: string | null | undefined) => (v === undefined ? null : v);
const dateOrNull = (v: string | null | undefined) => (v ? parseBingDate(v) : null);

/** A plain array answer (`{"d": [...]}`) whose rows carry no required date. Unreadable rows are counted, never invented. */
function parseArray<S extends z.ZodType, T>(body: unknown, schema: S, map: (row: z.infer<S>) => T): BingRows<T> {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return { rows: [], skipped: 0 };
  if (!Array.isArray(d)) throw new BingApiError("bad_response", 200);
  const rows: T[] = [];
  let skipped = 0;
  for (const raw of d) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) rows.push(map(parsed.data));
    else skipped++;
  }
  return { rows, skipped };
}

function parseObject<S extends z.ZodType, T>(body: unknown, schema: S, map: (row: z.infer<S>) => T): T | null {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return null;
  const parsed = schema.safeParse(d);
  if (!parsed.success) throw new BingApiError("bad_response", 200);
  return map(parsed.data);
}

export const parsePageStats = (body: unknown) =>
  parseList(body, querySchema, (r, date): BingPageRow => ({ page: r.Query, date, clicks: n(r.Clicks), impressions: n(r.Impressions), avgClickPosition: n(r.AvgClickPosition), avgImpressionPosition: n(r.AvgImpressionPosition) }));

const detailSchema = trafficSchema.extend({ Position: num });
export const parseQueryPageDetail = (body: unknown) =>
  parseList(body, detailSchema, (r, date): BingQueryPageDetailRow => ({ date, clicks: n(r.Clicks), impressions: n(r.Impressions), position: n(r.Position) }));

const issueSchema = z.looseObject({ Url: z.string().min(1), HttpCode: num, Issues: num, InLinks: num });
export const parseCrawlIssues = (body: unknown) =>
  parseArray(body, issueSchema, (r): BingCrawlIssueRow => ({ url: r.Url, httpCode: n(r.HttpCode), issues: n(r.Issues), inLinks: n(r.InLinks) }));

const blockedSchema = z.looseObject({ Url: z.string().min(1), Date: str, EntityType: num, RequestType: num });
export const parseBlockedUrls = (body: unknown) =>
  parseArray(body, blockedSchema, (r): BingBlockedUrlRow => ({ url: r.Url, date: dateOrNull(r.Date), entityType: n(r.EntityType), requestType: n(r.RequestType) }));

const linkCountsSchema = z.looseObject({ Links: z.array(z.looseObject({ Url: z.string().min(1), Count: num })).nullish(), TotalPages: num });
export const parseLinkCounts = (body: unknown): BingLinkCountsPage =>
  parseObject(body, linkCountsSchema, (r) => ({ links: (r.Links ?? []).map((l) => ({ url: l.Url, count: n(l.Count) })), totalPages: n(r.TotalPages) })) ?? { links: [], totalPages: null };

const linkDetailsSchema = z.looseObject({ Details: z.array(z.looseObject({ Url: z.string().min(1), AnchorText: str })).nullish(), TotalPages: num });
export const parseLinkDetails = (body: unknown): BingLinkDetailsPage =>
  parseObject(body, linkDetailsSchema, (r) => ({ details: (r.Details ?? []).map((l) => ({ url: l.Url, anchorText: s(l.AnchorText) })), totalPages: n(r.TotalPages) })) ?? { details: [], totalPages: null };

const feedSchema = z.looseObject({ Url: z.string().min(1), Type: str, Status: str, Submitted: str, LastCrawled: str, UrlCount: num, FileSize: num, Compressed: bool });
export const parseFeeds = (body: unknown) =>
  parseArray(
    body,
    feedSchema,
    (r): BingFeedRow => ({ url: r.Url, type: s(r.Type), status: s(r.Status), submitted: dateOrNull(r.Submitted), lastCrawled: dateOrNull(r.LastCrawled), urlCount: n(r.UrlCount), fileSize: n(r.FileSize), compressed: r.Compressed ?? null }),
  );

const urlInfoSchema = z.looseObject({ Url: z.string(), IsPage: bool, HttpStatus: num, DocumentSize: num, AnchorCount: num, TotalChildUrlCount: num, DiscoveryDate: str, LastCrawledDate: str });
export const parseUrlInfo = (body: unknown) =>
  parseObject(
    body,
    urlInfoSchema,
    (r): BingUrlInfo => ({ url: r.Url, isPage: r.IsPage ?? null, httpStatus: n(r.HttpStatus), documentSize: n(r.DocumentSize), anchorCount: n(r.AnchorCount), totalChildUrlCount: n(r.TotalChildUrlCount), discoveryDate: dateOrNull(r.DiscoveryDate), lastCrawledDate: dateOrNull(r.LastCrawledDate) }),
  );

const urlTrafficSchema = z.looseObject({ Url: z.string(), IsPage: bool, Clicks: num, Impressions: num });
export const parseUrlTraffic = (body: unknown) =>
  parseObject(body, urlTrafficSchema, (r): BingUrlTrafficInfo => ({ url: r.Url, isPage: r.IsPage ?? null, clicks: n(r.Clicks), impressions: n(r.Impressions) }));

const quotaSchema = z.looseObject({ DailyQuota: num, MonthlyQuota: num });
export const parseSubmissionQuota = (body: unknown) => parseObject(body, quotaSchema, (r): BingSubmissionQuota => ({ dailyQuota: n(r.DailyQuota), monthlyQuota: n(r.MonthlyQuota) }));

// KeywordStats has Query, Date, Impressions and BroadImpressions (Microsoft's class reference; no sample response is published).
const keywordSchema = z.looseObject({ Query: z.string(), Date: z.string(), Impressions: num, BroadImpressions: num });
export const parseKeywordStats = (body: unknown) =>
  parseList(body, keywordSchema, (r, date): BingKeywordRow => ({ query: r.Query, date, impressions: n(r.Impressions), broadImpressions: n(r.BroadImpressions) }));

// ---- parsers for the expansion methods ---------------------------------------------------------------------------

export const parseContentQuota = (body: unknown) => parseObject(body, quotaSchema, (r): BingContentQuota => ({ dailyQuota: n(r.DailyQuota), monthlyQuota: n(r.MonthlyQuota) }));

const queryParameterSchema = z.looseObject({ Parameter: z.string().min(1), IsEnabled: bool, Source: num, Date: str });
export const parseQueryParameters = (body: unknown) =>
  parseArray(body, queryParameterSchema, (r): BingQueryParameterRow => ({ parameter: r.Parameter, isEnabled: r.IsEnabled ?? null, source: n(r.Source), date: dateOrNull(r.Date) }));

// DelegatedCode is a delegated-verification secret: it is not in this schema's output, so nothing downstream can leak it.
const siteRoleSchema = z.looseObject({ Email: str, Role: num, Site: str, VerificationSite: str, DelegatorEmail: str, DelegatedCodeOwnerEmail: str, Expired: bool, Date: str });
export const parseSiteRoles = (body: unknown) =>
  parseArray(
    body,
    siteRoleSchema,
    (r): BingSiteRoleRow => ({
      email: s(r.Email),
      role: n(r.Role),
      site: s(r.Site),
      verificationSite: s(r.VerificationSite),
      delegatorEmail: s(r.DelegatorEmail),
      delegatedCodeOwnerEmail: s(r.DelegatedCodeOwnerEmail),
      expired: r.Expired ?? null,
      date: dateOrNull(r.Date),
    }),
  );

/** Microsoft's JSON sample sends CrawlRate as 24 numbers; its XML sample shows base64, so a base64 string is accepted too. */
const crawlSettingsSchema = z.looseObject({ AjaxEnabled: bool, CrawlBoostAvailable: bool, CrawlBoostEnabled: bool, CrawlRate: z.union([z.array(z.number().finite()), z.string()]).nullish() });
export const parseCrawlSettings = (body: unknown) =>
  parseObject(body, crawlSettingsSchema, (r): BingCrawlSettings => ({
    ajaxEnabled: r.AjaxEnabled ?? null,
    crawlBoostAvailable: r.CrawlBoostAvailable ?? null,
    crawlBoostEnabled: r.CrawlBoostEnabled ?? null,
    crawlRate: typeof r.CrawlRate === "string" ? [...Buffer.from(r.CrawlRate, "base64")] : (r.CrawlRate ?? []),
  }));

/** Fields whose name says they are an ownership, verification or delegation secret are never copied out of an undocumented object. */
const SECRET_FIELD = /(authentication|verification|delegated|secret|token|password|apikey|api_key)/i;

const looseValue = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return parseBingDate(v) ?? v;
  const json = JSON.stringify(v, (k, x) => (SECRET_FIELD.test(k) ? undefined : x));
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
};

/**
 * For methods whose response Microsoft does not document: keeps every plain field under a lower-camel name, reads /Date(...)/
 * values as dates, drops `__type` and anything that looks like a secret. Never throws on an unexpected shape; rows that are
 * not objects are counted as skipped.
 */
export function parseLoose(body: unknown): BingRows<BingLooseRow> {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return { rows: [], skipped: 0 };
  const items = Array.isArray(d) ? d : [d];
  const rows: BingLooseRow[] = [];
  let skipped = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      skipped++;
      continue;
    }
    const row: BingLooseRow = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === "__type" || SECRET_FIELD.test(k)) continue;
      row[k.charAt(0).toLowerCase() + k.slice(1)] = looseValue(v);
    }
    rows.push(row);
  }
  return { rows, skipped };
}

// GetKeyword and GetRelatedKeywords return Microsoft's Keyword class (Query, Date, Impressions, BroadImpressions); neither has a published sample.
const keywordPointSchema = z.looseObject({ Query: str, Date: str, Impressions: num, BroadImpressions: num });
export function parseKeywordPoints(body: unknown): BingRows<BingKeywordPoint> {
  const d = (body as { d?: unknown } | null)?.d;
  if (d === null || d === undefined) return { rows: [], skipped: 0 };
  const items = Array.isArray(d) ? d : [d];
  const rows: BingKeywordPoint[] = [];
  let skipped = 0;
  for (const item of items) {
    const p = keywordPointSchema.safeParse(item);
    if (!p.success) skipped++;
    else rows.push({ query: s(p.data.Query), date: dateOrNull(p.data.Date), impressions: n(p.data.Impressions), broadImpressions: n(p.data.BroadImpressions) });
  }
  return { rows, skipped };
}

export const parseUrlInfoList = (body: unknown) =>
  parseArray(body, urlInfoSchema, (r): BingUrlInfo => ({ url: r.Url, isPage: r.IsPage ?? null, httpStatus: n(r.HttpStatus), documentSize: n(r.DocumentSize), anchorCount: n(r.AnchorCount), totalChildUrlCount: n(r.TotalChildUrlCount), discoveryDate: dateOrNull(r.DiscoveryDate), lastCrawledDate: dateOrNull(r.LastCrawledDate) }));

export const parseUrlTrafficList = (body: unknown) =>
  parseArray(body, urlTrafficSchema, (r): BingUrlTrafficInfo => ({ url: r.Url, isPage: r.IsPage ?? null, clicks: n(r.Clicks), impressions: n(r.Impressions) }));

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

/** Largest response read into memory (streamed, so an oversized body is dropped early). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

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

  private get(auth: BingAuth, endpoint: string, params: Record<string, string>, outer?: AbortSignal): Promise<unknown> {
    return this.call("GET", auth, endpoint, params, undefined, outer);
  }

  private async call(method: "GET" | "POST", auth: BingAuth, endpoint: string, params: Record<string, string>, body: unknown, outer?: AbortSignal): Promise<unknown> {
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
        method,
        ...(method === "POST" && { body: JSON.stringify(body) }),
        headers: { accept: "application/json", "content-type": "application/json; charset=utf-8", ...(auth.method === "oauth" && { authorization: `Bearer ${auth.accessToken}` }) },
        signal,
        redirect: "error",
      });
    } catch {
      throw new BingApiError("unavailable");
    }

    let text: string | null;
    try {
      text = await readTextCapped(res, MAX_BODY_BYTES);
    } catch {
      throw new BingApiError("unavailable", res.status);
    }
    if (text === null) throw new BingApiError("bad_response", res.status);
    let parsedBody: unknown;
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      parsedBody = undefined;
    }

    const apiCode = typeof (parsedBody as { ErrorCode?: unknown } | null)?.ErrorCode === "number" ? ((parsedBody as { ErrorCode: number }).ErrorCode) : null;
    if (res.ok && apiCode === null && parsedBody !== undefined) return parsedBody;

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

  /**
   * String arguments are sent exactly as given, unquoted. Microsoft's samples show them as JSON strings (query=%22query1%22), but the
   * live API rejects that form: a quoted address fails with SiteUriSchemeIsNotSupported / InvalidUrl and a quoted keyword, country or
   * language with InvalidParameter, while the bare form works (checked against a real property, 27 Oct 2026).
   */
  private static json(value: string): string {
    return value;
  }

  async getPageStats(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parsePageStats(await this.get(auth, "GetPageStats", { siteUrl }, signal));
  }
  async getQueryPageStats(auth: BingAuth, siteUrl: string, query: string, signal?: AbortSignal) {
    return parsePageStats(await this.get(auth, "GetQueryPageStats", { siteUrl, query: HttpBingApiClient.json(query) }, signal));
  }
  async getPageQueryStats(auth: BingAuth, siteUrl: string, page: string, signal?: AbortSignal) {
    return parseQueries(await this.get(auth, "GetPageQueryStats", { siteUrl, page: HttpBingApiClient.json(page) }, signal));
  }
  async getQueryPageDetailStats(auth: BingAuth, siteUrl: string, query: string, page: string, signal?: AbortSignal) {
    return parseQueryPageDetail(await this.get(auth, "GetQueryPageDetailStats", { siteUrl, query: HttpBingApiClient.json(query), page: HttpBingApiClient.json(page) }, signal));
  }
  async getCrawlIssues(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseCrawlIssues(await this.get(auth, "GetCrawlIssues", { siteUrl }, signal));
  }
  async getBlockedUrls(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseBlockedUrls(await this.get(auth, "GetBlockedUrls", { siteUrl }, signal));
  }
  async getLinkCounts(auth: BingAuth, siteUrl: string, page: number, signal?: AbortSignal) {
    return parseLinkCounts(await this.get(auth, "GetLinkCounts", { siteUrl, page: String(page) }, signal));
  }
  async getUrlLinks(auth: BingAuth, siteUrl: string, link: string, page: number, signal?: AbortSignal) {
    return parseLinkDetails(await this.get(auth, "GetUrlLinks", { siteUrl, link: HttpBingApiClient.json(link), page: String(page) }, signal));
  }
  async getFeeds(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseFeeds(await this.get(auth, "GetFeeds", { siteUrl }, signal));
  }
  async getUrlInfo(auth: BingAuth, siteUrl: string, url: string, signal?: AbortSignal) {
    return parseUrlInfo(await this.get(auth, "GetUrlInfo", { siteUrl, url: HttpBingApiClient.json(url) }, signal));
  }
  async getUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string, signal?: AbortSignal) {
    return parseUrlTraffic(await this.get(auth, "GetUrlTrafficInfo", { siteUrl, url: HttpBingApiClient.json(url) }, signal));
  }
  async getUrlSubmissionQuota(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseSubmissionQuota(await this.get(auth, "GetUrlSubmissionQuota", { siteUrl }, signal));
  }
  async getKeywordStats(auth: BingAuth, query: string, country: string, language: string, signal?: AbortSignal) {
    return parseKeywordStats(await this.get(auth, "GetKeywordStats", { q: HttpBingApiClient.json(query), country: HttpBingApiClient.json(country), language: HttpBingApiClient.json(language) }, signal));
  }

  async getQueryTrafficStats(auth: BingAuth, siteUrl: string, query: string, signal?: AbortSignal) {
    return parseTraffic(await this.get(auth, "GetQueryTrafficStats", { siteUrl, query: HttpBingApiClient.json(query) }, signal));
  }
  /** The only POST: Microsoft documents GetChildrenUrlInfo with a JSON body. It still only reads. */
  async getChildrenUrlInfo(auth: BingAuth, siteUrl: string, url: string, page: number, filter: BingUrlFilter, signal?: AbortSignal) {
    const body = {
      siteUrl,
      url,
      page,
      filterProperties: { CrawlDateFilter: filter.crawlDate ?? 0, DiscoveredDateFilter: filter.discoveredDate ?? 0, DocFlagsFilters: filter.docFlags ?? 0, HttpCodeFilters: filter.httpCode ?? 0 },
    };
    return parseUrlInfoList(await this.call("POST", auth, "GetChildrenUrlInfo", {}, body, signal));
  }
  async getChildrenUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string, page: number, signal?: AbortSignal) {
    return parseUrlTrafficList(await this.get(auth, "GetChildrenUrlTrafficInfo", { siteUrl, url: HttpBingApiClient.json(url), page: String(page) }, signal));
  }
  async getCrawlSettings(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseCrawlSettings(await this.get(auth, "GetCrawlSettings", { siteUrl }, signal));
  }
  async getFeedDetails(auth: BingAuth, siteUrl: string, feedUrl: string, signal?: AbortSignal) {
    return parseFeeds(await this.get(auth, "GetFeedDetails", { siteUrl, feedUrl: HttpBingApiClient.json(feedUrl) }, signal));
  }
  async getDeepLinkBlocks(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseLoose(await this.get(auth, "GetDeepLinkBlocks", { siteUrl }, signal));
  }
  async getActivePagePreviewBlocks(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseLoose(await this.get(auth, "GetActivePagePreviewBlocks", { siteUrl }, signal));
  }
  async getCountryRegionSettings(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseLoose(await this.get(auth, "GetCountryRegionSettings", { siteUrl }, signal));
  }
  async getQueryParameters(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseQueryParameters(await this.get(auth, "GetQueryParameters", { siteUrl }, signal));
  }
  async getConnectedPages(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseLoose(await this.get(auth, "GetConnectedPages", { siteUrl }, signal));
  }
  async getSiteMoves(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseLoose(await this.get(auth, "GetSiteMoves", { siteUrl }, signal));
  }
  async getSiteRoles(auth: BingAuth, siteUrl: string, includeAllSubdomains: boolean, signal?: AbortSignal) {
    return parseSiteRoles(await this.get(auth, "GetSiteRoles", { siteUrl, includeAllSubdomains: String(includeAllSubdomains) }, signal));
  }
  async getContentSubmissionQuota(auth: BingAuth, siteUrl: string, signal?: AbortSignal) {
    return parseContentQuota(await this.get(auth, "GetContentSubmissionQuota", { siteUrl }, signal));
  }
  /** GetKeyword / GetRelatedKeywords take a plain ISO date (YYYY-MM-DD). The /Date(ms)/ form Bing uses in responses is rejected (InvalidParameter). */
  private static dateArg(day: string): string {
    return day;
  }
  async getKeyword(auth: BingAuth, query: string, country: string, language: string, startDate: string, endDate: string, signal?: AbortSignal) {
    const params = { q: HttpBingApiClient.json(query), country: HttpBingApiClient.json(country), language: HttpBingApiClient.json(language), startDate: HttpBingApiClient.dateArg(startDate), endDate: HttpBingApiClient.dateArg(endDate) };
    return parseKeywordPoints(await this.get(auth, "GetKeyword", params, signal));
  }
  async getRelatedKeywords(auth: BingAuth, query: string, country: string, language: string, startDate: string, endDate: string, signal?: AbortSignal) {
    const params = { q: HttpBingApiClient.json(query), country: HttpBingApiClient.json(country), language: HttpBingApiClient.json(language), startDate: HttpBingApiClient.dateArg(startDate), endDate: HttpBingApiClient.dateArg(endDate) };
    return parseKeywordPoints(await this.get(auth, "GetRelatedKeywords", params, signal));
  }
}
