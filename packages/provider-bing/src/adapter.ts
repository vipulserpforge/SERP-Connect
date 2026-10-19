import {
  ConnectorException,
  type AuthorizedQueryContext,
  type BingReportKind,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportRow,
  type ReportWarning,
} from "@serp/contracts";
import { BingApiError, type BingApiClient } from "./client.js";
import { BING_DATE_SEMANTICS, BING_DOCS_URL, type BingAuth } from "./constants.js";
import { toBingConnectorError } from "./errors.js";

/** A validated request with its date window resolved. null = no filter (everything Bing returned). */
export interface BingQuery {
  propertyId: string;
  report: BingReportKind;
  startDate: string | null;
  endDate: string | null;
  sortBy: "date" | "clicks" | "impressions";
  sortDirection: "asc" | "desc";
  limit: number;
}

export type BingAdapter = ReportAdapter<BingQuery>;

/** What the connection record should learn from a real provider answer. Implemented by the credential layer. */
export interface BingConnectionHooks {
  onSuccess(ctx: AuthorizedQueryContext): Promise<void>;
  onAuthRejected(ctx: AuthorizedQueryContext): Promise<void>;
}

export interface LiveBingDeps {
  client: BingApiClient;
  /** Returns the credential of the connection the authorization step already resolved, with its stored method. Never a caller-supplied id. */
  getAuth(ctx: AuthorizedQueryContext): Promise<BingAuth>;
  hooks?: BingConnectionHooks;
  now?: () => Date;
}

const REPORT_META: Record<BingReportKind, { endpoint: string; dimensions: string[]; metrics: string[]; freshness: string }> = {
  traffic: {
    endpoint: "GetRankAndTrafficStats",
    dimensions: ["date"],
    metrics: ["clicks", "impressions"],
    freshness: "Bing documents this series as updated every day. It includes Web, Chat, News, Images, Videos and Knowledge Panel traffic from 24 March 2023.",
  },
  queries: {
    endpoint: "GetQueryStats",
    dimensions: ["query", "date"],
    metrics: ["clicks", "impressions", "avgClickPosition", "avgImpressionPosition"],
    freshness: "Bing documents this report as updated every week, so recent days are not expected. Which queries are included is not documented.",
  },
  crawl: {
    endpoint: "GetCrawlStats",
    dimensions: ["date"],
    metrics: ["crawledPages", "crawlErrors", "inIndex", "inLinks", "code2xx", "code301", "code302", "code4xx", "code5xx", "allOtherCodes", "blockedByRobotsTxt", "containsMalware"],
    freshness: "Bing documents this as updated every day and covering the last 6 months.",
  },
};

export const BING_REPORT_META = REPORT_META;

const inWindow = (date: string, start: string | null, end: string | null) => (start === null || date >= start) && (end === null || date <= end);

/** Reads, filters, sorts and trims Bing's rows. Absent values stay null (never turned into 0). */
export function shapeBingRows(rows: Array<Record<string, string | number | null>>, query: BingQuery): { rows: ReportRow[]; afterFilter: number } {
  const filtered = rows.filter((r) => inWindow(String(r.date), query.startDate, query.endDate));
  const dir = query.sortDirection === "asc" ? 1 : -1;
  const key = query.report === "crawl" ? "date" : query.sortBy;
  const sorted = [...filtered].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    // Missing values always sort last, whatever the direction.
    if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
    if (bv === null || bv === undefined) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.date) < String(b.date) ? 1 : -1; // stable, newest first on ties
  });
  return { rows: sorted.slice(0, query.limit).map((r) => ({ ...r })), afterFilter: filtered.length };
}

export function buildBingResult(input: {
  query: BingQuery;
  ctx: AuthorizedQueryContext;
  fetched: Array<Record<string, string | number | null>>;
  skipped: number;
  mock: boolean;
  now: Date;
}): NormalizedReportResult {
  const { query, ctx, fetched, skipped, mock } = input;
  const meta = REPORT_META[query.report];
  const shaped = shapeBingRows(fetched, query);
  const warnings: ReportWarning[] = [];
  if (mock) warnings.push({ code: "MOCK_DATA", message: "Synthetic fixture data; not from Bing." });
  if (skipped > 0) warnings.push({ code: "ROWS_SKIPPED", message: `${skipped} row${skipped === 1 ? "" : "s"} from Bing could not be read (for example an unreadable date) and ${skipped === 1 ? "was" : "were"} left out.` });
  if (fetched.length === 0) {
    warnings.push({ code: "EMPTY_RESULT", message: "Bing returned no rows for this site. That means no data was reported, not that the values are zero." });
  } else if (shaped.afterFilter === 0) {
    warnings.push({ code: "NO_ROWS_IN_WINDOW", message: `Bing returned ${fetched.length} rows, but none fall inside the requested dates. ${meta.freshness}` });
  }
  if (shaped.afterFilter > shaped.rows.length) {
    warnings.push({ code: "ROW_LIMIT_REACHED", message: `Showing ${shaped.rows.length} of ${shaped.afterFilter} matching rows. Raise the limit or narrow the dates for the rest.` });
  }
  const newest = fetched.reduce<string | null>((acc, r) => (acc === null || String(r.date) > acc ? String(r.date) : acc), null);
  return {
    provider: "bing",
    property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
    report: {
      startDate: query.startDate,
      endDate: query.endDate,
      dateSemantics: BING_DATE_SEMANTICS,
      dimensions: meta.dimensions,
      metrics: meta.metrics,
      sort: [{ field: query.report === "crawl" ? "date" : query.sortBy, direction: query.sortDirection }],
      limit: query.limit,
    },
    rows: shaped.rows,
    rowCountReturned: shaped.rows.length,
    // What Bing sent before this app filtered it by date: Bing itself reports no total.
    rowCountReportedByProvider: fetched.length,
    fetchedAt: input.now.toISOString(),
    cache: { hit: false, ageSeconds: 0 },
    // Bing documents no completeness guarantee for the query report, so it is never called complete.
    completeness: query.report === "queries" ? "unknown_or_provider_limited" : "complete",
    mock,
    warnings,
    providerMetadata: {
      source: "Bing Webmaster Tools (not Google Search Console: positions, impressions and clicks are counted by Bing and are not comparable one-to-one)",
      endpoint: meta.endpoint,
      freshness: meta.freshness,
      newestDateInResponse: newest,
      authMethod: ctx.connection.authMethod,
      docs: BING_DOCS_URL,
    },
    requestId: ctx.requestId,
  };
}

/** The only code that reads Bing reports. Resolves the credential, calls once, shapes the answer. */
export class LiveBingAdapter implements BingAdapter {
  readonly provider = "bing" as const;
  readonly mock: boolean;

  constructor(private readonly deps: LiveBingDeps) {
    this.mock = deps.client.mock;
  }

  async query(query: BingQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const { client, hooks } = this.deps;
    const auth = await this.deps.getAuth(ctx);
    const site = ctx.property.externalPropertyId;
    let data;
    try {
      data =
        query.report === "traffic"
          ? await client.getRankAndTrafficStats(auth, site, ctx.signal)
          : query.report === "queries"
            ? await client.getQueryStats(auth, site, ctx.signal)
            : await client.getCrawlStats(auth, site, ctx.signal);
    } catch (err) {
      if (err instanceof BingApiError && err.kind === "unauthenticated") await hooks?.onAuthRejected(ctx).catch(() => undefined);
      throw toBingConnectorError(err);
    }
    await hooks?.onSuccess(ctx).catch(() => undefined);
    return buildBingResult({
      query,
      ctx,
      fetched: data.rows as unknown as Array<Record<string, string | number | null>>,
      skipped: data.skipped,
      mock: this.mock,
      now: this.deps.now?.() ?? new Date(),
    });
  }
}

export function createBingAdapter(deps: LiveBingDeps): BingAdapter {
  return new LiveBingAdapter(deps);
}

export function bingDisabled(): ConnectorException {
  return new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Bing Webmaster support is not enabled on this server yet.", {
    provider: "bing",
    suggestedAction: "Use Search Console or GA4 for now.",
  });
}
