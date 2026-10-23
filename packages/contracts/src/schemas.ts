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

export const GetClarityInsightsSchema = z
  .object({
    propertyId: z.string().min(1).max(256),
    numOfDays: z
      .union([z.literal(1), z.literal(2), z.literal(3)], { message: "Clarity only reports the last 1, 2 or 3 days (24-72 hours). For 7, 28 or 90 days use query_gsc_performance or query_ga4_report." })
      .default(1)
      .describe("Rolling window: 1, 2 or 3 days. Clarity cannot report anything older than 72 hours."),
    dimensions: z.array(z.string().min(1).max(64)).max(3).default([]),
  })
  .strict();
export type GetClarityInsightsInput = z.infer<typeof GetClarityInsightsSchema>;

export const GetClarityQuotaStatusSchema = z
  .object({ propertyId: z.string().min(1).max(256).describe("A Clarity property id from list_clarity_projects.") })
  .strict();
export type GetClarityQuotaStatusInput = z.infer<typeof GetClarityQuotaStatusSchema>;

/** Bing reports that are documented well enough to enable. Others stay disabled until verified (see docs/BING.md). */
export const BING_REPORTS = ["traffic", "queries", "crawl"] as const;
export type BingReportKind = (typeof BING_REPORTS)[number];

export const QueryBingSchema = z
  .object({
    propertyId: z.string().min(1).max(2048).describe("A Bing site exactly as returned by list_bing_sites, e.g. https://www.example.com/."),
    report: z.enum(BING_REPORTS).describe("traffic = daily clicks and impressions; queries = search queries with clicks, impressions and positions; crawl = Bingbot crawl and index statistics."),
    startDate: isoDate.optional().describe("Keep only rows on or after this date, YYYY-MM-DD. Needs endDate."),
    endDate: isoDate.optional().describe("Keep only rows on or before this date, YYYY-MM-DD. Needs startDate."),
    lastDays: z.number().int().min(1).max(500).optional().describe("Keep only the last N calendar days up to today (UTC). Use this OR startDate+endDate, never both. Omit all three to get everything Bing returns."),
    sortBy: z.enum(["date", "clicks", "impressions"]).optional().describe("Defaults: date for traffic and crawl, clicks for queries. crawl supports date only."),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
  })
  .strict()
  .refine((v) => (v.startDate === undefined) === (v.endDate === undefined), { message: "Provide startDate and endDate together.", path: ["startDate"] })
  .refine((v) => v.lastDays === undefined || (v.startDate === undefined && v.endDate === undefined), { message: "Provide either startDate and endDate, or lastDays (not both).", path: ["lastDays"] })
  .refine((v) => v.startDate === undefined || v.endDate === undefined || v.startDate <= v.endDate, { message: "startDate must not be after endDate.", path: ["startDate"] })
  .refine((v) => v.report !== "crawl" || v.sortBy === undefined || v.sortBy === "date", { message: "crawl reports can only be sorted by date.", path: ["sortBy"] });
export type QueryBingInput = z.infer<typeof QueryBingSchema>;

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
