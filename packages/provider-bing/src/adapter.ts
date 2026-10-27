import {
  ConnectorException,
  type AuthorizedQueryContext,
  type BingReportKind,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportRow,
  type ReportWarning,
} from "@serp/contracts";
import { BingApiError, type BingApiClient, type BingBlockedUrlRow, type BingCrawlIssueRow, type BingRows } from "./client.js";
import { BING_DATE_SEMANTICS, BING_DOCS_URL, type BingAuth } from "./constants.js";
import { toBingConnectorError } from "./errors.js";
import {
  aggregateByKey,
  addDaysIso,
  daysBetween,
  decodeCrawlIssues,
  formatChange,
  formatInt,
  formatPct,
  missingDays,
  normalizeUrl,
  pctChange,
  ratio,
  round,
  totalsOf,
  type Aggregated,
  type Raw,
} from "./normalize.js";

export type BingSortField = "date" | "clicks" | "impressions" | "ctr" | "position" | "clicksChange" | "impressionsChange" | "count";

/** A validated request with its date windows resolved. null = no filter (everything Bing returned). */
export interface BingQuery {
  propertyId: string;
  report: BingReportKind;
  startDate: string | null;
  endDate: string | null;
  /** The window of equal length just before the main one, when a comparison was asked for. */
  compare: { startDate: string; endDate: string } | null;
  aggregate: boolean;
  sortBy: BingSortField;
  sortDirection: "asc" | "desc";
  limit: number;
  query: string | null;
  page: string | null;
  url: string | null;
  keyword: string | null;
  country: string | null;
  language: string | null;
  contains: string | null;
  minImpressions: number | null;
  maxCtr: number | null;
  onlyDeclining: boolean;
  mergeUrlVariants: boolean;
  feedUrl: string | null;
  /** 0-based page of Bing's own paging (children_url_info, children_url_traffic). */
  pageNumber: number;
  includeAllSubdomains: boolean;
}

export type BingAdapter = ReportAdapter<BingQuery>;

/** What the connection record should learn from a real provider answer. Implemented by the credential layer. */
export interface BingConnectionHooks {
  onSuccess(ctx: AuthorizedQueryContext): Promise<void>;
  onAuthRejected(ctx: AuthorizedQueryContext): Promise<void>;
}

export interface LiveBingDeps {
  client: BingApiClient;
  /** Returns the credential of the connection the authorization step already resolved, with its stored method. Never a caller-supplied id. */
  getAuth(ctx: AuthorizedQueryContext): Promise<BingAuth>;
  hooks?: BingConnectionHooks;
  now?: () => Date;
}

interface ReportMeta {
  endpoint: string;
  dimensions: string[];
  metrics: string[];
  freshness: string;
  /** What the report is about, for the plain-language summary. */
  about: string;
  /** How rows are dated: daily and weekly series take a window; the rest are a snapshot. */
  dated: "daily" | "weekly" | "none";
}

const WEEKLY = "Bing documents this report as updated every week, so recent days are not expected.";
const SNAPSHOT = "A snapshot of what Bing holds now; Bing does not date it.";

const REPORT_META: Record<BingReportKind, ReportMeta> = {
  traffic: {
    endpoint: "GetRankAndTrafficStats",
    dimensions: ["date"],
    metrics: ["clicks", "impressions", "ctr"],
    freshness: "Bing documents this series as updated every day. It includes Web, Chat, News, Images, Videos and Knowledge Panel traffic from 24 March 2023.",
    about: "daily search traffic",
    dated: "daily",
  },
  queries: {
    endpoint: "GetQueryStats",
    dimensions: ["query"],
    metrics: ["clicks", "impressions", "ctr", "avgPosition", "avgClickPosition"],
    freshness: `${WEEKLY} Which queries are included is not documented.`,
    about: "search queries",
    dated: "weekly",
  },
  pages: {
    endpoint: "GetPageStats",
    dimensions: ["page"],
    metrics: ["clicks", "impressions", "ctr", "avgPosition", "avgClickPosition"],
    freshness: WEEKLY,
    about: "pages",
    dated: "weekly",
  },
  query_pages: {
    endpoint: "GetQueryPageStats",
    dimensions: ["page"],
    metrics: ["clicks", "impressions", "ctr", "avgPosition", "avgClickPosition"],
    freshness: WEEKLY,
    about: "pages for one query",
    dated: "weekly",
  },
  page_queries: {
    endpoint: "GetPageQueryStats",
    dimensions: ["query"],
    metrics: ["clicks", "impressions", "ctr", "avgPosition", "avgClickPosition"],
    freshness: WEEKLY,
    about: "queries for one page",
    dated: "weekly",
  },
  query_page_detail: {
    endpoint: "GetQueryPageDetailStats",
    dimensions: ["date"],
    metrics: ["clicks", "impressions", "ctr", "position"],
    freshness: WEEKLY,
    about: "one query on one page",
    dated: "weekly",
  },
  crawl: {
    endpoint: "GetCrawlStats",
    dimensions: ["date"],
    metrics: ["crawledPages", "crawlErrors", "inIndex", "inLinks", "code2xx", "code301", "code302", "code4xx", "code5xx", "allOtherCodes", "blockedByRobotsTxt", "containsMalware"],
    freshness: "Bing documents this as updated every day and covering the last 6 months.",
    about: "Bingbot crawl and index statistics",
    dated: "daily",
  },
  crawl_issues: {
    endpoint: "GetCrawlIssues",
    dimensions: ["url"],
    metrics: ["httpCode", "inLinks"],
    freshness: "A fixed issue can take a few days to disappear from this list (Microsoft).",
    about: "URLs with crawl issues",
    dated: "none",
  },
  crawl_problems: {
    endpoint: "GetCrawlIssues + GetBlockedUrls + GetCrawlStats",
    dimensions: ["kind", "url"],
    metrics: ["httpCode", "inLinks"],
    freshness: "Crawl statistics are daily; crawl issues can lag a few days; blocked URLs are a snapshot.",
    about: "crawl problems",
    dated: "none",
  },
  blocked_urls: {
    endpoint: "GetBlockedUrls",
    dimensions: ["url"],
    metrics: [],
    freshness: SNAPSHOT,
    about: "URLs blocked in Bing",
    dated: "none",
  },
  inbound_links: {
    endpoint: "GetLinkCounts",
    dimensions: ["url"],
    metrics: ["count"],
    freshness: "Not documented.",
    about: "pages with inbound links",
    dated: "none",
  },
  url_links: {
    endpoint: "GetUrlLinks",
    dimensions: ["url"],
    metrics: [],
    freshness: "Not documented.",
    about: "inbound links to one URL",
    dated: "none",
  },
  sitemaps: {
    endpoint: "GetFeeds",
    dimensions: ["url"],
    metrics: ["urlCount", "fileSize"],
    freshness: SNAPSHOT,
    about: "submitted sitemaps and feeds",
    dated: "none",
  },
  url_info: {
    endpoint: "GetUrlInfo",
    dimensions: ["url"],
    metrics: ["httpStatus", "documentSize", "anchorCount", "totalChildUrlCount"],
    freshness: SNAPSHOT,
    about: "index details of one URL",
    dated: "none",
  },
  url_traffic: {
    endpoint: "GetUrlTrafficInfo",
    dimensions: ["url"],
    metrics: ["clicks", "impressions"],
    freshness: "Not documented.",
    about: "traffic of one URL",
    dated: "none",
  },
  submission_quota: {
    endpoint: "GetUrlSubmissionQuota",
    dimensions: [],
    metrics: ["dailyQuota", "monthlyQuota"],
    freshness: "Live.",
    about: "URL submission quota",
    dated: "none",
  },
  keyword_stats: {
    endpoint: "GetKeywordStats",
    dimensions: ["date"],
    metrics: ["impressions", "broadImpressions"],
    freshness: "Not documented. This is Bing-wide search volume for a keyword, not your site's traffic.",
    about: "Bing search volume for a keyword",
    dated: "weekly",
  },
  query_traffic: {
    endpoint: "GetQueryTrafficStats",
    dimensions: ["date"],
    metrics: ["clicks", "impressions", "ctr"],
    freshness: "Bing documents this as updated every day. Only top queries are saved and returned.",
    about: "daily traffic of one query",
    dated: "daily",
  },
  children_url_info: {
    endpoint: "GetChildrenUrlInfo",
    dimensions: ["url"],
    metrics: ["httpStatus", "documentSize", "anchorCount", "totalChildUrlCount"],
    freshness: SNAPSHOT,
    about: "index details of pages and folders under a URL",
    dated: "none",
  },
  children_url_traffic: {
    endpoint: "GetChildrenUrlTrafficInfo",
    dimensions: ["url"],
    metrics: ["clicks", "impressions"],
    freshness: "Not documented.",
    about: "traffic of pages and folders under a URL",
    dated: "none",
  },
  crawl_settings: {
    endpoint: "GetCrawlSettings",
    dimensions: ["slot"],
    metrics: ["crawlRate"],
    freshness: SNAPSHOT,
    about: "crawl-rate setting",
    dated: "none",
  },
  feed_details: {
    endpoint: "GetFeedDetails",
    dimensions: ["url"],
    metrics: ["urlCount", "fileSize"],
    freshness: SNAPSHOT,
    about: "sitemap index details",
    dated: "none",
  },
  deep_link_blocks: { endpoint: "GetDeepLinkBlocks", dimensions: ["url"], metrics: [], freshness: SNAPSHOT, about: "blocked deep links", dated: "none" },
  page_preview_blocks: { endpoint: "GetActivePagePreviewBlocks", dimensions: ["url"], metrics: [], freshness: SNAPSHOT, about: "pages with a blocked preview", dated: "none" },
  country_region_settings: { endpoint: "GetCountryRegionSettings", dimensions: ["region"], metrics: [], freshness: SNAPSHOT, about: "target country or region settings", dated: "none" },
  query_parameters: { endpoint: "GetQueryParameters", dimensions: ["parameter"], metrics: [], freshness: SNAPSHOT, about: "URL parameters Bing ignores", dated: "none" },
  connected_pages: { endpoint: "GetConnectedPages", dimensions: ["page"], metrics: [], freshness: SNAPSHOT, about: "connected pages", dated: "none" },
  site_moves: { endpoint: "GetSiteMoves", dimensions: ["site"], metrics: [], freshness: "Live check (27 Oct 2026): Bing's JSON API answered HTTP 404 for this method, so it currently returns an error instead of data.", about: "site moves", dated: "none" },
  site_roles: { endpoint: "GetSiteRoles", dimensions: ["email"], metrics: [], freshness: SNAPSHOT, about: "people with access to the site", dated: "none" },
  content_submission_quota: {
    endpoint: "GetContentSubmissionQuota",
    dimensions: [],
    metrics: ["dailyQuota", "monthlyQuota"],
    freshness: "Live.",
    about: "content submission quota",
    dated: "none",
  },
  keyword: {
    endpoint: "GetKeyword",
    dimensions: ["query"],
    metrics: ["impressions", "broadImpressions"],
    freshness: "Not documented. Bing-wide search volume for a keyword over the period asked, not your site's traffic.",
    about: "Bing impressions for a keyword",
    dated: "none",
  },
  related_keywords: {
    endpoint: "GetRelatedKeywords",
    dimensions: ["query"],
    metrics: ["impressions", "broadImpressions"],
    freshness: "Not documented. Bing-wide search volume, not your site's traffic.",
    about: "related keywords",
    dated: "none",
  },
};

/** Methods Microsoft documents without a response sample: their fields are shown as Bing sends them and flagged as unverified. */
export const SHAPE_UNDOCUMENTED: ReadonlySet<BingReportKind> = new Set<BingReportKind>([
  "blocked_urls",
  "deep_link_blocks",
  "page_preview_blocks",
  "country_region_settings",
  "connected_pages",
  "site_moves",
  "keyword_stats",
  "keyword",
  "related_keywords",
]);

export const BING_REPORT_META = REPORT_META;

/**
 * Reports that were checked against a live Bing account with `pnpm bing:check`. Every other report follows Microsoft's published
 * shape but has not been seen live, and says so in its warnings until it is added here.
 */
export const LIVE_VERIFIED_REPORTS: ReadonlySet<BingReportKind> = new Set<BingReportKind>([
  "traffic", "queries", "crawl", "pages", "query_pages", "page_queries", "query_page_detail", "sitemaps", "url_info", "url_traffic", "submission_quota", "query_traffic", "feed_details", "crawl_settings", "site_roles", "content_submission_quota", "related_keywords", "keyword",
]);

const inWindow = (date: string, start: string | null, end: string | null) => (start === null || date >= start) && (end === null || date <= end);

/** Maximum pages of the paged link reports fetched in one call. Bing documents neither a page size nor a limit. */
const MAX_LINK_PAGES = 5;
const LOW_VOLUME_IMPRESSIONS = 100;
const DAILY_LAG_DAYS = 3;
const WEEKLY_LAG_DAYS = 14;

/** Sorts with missing values last in either direction; ties keep the order given (callers pre-sort by label). */
function sortRows(rows: Raw[], key: string, direction: "asc" | "desc"): Raw[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

/** Reads, filters, sorts and trims dated rows (the plain `date` reports). Absent values stay null (never turned into 0). */
export function shapeBingRows(rows: Raw[], query: Pick<BingQuery, "startDate" | "endDate" | "sortBy" | "sortDirection" | "limit" | "report">): { rows: ReportRow[]; afterFilter: number } {
  const filtered = rows.filter((r) => inWindow(String(r.date), query.startDate, query.endDate));
  const key = query.report === "crawl" || query.sortBy === "count" ? "date" : query.sortBy;
  // Newest first on ties, whatever the direction.
  const sorted = sortRows([...filtered].sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)), key, query.sortDirection);
  return { rows: sorted.slice(0, query.limit).map((r) => ({ ...r })), afterFilter: filtered.length };
}

interface Fetched {
  /** Rows exactly as Bing sent them, already mapped to readable names. */
  rows: Raw[];
  skipped: number;
  warnings: ReportWarning[];
  /** Extra facts for providerMetadata. */
  meta: Record<string, unknown>;
  /** Snapshot totals (for crawl_problems and quota). */
  totals?: Record<string, number | null>;
}

/** Rows are strings, numbers or null. Bing's yes/no fields become "yes"/"no"; nothing else is changed. */
const toRaw = <T extends object>(rows: T[]): Raw[] =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "yes" : "no") : v]))) as Raw[];

const labelOf = (report: BingReportKind): "query" | "page" => (report === "queries" || report === "page_queries" ? "query" : "page");
const isLabeled = (report: BingReportKind) => report === "queries" || report === "pages" || report === "query_pages" || report === "page_queries";

async function fetchPaged<T>(first: (page: number) => Promise<{ items: T[]; totalPages: number | null }>): Promise<{ items: T[]; truncated: boolean; totalPages: number | null }> {
  const items: T[] = [];
  const firstPage = await first(0);
  items.push(...firstPage.items);
  const totalPages = firstPage.totalPages;
  const last = Math.min(totalPages ?? 1, MAX_LINK_PAGES);
  for (let page = 1; page < last; page++) items.push(...(await first(page)).items);
  return { items, truncated: totalPages !== null && totalPages > MAX_LINK_PAGES, totalPages };
}

export function buildBingResult(input: {
  query: BingQuery;
  ctx: AuthorizedQueryContext;
  fetched: Fetched;
  mock: boolean;
  now: Date;
}): NormalizedReportResult {
  const { query, ctx, fetched, mock } = input;
  const meta = REPORT_META[query.report];
  const warnings: ReportWarning[] = [];
  if (mock) warnings.push({ code: "MOCK_DATA", message: "Synthetic fixture data; not from Bing." });
  if (fetched.skipped > 0) warnings.push({ code: "ROWS_SKIPPED", message: `${fetched.skipped} row${fetched.skipped === 1 ? "" : "s"} from Bing could not be read (for example an unreadable date) and ${fetched.skipped === 1 ? "was" : "were"} left out.` });
  if (!LIVE_VERIFIED_REPORTS.has(query.report)) {
    warnings.push({ code: "UNVERIFIED_REPORT", message: "This report follows Microsoft's published format but its data has not been confirmed against a live Bing account yet. If the numbers look wrong, say so and the operator can run the live check." });
  }
  if (SHAPE_UNDOCUMENTED.has(query.report)) {
    warnings.push({ code: "UNDOCUMENTED_SHAPE", message: "Microsoft publishes no sample response for this method, so its fields are shown as Bing sent them and the shape is unverified. Say so if a value looks wrong." });
  }
  warnings.push(...fetched.warnings);

  const shaped = shapeResult(query, fetched);
  const newest = fetched.rows.reduce<string | null>((acc, r) => (typeof r.date === "string" && (acc === null || r.date > acc) ? r.date : acc), null);

  if (fetched.rows.length === 0 && !["submission_quota", "content_submission_quota", "url_info", "url_traffic"].includes(query.report)) {
    warnings.push({ code: "EMPTY_RESULT", message: "Bing returned no rows for this site. That means no data was reported, not that the values are zero." });
  } else if (meta.dated !== "none" && shaped.afterFilter === 0 && fetched.rows.length > 0) {
    warnings.push({ code: "NO_ROWS_IN_WINDOW", message: `Bing returned ${fetched.rows.length} rows, but none fall inside the requested dates. ${meta.freshness}` });
  }
  if (shaped.afterFilter > shaped.rows.length) {
    warnings.push({ code: "ROW_LIMIT_REACHED", message: `Showing ${shaped.rows.length} of ${shaped.afterFilter} matching rows. Raise the limit or narrow the filters for the rest.` });
  }
  if (meta.dated !== "none" && query.endDate && newest && newest < query.endDate) {
    const lag = daysBetween(newest, query.endDate);
    if (lag > (meta.dated === "daily" ? DAILY_LAG_DAYS : WEEKLY_LAG_DAYS)) {
      warnings.push({ code: "INCOMPLETE_RECENT_DATA", message: `Bing's newest data is from ${newest}, ${lag} days before the end of the window (${query.endDate}). The most recent days are not in yet, so the last part of this period is incomplete.` });
    }
  }
  if (meta.dated === "weekly" && query.startDate && query.endDate && daysBetween(query.startDate, query.endDate) + 1 < 14) {
    warnings.push({ code: "WEEKLY_DATA", message: "Bing reports this data in weekly buckets, so a window shorter than two weeks holds only one or two buckets. Treat small windows and comparisons with care." });
  }
  if (shaped.totals && typeof shaped.totals.impressions === "number" && shaped.totals.impressions < LOW_VOLUME_IMPRESSIONS && ["traffic", "queries", "pages"].includes(query.report)) {
    warnings.push({ code: "LOW_VOLUME", message: `Only ${formatInt(shaped.totals.impressions)} impressions in this window, so percentages and averages can swing a lot.` });
  }
  warnings.push(...shaped.warnings);

  const summary = summarize(query, ctx.property.externalPropertyId, shaped, fetched);
  return {
    provider: "bing",
    property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
    report: {
      startDate: query.startDate,
      endDate: query.endDate,
      dateSemantics: BING_DATE_SEMANTICS,
      dimensions: meta.dimensions,
      metrics: meta.metrics,
      sort: [{ field: shaped.sortField, direction: query.sortDirection }],
      limit: query.limit,
    },
    rows: shaped.rows,
    rowCountReturned: shaped.rows.length,
    // What Bing sent before this app filtered it: Bing itself reports no total.
    rowCountReportedByProvider: fetched.rows.length,
    fetchedAt: input.now.toISOString(),
    cache: { hit: false, ageSeconds: 0 },
    // Bing documents no completeness guarantee for the query reports, so they are never called complete.
    completeness: ["queries", "pages", "query_pages", "page_queries"].includes(query.report) || shaped.truncatedUpstream ? "unknown_or_provider_limited" : "complete",
    mock,
    warnings,
    ...(shaped.totals && { totals: shaped.totals }),
    ...(shaped.comparison && { comparison: shaped.comparison }),
    summary,
    nextStep: nextStep(query, shaped),
    providerMetadata: {
      source: "Bing Webmaster Tools (not Google Search Console: positions, impressions and clicks are counted by Bing and are not comparable one-to-one)",
      endpoint: meta.endpoint,
      freshness: meta.freshness,
      newestDateInResponse: newest,
      authMethod: ctx.connection.authMethod,
      verifiedLive: LIVE_VERIFIED_REPORTS.has(query.report),
      docs: BING_DOCS_URL,
      shape: SHAPE_UNDOCUMENTED.has(query.report) ? "unverified" : "documented",
      granularity: meta.dated === "none" ? "snapshot" : meta.dated,
      pagination: {
        rowsFound: shaped.afterFilter,
        rowsReturned: shaped.rows.length,
        limit: query.limit,
        hasMore: shaped.afterFilter > shaped.rows.length,
        hint:
          shaped.afterFilter > shaped.rows.length
            ? `Showing ${shaped.rows.length} of ${shaped.afterFilter} rows. Raise limit, or narrow with contains, startDate/endDate or minImpressions to see the rest.`
            : fetched.meta.nextPageNumber !== undefined
              ? `Bing pages this report. Call again with pageNumber=${String(fetched.meta.nextPageNumber)} for the next page; an empty page means the end.`
              : "All matching rows are shown.",
      },
      ...fetched.meta,
    },
    requestId: ctx.requestId,
  };
}

interface Shaped {
  rows: ReportRow[];
  afterFilter: number;
  sortField: string;
  totals?: Record<string, number | null>;
  comparison?: NonNullable<NormalizedReportResult["comparison"]>;
  warnings: ReportWarning[];
  truncatedUpstream?: boolean;
}

function shapeResult(query: BingQuery, fetched: Fetched): Shaped {
  const warnings: ReportWarning[] = [];

  // ---- labelled search reports: one row per query or page -------------------------------------------------
  if (isLabeled(query.report)) {
    const label = labelOf(query.report);
    const merge = label === "page" && query.mergeUrlVariants;
    const keyOf = (r: Raw) => (label === "page" ? (merge ? normalizeUrl(String(r.page)) : String(r.page)) : String(r.query).trim().toLowerCase());
    const needle = query.contains?.toLowerCase();
    const matches = (r: Raw) => needle === undefined || String(r[label]).toLowerCase().includes(needle);
    const current = fetched.rows.filter((r) => matches(r) && inWindow(String(r.date), query.startDate, query.endDate));
    if (merge) {
      const distinct = new Set(current.map((r) => String(r.page))).size;
      const merged = new Set(current.map(keyOf)).size;
      if (distinct > merged) warnings.push({ code: "URL_VARIANTS_MERGED", message: `${distinct - merged} page address variant${distinct - merged === 1 ? " was" : "s were"} merged (trailing slash, #anchor, query string, letter case in the host). Set mergeUrlVariants=false to see Bing's raw addresses.` });
    }

    if (!query.aggregate) {
      const rows = sortRows(
        current.map((r): Raw => ({ ...r, ctr: round(ratio(r.clicks as number | null, r.impressions as number | null), 4) })).sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)),
        query.sortBy === "position" ? "avgImpressionPosition" : query.sortBy === "ctr" ? "ctr" : query.sortBy,
        query.sortDirection,
      );
      return { rows: rows.slice(0, query.limit), afterFilter: rows.length, sortField: query.sortBy, warnings, totals: tidyTotals(totalsOf(toTotals(current)), current.length) };
    }

    const cur = new Map(aggregateByKey(toAgg(current), (r) => keyOf(r as unknown as Raw)).map((a) => [a.key, a]));
    const prevRows = query.compare ? fetched.rows.filter((r) => matches(r) && inWindow(String(r.date), query.compare!.startDate, query.compare!.endDate)) : [];
    const prev = new Map(aggregateByKey(toAgg(prevRows), (r) => keyOf(r as unknown as Raw)).map((a) => [a.key, a]));

    const keys = query.compare && query.onlyDeclining ? new Set([...cur.keys(), ...prev.keys()]) : new Set(cur.keys());
    let rows: Raw[] = [...keys].map((key) => aggregatedRow(label, key, cur.get(key), query.compare ? (prev.get(key) ?? null) : undefined, Boolean(query.compare)));
    // Filters apply to what the row shows now. Rows that vanished (only in the previous period) are kept for onlyDeclining.
    if (query.minImpressions !== null) rows = rows.filter((r) => typeof r.impressions === "number" && r.impressions >= query.minImpressions!);
    if (query.maxCtr !== null) rows = rows.filter((r) => typeof r.ctr === "number" && r.ctr <= query.maxCtr!);
    if (query.compare && query.onlyDeclining) rows = rows.filter((r) => typeof r.previousClicks === "number" && r.previousClicks > 0 && (r.clicks as number) < r.previousClicks);

    const sortField = query.sortBy === "position" ? "avgPosition" : query.sortBy === "date" ? "clicks" : query.sortBy;
    const ordered = sortRows([...rows].sort((a, b) => String(a[label]).localeCompare(String(b[label]))), sortField, query.sortDirection);
    // Totals describe the whole window (every query or page that matched `contains`), not just the rows that survived the row filters
    // or the limit, and the previous period is totalled the same way, so the two are comparable.
    const windowTotals = totalsOf([...cur.values()]);
    const totals = { ...tidyTotals(windowTotals, cur.size), [label === "query" ? "queries" : "pages"]: cur.size };
    let comparison: Shaped["comparison"];
    if (query.compare) {
      const prevTotals = totalsOf([...prev.values()]);
      if (prevRows.length === 0) warnings.push({ code: "COMPARISON_UNAVAILABLE", message: "Bing has no rows in the previous period, so there is nothing to compare with." });
      comparison = comparisonOf(query.compare, windowTotals, prevTotals);
    }
    return { rows: ordered.slice(0, query.limit), afterFilter: ordered.length, sortField, totals, ...(comparison && { comparison }), warnings };
  }

  // ---- dated flat reports -------------------------------------------------------------------------------------------
  if (query.report === "traffic" || query.report === "query_traffic" || query.report === "query_page_detail" || query.report === "keyword_stats" || query.report === "crawl") {
    const hasCtr = query.report === "traffic" || query.report === "query_traffic" || query.report === "query_page_detail";
    const withCtr = fetched.rows.map((r) => (hasCtr ? { ...r, ctr: round(ratio(r.clicks as number | null, r.impressions as number | null), 4) } : r));
    const shaped = shapeBingRows(withCtr, query);
    const inside = withCtr.filter((r) => inWindow(String(r.date), query.startDate, query.endDate));
    const out: Shaped = { ...shaped, sortField: query.report === "crawl" ? "date" : query.sortBy, warnings };
    if ((query.report === "traffic" || query.report === "query_traffic") && query.startDate && query.endDate && inside.length > 1) {
      const lo = inside.reduce((a, r) => (String(r.date) < a ? String(r.date) : a), "9999");
      const hi = inside.reduce((a, r) => (String(r.date) > a ? String(r.date) : a), "0000");
      const gaps = missingDays(inside.map((r) => String(r.date))).filter((d) => d >= lo && d <= hi);
      if (gaps.length > 0) warnings.push({ code: "MISSING_DAYS", message: `Bing has no row for ${gaps.length} day${gaps.length === 1 ? "" : "s"} inside the window (${gaps.slice(0, 5).join(", ")}${gaps.length > 5 ? ", …" : ""}). They are left out, not counted as zero.` });
    }
    if (hasCtr) {
      const totals = totalsOf(toTotals(inside));
      out.totals = tidyTotals(totals, inside.length);
      if (query.compare) {
        const prevRows = withCtr.filter((r) => inWindow(String(r.date), query.compare!.startDate, query.compare!.endDate));
        if (prevRows.length === 0) warnings.push({ code: "COMPARISON_UNAVAILABLE", message: "Bing has no rows in the previous period, so there is nothing to compare with." });
        out.comparison = comparisonOf(query.compare, totals, totalsOf(toTotals(prevRows)));
      }
    } else if (query.report === "keyword_stats") {
      out.totals = { impressions: totalsOf(inside.map((r) => ({ clicks: null, impressions: r.impressions as number | null }))).impressions, rows: inside.length };
    }
    return out;
  }

  // ---- snapshots -------------------------------------------------------------------------------------------------------
  let rows = fetched.rows;
  if (query.report === "inbound_links" || query.report === "crawl_issues") {
    const urlField = "url";
    if (query.mergeUrlVariants) {
      const groups = new Map<string, Raw>();
      for (const r of rows) {
        const key = normalizeUrl(String(r[urlField]));
        const g = groups.get(key);
        if (!g) groups.set(key, { ...r, [urlField]: key });
        else if (query.report === "inbound_links") g.count = ((g.count as number | null) ?? 0) + ((r.count as number | null) ?? 0);
        else g.issues = (((g.issues as number | null) ?? 0) | ((r.issues as number | null) ?? 0)) as number;
      }
      if (groups.size < rows.length) warnings.push({ code: "URL_VARIANTS_MERGED", message: `${rows.length - groups.size} URL variant${rows.length - groups.size === 1 ? " was" : "s were"} merged (trailing slash, #anchor, query string). Set mergeUrlVariants=false for Bing's raw addresses.` });
      rows = [...groups.values()];
      if (query.report === "crawl_issues") rows = rows.map((r) => ({ ...r, issueNames: decodeCrawlIssues(r.issues as number | null).join(", ") }));
    }
  }
  if (query.contains) {
    const needle = query.contains.toLowerCase();
    // Reports with an address filter on it; settings reports (no address) filter on any text field.
    rows = rows.filter((r) => (typeof r.url === "string" || typeof r.page === "string" ? String(r.url ?? r.page).toLowerCase().includes(needle) : Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(needle))));
  }
  const SNAPSHOT_SORT: Partial<Record<BingReportKind, string>> = { inbound_links: "count", crawl_issues: "inLinks", related_keywords: "impressions", children_url_traffic: "clicks" };
  const sortField = SNAPSHOT_SORT[query.report] ?? null;
  const ordered = sortField ? sortRows([...rows].sort((a, b) => String(a.url).localeCompare(String(b.url))), sortField, query.sortDirection === "asc" ? "asc" : "desc") : rows;
  return { rows: ordered.slice(0, query.limit), afterFilter: ordered.length, sortField: sortField ?? "none", ...(fetched.totals && { totals: fetched.totals }), warnings, truncatedUpstream: fetched.meta.linkPagesTruncated === true };
}

// ---- shaping helpers ----------------------------------------------------------------------------------------------------

const toTotals = (rows: Raw[]) => rows.map((r) => ({ clicks: r.clicks as number | null, impressions: r.impressions as number | null }));
const toAgg = (rows: Raw[]) =>
  rows.map((r) => ({
    ...r,
    date: String(r.date),
    clicks: r.clicks as number | null,
    impressions: r.impressions as number | null,
    avgClickPosition: r.avgClickPosition as number | null,
    avgImpressionPosition: r.avgImpressionPosition as number | null,
  }));

function tidyTotals(t: { clicks: number | null; impressions: number | null; ctr: number | null }, rows: number): Record<string, number | null> {
  return { clicks: t.clicks, impressions: t.impressions, ctr: round(t.ctr, 4), rows };
}

function aggregatedRow(label: "query" | "page", key: string, cur: Aggregated | undefined, prev: Aggregated | null | undefined, compare: boolean): Raw {
  const row: Raw = {
    [label]: key,
    clicks: cur?.clicks ?? (compare ? 0 : null),
    impressions: cur?.impressions ?? (compare ? 0 : null),
    ctr: round(cur?.ctr ?? null, 4),
    avgPosition: round(cur?.avgPosition ?? null, 1),
    avgClickPosition: round(cur?.avgClickPosition ?? null, 1),
    periodsCovered: cur?.periods ?? 0,
  };
  if (compare) {
    row.previousClicks = prev?.clicks ?? null;
    row.previousImpressions = prev?.impressions ?? null;
    row.clicksChange = typeof row.clicks === "number" && prev?.clicks != null ? row.clicks - prev.clicks : null;
    row.impressionsChange = typeof row.impressions === "number" && prev?.impressions != null ? row.impressions - prev.impressions : null;
    row.clicksChangePct = pctChange(row.clicks as number | null, prev?.clicks ?? null);
    row.impressionsChangePct = pctChange(row.impressions as number | null, prev?.impressions ?? null);
    // Positive = the page moved down (worse) because a lower position number is better.
    row.positionChange = cur?.avgPosition != null && prev?.avgPosition != null ? round(cur.avgPosition - prev.avgPosition, 1) : null;
  }
  return row;
}

function comparisonOf(
  window: { startDate: string; endDate: string },
  cur: { clicks: number | null; impressions: number | null; ctr: number | null },
  prev: { clicks: number | null; impressions: number | null; ctr: number | null },
): NonNullable<NormalizedReportResult["comparison"]> {
  return {
    label: "previous period of the same length",
    startDate: window.startDate,
    endDate: window.endDate,
    totals: { clicks: prev.clicks, impressions: prev.impressions, ctr: round(prev.ctr, 4) },
    change: { clicks: pctChange(cur.clicks, prev.clicks), impressions: pctChange(cur.impressions, prev.impressions), ctr: pctChange(cur.ctr, prev.ctr) },
  };
}

// ---- plain-language summary and next step ------------------------------------------------------------------------

const BING_NOTE = "These are Bing's own numbers and are not comparable one-to-one with Google Search Console.";

function windowText(q: BingQuery): string {
  return q.startDate && q.endDate ? `${q.startDate} to ${q.endDate}` : "every date Bing returned";
}

function summarize(q: BingQuery, site: string, s: Shaped, f: Fetched): string {
  const head = `Bing Webmaster data for ${site}.`;
  const meta = REPORT_META[q.report];
  const change = s.comparison ? ` Compared with the previous period (${s.comparison.startDate} to ${s.comparison.endDate}): clicks ${formatChange(s.comparison.change.clicks ?? null)}, impressions ${formatChange(s.comparison.change.impressions ?? null)}.` : "";
  if (s.rows.length === 0 && f.rows.length === 0) return `${head} Bing reported no ${meta.about} for this site. ${BING_NOTE}`;
  switch (q.report) {
    case "traffic":
    case "query_page_detail":
      return `${head} ${formatInt((s.totals?.clicks as number | null) ?? null)} clicks and ${formatInt((s.totals?.impressions as number | null) ?? null)} impressions (click-through rate ${formatPct((s.totals?.ctr as number | null) ?? null)}) from ${windowText(q)}.${change} ${BING_NOTE}`;
    case "queries":
    case "pages":
    case "query_pages":
    case "page_queries": {
      const noun = labelOf(q.report) === "query" ? "queries" : "pages";
      return `${head} ${formatInt(s.afterFilter)} ${noun} matched for ${windowText(q)}, with ${formatInt((s.totals?.clicks as number | null) ?? null)} clicks and ${formatInt((s.totals?.impressions as number | null) ?? null)} impressions in total.${change} ${BING_NOTE}`;
    }
    case "crawl":
      return `${head} Bingbot crawl and index statistics for ${windowText(q)}: ${formatInt(s.afterFilter)} daily rows. ${BING_NOTE}`;
    case "crawl_issues":
      return `${head} ${formatInt(s.afterFilter)} URL${s.afterFilter === 1 ? "" : "s"} with crawl issues.`;
    case "crawl_problems":
      return `${head} ${formatInt((s.totals?.crawlIssues as number | null) ?? null)} URLs with crawl issues and ${formatInt((s.totals?.blockedUrls as number | null) ?? null)} blocked URLs. Latest crawl day: ${formatInt((s.totals?.crawlErrors as number | null) ?? null)} crawl errors.`;
    case "blocked_urls":
      return `${head} ${formatInt(s.afterFilter)} blocked URL${s.afterFilter === 1 ? "" : "s"} or director${s.afterFilter === 1 ? "y" : "ies"}.`;
    case "inbound_links":
      return `${head} ${formatInt(s.afterFilter)} page${s.afterFilter === 1 ? "" : "s"} with inbound links, most-linked first.`;
    case "url_links":
      return `${head} ${formatInt(s.afterFilter)} inbound link${s.afterFilter === 1 ? "" : "s"} listed for ${q.url}.`;
    case "sitemaps":
      return `${head} ${formatInt(s.afterFilter)} sitemap${s.afterFilter === 1 ? "" : "s"} or feed${s.afterFilter === 1 ? "" : "s"} submitted${s.totals ? `; ${formatInt((s.totals.notSuccessful as number | null) ?? null)} not reported as successful` : ""}.`;
    case "url_info":
      return `${head} Index details for ${q.url}.`;
    case "url_traffic":
      return `${head} Bing traffic for ${q.url}. ${BING_NOTE}`;
    case "submission_quota":
      return `${head} URL submission quota: ${formatInt((f.rows[0]?.dailyQuota as number | null) ?? null)} per day, ${formatInt((f.rows[0]?.monthlyQuota as number | null) ?? null)} per month.`;
    case "keyword_stats":
      return `Bing search-volume history for "${q.keyword}" (Bing-wide, not this site's traffic): ${formatInt((s.totals?.impressions as number | null) ?? null)} impressions over ${windowText(q)}.`;
    case "query_traffic":
      return `${head} ${formatInt((s.totals?.clicks as number | null) ?? null)} clicks and ${formatInt((s.totals?.impressions as number | null) ?? null)} impressions for the query "${q.query}" from ${windowText(q)}.${change} ${BING_NOTE}`;
    case "children_url_info":
      return `${head} ${formatInt(s.afterFilter)} page${s.afterFilter === 1 ? "" : "s"} or folder${s.afterFilter === 1 ? "" : "s"} under ${q.url} (Bing page ${q.pageNumber}).`;
    case "children_url_traffic":
      return `${head} Traffic for ${formatInt(s.afterFilter)} page${s.afterFilter === 1 ? "" : "s"} or folder${s.afterFilter === 1 ? "" : "s"} under ${q.url} (Bing page ${q.pageNumber}). ${BING_NOTE}`;
    case "crawl_settings":
      return `${head} Bing's crawl-rate setting (${formatInt(s.afterFilter)} values; crawl boost ${f.meta.crawlBoostEnabled === true ? "on" : f.meta.crawlBoostEnabled === false ? (f.meta.crawlBoostAvailable === true ? "available but off" : "off and not available") : "not stated"}).`;
    case "feed_details":
      return `${head} ${formatInt(s.afterFilter)} sitemap${s.afterFilter === 1 ? "" : "s"} listed under ${q.feedUrl}.`;
    case "deep_link_blocks":
    case "page_preview_blocks":
    case "country_region_settings":
    case "query_parameters":
    case "connected_pages":
    case "site_moves":
      return `${head} ${formatInt(s.afterFilter)} ${meta.about}.`;
    case "site_roles":
      return `${head} ${formatInt(s.afterFilter)} access role${s.afterFilter === 1 ? "" : "s"} on the site.`;
    case "content_submission_quota":
      return `${head} Content submission quota: ${formatInt((f.rows[0]?.dailyQuota as number | null) ?? null)} per day, ${formatInt((f.rows[0]?.monthlyQuota as number | null) ?? null)} per month.`;
    case "keyword":
      return `Bing impressions for "${q.keyword}" (Bing-wide, not this site's traffic) from ${windowText(q)}: ${formatInt((s.totals?.impressions as number | null) ?? null)}.`;
    case "related_keywords":
      return `${formatInt(s.afterFilter)} keyword${s.afterFilter === 1 ? "" : "s"} related to "${q.keyword}" in Bing (Bing-wide volume, not this site's traffic).`;
  }
}

function nextStep(q: BingQuery, s: Shaped): string {
  switch (q.report) {
    case "traffic":
      return "Ask for the top queries or top pages behind these numbers, or add compare=true to see the change against the previous period.";
    case "queries":
      return "Ask which pages those queries reach (query_pages), or for queries with many impressions but a low click-through rate (the low_ctr_queries preset).";
    case "pages":
      return "Ask which queries bring a page its traffic (page_queries), or which pages lost clicks (the declining_pages preset).";
    case "query_pages":
    case "page_queries":
    case "query_page_detail":
      return "Compare with the previous period (compare=true) or open the same page or query in Search Console for the Google side.";
    case "crawl":
      return "Ask for the crawl_problems preset to see which URLs have errors or are blocked.";
    case "crawl_issues":
    case "crawl_problems":
    case "blocked_urls":
      return s.afterFilter > 0 ? "Fix the listed URLs, then check again in a few days; Bing says fixed issues can take that long to disappear." : "No crawl issues reported. Check sitemap_status to confirm Bing is reading your sitemaps.";
    case "inbound_links":
      return "Ask who links to one of these pages (url_links) to see the linking pages and anchor text.";
    case "url_links":
      return "Ask for inbound_links to see which of your pages have the most links.";
    case "sitemaps":
      return "If a sitemap is not successful, open it in Bing Webmaster Tools to resubmit it; this connector cannot change anything.";
    case "url_info":
      return "Ask for url_traffic to see how that URL performs in Bing search.";
    case "url_traffic":
      return "Ask for page_queries to see which queries bring this page its traffic.";
    case "submission_quota":
      return "Submitting URLs is done in Bing Webmaster Tools or with IndexNow; this connector is read-only.";
    case "keyword_stats":
      return "Compare with your own queries (queries report) to see whether the site already ranks for this keyword.";
    case "query_traffic":
      return "Ask which pages that query reaches (query_pages) or compare with the previous period (compare=true).";
    case "children_url_info":
    case "children_url_traffic":
      return "Ask for the same report with a deeper folder as the url, or for url_info / url_traffic on one page.";
    case "crawl_settings":
      return "Crawl rate can only be changed in Bing Webmaster Tools; this connector is read-only.";
    case "feed_details":
      return "Ask for the sitemaps report to see every submitted sitemap and its status.";
    case "deep_link_blocks":
    case "page_preview_blocks":
    case "country_region_settings":
    case "query_parameters":
    case "connected_pages":
    case "site_moves":
    case "site_roles":
    case "content_submission_quota":
      return "These settings can only be changed in Bing Webmaster Tools; this connector is read-only.";
    case "keyword":
    case "related_keywords":
      return "Check whether the site already ranks for these keywords with the queries report.";
  }
}

// ---- the adapter -------------------------------------------------------------------------------------------------------

async function fetchReport(client: BingApiClient, auth: BingAuth, site: string, q: BingQuery, signal?: AbortSignal): Promise<Fetched> {
  const base = { skipped: 0, warnings: [] as ReportWarning[], meta: {} as Record<string, unknown> };
  const rowsOf = <T extends object>(r: BingRows<T>): Fetched => ({ ...base, rows: toRaw(r.rows), skipped: r.skipped });
  switch (q.report) {
    case "traffic":
      return rowsOf(await client.getRankAndTrafficStats(auth, site, signal));
    case "queries":
      return rowsOf(await client.getQueryStats(auth, site, signal));
    case "pages":
      return rowsOf(await client.getPageStats(auth, site, signal));
    case "query_pages":
      return rowsOf(await client.getQueryPageStats(auth, site, q.query!, signal));
    case "page_queries":
      return rowsOf(await client.getPageQueryStats(auth, site, q.page!, signal));
    case "query_page_detail":
      return rowsOf(await client.getQueryPageDetailStats(auth, site, q.query!, q.page!, signal));
    case "crawl":
      return rowsOf(await client.getCrawlStats(auth, site, signal));
    case "crawl_issues": {
      const r = await client.getCrawlIssues(auth, site, signal);
      return { ...base, skipped: r.skipped, rows: toRaw(r.rows.map((x) => ({ ...x, issueNames: decodeCrawlIssues(x.issues).join(", ") }))) };
    }
    case "blocked_urls":
      return rowsOf(await client.getBlockedUrls(auth, site, signal));
    case "crawl_problems":
      return fetchCrawlProblems(client, auth, site, signal);
    case "inbound_links": {
      const r = await fetchPaged((page) => client.getLinkCounts(auth, site, page, signal).then((p) => ({ items: p.links, totalPages: p.totalPages })));
      return { ...base, rows: toRaw(r.items), warnings: r.truncated ? [truncatedLinks(r.totalPages)] : [], meta: { totalPagesAtBing: r.totalPages, linkPagesTruncated: r.truncated } };
    }
    case "url_links": {
      const r = await fetchPaged((page) => client.getUrlLinks(auth, site, q.url!, page, signal).then((p) => ({ items: p.details, totalPages: p.totalPages })));
      return { ...base, rows: toRaw(r.items), warnings: r.truncated ? [truncatedLinks(r.totalPages)] : [], meta: { totalPagesAtBing: r.totalPages, linkPagesTruncated: r.truncated } };
    }
    case "sitemaps": {
      const r = await client.getFeeds(auth, site, signal);
      const notSuccessful = r.rows.filter((x) => x.status !== null && x.status.toLowerCase() !== "success").length;
      return { ...base, skipped: r.skipped, rows: toRaw(r.rows), totals: { feeds: r.rows.length, notSuccessful } };
    }
    case "url_info": {
      const r = await client.getUrlInfo(auth, site, q.url!, signal);
      return { ...base, rows: r ? toRaw([r]) : [] };
    }
    case "url_traffic": {
      const r = await client.getUrlTrafficInfo(auth, site, q.url!, signal);
      return { ...base, rows: r ? toRaw([r]) : [] };
    }
    case "submission_quota": {
      const r = await client.getUrlSubmissionQuota(auth, site, signal);
      return { ...base, rows: r ? toRaw([r]) : [] };
    }
    case "query_traffic":
      return rowsOf(await client.getQueryTrafficStats(auth, site, q.query!, signal));
    case "children_url_info": {
      const r = await client.getChildrenUrlInfo(auth, site, q.url!, q.pageNumber, {}, signal);
      return { ...rowsOf(r), meta: r.rows.length > 0 ? { bingPage: q.pageNumber, nextPageNumber: q.pageNumber + 1 } : { bingPage: q.pageNumber } };
    }
    case "children_url_traffic": {
      const r = await client.getChildrenUrlTrafficInfo(auth, site, q.url!, q.pageNumber, signal);
      return { ...rowsOf(r), meta: r.rows.length > 0 ? { bingPage: q.pageNumber, nextPageNumber: q.pageNumber + 1 } : { bingPage: q.pageNumber } };
    }
    case "crawl_settings": {
      const r = await client.getCrawlSettings(auth, site, signal);
      const rate = r?.crawlRate ?? [];
      return {
        ...base,
        rows: rate.map((crawlRate, slot) => ({ slot, crawlRate })),
        warnings: rate.length > 0 ? [{ code: "CRAWL_RATE_SLOTS", message: `Bing sent ${rate.length} crawl-rate values and does not document what each position or number stands for, so they are shown in the order Bing sent them.` }] : [],
        meta: { ajaxEnabled: r?.ajaxEnabled ?? null, crawlBoostAvailable: r?.crawlBoostAvailable ?? null, crawlBoostEnabled: r?.crawlBoostEnabled ?? null },
      };
    }
    case "feed_details":
      return rowsOf(await client.getFeedDetails(auth, site, q.feedUrl!, signal));
    case "deep_link_blocks":
      return rowsOf(await client.getDeepLinkBlocks(auth, site, signal));
    case "page_preview_blocks":
      return rowsOf(await client.getActivePagePreviewBlocks(auth, site, signal));
    case "country_region_settings":
      return rowsOf(await client.getCountryRegionSettings(auth, site, signal));
    case "query_parameters":
      return rowsOf(await client.getQueryParameters(auth, site, signal));
    case "connected_pages":
      return rowsOf(await client.getConnectedPages(auth, site, signal));
    case "site_moves":
      return rowsOf(await client.getSiteMoves(auth, site, signal));
    case "site_roles": {
      const r = await client.getSiteRoles(auth, site, q.includeAllSubdomains, signal);
      // Only role 2 is named in Microsoft's sample (XML "ReadWrite" = JSON 2); the other numbers are passed through, not guessed.
      return { ...base, skipped: r.skipped, rows: toRaw(r.rows.map((x) => ({ ...x, roleName: x.role === 2 ? "ReadWrite" : null }))) };
    }
    case "content_submission_quota": {
      const r = await client.getContentSubmissionQuota(auth, site, signal);
      return { ...base, rows: r ? toRaw([r]) : [] };
    }
    case "keyword":
    case "related_keywords": {
      const today = new Date().toISOString().slice(0, 10);
      const start = q.startDate ?? addDaysIso(today, -29);
      const end = q.endDate ?? today;
      const call = q.report === "keyword" ? client.getKeyword.bind(client) : client.getRelatedKeywords.bind(client);
      const r = await call(auth, q.keyword!, q.country ?? "us", q.language ?? "en-US", start, end, signal);
      // Live quirk: GetKeyword answers with Query = null when Bing has no data for the keyword. The row is for the keyword that was asked.
      const noName = r.rows.filter((x) => x.query === null).length;
      const filled = { ...r, rows: r.rows.map((x) => (x.query === null ? { ...x, query: q.keyword! } : x)) };
      const noData: ReportWarning[] = noName > 0 ? [{ code: "KEYWORD_NO_DATA", message: "Bing sent no keyword name for this lookup, which is what it does when it has no data for the keyword. Treat the numbers as 'no data', not as proof that nobody searched for it." }] : [];
      return { ...rowsOf(filled), warnings: [...localeWarnings(q), ...noData], meta: { country: q.country ?? "us", language: q.language ?? "en-US", periodSent: { startDate: start, endDate: end } } };
    }
    case "keyword_stats": {
      const r = await client.getKeywordStats(auth, q.keyword!, q.country ?? "us", q.language ?? "en-US", signal);
      return { ...rowsOf(r), warnings: q.country && q.language ? [] : [{ code: "ASSUMED_LOCALE", message: `Bing does not document the accepted country and language values; ${q.country ? "" : "country defaulted to us"}${!q.country && !q.language ? " and " : ""}${q.language ? "" : "language to en-US"}.` }], meta: { country: q.country ?? "us", language: q.language ?? "en-US" } };
    }
  }
}

const localeWarnings = (q: BingQuery): ReportWarning[] =>
  q.country && q.language ? [] : [{ code: "ASSUMED_LOCALE", message: `Bing does not document the accepted country and language values; ${q.country ? "" : "country defaulted to us"}${!q.country && !q.language ? " and " : ""}${q.language ? "" : "language to en-US"}.` }];

const truncatedLinks = (total: number | null): ReportWarning => ({
  code: "LINK_PAGES_LIMIT",
  message: `Bing has ${total ?? "more"} pages of results; only the first ${MAX_LINK_PAGES} were read, so the list is partial. Use contains or url_links to narrow down.`,
});

/** Crawl issues + blocked URLs + the most recent crawl-statistics day. A failure of one part is reported, never hidden. */
async function fetchCrawlProblems(client: BingApiClient, auth: BingAuth, site: string, signal?: AbortSignal): Promise<Fetched> {
  const warnings: ReportWarning[] = [];
  const settle = async <T>(name: string, work: Promise<T>): Promise<T | null> => {
    try {
      return await work;
    } catch (err) {
      // An auth problem is the whole answer; any other part may fail on its own without hiding the others.
      if (err instanceof BingApiError && (err.kind === "unauthenticated" || err.kind === "forbidden" || err.kind === "throttled")) throw err;
      warnings.push({ code: "PART_UNAVAILABLE", message: `${name} could not be read from Bing just now, so it is missing from this answer.` });
      return null;
    }
  };
  const [issues, blocked, crawl] = await Promise.all([
    settle("Crawl issues", client.getCrawlIssues(auth, site, signal)),
    settle("Blocked URLs", client.getBlockedUrls(auth, site, signal)),
    settle("Crawl statistics", client.getCrawlStats(auth, site, signal)),
  ]);
  const rows: Raw[] = [
    ...(issues?.rows ?? []).map((x: BingCrawlIssueRow): Raw => ({ kind: "crawl_issue", url: x.url, httpCode: x.httpCode, inLinks: x.inLinks, issues: decodeCrawlIssues(x.issues).join(", ") })),
    ...(blocked?.rows ?? []).map((x: BingBlockedUrlRow): Raw => ({ kind: "blocked_url", url: x.url, httpCode: null, inLinks: null, issues: "blocked in Bing Webmaster Tools" })),
  ];
  const latest = [...(crawl?.rows ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const totals: Record<string, number | null> = {
    crawlIssues: issues ? issues.rows.length : null,
    blockedUrls: blocked ? blocked.rows.length : null,
    crawlErrors: latest?.crawlErrors ?? null,
    code4xx: latest?.code4xx ?? null,
    code5xx: latest?.code5xx ?? null,
    blockedByRobotsTxt: latest?.blockedByRobotsTxt ?? null,
    containsMalware: latest?.containsMalware ?? null,
  };
  return { rows, skipped: (issues?.skipped ?? 0) + (blocked?.skipped ?? 0), warnings, meta: { latestCrawlDay: latest?.date ?? null }, totals };
}

/** The only code that reads Bing reports. Resolves the credential, calls Bing, shapes the answer. */
export class LiveBingAdapter implements BingAdapter {
  readonly provider = "bing" as const;
  readonly mock: boolean;

  constructor(private readonly deps: LiveBingDeps) {
    this.mock = deps.client.mock;
  }

  async query(query: BingQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const { client, hooks } = this.deps;
    const auth = await this.deps.getAuth(ctx);
    let fetched: Fetched;
    try {
      fetched = await fetchReport(client, auth, ctx.property.externalPropertyId, query, ctx.signal);
    } catch (err) {
      if (err instanceof BingApiError && err.kind === "unauthenticated") await hooks?.onAuthRejected(ctx).catch(() => undefined);
      throw toBingConnectorError(err);
    }
    await hooks?.onSuccess(ctx).catch(() => undefined);
    return buildBingResult({ query, ctx, fetched, mock: this.mock, now: this.deps.now?.() ?? new Date() });
  }
}

export function createBingAdapter(deps: LiveBingDeps): BingAdapter {
  return new LiveBingAdapter(deps);
}

export function bingDisabled(): ConnectorException {
  return new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Bing Webmaster support is not enabled on this server yet.", {
    provider: "bing",
    suggestedAction: "Use Search Console or GA4 for now.",
  });
}
