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
      startRow: fullFetch ? 0 : query.offset,
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
/** Strips `#fragment` from a URL: `/page/#elementor-toc__heading-anchor-0` and `/page/` are the same page. */
export function stripUrlFragment(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Merges rows whose `page` differs only by a #fragment (e.g. Elementor table-of-contents anchors) into one row.
 * Clicks and impressions add up; CTR is recomputed and position is the impression-weighted mean.
 * Returns how many rows were folded away so the caller can say so.
 */
export function mergeFragmentDuplicates(rows: ReportRow[], dimensions: readonly string[]): { rows: ReportRow[]; merged: number } {
  if (!dimensions.includes("page")) return { rows, merged: 0 };
  const groups = new Map<string, { row: ReportRow; clicks: number; impressions: number; posWeighted: number; n: number }>();
  for (const r of rows) {
    const clean: ReportRow = { ...r, page: stripUrlFragment(String(r.page)) };
    const key = dimensions.map((d) => String(clean[d])).join("\u0000");
    const clicks = Number(r.clicks);
    const impressions = Number(r.impressions);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { row: clean, clicks, impressions, posWeighted: Number(r.position) * impressions, n: 1 });
    } else {
      g.clicks += clicks;
      g.impressions += impressions;
      g.posWeighted += Number(r.position) * impressions;
      g.n++;
    }
  }
  if (groups.size === rows.length) return { rows: rows.map((r) => ({ ...r, page: stripUrlFragment(String(r.page)) })), merged: 0 };
  const out = [...groups.values()].map((g) => ({
    ...g.row,
    clicks: g.clicks,
    impressions: g.impressions,
    ctr: round(g.impressions > 0 ? g.clicks / g.impressions : 0, 4),
    position: round(g.impressions > 0 ? g.posWeighted / g.impressions : Number(g.row.position), 2),
  }));
  return { rows: out, merged: rows.length - out.length };
}

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
  const dedupe = mergeFragmentDuplicates(rows, query.dimensions);
  rows = dedupe.rows;
  if (dedupe.merged > 0) {
    warnings.push({
      code: "URL_ANCHOR_DUPLICATES_MERGED",
      message: `${dedupe.merged} row(s) pointed at the same page with a #fragment (for example #elementor-toc anchors). They were merged into the page without the fragment: clicks and impressions are summed, position is impression-weighted.`,
    });
  }
  const dir = query.sortDirection === "asc" ? 1 : -1;
  const keyOf = (r: ReportRow) => query.dimensions.map((d) => String(r[d])).join("\u0000");
  rows.sort((a, b) => dir * (Number(a[query.sortBy]) - Number(b[query.sortBy])) || Number(b.clicks) - Number(a.clicks) || keyOf(a).localeCompare(keyOf(b)));
  const sortedCount = rows.length;
  // With fullFetch Google's page always starts at 0 and we page locally; otherwise Google already skipped `offset` rows.
  rows = plan.fullFetch ? rows.slice(query.offset, query.offset + query.limit) : rows.slice(0, query.limit);

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
    warnings.push({ code: "ROW_LIMIT_REACHED", message: `The row limit was reached; more rows may exist. Ask for the next page with offset=${query.offset + query.limit}, or narrow the query.` });
  }
  if (plan.fullFetch && sortedCount > query.offset + query.limit) {
    warnings.push({ code: "MORE_ROWS_AVAILABLE", message: `${sortedCount - query.offset - query.limit} more row(s) exist beyond this page. Ask for the next page with offset=${query.offset + query.limit}.` });
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

export interface GscTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const DIM_LABEL: Record<string, string> = { page: "page", query: "search query", country: "country", device: "device", date: "day", searchAppearance: "search appearance" };
const fmt = (n: number) => n.toLocaleString("en-US");

/** A short plain-language reading of the result, from the rows and totals actually returned. */
export function buildGscSummary(query: GscQuery, rows: ReportRow[], totals: GscTotals | null): { summary: string; nextStep: string } {
  if (rows.length === 0) {
    return {
      summary: `Search Console reported no data for ${query.startDate} to ${query.endDate} with these filters.`,
      nextStep: "Widen the date range or remove a filter, then ask again.",
    };
  }
  const parts: string[] = [];
  if (totals) {
    parts.push(`From ${query.startDate} to ${query.endDate} the site got ${fmt(totals.clicks)} clicks from ${fmt(totals.impressions)} impressions (click-through rate ${(totals.ctr * 100).toFixed(1)}%, average position ${totals.position.toFixed(1)}).`);
  } else {
    parts.push(`From ${query.startDate} to ${query.endDate}, ${rows.length} row(s) are shown.`);
  }
  const dim = query.dimensions.find((d) => d !== "date");
  const top = [...rows].sort((a, b) => Number(b.clicks) - Number(a.clicks))[0]!;
  if (dim && String(top[dim] ?? "") !== "") {
    const share = totals && totals.clicks > 0 ? ` (${Math.round((Number(top.clicks) / totals.clicks) * 100)}% of all clicks)` : "";
    parts.push(`The ${DIM_LABEL[dim] ?? dim} with the most clicks is ${String(top[dim])}, with ${fmt(Number(top.clicks))}${share}.`);
  } else if (query.dimensions.includes("date")) {
    parts.push(`The best day was ${String(top.date)} with ${fmt(Number(top.clicks))} clicks.`);
  }
  const nextStep = dim === "page" ? "Pick a page and ask which queries bring it traffic." : dim === "query" ? "Ask which pages rank for the top query, or compare with the previous period." : "Compare with the previous period (compareTo) to see what changed.";
  return { summary: parts.join(" "), nextStep };
}
