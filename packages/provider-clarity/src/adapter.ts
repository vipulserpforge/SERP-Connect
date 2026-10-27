import {
  ConnectorException,
  type AuthorizedQueryContext,
  type GetClarityInsightsInput,
  type NormalizedReportResult,
  type ReportAdapter,
} from "@serp/contracts";
import { ClarityApiError, type ClarityApiClient } from "./client.js";
import { CLARITY_DOCS_URL } from "./constants.js";
import { buildClarityResult, parseClarityResponse } from "./normalize.js";
import type { ClarityQuotaStore } from "./quota.js";

export type ClarityQuery = GetClarityInsightsInput;
export type ClarityAdapter = ReportAdapter<ClarityQuery>;

/** What the connection record should learn from a real provider answer. Implemented by the credential layer. */
export interface ClarityConnectionHooks {
  onSuccess(ctx: AuthorizedQueryContext): Promise<void>;
  onAuthRejected(ctx: AuthorizedQueryContext, code: "AUTH_EXPIRED" | "FORBIDDEN"): Promise<void>;
  onRateLimited(ctx: AuthorizedQueryContext): Promise<void>;
}

export interface LiveClarityDeps {
  client: ClarityApiClient;
  quota: ClarityQuotaStore;
  /** Decrypts the token of the connection the authorization step already resolved. Never a caller-supplied id. */
  getToken(ctx: AuthorizedQueryContext): Promise<string>;
  hooks: ClarityConnectionHooks;
  now?: () => Date;
}

const exhausted = (message: string) =>
  new ConnectorException("CLARITY_DAILY_BUDGET_EXHAUSTED", message, {
    provider: "clarity",
    suggestedAction: "Try again after the next UTC day starts, or use a cached report.",
  });

/**
 * The only code that calls Clarity. Order matters: decrypt, reserve one unit of the durable budget, call once (no retries:
 * each retry would spend quota), record the outcome. A reservation is never refunded.
 */
export class LiveClarityAdapter implements ClarityAdapter {
  readonly provider = "clarity" as const;
  readonly mock = false;

  constructor(private readonly deps: LiveClarityDeps) {}

  async query(query: ClarityQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const { client, quota, hooks } = this.deps;
    const now = () => this.deps.now?.() ?? new Date();
    const token = await this.deps.getToken(ctx);

    const reservation = await quota.reserve({ projectKey: ctx.property.externalPropertyId, userId: ctx.userId, connectionId: ctx.connection.id, now: now() });
    if (!reservation.allowed) {
      throw exhausted(`This app's daily Clarity request budget for this project (${reservation.localBudget} of Clarity's 10) is used up. Saved results still work; fresh data returns after 00:00 UTC.`);
    }

    let body: unknown;
    try {
      body = await client.exportLiveInsights(token, { numOfDays: query.numOfDays, dimensions: query.dimensions }, ctx.signal);
    } catch (err) {
      const apiErr = err instanceof ClarityApiError ? err : new ClarityApiError("unavailable", null);
      await quota.complete(reservation.reservationId, apiErr.kind === "quota" ? "provider_limited" : "failed", apiErr.httpStatus, now());
      return this.raise(apiErr, ctx);
    }

    const parsed = parseClarityResponse(body, query.dimensions);
    if (!parsed) {
      await quota.complete(reservation.reservationId, "failed", 200, now());
      throw new ConnectorException("PROVIDER_UNAVAILABLE", "Clarity returned a response in an unexpected format.", {
        provider: "clarity",
        suggestedAction: `Try again later. If it persists, check ${CLARITY_DOCS_URL} for API changes.`,
      });
    }
    await quota.complete(reservation.reservationId, "succeeded", 200, now());
    await hooks.onSuccess(ctx);
    return buildClarityResult({
      parsed,
      numOfDays: query.numOfDays,
      dimensions: query.dimensions,
      property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
      requestId: ctx.requestId,
      now: now(),
      mock: false,
    });
  }

  private async raise(err: ClarityApiError, ctx: AuthorizedQueryContext): Promise<never> {
    const { hooks } = this.deps;
    switch (err.kind) {
      case "unauthorized":
        await hooks.onAuthRejected(ctx, "AUTH_EXPIRED");
        throw new ConnectorException("AUTH_EXPIRED", "Clarity rejected the token (401). It is wrong, expired, or was replaced by a newer one.", {
          provider: "clarity",
          suggestedAction: "In Clarity, generate a new token (Settings → Data Export) and reconnect it from the dashboard.",
        });
      case "forbidden":
        await hooks.onAuthRejected(ctx, "FORBIDDEN");
        throw new ConnectorException("FORBIDDEN", "Clarity says this token is not allowed to export data for this project (403).", {
          provider: "clarity",
          suggestedAction: "Ask a Clarity project admin to generate the token, then reconnect it.",
        });
      case "quota":
        await hooks.onRateLimited(ctx);
        throw exhausted("Clarity says this project has used its 10 requests for today (429). Saved results still work; fresh data returns after 00:00 UTC.");
      case "invalid_request":
        throw new ConnectorException("INVALID_QUERY", "Clarity rejected the request (400): the number of days or a dimension was not accepted. Use 1, 2 or 3 days and at most 3 listed dimensions.", { provider: "clarity" });
      case "bad_response":
        throw new ConnectorException("PROVIDER_UNAVAILABLE", "Clarity returned a response in an unexpected format.", { provider: "clarity" });
      default:
        throw new ConnectorException("PROVIDER_UNAVAILABLE", "Clarity could not be reached or did not answer in time.", {
          provider: "clarity",
          retryable: true,
          suggestedAction: "Try again later. Each attempt uses part of the daily request limit, so avoid repeated retries.",
        });
    }
  }
}

/** Synthetic fixture shaped like the documented response. Honours the same quota store so budget behaviour can be demoed. */
export class MockClarityAdapter implements ClarityAdapter {
  readonly provider = "clarity" as const;
  readonly mock = true;

  constructor(private readonly quota?: ClarityQuotaStore, private readonly clock: () => Date = () => new Date()) {}

  async query(query: ClarityQuery, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    if (this.quota) {
      const r = await this.quota.reserve({ projectKey: ctx.property.externalPropertyId, userId: ctx.userId, connectionId: ctx.connection.id, now: this.clock() });
      if (!r.allowed) throw exhausted(`This app's daily Clarity request budget for this project (${r.localBudget}) is used up.`);
      await this.quota.complete(r.reservationId, "succeeded", 200, this.clock());
    }
    const dims = query.dimensions;
    const label = (i: number) => (j: string) => `${j} ${["A", "B", "C"][i]}`;
    const dimCols = (i: number) => Object.fromEntries(dims.map((d) => [d, label(i)(d)]));
    const sessions = [3000, 1800, 900];
    const body = [
      {
        metricName: "Traffic",
        information: sessions.map((s, i) => ({ totalSessionCount: String(s), totalBotSessionCount: String(Math.round(s / 10)), distantUserCount: String(Math.round(s * 0.7)), PagesPerSessionPercentage: 1.5 - i * 0.2, ...dimCols(i) })),
      },
      { metricName: "Dead Click Count", information: sessions.map((s, i) => ({ sessionsCount: String(Math.round(s / 20)), sessionsWithMetricPercentage: 5 - i, subTotal: String(Math.round(s / 10)), ...dimCols(i) })) },
      { metricName: "Rage Click Count", information: sessions.map((s, i) => ({ sessionsCount: String(Math.round(s / 40)), sessionsWithMetricPercentage: 2.5 - i * 0.5, subTotal: String(Math.round(s / 30)), ...dimCols(i) })) },
    ];
    const parsed = parseClarityResponse(body, dims)!;
    return buildClarityResult({
      parsed,
      numOfDays: query.numOfDays,
      dimensions: dims,
      property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
      requestId: ctx.requestId,
      now: new Date(),
      mock: true,
      extraWarnings: [{ code: "MOCK_DATA", message: "Synthetic fixture data; not from Clarity." }],
    });
  }
}

export function createClarityAdapter(mode: "mock", quota?: ClarityQuotaStore, now?: () => Date): ClarityAdapter;
export function createClarityAdapter(mode: "live", deps: LiveClarityDeps): ClarityAdapter;
export function createClarityAdapter(mode: "mock" | "live", arg?: ClarityQuotaStore | LiveClarityDeps, now?: () => Date): ClarityAdapter {
  if (mode === "mock") return new MockClarityAdapter(arg as ClarityQuotaStore | undefined, now);
  if (!arg) {
    throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Live Clarity access needs a database and encryption keys, which are not configured.", { provider: "clarity" });
  }
  return new LiveClarityAdapter(arg as LiveClarityDeps);
}
