/**
 * Pure helpers that turn Bing's raw rows into readable, comparable numbers. No network, no state.
 * Bing's own counting rules are kept: nothing here converts Bing figures into Google-style ones.
 */

export type Raw = Record<string, string | number | null>;

/**
 * Bing lists https://x.com/a, https://x.com/a/ and https://x.com/a?utm=1#top as separate pages. This reduces them to one key:
 * lower-case scheme and host, default port dropped, fragment and query string removed, trailing slash removed (except the root).
 * Anything that is not an absolute http(s) URL is returned trimmed and otherwise untouched.
 */
export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return value;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return value;
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${u.host}${path}`.replace(/^(https?:\/\/[^/]+)$/, "$1/");
}

/** Ratio helpers: null in, null out; never divide by zero. */
export const ratio = (num: number | null, den: number | null): number | null => (num === null || den === null || den === 0 ? null : num / den);

export const round = (v: number | null, digits: number): number | null => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

/** Percent change from `previous` to `current`, rounded to 0.1. null when there is nothing to compare against (previous is 0 or missing). */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

const sum = (values: Array<number | null>): number | null => {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
};

/** Weighted mean over rows that have both a value and a weight > 0. null when no row qualifies. */
function weighted(rows: Array<{ value: number | null; weight: number | null }>): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.value === null || r.weight === null || r.weight <= 0) continue;
    num += r.value * r.weight;
    den += r.weight;
  }
  return den === 0 ? null : num / den;
}

export interface Aggregated {
  key: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  /** Impression-weighted average of Bing's AvgImpressionPosition. */
  avgPosition: number | null;
  /** Click-weighted average of Bing's AvgClickPosition. */
  avgClickPosition: number | null;
  /** How many of Bing's dated rows were summed (queries and pages are weekly buckets). */
  periods: number;
}

export interface Aggregatable {
  date: string;
  clicks: number | null;
  impressions: number | null;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

/** One row per label (query or page address), summed over whatever dated rows are passed in. `keyOf` decides what counts as the same label. */
export function aggregateByKey<T extends Aggregatable>(rows: T[], keyOf: (row: T) => string): Aggregated[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([key, g]) => {
    const clicks = sum(g.map((r) => r.clicks));
    const impressions = sum(g.map((r) => r.impressions));
    return {
      key,
      clicks,
      impressions,
      ctr: ratio(clicks, impressions),
      avgPosition: weighted(g.map((r) => ({ value: r.avgImpressionPosition, weight: r.impressions }))),
      avgClickPosition: weighted(g.map((r) => ({ value: r.avgClickPosition, weight: r.clicks }))),
      periods: new Set(g.map((r) => r.date)).size,
    };
  });
}

/** Whole-window totals over daily or weekly rows. */
export function totalsOf(rows: Array<{ clicks: number | null; impressions: number | null }>): { clicks: number | null; impressions: number | null; ctr: number | null } {
  const clicks = sum(rows.map((r) => r.clicks));
  const impressions = sum(rows.map((r) => r.impressions));
  return { clicks, impressions, ctr: ratio(clicks, impressions) };
}

/** Calendar days (YYYY-MM-DD) strictly between the first and last date of `dates` that have no row. For daily series only. */
export function missingDays(dates: string[]): string[] {
  if (dates.length < 2) return [];
  const have = new Set(dates);
  const sorted = [...have].sort();
  const out: string[] = [];
  const end = Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`);
  for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!have.has(d)) out.push(d);
  }
  return out;
}

/** Days between two YYYY-MM-DD dates (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const addDaysIso = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The window of equal length that ends the day before `start`. */
export function previousWindow(start: string, end: string): { startDate: string; endDate: string } {
  const length = daysBetween(start, end) + 1;
  return { startDate: addDaysIso(start, -length), endDate: addDaysIso(start, -1) };
}

/**
 * Bing's CrawlIssues is a bit-flag value. Microsoft's sample shows 32 = ContainsMalware, and the crawl-statistics report lists the
 * same categories, so the flags are decoded in that order. Bits that are not recognised are reported as `unknown_flag_<value>`
 * instead of being guessed.
 */
export const CRAWL_ISSUE_FLAGS: ReadonlyArray<readonly [number, string]> = [
  [1, "redirect_301"],
  [2, "redirect_302"],
  [4, "http_4xx"],
  [8, "http_5xx"],
  [16, "blocked_by_robots_txt"],
  [32, "contains_malware"],
  [64, "important_url_blocked_by_robots_txt"],
];

export function decodeCrawlIssues(flags: number | null): string[] {
  if (flags === null || flags === 0) return [];
  const names: string[] = [];
  let rest = flags;
  for (const [bit, name] of CRAWL_ISSUE_FLAGS) {
    if ((rest & bit) === bit) {
      names.push(name);
      rest &= ~bit;
    }
  }
  if (rest !== 0) names.push(`unknown_flag_${rest}`);
  return names;
}

export const formatInt = (v: number | null): string => (v === null ? "n/a" : Math.round(v).toLocaleString("en-US"));
export const formatPct = (v: number | null, digits = 1): string => (v === null ? "n/a" : `${(v * 100).toFixed(digits)}%`);
export const formatChange = (v: number | null): string => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}%`);
