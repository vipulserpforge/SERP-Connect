import {
  ConnectorException,
  type AuthorizedQueryContext,
  type NormalizedReportResult,
  type ReportAdapter,
  type ReportWarning,
  isConnectorException,
} from "@serp/contracts";
import { GscApiError, type GscApiClient } from "./api-client.js";
import { GSC_DATE_SEMANTICS, GSC_METRICS, normalizeGscResponse, planGscQuery, type GscQuery } from "./query.js";

export type GscAdapter = ReportAdapter<GscQuery>;

export interface GoogleGscAdapterDeps {
  client: GscApiClient;
  /** Returns a valid access token for the connection in `ctx`. Wired to CredentialService on the server. */
  getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>;
  /** Called when Google rejects the token itself, so the connection can be flagged for reconnect. */
  onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>;
  now?: () => Date;
}

const RECONNECT = "Reconnect the Google account from the dashboard.";

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

    let response;
    try {
      response = await this.deps.client.querySearchAnalytics(accessToken, ctx.property.externalPropertyId, plan.request, ctx.signal);
    } catch (err) {
      if (err instanceof GscApiError && err.kind === "unauthenticated") {
        await this.deps.onAuthRejected?.(ctx).catch(() => undefined);
      }
      throw toGscConnectorError(err);
    }

    const { rows, warnings, completeness } = normalizeGscResponse(query, plan, response);
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
      requestId: ctx.requestId,
    };
  }
}
