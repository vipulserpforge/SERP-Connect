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

export const Ga4FilterSchema = z
  .object({
    field: ga4Field,
    matchType: z.enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS"]),
    value: z.string().min(1).max(1024),
  })
  .strict();

export const Ga4MetricFilterSchema = z
  .object({
    field: ga4Field,
    operator: z.enum(["EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL"]),
    value: z.number().finite(),
  })
  .strict();

export const QueryGa4Schema = z
  .object({
    propertyId: z.string().min(1).max(64).describe("GA4 property id exactly as returned by list_ga4_properties (digits only)."),
    startDate: isoDate.optional().describe("First day, YYYY-MM-DD, in the property's reporting time zone. Needs endDate."),
    endDate: isoDate.optional().describe("Last day, YYYY-MM-DD, in the property's reporting time zone. Needs startDate."),
    lastDays: lastDays.optional(),
    dimensions: z.array(ga4Field).max(9).default(["pagePath"]).describe("GA4 API dimension names (e.g. pagePath, country, sessionDefaultChannelGroup). Call get_supported_metrics for the valid list."),
    metrics: z.array(ga4Field).min(1).max(10).default(["activeUsers"]).describe("GA4 API metric names (e.g. activeUsers, sessions, screenPageViews, eventCount, keyEvents)."),
    dimensionFilters: z.array(Ga4FilterSchema).max(10).default([]).describe("All filters must match (AND). Matching is case-insensitive."),
    metricFilters: z.array(Ga4MetricFilterSchema).max(10).default([]),
    orderBy: z
      .object({ field: ga4Field, direction: z.enum(["asc", "desc"]).default("desc") })
      .strict()
      .optional()
      .describe("Sort by one requested dimension or metric."),
    limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to return (server maximum applies)."),
    offset: z.number().int().min(0).max(100_000).default(0).describe("Rows to skip, for paging when the result says more rows are available."),
  })
  .strict()
  .refine(exactlyOneDateForm, { message: dateFormMessage, path: ["startDate"] });
export type QueryGa4Input = z.infer<typeof QueryGa4Schema>;

export const GetClarityInsightsSchema = z
  .object({
    propertyId: z.string().min(1).max(256),
    numOfDays: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
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
