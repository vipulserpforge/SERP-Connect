import {
  ConnectorException,
  type AuthorizedQueryContext,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportWarning,
  isConnectorException,
} from "@serp/contracts";
import { Ga4ApiError, type Ga4ApiClient, type Ga4Metadata } from "./api-client.js";
import {
  buildCohortRequest,
  buildGa4Summary,
  buildRealtimeRequest,
  buildRunReportRequest,
  describeIncompatibility,
  normalizeCohortResponse,
  normalizeGa4Response,
  todayInZone,
  validateGa4Fields,
  validateGa4RealtimeFields,
  type Ga4CohortQuery,
  type Ga4Query,
  type Ga4RealtimeQuery,
} from "./query.js";

export type Ga4Adapter = ReportAdapter<Ga4Query> & {
  /** Fields valid on one property (standard and custom). Property-specific, so it needs an authorized context. */
  describeFields?(ctx: AuthorizedQueryContext): Promise<Ga4Metadata>;
  /** Who is on the site right now (last 30 minutes at most). Uses the Realtime API's own, smaller field set. */
  queryRealtime?(query: Ga4RealtimeQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult>;
  /** Retention by cohort: how many users who first visited in a period came back in each later period. */
  queryCohort?(query: Ga4CohortQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult>;
};

export interface GoogleGa4AdapterDeps {
  client: Ga4ApiClient;
  getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>;
  /** Forces a token refresh after a 401 on a token that looked valid; the call is then retried once. */
  refreshAccessToken?: (ctx: AuthorizedQueryContext) => Promise<string>;
  onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>;
  now?: () => Date;
  /** How long property metadata and compatibility answers are reused. */
  metadataTtlMs?: number;
  /** Most concurrent reports per property; GA4 allows 10 per property. */
  maxConcurrentPerProperty?: number;
}

/** Readable names for the small Realtime field set (the metadata endpoint does not describe them). */
const REALTIME_LABELS: Record<string, string> = { activeUsers: "Active users", screenPageViews: "Views", eventCount: "Event count", keyEvents: "Key events", conversions: "Conversions" };

const RECONNECT = "Open the SERP Connect dashboard, find this Google account under Connections and click Reconnect, then ask again.";

/** Translates an API failure into the shared, user-presentable error. Never includes upstream text. */
export function toGa4ConnectorError(err: unknown): ConnectorException {
  if (isConnectorException(err)) return err;
  if (!(err instanceof Ga4ApiError)) {
    return new ConnectorException("PROVIDER_UNAVAILABLE", "Google Analytics is temporarily unavailable. Try again shortly.", { provider: "ga4", retryable: true });
  }
  switch (err.kind) {
    case "unauthenticated":
      return new ConnectorException("AUTH_EXPIRED", "Google rejected the stored access. The account needs to be reconnected.", { provider: "ga4", suggestedAction: RECONNECT });
    case "insufficient_scope":
      return new ConnectorException("FORBIDDEN", "This Google connection was not granted Google Analytics read access.", { provider: "ga4", suggestedAction: `${RECONNECT} Approve the Analytics permission.` });
    case "no_resource_access":
      return new ConnectorException(
        "PROPERTY_NOT_ACCESSIBLE",
        "The connected Google account cannot read this GA4 property (access may have been removed).",
        { provider: "ga4", suggestedAction: "Check the account's role on the property in Google Analytics, or connect an account that has access." },
      );
    case "quota":
      return new ConnectorException("PROVIDER_RATE_LIMITED", "Google Analytics quota for this property is used up for now. GA4 quotas reset hourly and daily.", {
        provider: "ga4",
        retryable: true,
        suggestedAction: "Wait before retrying, and prefer fewer, narrower reports.",
        ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
      });
    case "api_disabled":
      return new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "The Google Analytics API is not enabled for this application. This is a server configuration issue, not your account.", { provider: "ga4" });
    case "invalid_request":
      return new ConnectorException("INVALID_QUERY", "Google Analytics rejected the report request. Check the fields, filters and date range.", { provider: "ga4" });
    case "bad_response":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Google Analytics returned an unexpected response.", { provider: "ga4", retryable: true });
    case "unavailable":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Google Analytics is temporarily unavailable. Try again shortly.", { provider: "ga4", retryable: true });
  }
}

/** Limits simultaneous reports per key; extra callers wait their turn instead of burning concurrency quota. */
class ConcurrencyGate {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(private readonly max: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while ((this.active.get(key) ?? 0) >= this.max) {
      await new Promise<void>((resolve) => this.waiting.set(key, [...(this.waiting.get(key) ?? []), resolve]));
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      this.waiting.get(key)?.shift()?.();
    }
  }
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

/** GA4 report adapter: validates fields against the property's own metadata, checks compatibility, runs the report. */
export class GoogleGa4Adapter implements Ga4Adapter {
  readonly provider = "ga4" as const;
  private readonly metadata = new Map<string, Cached<Ga4Metadata>>();
  private readonly compat = new Map<string, Cached<{ dims: string[]; mets: string[] }>>();
  private readonly gate: ConcurrencyGate;
  private readonly ttl: number;

  constructor(private readonly deps: GoogleGa4AdapterDeps) {
    this.gate = new ConcurrencyGate(deps.maxConcurrentPerProperty ?? 5);
    this.ttl = deps.metadataTtlMs ?? 3600_000;
  }

  get mock(): boolean {
    return this.deps.client.mock;
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  // Keys include the user and connection: one tenant's cached answer is never served to another.
  private key(ctx: AuthorizedQueryContext): string {
    return `${ctx.userId}:${ctx.connection.id}:${ctx.property.externalPropertyId}`;
  }

  private async fail<T>(ctx: AuthorizedQueryContext, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof Ga4ApiError && err.kind === "unauthenticated") await this.deps.onAuthRejected?.(ctx).catch(() => undefined);
      throw toGa4ConnectorError(err);
    }
  }

  /** Runs a Google call with the connection's token; on a 401 refreshes the token once and retries before giving up. */
  private async authed<T>(ctx: AuthorizedQueryContext, op: (token: string) => Promise<T>): Promise<T> {
    let token = await this.deps.getAccessToken(ctx);
    return this.fail(ctx, async () => {
      try {
        return await op(token);
      } catch (err) {
        if (!(err instanceof Ga4ApiError && err.kind === "unauthenticated") || !this.deps.refreshAccessToken) throw err;
        token = await this.deps.refreshAccessToken(ctx);
        return op(token);
      }
    });
  }

  async describeFields(ctx: AuthorizedQueryContext): Promise<Ga4Metadata> {
    const key = this.key(ctx);
    const hit = this.metadata.get(key);
    if (hit && hit.expiresAt > this.nowMs()) return hit.value;
    const value = await this.authed(ctx, (token) => this.deps.client.getMetadata(token, ctx.property.externalPropertyId, ctx.signal));
    this.metadata.set(key, { value, expiresAt: this.nowMs() + this.ttl });
    return value;
  }

  async query(query: Ga4Query, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const propertyId = ctx.property.externalPropertyId;
    const metadata = await this.describeFields(ctx);
    validateGa4Fields(query, metadata);

    // Filter fields must work with the rest of the report too, so they are checked with the requested fields.
    const compatDims = [...new Set([...query.dimensions, ...query.dimensionFilters.map((f) => f.field)])];
    const compatMets = [...new Set([...query.metrics, ...query.metricFilters.map((f) => f.field)])];
    const compatKey = `${this.key(ctx)}|${[...compatDims].sort().join(",")}|${[...compatMets].sort().join(",")}`;
    let compat = this.compat.get(compatKey);
    if (!compat || compat.expiresAt <= this.nowMs()) {
      const result = await this.authed(ctx, (token) => this.deps.client.checkCompatibility(token, propertyId, { dimensions: compatDims, metrics: compatMets }, ctx.signal));
      compat = { value: { dims: result.incompatibleDimensions, mets: result.incompatibleMetrics }, expiresAt: this.nowMs() + this.ttl };
      this.compat.set(compatKey, compat);
    }
    if (compat.value.dims.length > 0 || compat.value.mets.length > 0) throw describeIncompatibility(compat.value.dims, compat.value.mets);

    const request = buildRunReportRequest(query);
    const response = await this.authed(ctx, (token) => this.gate.run(this.key(ctx), () => this.deps.client.runReport(token, propertyId, request, ctx.signal)));
    const { rows, warnings, completeness, providerMetadata, timeZone, totals } = normalizeGa4Response(query, response, ctx.property.timezone);
    const labels = Object.fromEntries([...metadata.dimensions, ...metadata.metrics].map((f) => [f.apiName, f.uiName]));
    const types = Object.fromEntries(response.metricHeaders.map((h) => [h.name, h.type]));
    const pagination = providerMetadata.pagination as { nextOffset: number | null };
    const summary = buildGa4Summary({
      propertyName: ctx.property.displayName,
      rows,
      totals,
      dimensions: query.dimensions,
      metrics: query.metrics,
      labels,
      types,
      currency: response.currencyCode,
      rowCount: response.rowCount,
      startDate: query.startDate,
      endDate: query.endDate,
    });
    const codes = new Set(warnings.map((w) => w.code));
    const nextStep =
      pagination.nextOffset !== null ? `Ask for the next page with offset ${pagination.nextOffset}.`
      : codes.has("OTHER_ROW_AGGREGATION") || codes.has("THRESHOLDING_APPLIED") ? "Narrow the date range or add a filter to avoid grouped or withheld rows."
      : "Add compareTo (previous_period or previous_year) to see how this changed, or filter to one page or channel to dig in.";

    const all: ReportWarning[] = this.mock ? [{ code: "MOCK_DATA", message: "Synthetic fixture data; not from Google." }, ...warnings] : warnings;
    const sort = request.orderBys[0]!;
    return {
      provider: "ga4",
      property: { id: propertyId, name: ctx.property.displayName },
      report: {
        startDate: query.startDate,
        endDate: query.endDate,
        dateSemantics: `GA4 property reporting time zone (${timeZone ?? "unknown"})`,
        dimensions: query.dimensions,
        metrics: query.metrics,
        sort: [{ field: sort.metric?.metricName ?? sort.dimension!.dimensionName, direction: sort.desc ? "desc" : "asc" }],
        limit: query.limit,
      },
      rows,
      rowCountReturned: rows.length,
      rowCountReportedByProvider: response.rowCount,
      fetchedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      cache: { hit: false, ageSeconds: 0 },
      completeness,
      mock: this.mock,
      warnings: all,
      ...(totals && { totals }),
      summary,
      nextStep,
      providerMetadata: { ...providerMetadata, fieldLabels: labels },
      requestId: ctx.requestId,
    };
  }

  async queryRealtime(query: Ga4RealtimeQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const propertyId = ctx.property.externalPropertyId;
    validateGa4RealtimeFields(query);
    const request = buildRealtimeRequest(query);
    const response = await this.authed(ctx, (token) => this.gate.run(this.key(ctx), () => this.deps.client.runRealtimeReport(token, propertyId, request, ctx.signal)));
    const { rows, warnings, completeness, providerMetadata, totals } = normalizeGa4Response({ dimensions: query.dimensions, metrics: query.metrics, offset: 0, limit: query.limit }, response, ctx.property.timezone);
    const types = Object.fromEntries(response.metricHeaders.map((h) => [h.name, h.type]));
    const window = `the last ${query.minutes} minute${query.minutes === 1 ? "" : "s"}`;
    const base = buildGa4Summary({ propertyName: ctx.property.displayName, rows, totals, dimensions: query.dimensions, metrics: query.metrics, labels: REALTIME_LABELS, types, currency: null, rowCount: response.rowCount, startDate: null, endDate: null, scope: window });
    const all: ReportWarning[] = [
      ...(this.mock ? [{ code: "MOCK_DATA", message: "Synthetic fixture data; not from Google." }] : []),
      { code: "REALTIME_NOT_FINAL", message: "Realtime data is a live snapshot of the last 30 minutes at most. It is not final, is not the same as the standard reports, and cannot be compared with them." },
      ...warnings.filter((w) => w.code !== "UNIQUE_METRICS_NOT_ADDITIVE"),
    ];
    return {
      provider: "ga4",
      property: { id: propertyId, name: ctx.property.displayName },
      report: { startDate: null, endDate: null, dateSemantics: `Realtime: ${window}, as of the moment of the request`, dimensions: query.dimensions, metrics: query.metrics, sort: [{ field: query.metrics[0]!, direction: "desc" }], limit: query.limit },
      rows,
      rowCountReturned: rows.length,
      rowCountReportedByProvider: response.rowCount,
      fetchedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      cache: { hit: false, ageSeconds: 0 },
      completeness,
      mock: this.mock,
      warnings: all,
      ...(totals && { totals }),
      summary: base,
      nextStep: "Ask again in a few minutes for a fresh snapshot, or use query_ga4_report for confirmed daily numbers.",
      providerMetadata,
      requestId: ctx.requestId,
    };
  }

  async queryCohort(query: Ga4CohortQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const propertyId = ctx.property.externalPropertyId;
    const request = buildCohortRequest(query);
    const response = await this.authed(ctx, (token) => this.gate.run(this.key(ctx), () => this.deps.client.runReport(token, propertyId, request, ctx.signal)));
    const today = todayInZone(this.deps.now?.() ?? new Date(), ctx.property.timezone);
    const { rows, warnings, averageRetention } = normalizeCohortResponse(query, response, today);
    const unit = query.granularity === "DAILY" ? "day" : query.granularity === "WEEKLY" ? "week" : "month";
    const later = Object.entries(averageRetention).filter(([k]) => Number(k) > 0);
    const retentionLine = later.length > 0 ? ` On average ${later.slice(0, 3).map(([k, v]) => `${v}% were still active in ${unit} ${k}`).join(", ")}.` : "";
    const summary = rows.length === 0 ? `${ctx.property.displayName}: GA4 returned no cohort data.` : `${ctx.property.displayName}: ${query.ranges.length} ${unit}ly cohort(s) of first-time visitors followed for ${query.periods} ${unit}s.${retentionLine}`;
    const all: ReportWarning[] = [...(this.mock ? [{ code: "MOCK_DATA", message: "Synthetic fixture data; not from Google." }] : []), ...warnings];
    return {
      provider: "ga4",
      property: { id: propertyId, name: ctx.property.displayName },
      report: { startDate: query.startDate, endDate: query.endDate, dateSemantics: `GA4 property reporting time zone (${response.timeZone ?? ctx.property.timezone ?? "unknown"}); cohorts are users by the ${unit} of their first visit`, dimensions: ["cohort", unit], metrics: [query.metric, ...(query.metric === "cohortActiveUsers" ? ["retentionPct"] : [])], sort: [{ field: "cohort", direction: "asc" }], limit: 1000 },
      rows,
      rowCountReturned: rows.length,
      rowCountReportedByProvider: response.rowCount,
      fetchedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      cache: { hit: false, ageSeconds: 0 },
      completeness: warnings.some((w) => w.code === "THRESHOLDING_APPLIED") ? "partial" : "complete",
      mock: this.mock,
      warnings: all,
      summary,
      nextStep: `Compare channels by adding a filter such as sessionDefaultChannelGroup = Organic Search, or try ${query.granularity === "WEEKLY" ? "MONTHLY" : "WEEKLY"} cohorts.`,
      providerMetadata: { averageRetention, cohorts: query.ranges },
      requestId: ctx.requestId,
    };
  }
}
