import {
  ConnectorException,
  type AuthorizedQueryContext,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportWarning,
  isConnectorException,
} from "@serp/contracts";
import { Ga4ApiError, type Ga4ApiClient, type Ga4Metadata } from "./api-client.js";
import { buildRunReportRequest, describeIncompatibility, normalizeGa4Response, validateGa4Fields, type Ga4Query } from "./query.js";

export type Ga4Adapter = ReportAdapter<Ga4Query> & {
  /** Fields valid on one property (standard and custom). Property-specific, so it needs an authorized context. */
  describeFields?(ctx: AuthorizedQueryContext): Promise<Ga4Metadata>;
};

export interface GoogleGa4AdapterDeps {
  client: Ga4ApiClient;
  getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>;
  onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>;
  now?: () => Date;
  /** How long property metadata and compatibility answers are reused. */
  metadataTtlMs?: number;
  /** Most concurrent reports per property; GA4 allows 10 per property. */
  maxConcurrentPerProperty?: number;
}

const RECONNECT = "Reconnect the Google account from the dashboard.";

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

  async describeFields(ctx: AuthorizedQueryContext): Promise<Ga4Metadata> {
    const key = this.key(ctx);
    const hit = this.metadata.get(key);
    if (hit && hit.expiresAt > this.nowMs()) return hit.value;
    const token = await this.deps.getAccessToken(ctx);
    const value = await this.fail(ctx, () => this.deps.client.getMetadata(token, ctx.property.externalPropertyId, ctx.signal));
    this.metadata.set(key, { value, expiresAt: this.nowMs() + this.ttl });
    return value;
  }

  async query(query: Ga4Query, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const propertyId = ctx.property.externalPropertyId;
    const metadata = await this.describeFields(ctx);
    validateGa4Fields(query, metadata);

    const token = await this.deps.getAccessToken(ctx);
    const compatKey = `${this.key(ctx)}|${[...query.dimensions].sort().join(",")}|${[...query.metrics].sort().join(",")}`;
    let compat = this.compat.get(compatKey);
    if (!compat || compat.expiresAt <= this.nowMs()) {
      const result = await this.fail(ctx, () => this.deps.client.checkCompatibility(token, propertyId, { dimensions: query.dimensions, metrics: query.metrics }, ctx.signal));
      compat = { value: { dims: result.incompatibleDimensions, mets: result.incompatibleMetrics }, expiresAt: this.nowMs() + this.ttl };
      this.compat.set(compatKey, compat);
    }
    if (compat.value.dims.length > 0 || compat.value.mets.length > 0) throw describeIncompatibility(compat.value.dims, compat.value.mets);

    const request = buildRunReportRequest(query);
    const response = await this.fail(ctx, () => this.gate.run(this.key(ctx), () => this.deps.client.runReport(token, propertyId, request, ctx.signal)));
    const { rows, warnings, completeness, providerMetadata, timeZone } = normalizeGa4Response(query, response, ctx.property.timezone);

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
      providerMetadata,
      requestId: ctx.requestId,
    };
  }
}
