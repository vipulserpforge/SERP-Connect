import {
  ConnectorException,
  type AuthorizedQueryContext,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportWarning,
  isConnectorException,
} from "@serp/contracts";
import { GscApiError, type GscApiClient } from "./api-client.js";
import { GSC_DATE_SEMANTICS, GSC_METRICS, buildGscSummary, normalizeGscResponse, planGscQuery, type GscPlan, type GscQuery, type GscTotals } from "./query.js";

export type GscAdapter = ReportAdapter<GscQuery>;

export interface GoogleGscAdapterDeps {
  client: GscApiClient;
  /** Returns a valid access token for the connection in `ctx`. Wired to CredentialService on the server. */
  getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>;
  /** Called when Google rejects the token itself, so the connection can be flagged for reconnect. */
  /** Forces a token refresh after a 401 on a token that looked valid; the query is then retried once. */
  refreshAccessToken?: (ctx: AuthorizedQueryContext) => Promise<string>;
  onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>;
  now?: () => Date;
}

const round4 = (n: number) => Number(n.toFixed(4));
const round2 = (n: number) => Number(n.toFixed(2));

const RECONNECT = "Open the SERP Connect dashboard, find this Google account under Connections and click Reconnect, then ask again.";

/** Translates an API failure into the shared, user-presentable error. Never includes upstream text. */
export function toGscConnectorError(err: unknown): ConnectorException {
  if (isConnectorException(err)) return err;
  if (!(err instanceof GscApiError)) {
    return new ConnectorException("PROVIDER_UNAVAILABLE", "Search Console is temporarily unavailable. Try again shortly.", { provider: "gsc", retryable: true });
  }
  switch (err.kind) {
    case "unauthenticated":
      return new ConnectorException("AUTH_EXPIRED", "Google rejected the stored access. The account needs to be reconnected.", { provider: "gsc", suggestedAction: RECONNECT });
    case "insufficient_scope":
      return new ConnectorException("FORBIDDEN", "This Google connection was not granted Search Console read access.", { provider: "gsc", suggestedAction: `${RECONNECT} Approve the Search Console permission.` });
    case "no_resource_access":
      return new ConnectorException(
        "PROPERTY_NOT_ACCESSIBLE",
        "The connected Google account cannot read this Search Console property (access may have been removed or never verified).",
        { provider: "gsc", suggestedAction: "Check the account's permission in Search Console, or connect an account that has access." },
      );
    case "quota":
      return new ConnectorException("PROVIDER_RATE_LIMITED", "Search Console is rate limiting requests. Wait a moment and retry.", {
        provider: "gsc",
        retryable: true,
        ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
      });
    case "api_disabled":
      return new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "The Search Console API is not enabled for this application. This is a server configuration issue, not your account.", { provider: "gsc" });
    case "invalid_request":
      return new ConnectorException("INVALID_QUERY", "Search Console rejected the query. Check the date range, dimensions and filters.", { provider: "gsc" });
    case "bad_response":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Search Console returned an unexpected response.", { provider: "gsc", retryable: true });
    case "unavailable":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Search Console is temporarily unavailable. Try again shortly.", { provider: "gsc", retryable: true });
  }
}

/** Search Analytics adapter: validates, calls the API client, normalizes. Works with the real or the mock client. */
export class GoogleGscAdapter implements GscAdapter {
  readonly provider = "gsc" as const;

  constructor(private readonly deps: GoogleGscAdapterDeps) {}

  get mock(): boolean {
    return this.deps.client.mock;
  }

  async query(query: GscQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const plan = planGscQuery(query); // fails before any token is touched or any request is made
    const accessToken = await this.deps.getAccessToken(ctx);

    const accessTokenRef = { value: accessToken };
    const run = (token: string) => this.deps.client.querySearchAnalytics(token, ctx.property.externalPropertyId, plan.request, ctx.signal);
    let response;
    try {
      try {
        response = await run(accessToken);
      } catch (err) {
        if (!(err instanceof GscApiError && err.kind === "unauthenticated") || !this.deps.refreshAccessToken) throw err;
        // Google rejected a token we thought was valid: refresh once and retry before asking the user to reconnect.
        accessTokenRef.value = await this.deps.refreshAccessToken(ctx);
        response = await run(accessTokenRef.value);
      }
    } catch (err) {
      if (err instanceof GscApiError && err.kind === "unauthenticated") {
        await this.deps.onAuthRejected?.(ctx).catch(() => undefined);
      }
      throw toGscConnectorError(err);
    }

    const { rows, warnings, completeness } = normalizeGscResponse(query, plan, response);

    // Whole-range totals for the same filters: summing rows is wrong (omitted rare queries, per-page aggregation).
    let totals: GscTotals | null = null;
    if (query.dimensions.length > 0 && rows.length > 0) {
      try {
        const t = await this.fetchTotals(plan, ctx, accessTokenRef.value);
        if (t) totals = { clicks: t.clicks, impressions: t.impressions, ctr: round4(t.ctr), position: round2(t.position) };
      } catch {
        warnings.push({ code: "TOTALS_UNAVAILABLE", message: "The whole-range totals could not be fetched, so no total or share-of-total is shown. The rows themselves are unaffected." });
      }
    } else if (query.dimensions.length === 0 && rows[0]) {
      totals = { clicks: Number(rows[0].clicks), impressions: Number(rows[0].impressions), ctr: Number(rows[0].ctr), position: Number(rows[0].position) };
    }
    const { summary, nextStep } = buildGscSummary(query, rows, totals);
    const all: ReportWarning[] = this.mock ? [{ code: "MOCK_DATA", message: "Synthetic fixture data; not from Google." }, ...warnings] : warnings;
    return {
      provider: "gsc",
      property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
      report: {
        startDate: query.startDate,
        endDate: query.endDate,
        dateSemantics: GSC_DATE_SEMANTICS,
        dimensions: query.dimensions,
        metrics: [...GSC_METRICS],
        sort: [{ field: query.sortBy, direction: query.sortDirection }],
        limit: query.limit,
      },
      rows,
      rowCountReturned: rows.length,
      rowCountReportedByProvider: null,
      fetchedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      cache: { hit: false, ageSeconds: 0 },
      completeness,
      mock: this.mock,
      warnings: all,
      ...(totals && { totals: { ...totals } }),
      summary,
      nextStep,
      requestId: ctx.requestId,
    };
  }

  /** The same filters, dates and type with no grouping: Google answers with one whole-range row. */
  private async fetchTotals(plan: GscPlan, ctx: AuthorizedQueryContext, token: string) {
    const res = await this.deps.client.querySearchAnalytics(token, ctx.property.externalPropertyId, { ...plan.request, dimensions: [], rowLimit: 1, startRow: 0 }, ctx.signal);
    return res.rows[0] ?? null;
  }
}
