import type { NormalizedReportResult, ReportRow, ReportWarning } from "@serp/contracts";
import { CLARITY_MAX_ROWS, CLARITY_NUM_OF_DAYS, CLARITY_TIME_SEMANTICS } from "./constants.js";

export interface MetricBlockInfo {
  metricName: string;
  rows: number;
  /** True when the block reached the documented 1,000-row cap, so rows may be missing. */
  truncated: boolean;
}

export interface ParsedClarity {
  rows: ReportRow[];
  metricFields: string[];
  blocks: MetricBlockInfo[];
  warnings: ReportWarning[];
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Turns the provider's `[{ metricName, information: [ {...}, ... ] }]` into flat rows tagged with `metricName`.
 * Shape facts from the official sample: numbers arrive as strings ("9554") or numbers (1.0931), and each information
 * row carries the requested dimension as a column. Nothing is invented: a field the provider omitted stays absent
 * (not zero), an explicit null stays null, and unknown fields are kept under their original names.
 * Returns null when the body is not the expected array at all.
 */
export function parseClarityResponse(body: unknown, requestedDimensions: readonly string[]): ParsedClarity | null {
  if (!Array.isArray(body)) return null;
  const dimKeys = new Set(requestedDimensions.map(squash));
  const rows: ReportRow[] = [];
  const blocks: MetricBlockInfo[] = [];
  const warnings: ReportWarning[] = [];
  const fields = new Set<string>();
  let skipped = 0;

  for (const block of body) {
    if (typeof block !== "object" || block === null || typeof (block as { metricName?: unknown }).metricName !== "string") {
      skipped++;
      continue;
    }
    const { metricName, information } = block as { metricName: string; information?: unknown };
    if (!Array.isArray(information)) {
      skipped++;
      continue;
    }
    let count = 0;
    for (const item of information) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        skipped++;
        continue;
      }
      const row: ReportRow = { metricName };
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (key === "metricName") continue;
        const isDimension = dimKeys.has(squash(key));
        if (value === null) row[key] = null;
        else if (typeof value === "number" && Number.isFinite(value)) row[key] = value;
        else if (typeof value === "string") row[key] = !isDimension && NUMERIC.test(value) ? Number(value) : value;
        else if (typeof value === "boolean") row[key] = value ? 1 : 0;
        else row[key] = JSON.stringify(value).slice(0, 500);
        if (!isDimension && typeof row[key] === "number") fields.add(key);
      }
      rows.push(row);
      count++;
    }
    blocks.push({ metricName, rows: count, truncated: count >= CLARITY_MAX_ROWS });
  }

  if (skipped > 0) warnings.push({ code: "UNEXPECTED_STRUCTURE", message: `${skipped} part(s) of Clarity's response had an unexpected shape and were left out.` });
  for (const b of blocks.filter((x) => x.truncated)) {
    warnings.push({
      code: "ROW_LIMIT_REACHED",
      message: `"${b.metricName}" reached Clarity's ${CLARITY_MAX_ROWS}-row response limit, which cannot be paged. Rows are missing; add or change a dimension to narrow it.`,
    });
  }
  return { rows, metricFields: [...fields].sort(), blocks, warnings };
}

export function buildClarityResult(input: {
  parsed: ParsedClarity;
  numOfDays: 1 | 2 | 3;
  dimensions: readonly string[];
  property: { id: string; name: string };
  requestId: string;
  now: Date;
  mock: boolean;
  extraWarnings?: ReportWarning[];
}): NormalizedReportResult {
  const { parsed, now } = input;
  const warnings = [...parsed.warnings, ...(input.extraWarnings ?? [])];
  const empty = parsed.rows.length === 0;
  if (empty) {
    warnings.push({
      code: "EMPTY_RESULT",
      message: "Clarity returned no rows for this window. That means no data was reported, not that every value is zero (a new project or very low traffic can look like this).",
    });
  }
  const truncated = parsed.blocks.some((b) => b.truncated);
  const bots = summarizeBotTraffic(parsed.rows);
  if (bots && bots.botSessions > 0) {
    warnings.push({
      code: "BOT_TRAFFIC_INCLUDED",
      message: `Clarity counts bot sessions: ${bots.botSessions} of ${bots.totalSessions} sessions (${bots.botSharePercent}%) in this window are bots. Session counts include them; human sessions are about ${bots.humanSessions}. Treat unfiltered session, page and engagement numbers as inflated by bots.`,
    });
  } else if (!bots && !empty) {
    warnings.push({ code: "BOT_TRAFFIC_UNKNOWN", message: "This response has no bot-session count, so bot traffic cannot be separated from human sessions." });
  }
  warnings.push({
    code: "CLARITY_LAST_72_HOURS_ONLY",
    message: `Clarity only reports the last ${CLARITY_NUM_OF_DAYS.length * 24} hours at most (${input.numOfDays * 24}h here), with no custom dates. For 7, 28 or 90 days use query_gsc_performance (search) or query_ga4_report (traffic).`,
  });
  return {
    provider: "clarity",
    property: input.property,
    report: {
      startDate: null,
      endDate: null,
      dateSemantics: CLARITY_TIME_SEMANTICS,
      dimensions: [...input.dimensions],
      metrics: parsed.metricFields,
      sort: [],
      limit: CLARITY_MAX_ROWS,
      period: { resolvedFrom: "lastDays", lastDays: input.numOfDays, timeZone: "UTC" },
    },
    rows: parsed.rows,
    rowCountReturned: parsed.rows.length,
    rowCountReportedByProvider: null,
    fetchedAt: now.toISOString(),
    cache: { hit: false, ageSeconds: 0 },
    completeness: truncated || empty ? "unknown_or_provider_limited" : "complete",
    mock: input.mock,
    warnings,
    providerMetadata: {
      windowHours: input.numOfDays * 24,
      windowEndsApproximately: now.toISOString(),
      windowStartsApproximately: new Date(now.getTime() - input.numOfDays * 86_400_000).toISOString(),
      timeZone: "UTC",
      metricBlocks: parsed.blocks,
      maxHistoryHours: CLARITY_NUM_OF_DAYS.length * 24,
      ...(bots && { botTraffic: bots }),
    },
    requestId: input.requestId,
  };
}

export interface BotTrafficSummary {
  totalSessions: number;
  botSessions: number;
  humanSessions: number;
  botSharePercent: number;
}

/** Sums the Traffic block's total and bot session counts. Null when the response carries no bot count to compare. */
export function summarizeBotTraffic(rows: readonly ReportRow[]): BotTrafficSummary | null {
  let total = 0;
  let bot = 0;
  let seen = false;
  for (const r of rows) {
    if (squash(String(r.metricName)) !== "traffic") continue;
    const t = r[Object.keys(r).find((k) => squash(k) === "totalsessioncount") ?? ""];
    const b = r[Object.keys(r).find((k) => squash(k) === "totalbotsessioncount") ?? ""];
    if (typeof t !== "number" || typeof b !== "number") continue;
    seen = true;
    total += t;
    bot += b;
  }
  if (!seen) return null;
  return { totalSessions: total, botSessions: bot, humanSessions: Math.max(0, total - bot), botSharePercent: total > 0 ? Math.round((bot / total) * 1000) / 10 : 0 };
}
