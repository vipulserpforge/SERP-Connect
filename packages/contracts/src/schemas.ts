import { z } from "zod";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Not a real calendar date");

export const GscFilterSchema = z
  .object({
    dimension: z.enum(["page", "query", "country", "device", "searchAppearance"]).describe("Dimension to filter on."),
    operator: z
      .enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"])
      .describe("Match type. Regex operators use RE2 syntax."),
    expression: z
      .string()
      .min(1)
      .max(2048)
      .describe("Value to match. Countries are ISO 3166-1 alpha-3 codes (e.g. USA); devices are DESKTOP, MOBILE or TABLET."),
  })
  .strict();
export type GscFilter = z.infer<typeof GscFilterSchema>;

/** "Last N completed days", resolved by the server in the provider's own time zone and data-availability rules. */
const lastDays = z
  .number()
  .int()
  .min(1)
  .max(500)
  .describe("Relative range: the last N completed days, resolved by the server in the provider's own time zone. Use this OR startDate+endDate, never both.");

/** Either an explicit start and end date, or `lastDays`: never both, never neither. */
const exactlyOneDateForm = (v: { startDate?: string | undefined; endDate?: string | undefined; lastDays?: number | undefined }) =>
  v.lastDays !== undefined ? v.startDate === undefined && v.endDate === undefined : v.startDate !== undefined && v.endDate !== undefined;
const dateFormMessage = "Provide either startDate and endDate, or lastDays (not both).";

export const QueryGscSchema = z
  .object({
    propertyId: z.string().min(1).max(2048).describe("Search Console property exactly as returned by list_gsc_properties, e.g. sc-domain:example.com or https://www.example.com/."),
    startDate: isoDate.optional().describe("First day, YYYY-MM-DD, in Pacific Time. Needs endDate."),
    endDate: isoDate.optional().describe("Last day, YYYY-MM-DD, in Pacific Time. Needs startDate."),
    lastDays: lastDays.optional(),
    dimensions: z
      .array(z.enum(["date", "page", "query", "country", "device", "searchAppearance"]))
      .max(6)
      .default(["page"])
      .describe("How to group rows. searchAppearance cannot be combined with other dimensions."),
    type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web").describe("Search type. discover and googleNews have no queries."),
    filters: z.array(GscFilterSchema).max(10).default([]).describe("All filters must match (AND)."),
    sortBy: z.enum(["clicks", "impressions", "ctr", "position"]).default("clicks").describe("Metric to order rows by."),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(1000).default(25).describe("Maximum rows to return (server maximum applies)."),
    offset: z.number().int().min(0).max(100_000).default(0).describe("Rows to skip, to page past the first `limit` rows when a warning says more rows exist."),
    compareTo: z
      .enum(["previous_period", "previous_year"])
      .optional()
      .describe("Also fetch an earlier range and add previous/change columns to every row and the totals. previous_period = the same number of days right before the range; previous_year = the same dates a year earlier."),
    fresh: z.boolean().optional().describe("true skips the saved-result cache and asks Google again. Use only when the user needs the very latest numbers."),
    /** "final" (default) returns only finalized days; "all" also returns fresh, still-changing data. */
    dataState: z.enum(["final", "all"]).default("final"),
  })
  .strict()
  .refine(exactlyOneDateForm, { message: dateFormMessage, path: ["startDate"] });
export type QueryGscInput = z.infer<typeof QueryGscSchema>;

/** A validated request whose dates have been resolved to concrete calendar dates. */
export type WithResolvedDates<T> = Omit<T, "lastDays" | "startDate" | "endDate"> & { startDate: string; endDate: string };

/** GA4 API names: letters, digits, underscore, and `customEvent:` / `customUser:` style prefixes. */
const ga4Field = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*(:[A-Za-z0-9_]+)?$/, "Not a valid GA4 field name");

export const GA4_MATCH_TYPES = ["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP", "IN_LIST"] as const;

export const Ga4FilterSchema = z
  .object({
    field: ga4Field,
    matchType: z.enum(GA4_MATCH_TYPES).describe("EXACT, BEGINS_WITH, ENDS_WITH, CONTAINS, FULL_REGEXP (whole value matches), PARTIAL_REGEXP (matches anywhere), or IN_LIST (any of `values`)."),
    value: z.string().min(1).max(1024).optional().describe("Text or regular expression. Not used with IN_LIST."),
    values: z.array(z.string().min(1).max(256)).min(1).max(50).optional().describe("For IN_LIST: match any of these exact values."),
    exclude: z.boolean().optional().describe("true keeps only rows that do NOT match (for example exclude Direct traffic)."),
  })
  .strict()
  .refine((f) => (f.matchType === "IN_LIST" ? Boolean(f.values?.length) && f.value === undefined : f.value !== undefined && f.values === undefined), {
    message: "IN_LIST needs `values` (and no `value`); every other match type needs `value` (and no `values`).",
    path: ["value"],
  });

export const Ga4MetricFilterSchema = z
  .object({
    field: ga4Field,
    operator: z.enum(["EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL"]),
    value: z.number().finite(),
  })
  .strict();

/** Ready-made GA4 reports. A preset sets the dimensions, metrics, organic filter and sort; extra filters are still applied. */
export const GA4_PRESETS = [
  // Acquisition
  "organic_landing_pages",
  "sessions_by_channel",
  "traffic_by_channel_medium",
  "traffic_by_source_medium",
  "traffic_by_campaign",
  "user_acquisition_by_channel",
  "new_vs_returning",
  "traffic_trend",
  // Engagement
  "engagement_by_page",
  "landing_pages",
  "key_events_by_page",
  "events_overview",
  // Audience
  "device_breakdown",
  "country_breakdown",
  "city_breakdown",
  "age_breakdown",
  "gender_breakdown",
  // Retention
  "user_stickiness",
  // Monetization
  "revenue_by_product",
  "revenue_by_channel",
  "revenue_by_category",
  "promotions_performance",
  "ecommerce_funnel",
  "lifetime_value_by_channel",
] as const;
export type Ga4Preset = (typeof GA4_PRESETS)[number];

export const QueryGa4Schema = z
  .object({
    propertyId: z.string().min(1).max(64).describe("GA4 property id exactly as returned by list_ga4_properties (digits only)."),
    startDate: isoDate.optional().describe("First day, YYYY-MM-DD, in the property's reporting time zone. Needs endDate."),
    endDate: isoDate.optional().describe("Last day, YYYY-MM-DD, in the property's reporting time zone. Needs startDate."),
    lastDays: lastDays.optional(),
    dimensions: z.array(ga4Field).max(9).default(["pagePath"]).describe("GA4 API dimension names (e.g. pagePath, country, sessionDefaultChannelGroup). Call get_supported_metrics for the valid list."),
    metrics: z.array(ga4Field).min(1).max(10).default(["activeUsers"]).describe("GA4 API metric names (e.g. activeUsers, sessions, screenPageViews, eventCount, keyEvents)."),
    dimensionFilters: z.array(Ga4FilterSchema).max(10).default([]).describe("Filters on dimensions, combined by filterMode (default: all must match). Matching is case-insensitive."),
    metricFilters: z.array(Ga4MetricFilterSchema).max(10).default([]).describe("Filters on metrics, combined by filterMode."),
    filterMode: z.enum(["and", "or"]).default("and").describe("and = every filter must match; or = any filter may match (applies to each filter list separately)."),
    orderBy: z
      .object({ field: ga4Field, direction: z.enum(["asc", "desc"]).default("desc") })
      .strict()
      .optional()
      .describe("Sort by one requested dimension or metric."),
    limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
    offset: z.number().int().min(0).max(100_000).default(0).describe("Rows to skip, for paging when the result says more rows are available."),
    preset: z
      .enum(GA4_PRESETS)
      .optional()
      .describe(
        "Ready-made report that REPLACES dimensions, metrics and sort (your own filters are kept): organic_landing_pages = top organic Search landing pages by active users; sessions_by_channel; key_events_by_page; new_vs_returning; traffic_trend = daily sessions, users and key events.",
      ),
    compareTo: z
      .enum(["previous_period", "previous_year"])
      .optional()
      .describe("Also fetch an earlier range and add previous/change columns to every row and the totals. previous_period = the same number of days right before the range; previous_year = the same dates a year earlier."),
    fresh: z.boolean().optional().describe("true skips the saved-result cache and asks Google again. Use only when the user needs the very latest numbers."),
  })
  .strict()
  .refine(exactlyOneDateForm, { message: dateFormMessage, path: ["startDate"] });
export type QueryGa4Input = z.infer<typeof QueryGa4Schema>;

/** Realtime reports use their own, smaller field set (see GA4_REALTIME_DIMENSIONS / GA4_REALTIME_METRICS in provider-ga4). */
export const QueryGa4RealtimeSchema = z
  .object({
    propertyId: z.string().min(1).max(64).describe("GA4 property id exactly as returned by list_ga4_properties (digits only)."),
    dimensions: z.array(ga4Field).max(4).default(["country"]).describe("Realtime dimensions, e.g. country, city, deviceCategory, unifiedScreenName (page title), eventName, platform, minutesAgo."),
    metrics: z.array(ga4Field).min(1).max(5).default(["activeUsers"]).describe("Realtime metrics: activeUsers, screenPageViews, eventCount, keyEvents."),
    dimensionFilters: z.array(Ga4FilterSchema).max(5).default([]).describe("All filters must match (AND)."),
    minutes: z.number().int().min(1).max(30).default(30).describe("How many recent minutes to include (1-30)."),
    limit: z.number().int().min(1).max(250).default(25),
  })
  .strict();
export type QueryGa4RealtimeInput = z.infer<typeof QueryGa4RealtimeSchema>;

/** Cohort retention: users grouped by the period they first visited, and how many were active in each later period. */
export const QueryGa4CohortSchema = z
  .object({
    propertyId: z.string().min(1).max(64).describe("GA4 property id exactly as returned by list_ga4_properties (digits only)."),
    granularity: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).default("WEEKLY").describe("Cohort size: users who first visited on the same day, week (Sunday to Saturday) or month."),
    cohorts: z.number().int().min(1).max(12).default(4).describe("How many of the most recent COMPLETE cohorts to include."),
    periods: z.number().int().min(1).max(12).default(5).describe("How many periods to follow each cohort (period 0 is the first period)."),
    metric: z.enum(["cohortActiveUsers", "cohortTotalUsers"]).default("cohortActiveUsers"),
    dimensionFilters: z.array(Ga4FilterSchema).max(5).default([]).describe("Optional, for example only one country or channel."),
  })
  .strict();
export type QueryGa4CohortInput = z.infer<typeof QueryGa4CohortSchema>;

/** Clarity-only report presets. The dimensions each one maps to live in provider-clarity. */
export const CLARITY_REPORT_TYPES = ["overview", "by_device", "by_country", "by_source", "by_channel", "by_page", "frustration_by_page", "by_browser_os"] as const;

export const GetClarityInsightsSchema = z
  .object({
    propertyId: z.string().min(1).max(256),
    numOfDays: z
      .union([z.literal(1), z.literal(2), z.literal(3)], { message: "Clarity only reports the last 1, 2 or 3 days (24-72 hours). For 7, 28 or 90 days use query_gsc_performance or query_ga4_report." })
      .default(1)
      .describe("Rolling window: 1, 2 or 3 days. Clarity cannot report anything older than 72 hours."),
    dimensions: z.array(z.string().min(1).max(64)).max(3).default([]),
    reportType: z
      .enum(CLARITY_REPORT_TYPES)
      .optional()
      .describe("Ready-made report; use it instead of dimensions. Each one is one Clarity request, so ask for one or two per question."),
    limit: z.number().int().min(1).max(100).default(25).describe("Rows to return for a dimension report (the rest are counted in rowsAvailable)."),
  })
  .strict();
export type GetClarityInsightsInput = z.infer<typeof GetClarityInsightsSchema>;

export const GetClarityHistorySchema = z
  .object({
    propertyId: z.string().min(1).max(256),
    reportType: z.enum(CLARITY_REPORT_TYPES).optional().describe("Which kind of saved pull to show. Defaults to overview."),
    dimensions: z.array(z.string().min(1).max(64)).max(3).default([]).describe("Alternative to reportType."),
    limit: z.number().int().min(1).max(30).default(7).describe("How many saved pulls to return, newest first."),
  })
  .strict();
export type GetClarityHistoryInput = z.infer<typeof GetClarityHistorySchema>;

export const GetClarityQuotaStatusSchema = z
  .object({ propertyId: z.string().min(1).max(256).describe("A Clarity property id from list_clarity_projects.") })
  .strict();
export type GetClarityQuotaStatusInput = z.infer<typeof GetClarityQuotaStatusSchema>;

/**
 * Bing reports: every one is a documented read-only method of Microsoft's IWebmasterApi (see docs/BING.md for the matrix).
 * `crawl_problems` is a composite (crawl issues + blocked URLs + the latest crawl statistics) used by the presets.
 */
export const BING_REPORTS = [
  "traffic",
  "queries",
  "pages",
  "query_pages",
  "page_queries",
  "query_page_detail",
  "crawl",
  "crawl_issues",
  "crawl_problems",
  "blocked_urls",
  "inbound_links",
  "url_links",
  "sitemaps",
  "url_info",
  "url_traffic",
  "submission_quota",
  "keyword_stats",
  "query_traffic",
  "children_url_info",
  "children_url_traffic",
  "crawl_settings",
  "feed_details",
  "deep_link_blocks",
  "page_preview_blocks",
  "country_region_settings",
  "query_parameters",
  "connected_pages",
  "site_moves",
  "site_roles",
  "content_submission_quota",
  "keyword",
  "related_keywords",
] as const;
export type BingReportKind = (typeof BING_REPORTS)[number];

/** Reports `query_bing_report` serves (performance, index, links, crawl, sitemaps). The older names keep working. */
export const BING_QUERY_REPORTS = [
  "traffic", "queries", "pages", "query_pages", "page_queries", "query_page_detail", "crawl", "crawl_issues", "crawl_problems", "blocked_urls",
  "inbound_links", "url_links", "sitemaps", "url_info", "url_traffic", "submission_quota", "keyword_stats",
  "query_traffic", "children_url_info", "children_url_traffic", "crawl_settings", "feed_details",
] as const satisfies ReadonlyArray<BingReportKind>;

/** Reports `get_bing_site_settings` serves: how the site is configured at Bing. */
export const BING_SETTINGS_REPORTS = [
  "blocked_urls", "deep_link_blocks", "page_preview_blocks", "country_region_settings", "query_parameters", "connected_pages", "site_moves", "site_roles", "submission_quota", "content_submission_quota",
] as const satisfies ReadonlyArray<BingReportKind>;

/** Reports `query_bing_keywords` serves: market-wide Bing search volume, not tied to a site. */
export const BING_KEYWORD_REPORTS = ["keyword_stats", "keyword", "related_keywords"] as const satisfies ReadonlyArray<BingReportKind>;

export const BING_SORT_FIELDS = ["date", "clicks", "impressions", "ctr", "position", "clicksChange", "impressionsChange", "count"] as const;

const bingWindow = {
  startDate: isoDate.optional().describe("Keep only rows on or after this date, YYYY-MM-DD. Needs endDate."),
  endDate: isoDate.optional().describe("Keep only rows on or before this date, YYYY-MM-DD. Needs startDate."),
  lastDays: z.number().int().min(1).max(500).optional().describe("Keep only the last N calendar days up to today (UTC). Use this OR startDate+endDate, never both."),
};

const BING_NEEDS: Partial<Record<BingReportKind, Array<"query" | "page" | "url" | "keyword" | "feedUrl">>> = {
  query_pages: ["query"],
  page_queries: ["page"],
  query_page_detail: ["query", "page"],
  url_links: ["url"],
  url_info: ["url"],
  url_traffic: ["url"],
  keyword_stats: ["keyword"],
  query_traffic: ["query"],
  children_url_info: ["url"],
  children_url_traffic: ["url"],
  feed_details: ["feedUrl"],
};

export const QueryBingSchema = z
  .object({
      propertyId: z.string().min(1).max(2048).describe("A Bing site exactly as returned by list_bing_sites, e.g. https://www.example.com/."),
      report: z.enum(BING_QUERY_REPORTS).describe(
        "traffic = daily clicks and impressions. queries = search queries. pages = pages ranked in Bing. query_pages = pages that got impressions for one `query`. page_queries = queries that led to one `page`. query_page_detail = daily detail for one `query` on one `page`. " +
          "crawl = Bingbot crawl and index statistics by day. crawl_issues = URLs with crawl problems. crawl_problems = crawl issues + blocked URLs + latest crawl numbers in one answer. blocked_urls = URLs/directories blocked in Bing. " +
          "inbound_links = pages with inbound links (counts). url_links = who links to one `url`. sitemaps = submitted sitemaps/feeds and their status. url_info = index details of one `url`. url_traffic = clicks and impressions of one `url`. " +
          "submission_quota = how many URLs can still be submitted. keyword_stats = Bing search-volume history of one `keyword`. " +
          "query_traffic = daily clicks and impressions of one top `query` on this site. children_url_info = index details of the pages and folders under one `url` (page through with pageNumber). children_url_traffic = clicks and impressions of the pages and folders under one `url`. " +
          "crawl_settings = Bing's crawl-rate setting for the site. feed_details = details of one sitemap index `feedUrl`.",
      ),
      ...bingWindow,
      compare: z.boolean().default(false).describe("Also fetch the previous period of the same length and add the change (percent) for totals and rows. Needs lastDays or startDate+endDate (defaults to the last 28 days)."),
      aggregate: z.boolean().default(true).describe("queries/pages/query_pages/page_queries: one row per query or page, summed over the window, with CTR and average position. false = Bing's raw rows per date (queries and pages are weekly)."),
      query: z.string().min(1).max(500).optional().describe("A search query. Needed by query_pages and query_page_detail."),
      page: z.string().min(1).max(2048).optional().describe("A page address on the site. Needed by page_queries and query_page_detail."),
      url: z.string().min(1).max(2048).optional().describe("A URL on the site (or `domain:example.com`). Needed by url_links, url_info and url_traffic."),
      keyword: z.string().min(1).max(500).optional().describe("A keyword. Needed by keyword_stats."),
      feedUrl: z.string().min(1).max(2048).optional().describe("A sitemap or feed address as listed by the sitemaps report. Needed by feed_details."),
      pageNumber: z.number().int().min(0).max(1000).default(0).describe("children_url_info and children_url_traffic: 0-based page of Bing's results. Bing returns an empty page when there is no more."),
      country: z.string().min(2).max(10).optional().describe("keyword_stats only: country code, default us. Bing does not document the accepted values."),
      language: z.string().min(2).max(10).optional().describe("keyword_stats only: language code, default en-US. Bing does not document the accepted values."),
      contains: z.string().min(1).max(200).optional().describe("Keep only queries or pages whose text contains this (case-insensitive)."),
      minImpressions: z.number().int().min(0).max(1_000_000_000).optional().describe("Keep only rows with at least this many impressions (after summing)."),
      maxCtr: z.number().min(0).max(1).optional().describe("Keep only rows with a click-through rate at or below this (0.02 = 2%)."),
      onlyDeclining: z.boolean().default(false).describe("With compare: keep only rows whose clicks fell versus the previous period."),
      mergeUrlVariants: z.boolean().default(true).describe("Treat https://x.com/a, https://x.com/a/ and https://x.com/a?utm=1#top as one page (Bing lists them separately)."),
      sortBy: z.enum(BING_SORT_FIELDS).optional().describe("Defaults: date for traffic/crawl, clicks for queries and pages, count for inbound_links. clicksChange/impressionsChange need compare=true."),
      sortDirection: z.enum(["asc", "desc"]).default("desc"),
      limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
    })
  .strict()
  .refine((v) => (v.startDate === undefined) === (v.endDate === undefined), { message: "Provide startDate and endDate together.", path: ["startDate"] })
  .refine((v) => v.lastDays === undefined || (v.startDate === undefined && v.endDate === undefined), { message: "Provide either startDate and endDate, or lastDays (not both).", path: ["lastDays"] })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate must not be after endDate.", path: ["startDate"] })
  .refine((v) => (BING_NEEDS[v.report] ?? []).every((f) => v[f] !== undefined), { message: "This report needs an extra field: query_pages and query_traffic need `query`; page_queries needs `page`; query_page_detail needs `query` and `page`; url_links, url_info, url_traffic, children_url_info and children_url_traffic need `url`; keyword_stats needs `keyword`; feed_details needs `feedUrl`.", path: ["report"] })
  .refine((v) => !["clicksChange", "impressionsChange"].includes(v.sortBy ?? "") || v.compare, { message: "Sorting by a change needs compare=true.", path: ["sortBy"] })
  .refine((v) => !v.onlyDeclining || v.compare, { message: "onlyDeclining needs compare=true.", path: ["onlyDeclining"] });
export type QueryBingInput = z.infer<typeof QueryBingSchema>;

export const BingSettingsSchema = z
  .object({
    propertyId: z.string().min(1).max(2048).describe("A Bing site exactly as returned by list_bing_sites, e.g. https://www.example.com/."),
    report: z
      .enum(BING_SETTINGS_REPORTS)
      .describe(
        "blocked_urls = URLs and folders blocked in Bing. deep_link_blocks = blocked deep links. page_preview_blocks = pages whose preview is blocked. country_region_settings = the site's target country or region. " +
          "query_parameters = URL parameters Bing ignores. connected_pages = social and business pages connected to the site. site_moves = site-move (domain change) records. " +
          "site_roles = who has access to the site in Bing (email addresses and role; delegation codes are never shown). submission_quota = URL submissions left. content_submission_quota = content submissions left.",
      ),
    includeAllSubdomains: z.boolean().default(false).describe("site_roles only: include roles on the site's subdomains."),
    contains: z.string().min(1).max(200).optional().describe("Keep only rows where any text field contains this (case-insensitive)."),
    limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
  })
  .strict();
export type BingSettingsInput = z.infer<typeof BingSettingsSchema>;

export const QueryBingKeywordsSchema = z
  .object({
    report: z.enum(BING_KEYWORD_REPORTS).describe("keyword_stats = Bing search-volume history of one keyword. keyword = impressions for one keyword over a period. related_keywords = keywords related to one keyword, with their impressions."),
    keyword: z.string().min(1).max(500).describe("The keyword or phrase to look up. This is Bing-wide market data, not this site's traffic."),
    propertyId: z.string().min(1).max(2048).optional().describe("Optional: any of your Bing sites from list_bing_sites. Keywords are not site-specific; this only picks which Bing connection to use. Defaults to your first visible Bing site."),
    country: z.string().min(2).max(10).optional().describe("Country code, default us. Bing does not document the accepted values."),
    language: z.string().min(2).max(10).optional().describe("Language code, default en-US. Bing does not document the accepted values."),
    startDate: isoDate.optional().describe("Period start, YYYY-MM-DD. Needs endDate. keyword and related_keywords default to the last 30 days."),
    endDate: isoDate.optional().describe("Period end, YYYY-MM-DD. Needs startDate."),
    lastDays: z.number().int().min(1).max(500).optional().describe("The last N calendar days up to today (UTC). Use this OR startDate+endDate."),
    limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
  })
  .strict()
  .refine((v) => (v.startDate === undefined) === (v.endDate === undefined), { message: "Provide startDate and endDate together.", path: ["startDate"] })
  .refine((v) => v.lastDays === undefined || (v.startDate === undefined && v.endDate === undefined), { message: "Provide either startDate and endDate, or lastDays (not both).", path: ["lastDays"] })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate must not be after endDate.", path: ["startDate"] });
export type QueryBingKeywordsInput = z.infer<typeof QueryBingKeywordsSchema>;

/** Curated Bing questions. Each maps to query_bing_report with sensible defaults. */
export const BING_PRESETS = ["top_queries", "top_pages", "low_ctr_queries", "declining_pages", "crawl_problems", "top_inbound_links", "sitemap_status"] as const;
export type BingPreset = (typeof BING_PRESETS)[number];

export const BingPresetSchema = z
  .object({
    propertyId: z.string().min(1).max(2048).describe("A Bing site exactly as returned by list_bing_sites."),
    preset: z.enum(BING_PRESETS).describe(
      "top_queries = queries by impressions. top_pages = pages by clicks. low_ctr_queries = queries with many impressions but few clicks. declining_pages = pages losing clicks versus the previous period (default: last 14 days vs the 14 before, because Bing reports pages in weekly buckets). " +
        "crawl_problems = crawl errors, blocked URLs and latest crawl numbers. top_inbound_links = pages with the most inbound links. sitemap_status = submitted sitemaps and whether Bing read them.",
    ),
    lastDays: z.number().int().min(1).max(500).optional().describe("Window in days. Defaults: 28 (14 for declining_pages). Ignored by crawl_problems, top_inbound_links and sitemap_status."),
    limit: z.number().int().min(1).max(200).default(20),
    minImpressions: z.number().int().min(0).optional().describe("low_ctr_queries only. Default 100."),
    maxCtr: z.number().min(0).max(1).optional().describe("low_ctr_queries only. Default 0.02 (2%)."),
  })
  .strict();
export type BingPresetInput = z.infer<typeof BingPresetSchema>;


export const ListPropertiesSchema = z
  .object({ connectionId: z.string().min(1).max(128).optional().describe("Only list properties of this connection (an id from get_connection_status).") })
  .strict();
export type ListPropertiesInput = z.infer<typeof ListPropertiesSchema>;

export const GetSupportedMetricsSchema = z
  .object({
    provider: z.enum(["gsc", "ga4", "clarity", "bing"]).describe("Which provider's fields to describe."),
    /** GA4 only: returns the fields available on that property, including its custom dimensions and metrics. */
    propertyId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type GetSupportedMetricsInput = z.infer<typeof GetSupportedMetricsSchema>;
