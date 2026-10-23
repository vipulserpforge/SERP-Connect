import { createHash } from "node:crypto";
import { ConnectorException, type GscFilter, type ProviderKey, type QueryGa4Input, type QueryGscInput, type ReportWarning, type WithResolvedDates } from "@serp/contracts";

export const GSC_TIME_ZONE = "America/Los_Angeles";
export const GSC_RETENTION_MONTHS = 16;
export const CLARITY_MAX_DAYS = 3;
/** GA4 reporting began on this date; the Data API rejects earlier start dates. */
export const GA4_EARLIEST_START_DATE = "2015-08-14";

/** Calendar date (YYYY-MM-DD) of `now` in an IANA time zone. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** "Last N completed days": ends yesterday in `timeZone`, never including today. */
export function resolveLastCompletedDays(days: number, timeZone: string, now: Date = new Date()) {
  if (!Number.isInteger(days) || days < 1) {
    throw new ConnectorException("INVALID_QUERY", "Number of days must be a positive integer.");
  }
  const endDate = addDays(todayInTimeZone(timeZone, now), -1);
  return { startDate: addDays(endDate, -(days - 1)), endDate };
}

export interface DateValidation {
  warnings: ReportWarning[];
}

function assertOrdered(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new ConnectorException("INVALID_QUERY", "startDate must not be after endDate.");
  }
}

/** GSC dates are Pacific Time, retained ~16 months, and the most recent days may be incomplete. */
export function validateGscDateRange(startDate: string, endDate: string, now: Date = new Date(), dataState: "final" | "all" = "final"): DateValidation {
  assertOrdered(startDate, endDate);
  const today = todayInTimeZone(GSC_TIME_ZONE, now);
  const earliest = addMonths(today, -GSC_RETENTION_MONTHS);
  if (startDate < earliest) {
    throw new ConnectorException(
      "DATE_RANGE_UNSUPPORTED",
      `Search Console keeps about ${GSC_RETENTION_MONTHS} months of data; earliest available date is ${earliest}.`,
      { provider: "gsc", suggestedAction: `Use a startDate on or after ${earliest}.` },
    );
  }
  if (endDate > today) {
    throw new ConnectorException("DATE_RANGE_UNSUPPORTED", `endDate cannot be in the future (today is ${today} PT).`, {
      provider: "gsc",
    });
  }
  const warnings: ReportWarning[] = [];
  // Finalized data stops GSC_FINAL_LAG_DAYS back, so a range ending there is complete; with fresh data the last days are provisional.
  const incomplete = dataState === "all" ? endDate >= addDays(today, -GSC_FINAL_LAG_DAYS) : endDate > addDays(today, -GSC_FINAL_LAG_DAYS);
  if (incomplete) {
    warnings.push({
      code: "RECENT_DATA_INCOMPLETE",
      message:
        dataState === "all"
          ? "The most recent 1-2 days include fresh Search Console data that is still provisional and can change."
          : `Search Console only returns finalized data, which lags about ${GSC_FINAL_LAG_DAYS} days: the range ends after the newest finalized day, so the latest days are missing from the totals.`,
    });
  }
  return { warnings };
}

/** GA4 ranges are interpreted in the property's reporting time zone. */
export function validateGa4DateRange(startDate: string, endDate: string, timeZone: string | null, now: Date = new Date()): DateValidation {
  assertOrdered(startDate, endDate);
  const today = todayInTimeZone(timeZone ?? "UTC", now);
  if (startDate < GA4_EARLIEST_START_DATE) {
    throw new ConnectorException("DATE_RANGE_UNSUPPORTED", `GA4 reports cannot start before ${GA4_EARLIEST_START_DATE}.`, {
      provider: "ga4",
      suggestedAction: `Use a startDate on or after ${GA4_EARLIEST_START_DATE}.`,
    });
  }
  if (endDate > today) {
    throw new ConnectorException("DATE_RANGE_UNSUPPORTED", `endDate cannot be in the future (today is ${today} in the property time zone).`, {
      provider: "ga4",
    });
  }
  const warnings: ReportWarning[] = [];
  if (endDate === today) {
    warnings.push({ code: "PARTIAL_DAY", message: "The range includes today, which is still incomplete." });
  }
  if (endDate >= addDays(today, -1)) {
    warnings.push({ code: "RECENT_DATA_INCOMPLETE", message: "GA4 can take 24-48 hours to finish processing; the latest days may still change." });
  }
  if (timeZone === null) {
    warnings.push({ code: "TIMEZONE_UNKNOWN", message: "This property's reporting time zone is not stored, so UTC was used for date checks. GA4 interprets the dates in the property's own time zone." });
  }
  return { warnings };
}

export function validateClarityDays(numOfDays: number): void {
  if (!Number.isInteger(numOfDays) || numOfDays < 1 || numOfDays > CLARITY_MAX_DAYS) {
    throw new ConnectorException(
      "DATE_RANGE_UNSUPPORTED",
      `Clarity's export API only covers the last 1-${CLARITY_MAX_DAYS} days; longer windows such as 30 days are not available.`,
      { provider: "clarity", suggestedAction: "Request 1, 2 or 3 days." },
    );
  }
}

/** Deterministic JSON with sorted keys, so equivalent queries hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Bump when canonicalization or result shape changes, so older cached results are never served as current. */
export const REPORT_RULES_VERSION = 2;

/**
 * Hash of everything that can change a report's content: the canonical request (dates, dimensions, metrics, filters,
 * ordering, paging, data state) and the calendar it was resolved in. Scope (user, connection, property) is kept
 * separate by the cache itself, never mixed into this hash.
 */
export function canonicalQueryHash(parts: { query: unknown; timeZone: string }): string {
  return createHash("sha256").update(stableStringify({ q: parts.query, tz: parts.timeZone, v: REPORT_RULES_VERSION })).digest("hex");
}

export interface CacheKeyParts {
  userId: string;
  provider: ProviderKey;
  connectionId: string;
  propertyId: string;
  query: unknown;
  schemaVersion?: number;
}

/** Cache keys are partitioned by user/connection/property and never contain credentials. */
export function buildCacheKey(parts: CacheKeyParts): string {
  const hash = createHash("sha256")
    .update(stableStringify({ q: parts.query, v: parts.schemaVersion ?? 1 }))
    .digest("hex");
  return [parts.userId, parts.provider, parts.connectionId, parts.propertyId, hash].join(":");
}

export interface TtlConfig {
  defaultSeconds: number;
}

/** Starting TTLs from the TRD; tune with usage data. Recent windows cache shorter than settled history. */
export function ttlSeconds(provider: ProviderKey, endDate: string | null, now: Date, config: TtlConfig): number {
  if (provider === "clarity") return 6 * 3600;
  // Bing documents daily (traffic, crawl) and weekly (queries) updates, so a few hours of caching never hides new data.
  if (provider === "bing") return 6 * 3600;
  if (!endDate) return config.defaultSeconds;
  const recent = endDate >= addDays(now.toISOString().slice(0, 10), -3);
  if (provider === "gsc") return recent ? 20 * 60 : 6 * 3600;
  if (provider === "ga4") return recent ? 10 * 60 : 2 * 3600;
  return config.defaultSeconds;
}

// ---- date resolution ---------------------------------------------------------------------

/**
 * Newest day Search Console treats as final. Google documents that fresh data is provisional for a short time;
 * the exact lag is unverified, so it is a named constant rather than a hidden assumption.
 */
export const GSC_FINAL_LAG_DAYS = 2;

export interface ResolvedDates {
  startDate: string;
  endDate: string;
  resolvedFrom: "explicit" | "lastDays";
  lastDays?: number;
  /** The calendar the dates follow: Pacific Time for Search Console, the property's zone for GA4. */
  timeZone: string;
}

interface DateInput {
  startDate?: string | undefined;
  endDate?: string | undefined;
  lastDays?: number | undefined;
}

/**
 * Turns either explicit dates or "last N completed days" into concrete dates, using the provider's own rules:
 *  - Search Console: Pacific Time; "completed" means finalized (2 days back), or yesterday with fresh data allowed.
 *  - GA4: the property's reporting time zone (UTC with a caller-visible warning if unknown); ends yesterday.
 */
export function resolveReportDates(
  provider: "gsc" | "ga4",
  input: DateInput,
  options: { timeZone?: string | null; dataState?: "final" | "all"; now?: Date } = {},
): ResolvedDates {
  const now = options.now ?? new Date();
  const timeZone = provider === "gsc" ? GSC_TIME_ZONE : (options.timeZone ?? "UTC");

  if (input.lastDays !== undefined) {
    if (input.startDate !== undefined || input.endDate !== undefined) {
      throw new ConnectorException("INVALID_QUERY", "Provide either startDate and endDate, or lastDays (not both).");
    }
    if (!Number.isInteger(input.lastDays) || input.lastDays < 1) {
      throw new ConnectorException("INVALID_QUERY", "lastDays must be a positive whole number.");
    }
    const lag = provider === "gsc" ? (options.dataState === "all" ? 1 : GSC_FINAL_LAG_DAYS) : 1;
    const endDate = addDays(todayInTimeZone(timeZone, now), -lag);
    return { startDate: addDays(endDate, -(input.lastDays - 1)), endDate, resolvedFrom: "lastDays", lastDays: input.lastDays, timeZone };
  }
  if (input.startDate === undefined || input.endDate === undefined) {
    throw new ConnectorException("INVALID_QUERY", "Provide either startDate and endDate, or lastDays.");
  }
  return { startDate: input.startDate, endDate: input.endDate, resolvedFrom: "explicit", timeZone };
}

// ---- canonical form ----------------------------------------------------------------------

const byJson = <T>(items: T[]): T[] => [...items].sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1));

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = stableStringify(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function canonicalGscFilter(f: GscFilter): GscFilter {
  const expression = f.expression.trim();
  if (f.dimension === "country" || f.dimension === "device") return { ...f, expression: expression.toUpperCase() };
  return { ...f, expression };
}

/** Equivalent requests become identical objects: trimmed, case-folded where Google is case-insensitive, filters sorted and de-duplicated. */
export function canonicalizeGscQuery(q: WithResolvedDates<QueryGscInput>): WithResolvedDates<QueryGscInput> {
  return { ...q, propertyId: q.propertyId.trim(), filters: byJson(dedupe(q.filters.map(canonicalGscFilter))) };
}

/** GA4 string filters are case-insensitive here (we send caseSensitive: false), so values are trimmed and ordering is canonical. */
export function canonicalizeGa4Query(q: WithResolvedDates<QueryGa4Input>): WithResolvedDates<QueryGa4Input> {
  return {
    ...q,
    propertyId: q.propertyId.trim(),
    dimensionFilters: byJson(dedupe(q.dimensionFilters.map((f) => ({ ...f, value: f.value.trim() })))),
    metricFilters: byJson(dedupe(q.metricFilters)),
  };
}
