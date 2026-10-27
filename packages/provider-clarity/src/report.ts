import type { NormalizedReportResult, ReportRow, ReportWarning } from "@serp/contracts";
import { CLARITY_MAX_ROWS, type ClarityDimension } from "./constants.js";

/**
 * Report presets: a plain-language question mapped to the dimensions that answer it. One preset is one Clarity request,
 * so ask for one or two per user question, never all of them.
 */
export const CLARITY_REPORT_TYPES = ["overview", "by_device", "by_country", "by_source", "by_channel", "by_page", "frustration_by_page", "by_browser_os"] as const;
export type ClarityReportType = (typeof CLARITY_REPORT_TYPES)[number];

export const CLARITY_REPORT_PRESETS: Record<ClarityReportType, { dimensions: ClarityDimension[]; answers: string }> = {
  overview: { dimensions: [], answers: "How is the site doing overall in the last 1-3 days? Totals plus top devices, browsers, OS, countries, pages and referrers." },
  by_device: { dimensions: ["Device"], answers: "How do Mobile, PC and Tablet visitors differ in sessions, engagement and frustration?" },
  by_country: { dimensions: ["Country/Region"], answers: "Where are visitors located and how do they behave per country?" },
  by_source: { dimensions: ["Source", "Medium"], answers: "Which traffic sources and mediums send visitors (e.g. google / organic, direct / none)?" },
  by_channel: { dimensions: ["Channel"], answers: "Which channels (Organic search, Direct, Social, Referral, Paid...) send visitors?" },
  by_page: { dimensions: ["URL"], answers: "Which pages get the sessions, engagement and scroll depth?" },
  frustration_by_page: { dimensions: ["URL"], answers: "Which pages have rage clicks, dead clicks, quick-backs, script errors or error clicks?" },
  by_browser_os: { dimensions: ["Browser", "OS"], answers: "Which browser and operating system combinations are used or have problems?" },
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, d = 1): number | null => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Clarity's click and error blocks, with the short name used in the clean output. */
const SIGNALS: Array<[block: string, name: string]> = [
  ["rageclickcount", "rageClick"],
  ["deadclickcount", "deadClick"],
  ["quickbackclick", "quickback"],
  ["errorclickcount", "errorClick"],
  ["scripterrorcount", "scriptError"],
  ["excessivescroll", "excessiveScroll"],
];
const FRUSTRATION = ["rageClick", "deadClick", "quickback", "errorClick"] as const;

const METRIC_KEYS = new Set(
  ["totalSessionCount", "totalBotSessionCount", "distinctUserCount", "distantUserCount", "pagesPerSessionPercentage", "averageScrollDepth", "totalTime", "activeTime", "sessionsCount", "sessionsWithMetricPercentage", "sessionsWithoutMetricPercentage", "pagesViews", "subTotal", "visitsCount"].map(squash),
);
const BREAKDOWN_BLOCKS: Record<string, string> = { browser: "browsers", device: "devices", os: "operatingSystems", country: "countries", countryregion: "countries", pagetitle: "pageTitles", referrerurl: "referrers", popularpages: "popularPages" };

type Clean = Record<string, string | number | null>;

function applyBlock(target: Clean, blockKey: string, r: ReportRow): void {
  const get = (k: string) => num(r[Object.keys(r).find((x) => squash(x) === squash(k)) ?? ""]);
  if (blockKey === "traffic") {
    target.sessions = get("totalSessionCount");
    target.botSessions = get("totalBotSessionCount");
    target.distinctUsers = get("distinctUserCount") ?? get("distantUserCount");
    target.pagesPerSession = round(get("pagesPerSessionPercentage"), 2);
  } else if (blockKey === "scrolldepth") {
    target.avgScrollDepthPercent = round(get("averageScrollDepth"), 1);
  } else if (blockKey === "engagementtime") {
    target.totalTimeSeconds = get("totalTime");
    target.activeTimeSeconds = get("activeTime");
  } else {
    const sig = SIGNALS.find(([b]) => b === blockKey);
    if (!sig) return;
    const name = sig[1];
    // Live data: sessionsCount is every session in scope (not only affected ones); subTotal is the number of events.
    const pct = get("sessionsWithMetricPercentage");
    const inScope = get("sessionsCount");
    target[`${name}Count`] = get("subTotal");
    target[`${name}SessionsPercent`] = round(pct, 2);
    target[`${name}Sessions`] = pct === null || inScope === null ? null : Math.round((inScope * pct) / 100);
  }
}

const frustrationScore = (row: Clean): number => FRUSTRATION.reduce((s, n) => s + (typeof row[`${n}Count`] === "number" ? (row[`${n}Count`] as number) : 0), 0);

export interface ClarityReportQuota {
  usedToday: number;
  remainingToday: number;
  dailyBudgetForThisApp: number;
  resetsAtUtc: string;
}

export interface ShapeInput {
  result: NormalizedReportResult;
  reportType: ClarityReportType | null;
  dimensions: readonly string[];
  numOfDays: 1 | 2 | 3;
  limit: number;
  quota: ClarityReportQuota;
  now: Date;
}

/**
 * Turns the flat provider rows into one tidy object: dimension rows are merged into a single row per dimension value with
 * short, numeric fields. Nothing is derived from numbers that could be wrong: bot sessions are reported next to sessions as
 * two separate figures, because live data shows the bot count is not a subset of the session count.
 */
export function shapeClarityReport(input: ShapeInput): Record<string, unknown> {
  const { result, quota, limit } = input;
  const warnings: ReportWarning[] = result.warnings.filter((w) => w.code !== "BOT_TRAFFIC_INCLUDED" && w.code !== "BOT_TRAFFIC_UNKNOWN");
  const blocks = (result.providerMetadata?.metricBlocks as Array<{ metricName: string; rows: number; truncated: boolean }> | undefined) ?? [];
  const pulledAt = result.fetchedAt;
  const windowEnd = new Date(pulledAt);
  const windowStart = new Date(windowEnd.getTime() - input.numOfDays * 86_400_000);
  const dimensionMode = input.dimensions.length > 0;

  let rowsAvailable = 0;
  let rows: Clean[] = [];
  const totals: Clean = {};
  const breakdowns: Record<string, Clean[]> = {};

  if (dimensionMode) {
    const merged = new Map<string, Clean>();
    for (const r of result.rows) {
      const key = squash(String(r.metricName));
      const dimCols = Object.keys(r).filter((k) => k !== "metricName" && !METRIC_KEYS.has(squash(k)));
      const label = dimCols.map((k) => String(r[k] ?? "(not set)"));
      const id = label.join("\u0000");
      let row = merged.get(id);
      if (!row) {
        row = {};
        dimCols.forEach((k, i) => (row![k] = label[i] ?? ""));
        merged.set(id, row);
      }
      applyBlock(row, key, r);
    }
    rows = [...merged.values()];
    rows.sort((a, b) => (num(b.sessions) ?? -1) - (num(a.sessions) ?? -1) || frustrationScore(b) - frustrationScore(a));
    if (input.reportType === "frustration_by_page") {
      rows = rows.filter((r) => frustrationScore(r) > 0 || FRUSTRATION.some((n) => (num(r[`${n}SessionsPercent`]) ?? 0) > 0));
      rows.sort((a, b) => frustrationScore(b) - frustrationScore(a));
      if (rows.length === 0) {
        warnings.push({ code: "NO_FRUSTRATION_SIGNALS", message: "No page had rage clicks, dead clicks, quick-backs or error clicks in this window. That is a good sign, not missing data." });
      }
    }
    rowsAvailable = rows.length;
    rows = rows.slice(0, limit);
  } else {
    for (const r of result.rows) {
      const key = squash(String(r.metricName));
      const bucket = BREAKDOWN_BLOCKS[key];
      if (bucket) {
        const entry: Clean = typeof r.url === "string" ? { url: r.url, visits: num(r.visitsCount) } : { name: typeof r.name === "string" ? r.name : "(not set)", sessions: num(r.sessionsCount) };
        (breakdowns[bucket] ??= []).push(entry);
      } else {
        applyBlock(totals, key, r);
      }
    }
    rowsAvailable = Object.values(breakdowns).reduce((s, b) => s + b.length, 0);
  }

  // Row-limit truncation is reported from the provider's own per-block counts.
  const truncated = blocks.filter((b) => b.truncated);
  const rowsReturned = dimensionMode ? rows.length : rowsAvailable;
  const cacheAgeMinutes = Math.round(result.cache.ageSeconds / 60);

  if (quota.remainingToday === 0) {
    warnings.push({
      code: "QUOTA_EXHAUSTED_CACHE_ONLY",
      message: `This app has used all of today's Clarity requests for this project. Only saved results are served until ${quota.resetsAtUtc} (UTC); a question that has not been asked recently cannot be answered until then.`,
    });
  } else if (quota.remainingToday <= 2) {
    warnings.push({
      code: "LOW_QUOTA",
      message: `Only ${quota.remainingToday} fresh Clarity request(s) left today for this project (resets ${quota.resetsAtUtc} UTC). Prefer saved results and ask only what you need.`,
    });
  }
  if (result.cache.hit) {
    warnings.push({ code: "SERVED_FROM_CACHE", message: `Saved result from ${pulledAt}, about ${cacheAgeMinutes} minute(s) old. No Clarity request was used.` });
  }
  if (truncated.length > 0) {
    warnings.push({ code: "TRUNCATED_AT_1000_ROWS", message: `Clarity cut at least one metric at ${CLARITY_MAX_ROWS} rows and cannot page. Some dimension values are missing; use a narrower report type.` });
  }

  const base = {
    provider: "clarity",
    property: result.property,
    reportType: input.reportType ?? "custom",
    dimensions: [...input.dimensions],
    source: result.cache.hit ? "cache" : "live",
    stale: Boolean((result.cache as { stale?: boolean }).stale),
    completeness: result.completeness,
    pulledAt,
    dataAgeMinutes: cacheAgeMinutes,
    window: { startUtc: windowStart.toISOString(), endUtc: windowEnd.toISOString(), days: input.numOfDays, note: "Rolling window ending at pulledAt, in UTC. Clarity has nothing older than 3 days." },
    rowsReturned,
    rowsAvailable,
    truncated: truncated.length > 0,
    quota,
    labels: {
      sessions: "Sessions as counted by Clarity (totalSessionCount).",
      botSessions: "Bot sessions as counted by Clarity (totalBotSessionCount). Reported separately: it can be larger than sessions, so it is not subtracted from them.",
      "rageClick/deadClick/quickback/errorClick/scriptError/excessiveScroll": "xCount = events, xSessionsPercent = share of sessions affected, xSessions = affected sessions (computed from the percentage).",
      ...(dimensionMode ? {} : { totals: "Whole-window totals. breakdowns lists each source's top values (max 10 each)." }),
    },
    mock: result.mock,
    requestId: result.requestId,
    warnings,
  };
  return dimensionMode ? { ...base, rows } : { ...base, totals, breakdowns };
}
