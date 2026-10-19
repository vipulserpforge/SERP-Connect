import { ConnectorException, type QueryGa4Input, type ReportRow, type ReportWarning, type WithResolvedDates } from "@serp/contracts";
import type { Ga4FieldMeta, Ga4Filter, Ga4Metadata, Ga4RunReportRequest, Ga4RunReportResponse } from "./api-client.js";

/** A request whose dates the reporting layer has already resolved (`lastDays` is gone). */
export type Ga4Query = WithResolvedDates<QueryGa4Input>;

/** GA4 reporting began on this date; the Data API rejects earlier start dates. */
export const GA4_EARLIEST_START_DATE = "2015-08-14";

/** Starter lists used only for documentation and offline checks. Live validation uses the property's own metadata. */
export const GA4_DIMENSIONS = ["date", "pagePath", "pageTitle", "landingPage", "country", "city", "deviceCategory", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium", "eventName"] as const;
export const GA4_METRICS = ["activeUsers", "totalUsers", "newUsers", "sessions", "engagedSessions", "engagementRate", "screenPageViews", "eventCount", "keyEvents", "conversions"] as const;

/** Metrics that count distinct people: summing them across rows over-counts. */
const UNIQUE_METRICS = new Set(["activeUsers", "totalUsers", "newUsers", "returningUsers"]);

const fail = (message: string, suggestedAction?: string) =>
  new ConnectorException("DIMENSION_METRIC_INCOMPATIBLE", message, { provider: "ga4", ...(suggestedAction && { suggestedAction }) });

// ---- field validation against property metadata ---------------------------------------

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function suggest(name: string, known: Ga4FieldMeta[]): string[] {
  const lower = name.toLowerCase();
  return known
    .map((f) => ({ n: f.apiName, d: distance(lower, f.apiName.toLowerCase()) - (f.apiName.toLowerCase().includes(lower) ? 3 : 0) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.n);
}

/** Unknown names, names used on the wrong side, and deprecated aliases all fail with a precise message. */
export function validateGa4Fields(query: Pick<Ga4Query, "dimensions" | "metrics" | "orderBy" | "dimensionFilters" | "metricFilters">, metadata: Ga4Metadata): void {
  if (new Set(query.dimensions).size !== query.dimensions.length) throw fail("Dimensions must not repeat.");
  if (new Set(query.metrics).size !== query.metrics.length) throw fail("Metrics must not repeat.");
  const dims = new Map(metadata.dimensions.map((d) => [d.apiName, d]));
  const mets = new Map(metadata.metrics.map((m) => [m.apiName, m]));
  const problems: string[] = [];

  const check = (name: string, kind: "dimension" | "metric") => {
    const own = kind === "dimension" ? dims : mets;
    const other = kind === "dimension" ? mets : dims;
    if (own.has(name)) return;
    const replacement = [...own.values()].find((f) => f.deprecatedApiNames.includes(name));
    if (replacement) problems.push(`"${name}" is deprecated; use "${replacement.apiName}"`);
    else if (other.has(name)) problems.push(`"${name}" is a ${kind === "dimension" ? "metric" : "dimension"}, not a ${kind}`);
    else {
      const hints = suggest(name, [...own.values()]);
      problems.push(`unknown ${kind} "${name}"${hints.length ? ` (did you mean ${hints.map((h) => `"${h}"`).join(", ")}?)` : ""}`);
    }
  };
  query.dimensions.forEach((d) => check(d, "dimension"));
  query.metrics.forEach((m) => check(m, "metric"));
  query.dimensionFilters.forEach((f) => check(f.field, "dimension"));
  query.metricFilters.forEach((f) => check(f.field, "metric"));
  if (problems.length > 0) {
    throw fail(`Unsupported GA4 field(s) for this property: ${[...new Set(problems)].slice(0, 8).join("; ")}.`, "Use get_supported_metrics with this propertyId to see the valid fields.");
  }

  const order = query.orderBy?.field;
  if (order && !query.dimensions.includes(order) && !query.metrics.includes(order)) {
    throw new ConnectorException("INVALID_QUERY", `orderBy "${order}" must be one of the requested dimensions or metrics.`, { provider: "ga4" });
  }
}

export function describeIncompatibility(incompatibleDimensions: string[], incompatibleMetrics: string[]): ConnectorException {
  const names = [...incompatibleDimensions.map((d) => `${d} (dimension)`), ...incompatibleMetrics.map((m) => `${m} (metric)`)];
  return fail(
    `GA4 cannot combine these fields with the rest of the request: ${names.join(", ")}.`,
    "Remove one of the listed fields, or run them as separate reports.",
  );
}

// ---- request building -------------------------------------------------------------------

export function buildRunReportRequest(query: Ga4Query): Ga4RunReportRequest {
  const dimFilters: Ga4Filter[] = query.dimensionFilters.map((f) => ({
    filter: { fieldName: f.field, stringFilter: { matchType: f.matchType, value: f.value, caseSensitive: false } },
  }));
  const metricFilters: Ga4Filter[] = query.metricFilters.map((f) => ({
    filter: { fieldName: f.field, numericFilter: { operation: f.operator, value: { doubleValue: f.value } } },
  }));
  const expression = (parts: Ga4Filter[]) => (parts.length === 1 ? { filter: parts[0]!.filter } : { andGroup: { expressions: parts } });

  // Always ask for an explicit order so results never depend on an API default.
  const orderField = query.orderBy?.field ?? query.metrics[0]!;
  const desc = (query.orderBy?.direction ?? "desc") === "desc";
  const isDimension = query.dimensions.includes(orderField);
  return {
    dateRanges: [{ startDate: query.startDate, endDate: query.endDate }],
    dimensions: query.dimensions.map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    ...(dimFilters.length > 0 && { dimensionFilter: expression(dimFilters) }),
    ...(metricFilters.length > 0 && { metricFilter: expression(metricFilters) }),
    orderBys: [isDimension ? { desc, dimension: { dimensionName: orderField, orderType: "ALPHANUMERIC" as const } } : { desc, metric: { metricName: orderField } }],
    limit: String(query.limit),
    offset: String(query.offset),
    returnPropertyQuota: true,
  };
}

// ---- normalization ----------------------------------------------------------------------

const NUMERIC_TYPES = /^TYPE_(INTEGER|FLOAT|SECONDS|MILLISECONDS|MINUTES|HOURS|STANDARD|CURRENCY|FEET|MILES|METERS|KILOMETERS)$/;

function metricValue(raw: string, type: string): string | number | null {
  if (raw === "") return null;
  if (!NUMERIC_TYPES.test(type)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** GA4 reports dates as YYYYMMDD. */
function dimensionValue(name: string, raw: string): string {
  return name === "date" && /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
}

export interface NormalizedGa4 {
  rows: ReportRow[];
  warnings: ReportWarning[];
  completeness: "complete" | "unknown_or_provider_limited" | "partial";
  providerMetadata: Record<string, unknown>;
  timeZone: string | null;
}

export function normalizeGa4Response(query: Ga4Query, response: Ga4RunReportResponse, storedTimeZone: string | null): NormalizedGa4 {
  const warnings: ReportWarning[] = [];
  let completeness: NormalizedGa4["completeness"] = "complete";
  const metricTypes = Object.fromEntries(response.metricHeaders.map((h) => [h.name, h.type]));
  const dimNames = response.dimensionHeaders.length === query.dimensions.length ? response.dimensionHeaders : query.dimensions;
  const metNames = response.metricHeaders.length === query.metrics.length ? response.metricHeaders.map((h) => h.name) : query.metrics;

  const rows: ReportRow[] = response.rows.map((r) => {
    const row: ReportRow = {};
    dimNames.forEach((d, i) => (row[d] = dimensionValue(d, r.dimensions[i] ?? "")));
    metNames.forEach((m, i) => (row[m] = metricValue(r.metrics[i] ?? "", metricTypes[m] ?? "TYPE_INTEGER")));
    return row;
  });

  const total = response.rowCount;
  const nextOffset = total !== null && query.offset + rows.length < total ? query.offset + rows.length : null;
  if (rows.length === 0) {
    warnings.push({ code: "NO_DATA", message: "GA4 returned no rows. The period may have no traffic, the filters may match nothing, or recent data may still be processing." });
  }
  if (nextOffset !== null) {
    completeness = "partial";
    warnings.push({ code: "MORE_ROWS_AVAILABLE", message: `GA4 has ${total} rows for this query; this response holds ${rows.length}. Request offset ${nextOffset} for the next page.` });
  }
  if (response.subjectToThresholding) {
    completeness = "partial";
    warnings.push({ code: "THRESHOLDING_APPLIED", message: "GA4 applied data thresholds to protect user privacy, so some rows may be withheld." });
  }
  if (response.dataLossFromOtherRow) {
    completeness = "partial";
    warnings.push({ code: "OTHER_ROW_AGGREGATION", message: 'Some values were grouped into an "(other)" row because the report has too many unique values. Narrow the date range or add filters.' });
  }
  if (response.sampling.length > 0) {
    completeness = "partial";
    const ratios = response.sampling.map((s) => {
      const read = Number(s.samplesReadCount);
      const space = Number(s.samplingSpaceSize);
      return read > 0 && space > 0 ? `${Math.round((read / space) * 100)}%` : "unknown";
    });
    warnings.push({ code: "SAMPLED_DATA", message: `GA4 sampled this data (${ratios.join(", ")} of events read), so figures are estimates.` });
  }
  if (response.restrictedMetrics.length > 0) {
    warnings.push({ code: "RESTRICTED_METRICS", message: `The connected account may not see these metrics because of access restrictions: ${response.restrictedMetrics.join(", ")}. Their values can be missing.` });
  }
  if (rows.length > 1 && query.metrics.some((m) => UNIQUE_METRICS.has(m))) {
    warnings.push({ code: "UNIQUE_METRICS_NOT_ADDITIVE", message: "User counts are distinct per row; adding them across rows over-counts people who appear in several rows." });
  }

  const quotaLow = Object.entries(response.quota).filter(([, q]) => q.consumed !== null && q.remaining !== null && q.remaining + q.consumed > 0 && q.remaining / (q.remaining + q.consumed) < 0.1);
  if (quotaLow.length > 0) {
    warnings.push({ code: "LOW_QUOTA", message: `GA4 quota is running low (${quotaLow.map(([k]) => k).join(", ")}). Space out or narrow further reports.` });
  }

  const timeZone = response.timeZone ?? storedTimeZone;
  if (response.timeZone && storedTimeZone && response.timeZone !== storedTimeZone) {
    warnings.push({ code: "TIMEZONE_CHANGED", message: `GA4 reports this property in ${response.timeZone}, but ${storedTimeZone} was stored earlier. Dates follow ${response.timeZone}; refresh the property list.` });
  }

  return {
    rows,
    warnings,
    completeness,
    timeZone,
    providerMetadata: {
      timeZone,
      currencyCode: response.currencyCode,
      metricTypes,
      pagination: { offset: query.offset, limit: query.limit, rowCount: total, nextOffset },
      quota: response.quota,
    },
  };
}
