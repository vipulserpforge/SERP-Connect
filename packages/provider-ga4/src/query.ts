import { ConnectorException, type QueryGa4CohortInput, type QueryGa4Input, type QueryGa4RealtimeInput, type ReportRow, type ReportWarning, type WithResolvedDates } from "@serp/contracts";
import type { Ga4CohortSpec, Ga4FieldMeta, Ga4FilterExpression, Ga4Metadata, Ga4RealtimeRequest, Ga4RunReportRequest, Ga4RunReportResponse } from "./api-client.js";

/** A request whose dates the reporting layer has already resolved (`lastDays` is gone). */
export type Ga4Query = WithResolvedDates<Omit<QueryGa4Input, "preset" | "compareTo" | "fresh">>;
export type Ga4RealtimeQuery = QueryGa4RealtimeInput & { startDate: null; endDate: null };

/** Fields the Realtime API accepts: a much smaller set than standard reports. */
export const GA4_REALTIME_DIMENSIONS = ["appVersion", "audienceId", "audienceName", "city", "cityId", "country", "countryId", "deviceCategory", "eventName", "minutesAgo", "platform", "streamId", "streamName", "unifiedPagePathScreen", "unifiedScreenClass", "unifiedScreenName"] as const;
export const GA4_REALTIME_METRICS = ["activeUsers", "conversions", "eventCount", "keyEvents", "screenPageViews"] as const;

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

  for (const f of query.dimensionFilters) {
    if ((f.matchType === "FULL_REGEXP" || f.matchType === "PARTIAL_REGEXP") && f.value !== undefined) {
      try {
        new RegExp(f.value);
      } catch {
        throw new ConnectorException("INVALID_QUERY", `The regular expression for "${f.field}" is not valid: ${f.value}`, { provider: "ga4", suggestedAction: "GA4 uses RE2 syntax: no lookaheads or backreferences. Simplify the pattern or use CONTAINS." });
      }
    }
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

type DimFilter = QueryGa4Input["dimensionFilters"][number];

/** One filter as a tree node; `exclude` wraps it in NOT. */
function dimensionLeaf(f: DimFilter): Ga4FilterExpression {
  const leaf: Ga4FilterExpression =
    f.matchType === "IN_LIST"
      ? { filter: { fieldName: f.field, inListFilter: { values: f.values ?? [], caseSensitive: false } } }
      : { filter: { fieldName: f.field, stringFilter: { matchType: f.matchType, value: f.value ?? "", caseSensitive: false } } };
  return f.exclude ? { notExpression: leaf } : leaf;
}

const joinFilters = (parts: Ga4FilterExpression[], mode: "and" | "or"): Ga4FilterExpression => (parts.length === 1 ? parts[0]! : mode === "or" ? { orGroup: { expressions: parts } } : { andGroup: { expressions: parts } });

export function buildDimensionFilter(filters: readonly DimFilter[], mode: "and" | "or"): Ga4FilterExpression | undefined {
  return filters.length > 0 ? joinFilters(filters.map(dimensionLeaf), mode) : undefined;
}

export function buildRunReportRequest(query: Ga4Query): Ga4RunReportRequest {
  const dimensionFilter = buildDimensionFilter(query.dimensionFilters, query.filterMode);
  const metricLeaves: Ga4FilterExpression[] = query.metricFilters.map((f) => ({ filter: { fieldName: f.field, numericFilter: { operation: f.operator, value: { doubleValue: f.value } } } }));

  // Always ask for an explicit order so results never depend on an API default.
  const orderField = query.orderBy?.field ?? query.metrics[0]!;
  const desc = (query.orderBy?.direction ?? "desc") === "desc";
  const isDimension = query.dimensions.includes(orderField);
  return {
    dateRanges: [{ startDate: query.startDate, endDate: query.endDate }],
    dimensions: query.dimensions.map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    ...(dimensionFilter && { dimensionFilter }),
    ...(metricLeaves.length > 0 && { metricFilter: joinFilters(metricLeaves, query.filterMode) }),
    orderBys: [isDimension ? { desc, dimension: { dimensionName: orderField, orderType: "ALPHANUMERIC" as const } } : { desc, metric: { metricName: orderField } }],
    limit: String(query.limit),
    offset: String(query.offset),
    metricAggregations: ["TOTAL"],
    returnPropertyQuota: true,
  };
}

export function validateGa4RealtimeFields(query: Pick<Ga4RealtimeQuery, "dimensions" | "metrics" | "dimensionFilters">): void {
  const bad = [
    ...query.dimensions.filter((d) => !(GA4_REALTIME_DIMENSIONS as readonly string[]).includes(d)).map((d) => `dimension "${d}"`),
    ...query.dimensionFilters.map((f) => f.field).filter((d) => !(GA4_REALTIME_DIMENSIONS as readonly string[]).includes(d)).map((d) => `filter field "${d}"`),
    ...query.metrics.filter((m) => !(GA4_REALTIME_METRICS as readonly string[]).includes(m)).map((m) => `metric "${m}"`),
  ];
  if (new Set(query.dimensions).size !== query.dimensions.length || new Set(query.metrics).size !== query.metrics.length) throw fail("Fields must not repeat.");
  if (bad.length > 0) {
    throw fail(
      `Realtime reports do not support: ${[...new Set(bad)].join(", ")}.`,
      `Realtime dimensions: ${GA4_REALTIME_DIMENSIONS.join(", ")}. Realtime metrics: ${GA4_REALTIME_METRICS.join(", ")}. For anything else use query_ga4_report.`,
    );
  }
}

export function buildRealtimeRequest(query: Ga4RealtimeQuery): Ga4RealtimeRequest {
  const dimensionFilter = buildDimensionFilter(query.dimensionFilters, "and");
  return {
    dimensions: query.dimensions.map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    ...(dimensionFilter && { dimensionFilter }),
    minuteRanges: [{ startMinutesAgo: query.minutes - 1, endMinutesAgo: 0 }],
    orderBys: [{ desc: true, metric: { metricName: query.metrics[0]! } }],
    limit: String(query.limit),
    metricAggregations: ["TOTAL"],
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
  /** Whole-range totals by metric for the same filters (GA4 computes distinct users correctly here, unlike a sum of rows). */
  totals: Record<string, number | null> | null;
}

export function normalizeGa4Response(query: Pick<Ga4Query, "dimensions" | "metrics" | "offset" | "limit">, response: Ga4RunReportResponse, storedTimeZone: string | null): NormalizedGa4 {
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
  const notSet = rows.filter((r) => dimNames.some((d) => r[d] === "(not set)")).length;
  if (notSet > 0) {
    warnings.push({ code: "NOT_SET_VALUES", message: `${notSet} row(s) have "(not set)": GA4 did not record that value (for example missing tagging or consent). They are real traffic, just unlabeled.` });
  }
  if (rows.some((r) => dimNames.some((d) => r[d] === "(other)"))) {
    warnings.push({ code: "OTHER_ROW_PRESENT", message: 'A row labeled "(other)" combines many small values GA4 could not list separately. Narrow the date range or add a filter to see them.' });
  }
  if (rows.length > 1 && query.metrics.some((m) => UNIQUE_METRICS.has(m)) && response.totals === null) {
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

  const totals = response.totals ? Object.fromEntries(metNames.map((m, i) => [m, metricValue(response.totals![i] ?? "", metricTypes[m] ?? "TYPE_INTEGER") as number | null])) : null;
  if (rows.length > 1 && query.metrics.some((m) => UNIQUE_METRICS.has(m)) && response.totals !== null) {
    warnings.push({ code: "UNIQUE_METRICS_NOT_ADDITIVE", message: "User counts in the rows are distinct per row and will not add up to the total (people appear in several rows). Use the totals line for the overall figure." });
  }

  return {
    rows,
    warnings,
    completeness,
    timeZone,
    totals,
    providerMetadata: {
      timeZone,
      currencyCode: response.currencyCode,
      metricTypes,
      pagination: { offset: query.offset, limit: query.limit, rowCount: total, nextOffset },
      quota: response.quota,
    },
  };
}

// ---- plain-language presentation -------------------------------------------------------

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** Formats a value the way a reader expects: rates as percentages, durations in seconds, money with its currency. */
export function formatGa4Value(name: string, type: string | undefined, v: number | string | null, currency?: string | null): string {
  if (v === null || typeof v === "string") return v === null ? "n/a" : v;
  if (type === "TYPE_FLOAT" && /(rate|perMau|perWau)$/i.test(name)) return `${(v * 100).toFixed(1)}%`;
  if (type === "TYPE_SECONDS") return `${num(Math.round(v))}s`;
  if (type === "TYPE_CURRENCY") return `${currency ? `${currency} ` : ""}${num(Math.round(v * 100) / 100)}`;
  return num(v);
}

export interface Ga4SummaryInput {
  propertyName: string;
  rows: ReportRow[];
  totals: Record<string, number | null> | null;
  dimensions: string[];
  metrics: string[];
  labels: Record<string, string>;
  types: Record<string, string>;
  currency: string | null;
  rowCount: number | null;
  startDate: string | null;
  endDate: string | null;
  scope?: string;
}

export function buildGa4Summary(i: Ga4SummaryInput): string {
  const label = (n: string) => i.labels[n] ?? n;
  const where = i.startDate && i.endDate ? ` from ${i.startDate} to ${i.endDate}` : "";
  if (i.rows.length === 0) return `${i.propertyName}: GA4 returned no rows${where}.`;
  const totalLine = i.totals ? ` Totals: ${i.metrics.map((m) => `${label(m)} ${formatGa4Value(m, i.types[m], i.totals![m] ?? null, i.currency)}`).join(", ")}.` : "";
  const top = i.rows[0]!;
  const first = i.metrics[0]!;
  const topName = i.dimensions.map((d) => String(top[d])).join(" / ");
  const topLine = i.dimensions.length > 0 && !i.dimensions.includes("date") ? ` Top row: ${topName} (${label(first)} ${formatGa4Value(first, i.types[first], top[first] ?? null, i.currency)}).` : "";
  return `${i.propertyName}: ${i.rowCount ?? i.rows.length} row(s)${where}${i.scope ? ` (${i.scope})` : ""}.${totalLine}${topLine}`;
}

// ---- cohort retention -------------------------------------------------------------------

export type Ga4CohortQuery = QueryGa4CohortInput & {
  /** Calendar ranges of the cohorts, oldest first. Planned by the reporting layer from the property's own date. */
  ranges: Array<{ name: string; startDate: string; endDate: string }>;
  /** Earliest and latest cohort date, so the cohort query has the same period fields as every other report. */
  startDate: string;
  endDate: string;
};

/** Today's calendar date in a time zone (the property's own, falling back to UTC). */
export function todayInZone(now: Date, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const day = (iso: string, delta: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/**
 * The most recent COMPLETE cohorts, oldest first. GA4 wants weekly cohorts to run Sunday to Saturday and monthly ones to cover a
 * whole calendar month. `today` is the date in the property's own time zone; today itself is never in a cohort (still filling).
 */
export function planCohorts(granularity: Ga4CohortQuery["granularity"], count: number, today: string): Ga4CohortQuery["ranges"] {
  const out: Ga4CohortQuery["ranges"] = [];
  if (granularity === "DAILY") {
    for (let k = count; k >= 1; k--) out.push({ name: day(today, -k), startDate: day(today, -k), endDate: day(today, -k) });
  } else if (granularity === "WEEKLY") {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    const lastSaturday = day(today, -(((dow + 1) % 7) || 7));
    for (let k = count - 1; k >= 0; k--) {
      const end = day(lastSaturday, -7 * k);
      out.push({ name: `week of ${day(end, -6)}`, startDate: day(end, -6), endDate: end });
    }
  } else {
    const [y, m] = today.split("-").map(Number) as [number, number];
    for (let k = count; k >= 1; k--) {
      const first = new Date(Date.UTC(y, m - 1 - k, 1));
      const last = new Date(Date.UTC(y, m - k, 0));
      out.push({ name: first.toISOString().slice(0, 7), startDate: first.toISOString().slice(0, 10), endDate: last.toISOString().slice(0, 10) });
    }
  }
  return out;
}

const NTH = { DAILY: "cohortNthDay", WEEKLY: "cohortNthWeek", MONTHLY: "cohortNthMonth" } as const;

export function buildCohortRequest(query: Ga4CohortQuery): Ga4RunReportRequest {
  const dimensionFilter = buildDimensionFilter(query.dimensionFilters, "and");
  const cohortSpec: Ga4CohortSpec = {
    cohorts: query.ranges.map((r) => ({ name: r.name, dimension: "firstSessionDate", dateRange: { startDate: r.startDate, endDate: r.endDate } })),
    cohortsRange: { granularity: query.granularity, startOffset: 0, endOffset: query.periods - 1 },
  };
  return {
    cohortSpec,
    dimensions: [{ name: "cohort" }, { name: NTH[query.granularity] }],
    metrics: [{ name: query.metric }],
    ...(dimensionFilter && { dimensionFilter }),
    orderBys: [{ desc: false, dimension: { dimensionName: "cohort", orderType: "ALPHANUMERIC" } }],
    limit: "1000",
    offset: "0",
    returnPropertyQuota: true,
  };
}

export interface NormalizedCohort {
  rows: ReportRow[];
  warnings: ReportWarning[];
  /** Average share of the first period's users still active in each later period, by period number. */
  averageRetention: Record<number, number>;
}

/** Turns Google's cohort rows into one row per cohort and period, with the share still active compared with period 0. */
export function normalizeCohortResponse(query: Ga4CohortQuery, response: Ga4RunReportResponse, today: string): NormalizedCohort {
  const warnings: ReportWarning[] = [];
  const unit = query.granularity === "DAILY" ? "day" : query.granularity === "WEEKLY" ? "week" : "month";
  const parsed = response.rows.map((r) => ({ cohort: r.dimensions[0] ?? "", period: Number(r.dimensions[1] ?? 0), value: Number(r.metrics[0] ?? 0) }));
  const base = new Map(parsed.filter((p) => p.period === 0).map((p) => [p.cohort, p.value]));
  const canShare = query.metric === "cohortActiveUsers";
  const rows: ReportRow[] = parsed
    .sort((a, b) => a.cohort.localeCompare(b.cohort) || a.period - b.period)
    .map((p) => {
      const first = base.get(p.cohort) ?? 0;
      return { cohort: p.cohort, [unit]: p.period, [query.metric]: p.value, ...(canShare && { retentionPct: first > 0 ? Math.round((p.value / first) * 1000) / 10 : null }) };
    });

  const sums = new Map<number, { total: number; n: number }>();
  if (canShare) {
    for (const r of rows) {
      const pct = r.retentionPct;
      if (typeof pct !== "number") continue;
      const e = sums.get(Number(r[unit])) ?? { total: 0, n: 0 };
      e.total += pct;
      e.n += 1;
      sums.set(Number(r[unit]), e);
    }
  }
  const averageRetention = Object.fromEntries([...sums].map(([k, v]) => [k, Math.round((v.total / v.n) * 10) / 10]));

  if (rows.length === 0) warnings.push({ code: "NO_DATA", message: "GA4 returned no cohort rows. The cohorts may have no first-time visitors, or the property is too new." });
  // A cohort cannot have reached a period that has not finished yet.
  const periodDays = query.granularity === "DAILY" ? 1 : query.granularity === "WEEKLY" ? 7 : 30;
  const young = query.ranges.filter((r) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.endDate}T00:00:00Z`)) / 86_400_000 < periodDays * (query.periods - 1));
  if (young.length > 0) warnings.push({ code: "COHORTS_STILL_MATURING", message: `The ${young.length} most recent cohort(s) have not yet lived through all ${query.periods} ${unit}s, so their later periods are incomplete, not low retention.` });
  if (response.subjectToThresholding) warnings.push({ code: "THRESHOLDING_APPLIED", message: "GA4 applied data thresholds to protect user privacy, so small cohorts may be withheld." });
  return { rows, warnings, averageRetention };
}
