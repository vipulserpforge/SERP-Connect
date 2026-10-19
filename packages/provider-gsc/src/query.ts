import { ConnectorException, type GscFilter, type QueryGscInput, type ReportRow, type ReportWarning, type WithResolvedDates } from "@serp/contracts";
import type { SearchAnalyticsRequest, SearchAnalyticsResponse } from "./api-client.js";

/** A request whose dates the reporting layer has already resolved (`lastDays` is gone). */
export type GscQuery = WithResolvedDates<QueryGscInput>;

export const GSC_DATE_SEMANTICS = "Google Search Console reporting date (Pacific Time)";
export const GSC_METRICS = ["clicks", "impressions", "ctr", "position"] as const;
export const GSC_DIMENSIONS = ["date", "page", "query", "country", "device", "searchAppearance"] as const;
/** Largest page the API accepts. */
export const GSC_MAX_ROW_LIMIT = 25_000;

const DEVICES = new Set(["DESKTOP", "MOBILE", "TABLET"]);
const REGEX_DIMENSIONS = new Set(["page", "query"]);
const SUBSTRING_DIMENSIONS = new Set(["page", "query"]);
// Google evaluates filters with RE2: no lookaround and no backreferences.
const NON_RE2 = /\(\?<?[=!]|\\[1-9]|\(\?P?<|\(\?>/;

const bad = (message: string, suggestedAction?: string) =>
  new ConnectorException("INVALID_QUERY", message, { provider: "gsc", ...(suggestedAction && { suggestedAction }) });

function normalizeFilter(f: GscFilter): GscFilter {
  const regex = f.operator === "includingRegex" || f.operator === "excludingRegex";
  const contains = f.operator === "contains" || f.operator === "notContains";
  if (regex) {
    if (!REGEX_DIMENSIONS.has(f.dimension)) throw bad(`Regex filters are only supported on page and query, not ${f.dimension}.`);
    if (NON_RE2.test(f.expression)) throw bad("Regex filters use RE2 syntax: lookaround and backreferences are not supported.");
    try {
      new RegExp(f.expression);
    } catch {
      throw bad("The regex filter is not a valid expression.");
    }
  }
  if (contains && !SUBSTRING_DIMENSIONS.has(f.dimension)) {
    throw bad(`"${f.operator}" is only supported on page and query; use equals or notEquals for ${f.dimension}.`);
  }
  if (f.dimension === "country") {
    if (!/^[A-Za-z]{3}$/.test(f.expression)) throw bad("Country filters take an ISO 3166-1 alpha-3 code such as USA or GBR.");
    return { ...f, expression: f.expression.toUpperCase() };
  }
  if (f.dimension === "device") {
    const v = f.expression.toUpperCase();
    if (!DEVICES.has(v)) throw bad("Device filters must be DESKTOP, MOBILE or TABLET.");
    return { ...f, expression: v };
  }
  return f;
}

export interface GscPlan {
  request: SearchAnalyticsRequest;
  /** True when Google's own ordering cannot answer the question, so we fetch a large page and sort here. */
  fullFetch: boolean;
}

/** Validates dimension/filter combinations Search Console rejects or silently mishandles. */
export function planGscQuery(query: GscQuery): GscPlan {
  if (!query.startDate || !query.endDate) throw bad("Dates must be resolved before querying Search Console.");
  const dims = query.dimensions;
  if (new Set(dims).size !== dims.length) throw bad("Dimensions must not repeat.");
  if (dims.includes("searchAppearance") && dims.length > 1) {
    throw bad(
      "searchAppearance cannot be combined with other dimensions.",
      "Query searchAppearance on its own, then filter by one appearance value to break it down further.",
    );
  }
  if (query.type === "discover" || query.type === "googleNews") {
    const unsupported = [...dims, ...query.filters.map((f) => f.dimension)].filter((d) => d === "query");
    if (unsupported.length > 0) throw bad(`${query.type} data has no search queries; remove the "query" dimension or filter.`);
  }
  const filters = query.filters.map(normalizeFilter);

  // Google returns rows ordered by clicks (descending), or by date when grouped by date. Any other order
  // needs more rows than the caller asked for, otherwise "top N by impressions" would be wrong.
  const fullFetch = query.sortBy !== "clicks" || query.sortDirection !== "desc" || dims.includes("date");
  return {
    fullFetch,
    request: {
      startDate: query.startDate,
      endDate: query.endDate,
      dimensions: [...dims],
      searchType: query.type,
      ...(filters.length > 0 && { dimensionFilterGroups: [{ groupType: "and" as const, filters }] }),
      rowLimit: fullFetch ? GSC_MAX_ROW_LIMIT : query.limit,
      startRow: 0,
      dataState: query.dataState,
    },
  };
}

const round = (n: number, places: number) => Number(n.toFixed(places));

export interface NormalizedGsc {
  rows: ReportRow[];
  warnings: ReportWarning[];
  completeness: "complete" | "unknown_or_provider_limited" | "partial";
}

/** Maps Google's positional `keys` onto named dimensions, applies the requested order, and reports gaps. */
export function normalizeGscResponse(query: GscQuery, plan: GscPlan, response: SearchAnalyticsResponse): NormalizedGsc {
  const warnings: ReportWarning[] = [];
  let completeness: NormalizedGsc["completeness"] = "unknown_or_provider_limited";

  let rows: ReportRow[] = response.rows.map((r) => {
    const row: ReportRow = {};
    query.dimensions.forEach((dim, i) => {
      row[dim] = r.keys[i] ?? "";
    });
    // Rounded for readability only; clicks and impressions are exact.
    return { ...row, clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position, 2) };
  });

  const fetched = rows.length;
  const dir = query.sortDirection === "asc" ? 1 : -1;
  const keyOf = (r: ReportRow) => query.dimensions.map((d) => String(r[d])).join("\u0000");
  rows.sort((a, b) => dir * (Number(a[query.sortBy]) - Number(b[query.sortBy])) || Number(b.clicks) - Number(a.clicks) || keyOf(a).localeCompare(keyOf(b)));
  rows = rows.slice(0, query.limit);

  if (fetched === 0) {
    warnings.push({
      code: "NO_DATA",
      message: "Search Console returned no rows. The period may have no traffic, the filters may match nothing, or the days may not be finalized yet.",
    });
  } else if (plan.fullFetch && fetched >= GSC_MAX_ROW_LIMIT) {
    completeness = "partial";
    warnings.push({
      code: "SORT_LIMITED_TO_FETCHED_ROWS",
      message: `Google returned its maximum of ${GSC_MAX_ROW_LIMIT} rows (ordered by clicks); the requested order was applied to those rows only, so rows beyond them are not ranked.`,
    });
  } else if (!plan.fullFetch && fetched >= plan.request.rowLimit) {
    warnings.push({ code: "ROW_LIMIT_REACHED", message: "The row limit was reached; more rows may exist. Narrow the query or raise the limit." });
  }

  if (query.dimensions.includes("query")) {
    warnings.push({
      code: "ANONYMIZED_QUERIES_OMITTED",
      message: "Google omits anonymized (rare) queries when grouping by query, so row totals can be lower than the property's overall totals.",
    });
  }
  if (response.responseAggregationType === "byPage") {
    warnings.push({
      code: "AGGREGATION_BY_PAGE",
      message: "Google aggregated this report by page: impressions and position are counted per URL and will not match property-level totals.",
    });
  }
  if (query.dataState === "all") {
    warnings.push({ code: "FRESH_DATA_INCLUDED", message: "Fresh, not-yet-finalized data was requested; recent days may still change." });
    if (response.firstIncompleteDate && response.firstIncompleteDate <= query.endDate) {
      completeness = "partial";
      warnings.push({
        code: "INCOMPLETE_DATA_FROM",
        message: `Data from ${response.firstIncompleteDate} onward is incomplete according to Google.`,
      });
    }
  }
  return { rows, warnings, completeness };
}
