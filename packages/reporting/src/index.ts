import { authorizeProperty, type Principal } from "@serp/auth";
import { MemoryReportCache, type CacheScope, type ReportCache } from "@serp/cache";
import {
  ConnectorException,
  GetClarityInsightsSchema,
  GetClarityQuotaStatusSchema,
  QueryBingSchema,
  isConnectorException,
  GetSupportedMetricsSchema,
  QueryGa4Schema,
  QueryGscSchema,
  type AuthorizedQueryContext,
  type ReportWarning,
  toConnectorError,
  type NormalizedReportResult,
  type ProviderConnection,
  type ProviderKey,
  type PropertyRecord,
  type ReportAdapter,
  type SharedEnv,
} from "@serp/contracts";
import { z } from "zod";
import { MockRepository, type Repository } from "@serp/db";
import { createLogger, type Logger } from "@serp/observability";
import {
  canonicalQueryHash,
  canonicalizeGa4Query,
  addDays,
  canonicalizeGscQuery,
  resolveReportDates,
  ttlSeconds,
  validateClarityDays,
  validateGa4DateRange,
  validateGscDateRange,
  type ResolvedDates,
} from "@serp/query-planner";
import { GA4_DIMENSIONS, GA4_METRICS, createGa4Adapter, type Ga4Adapter, type Ga4Query } from "@serp/provider-ga4";
import { BING_CAPABILITIES, BING_DATE_SEMANTICS, MockBingApiClient, createBingAdapter, enabledBingCapabilities, type BingQuery } from "@serp/provider-bing";
import {
  CLARITY_DAILY_REQUEST_LIMIT,
  CLARITY_DIMENSIONS,
  CLARITY_DOCUMENTED_METRICS,
  CLARITY_MAX_ROWS,
  CLARITY_TIME_SEMANTICS,
  MemoryClarityQuotaStore,
  createClarityAdapter,
  validateClarityDimensions,
  type ClarityQuery,
  type ClarityQuotaStore,
  type QuotaStatus,
} from "@serp/provider-clarity";
import { GSC_DIMENSIONS, GSC_METRICS, createGscAdapter, type GscQuery } from "@serp/provider-gsc";
import { RateLimiter, SingleFlight, UserConcurrencyGate } from "./limits.js";

export * from "./limits.js";

export interface ClarityQuotaReport {
  propertyId: string;
  name: string;
  connectionStatus: ProviderConnection["status"];
  lastVerifiedAt: string | null;
  cacheTtlSeconds: number;
  quota: QuotaStatus;
  notes: string[];
}

export interface ReportServiceDeps {
  repo: Repository;
  cache: ReportCache;
  /** Durable (Postgres) in production; in-process for mock mode and tests. Used for status; the adapter reserves through the same store. */
  clarityQuota: ClarityQuotaStore;
  gsc: ReportAdapter<GscQuery>;
  ga4: Ga4Adapter;
  clarity: ReportAdapter<ClarityQuery>;
  bing: ReportAdapter<BingQuery>;
  env: ReportEnv;
  logger: Logger;
  now?: () => Date;
  /** Test seams. Defaults: real timers, Math.random, 4 simultaneous upstream reports per user. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxConcurrentPerUser?: number;
}

export type ReportEnv = Pick<
  SharedEnv,
  | "MAX_REPORT_ROWS_HARD_LIMIT"
  | "REPORT_CACHE_DEFAULT_TTL_SECONDS"
  | "PROVIDER_GSC_ENABLED"
  | "PROVIDER_GA4_ENABLED"
  | "PROVIDER_CLARITY_ENABLED"
  | "PROVIDER_BING_ENABLED"
  | "PROVIDER_REQUEST_TIMEOUT_MS"
  | "REPORT_MAX_RETRIES"
  | "REPORT_RATE_LIMIT_PER_USER_PER_MINUTE"
  | "REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE"
  | "REPORT_MAX_STALE_SECONDS"
>;

type Auth = { property: PropertyRecord; connection: ProviderConnection };
/** How a report window was obtained. Absent for providers whose reports take no date range and were not filtered. */
type PeriodInfo = Pick<ResolvedDates, "resolvedFrom" | "lastDays" | "timeZone">;

/** Errors worth falling back to an older cached report for. Auth and validation errors are never masked. */
const STALE_OK: ReadonlySet<string> = new Set(["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "RATE_LIMITED"]);
const MAX_PROVIDER_RETRY_AFTER_SECONDS = 4;
const BACKOFF_BASE_MS = 250;

export interface ConnectionStatusEntry {
  id: string;
  provider: ProviderConnection["provider"];
  accountLabel: string | null;
  status: ProviderConnection["status"];
  lastValidatedAt: string | null;
  /** Bing only: how this connection authenticates. */
  authMethod: ProviderConnection["authMethod"];
  propertyCount: number;
}

export interface PropertySummary {
  id: string;
  name: string;
  type: string | null;
  timezone: string | null;
  connectionId: string;
}

/** Validates untrusted tool input; failures become the shared INVALID_QUERY error. */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new ConnectorException("INVALID_QUERY", `Invalid input. ${detail}`, { suggestedAction: "Correct the listed fields and try again." });
  }
  return result.data;
}

/** Orchestrates authorization, validation, caching and adapter calls. Holds no HTTP or MCP concerns. */
export class ReportService {
  private readonly flights = new SingleFlight<NormalizedReportResult>();
  private readonly userLimiter: RateLimiter;
  private readonly connectionLimiter: RateLimiter;
  private readonly gate: UserConcurrencyGate;

  constructor(private readonly deps: ReportServiceDeps) {
    const clock = () => this.now().getTime();
    this.userLimiter = new RateLimiter(deps.env.REPORT_RATE_LIMIT_PER_USER_PER_MINUTE, clock);
    this.connectionLimiter = new RateLimiter(deps.env.REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE, clock);
    this.gate = new UserConcurrencyGate(deps.maxConcurrentPerUser ?? 4);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Call when a connection is removed so its cached reports stop being served immediately. */
  async invalidateConnection(userId: string, connectionId: string): Promise<number> {
    return this.deps.cache.invalidate({ userId, connectionId });
  }

  private assertEnabled(provider: ProviderKey): void {
    const e = this.deps.env;
    const enabled = { gsc: e.PROVIDER_GSC_ENABLED, ga4: e.PROVIDER_GA4_ENABLED, clarity: e.PROVIDER_CLARITY_ENABLED, bing: e.PROVIDER_BING_ENABLED }[provider];
    if (!enabled) throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", `${provider} is disabled on this server.`, { provider });
  }

  async getConnectionStatus(principal: Principal): Promise<ConnectionStatusEntry[]> {
    const [connections, properties] = await Promise.all([
      this.deps.repo.listConnections(principal.userId),
      this.deps.repo.listProperties(principal.userId),
    ]);
    return connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      accountLabel: c.accountLabel,
      status: c.status,
      lastValidatedAt: c.lastValidatedAt,
      authMethod: c.authMethod,
      propertyCount: properties.filter((p) => p.connectionId === c.id).length,
    }));
  }

  async listProperties(principal: Principal, provider: ProviderKey, connectionId?: string): Promise<PropertySummary[]> {
    this.assertEnabled(provider);
    const props = await this.deps.repo.listProperties(principal.userId, {
      provider,
      enabledOnly: true,
      ...(connectionId && { connectionId }),
    });
    return props.map((p: PropertyRecord) => ({ id: p.externalPropertyId, name: p.displayName, type: p.propertyType, timezone: p.timezone, connectionId: p.connectionId }));
  }

  async queryGsc(principal: Principal, rawInput: unknown, requestId: string): Promise<NormalizedReportResult> {
    this.assertEnabled("gsc");
    const input = parseInput(QueryGscSchema, rawInput);
    const auth = await authorizeProperty(this.deps.repo, principal, "gsc", input.propertyId);
    const period = resolveReportDates("gsc", input, { dataState: input.dataState, now: this.now() });
    const { lastDays: _l, ...rest } = input;
    const query: GscQuery = canonicalizeGscQuery({ ...rest, startDate: period.startDate, endDate: period.endDate, limit: Math.min(input.limit, this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT) });
    const { warnings } = validateGscDateRange(query.startDate, query.endDate, this.now());
    return this.runReport(this.deps.gsc, query, auth, principal, requestId, period, warnings);
  }

  async queryGa4(principal: Principal, rawInput: unknown, requestId: string): Promise<NormalizedReportResult> {
    this.assertEnabled("ga4");
    const input = parseInput(QueryGa4Schema, rawInput);
    const auth = await authorizeProperty(this.deps.repo, principal, "ga4", input.propertyId);
    const period = resolveReportDates("ga4", input, { timeZone: auth.property.timezone, now: this.now() });
    const { lastDays: _l, ...rest } = input;
    const query: Ga4Query = canonicalizeGa4Query({ ...rest, startDate: period.startDate, endDate: period.endDate, limit: Math.min(input.limit, this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT) });
    const { warnings } = validateGa4DateRange(query.startDate, query.endDate, auth.property.timezone, this.now());
    return this.runReport(this.deps.ga4, query, auth, principal, requestId, period, warnings);
  }

  /**
   * Bing Webmaster reports. Bing's report endpoints take no date range, so any window is applied to the rows it returns; with no
   * window, everything Bing returned is kept. Cached per user, connection, site and request like every other provider.
   */
  async queryBing(principal: Principal, rawInput: unknown, requestId: string): Promise<NormalizedReportResult> {
    this.assertEnabled("bing");
    const input = parseInput(QueryBingSchema, rawInput);
    const auth = await authorizeProperty(this.deps.repo, principal, "bing", input.propertyId);
    const today = this.now().toISOString().slice(0, 10);
    const window =
      input.lastDays !== undefined
        ? { startDate: addDays(today, -(input.lastDays - 1)), endDate: today }
        : { startDate: input.startDate ?? null, endDate: input.endDate ?? null };
    const query: BingQuery = {
      propertyId: auth.property.externalPropertyId,
      report: input.report,
      ...window,
      sortBy: input.sortBy ?? (input.report === "queries" ? "clicks" : "date"),
      sortDirection: input.sortDirection,
      limit: Math.min(input.limit, this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT),
    };
    const period = input.lastDays !== undefined ? { resolvedFrom: "lastDays" as const, lastDays: input.lastDays, timeZone: "UTC" } : input.startDate !== undefined ? { resolvedFrom: "explicit" as const, timeZone: "UTC" } : null;
    return this.runReport(this.deps.bing, query, auth, principal, requestId, period, []);
  }

  /** Validates and authorizes a Clarity request and derives its cache identity. Makes no provider call. */
  private async prepareClarity(principal: Principal, rawInput: unknown) {
    this.assertEnabled("clarity");
    const input = parseInput(GetClarityInsightsSchema, rawInput);
    validateClarityDays(input.numOfDays);
    validateClarityDimensions(input.dimensions);
    const auth = await authorizeProperty(this.deps.repo, principal, "clarity", input.propertyId);
    return { input, auth, scope: this.scope(principal, auth, "clarity"), hash: canonicalQueryHash({ query: input, timeZone: "UTC" }) };
  }

  /**
   * Fetches Clarity insights: cache first (a hit costs no quota), identical concurrent requests share one call, and the
   * live adapter reserves from the durable daily budget before the single, non-retried provider call.
   */
  async getClarityInsights(principal: Principal, rawInput: unknown, requestId: string): Promise<NormalizedReportResult> {
    const { input, auth, scope, hash } = await this.prepareClarity(principal, rawInput);

    const fresh = await this.deps.cache.get<NormalizedReportResult>(scope, hash);
    if (fresh) return this.fromCache(fresh.value, fresh.fetchedAt, requestId);

    const flightKey = [scope.userId, scope.provider, scope.connectionId, scope.propertyId, hash].join(":");
    const { promise } = this.flights.run(flightKey, async () => {
      const raced = await this.deps.cache.get<NormalizedReportResult>(scope, hash);
      if (raced) return this.fromCache(raced.value, raced.fetchedAt, requestId);
      try {
        const user = this.userLimiter.take(principal.userId);
        if (!user.ok) throw this.rateLimited("You have run too many reports in a short time.", user.retryAfterSeconds);
        const result = await this.deps.clarity.query(input, this.context(principal, auth, requestId));
        result.cache = { hit: false, ageSeconds: 0 };
        await this.deps.cache.set(scope, hash, result, ttlSeconds("clarity", null, this.now(), { defaultSeconds: this.deps.env.REPORT_CACHE_DEFAULT_TTL_SECONDS }), { rowCount: result.rowCountReturned });
        this.deps.logger.info("report.executed", { provider: "clarity", requestId, rows: result.rowCountReturned, mock: result.mock });
        return result;
      } catch (err) {
        const code = toConnectorError(err, requestId).code;
        // Out of budget or provider trouble: an older saved result beats nothing. Auth and validation errors are never masked.
        if (code !== "CLARITY_DAILY_BUDGET_EXHAUSTED" && code !== "PROVIDER_UNAVAILABLE") throw err;
        const stale = await this.deps.cache.get<NormalizedReportResult>(scope, hash, { allowStale: true, maxStaleSeconds: this.deps.env.REPORT_MAX_STALE_SECONDS }).catch(() => null);
        if (!stale) throw err;
        const served = this.fromCache(stale.value, stale.fetchedAt, requestId, true);
        served.warnings.push({
          code: "STALE_CACHE",
          message:
            code === "CLARITY_DAILY_BUDGET_EXHAUSTED"
              ? "The daily Clarity request budget is used up, so this is the most recent saved result."
              : "Clarity could not be reached, so this is the most recent saved result and may be out of date.",
        });
        return served;
      }
    });
    return { ...this.copy(await promise), requestId };
  }

  /** Saved Clarity data only. Never calls Clarity and never touches the quota, so a page view is always free. */
  async peekClarityCache(principal: Principal, rawInput: unknown, requestId: string): Promise<NormalizedReportResult | null> {
    const { scope, hash } = await this.prepareClarity(principal, rawInput);
    const fresh = await this.deps.cache.get<NormalizedReportResult>(scope, hash);
    if (fresh) return this.fromCache(fresh.value, fresh.fetchedAt, requestId);
    const stale = await this.deps.cache.get<NormalizedReportResult>(scope, hash, { allowStale: true, maxStaleSeconds: this.deps.env.REPORT_MAX_STALE_SECONDS });
    if (!stale) return null;
    const served = this.fromCache(stale.value, stale.fetchedAt, requestId, true);
    served.warnings.push({ code: "STALE_CACHE", message: "This saved result has expired. Fetching fresh data uses part of the daily request limit." });
    return served;
  }

  /** Application-tracked quota for one of the caller's own Clarity properties. */
  async getClarityQuotaStatus(principal: Principal, propertyId: string): Promise<ClarityQuotaReport> {
    this.assertEnabled("clarity");
    const auth = await authorizeProperty(this.deps.repo, principal, "clarity", parseInput(GetClarityQuotaStatusSchema, { propertyId }).propertyId);
    const quota = await this.deps.clarityQuota.status(auth.property.externalPropertyId, this.now());
    return {
      propertyId: auth.property.externalPropertyId,
      name: auth.property.displayName,
      connectionStatus: auth.connection.status,
      lastVerifiedAt: auth.connection.lastValidatedAt,
      cacheTtlSeconds: ttlSeconds("clarity", null, this.now(), { defaultSeconds: this.deps.env.REPORT_CACHE_DEFAULT_TTL_SECONDS }),
      quota,
      notes: [
        "Usage is counted by this application only. Clarity does not expose an authoritative counter, so other uses of the same token are not included.",
        "The reset time is not documented by Clarity; this app assumes the UTC calendar day.",
        "Failed calls are counted as used, because it is not documented whether Clarity counts them.",
      ],
    };
  }

  async getSupportedMetrics(principal: Principal, rawInput: unknown) {
    const { provider, propertyId } = parseInput(GetSupportedMetricsSchema, rawInput);
    switch (provider) {
      case "gsc":
        return { provider, dimensions: [...GSC_DIMENSIONS], metrics: [...GSC_METRICS], limits: { maxRows: this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT, retentionMonths: 16, dateSemantics: "Pacific Time" }, notes: ["Results may omit rows due to Google's internal limits.", "The latest 1-2 days can be incomplete; set dataState to \"all\" to include fresh, still-changing days.", "Grouping by query omits anonymized queries.", "searchAppearance must be queried on its own.", "Sorting by anything other than clicks is applied to up to 25,000 rows fetched from Google."] };
      case "ga4": {
        const limits = { maxRows: this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT, maxDimensions: 9, maxMetrics: 10, dateSemantics: "Property reporting time zone", earliestStartDate: "2015-08-14" };
        const notes = ["Not every dimension can be combined with every metric; incompatible requests are rejected with the fields to remove.", "User counts are distinct per row and are not additive.", "Recent days can take 24-48 hours to finish processing."];
        if (!propertyId) {
          return { provider, dimensions: [...GA4_DIMENSIONS], metrics: [...GA4_METRICS], limits, notes: [...notes, "Starter list. Pass propertyId to get the exact fields (including custom ones) for a property."] };
        }
        this.assertEnabled("ga4");
        const auth = await authorizeProperty(this.deps.repo, principal, "ga4", propertyId);
        if (!this.deps.ga4.describeFields) return { provider, propertyId, dimensions: [...GA4_DIMENSIONS], metrics: [...GA4_METRICS], limits, notes };
        const fields = await this.deps.ga4.describeFields(this.context(principal, auth, "supported-metrics"));
        const brief = (f: { apiName: string; uiName: string; category: string; custom: boolean }) => ({ name: f.apiName, label: f.uiName, category: f.category, custom: f.custom });
        return { provider, propertyId, dimensions: fields.dimensions.map(brief), metrics: fields.metrics.map(brief), limits, notes };
      }
      case "clarity":
        return {
          provider,
          dimensions: [...CLARITY_DIMENSIONS],
          metrics: [...CLARITY_DOCUMENTED_METRICS],
          limits: { numOfDays: [1, 2, 3], maxDimensions: 3, maxRows: CLARITY_MAX_ROWS, requestsPerProjectPerDay: CLARITY_DAILY_REQUEST_LIMIT, dateSemantics: CLARITY_TIME_SEMANTICS },
          notes: [
            "Clarity measures on-site behaviour (sessions, engagement, clicks, scrolling, errors). It does not provide search rankings, impressions or organic clicks: use Search Console for those and GA4 for analytics.",
            "Rolling last 24/48/72 hours in UTC only: no custom date ranges, no history, no pagination (1,000 rows max per metric).",
            "Metric names are listed from Clarity's documentation; a real response may omit some and include others. Values missing from a response are not zero.",
            "Each project may make only 10 requests per day. Results are cached; repeat questions are free, fresh fetches are not.",
          ],
        };
      case "bing":
        this.assertEnabled("bing");
        return {
          provider,
          dimensions: ["date", "query"],
          metrics: ["clicks", "impressions", "avgClickPosition", "avgImpressionPosition", "crawledPages", "crawlErrors", "inIndex", "inLinks", "code2xx", "code301", "code302", "code4xx", "code5xx", "allOtherCodes", "blockedByRobotsTxt", "containsMalware"],
          reports: enabledBingCapabilities()
            .filter((c) => c.id !== "sites")
            .map((c) => ({ report: c.id, bingMethod: c.endpoint, fields: c.responseFields, freshness: c.freshness })),
          disabledReports: BING_CAPABILITIES.filter((c) => !c.enabled && c.status === "unverified").map((c) => ({ report: c.id, reason: c.note })),
          limits: { maxRows: this.deps.env.MAX_REPORT_ROWS_HARD_LIMIT, dateSemantics: BING_DATE_SEMANTICS, quota: "Bing documents no numeric request limit; it may answer with a throttling error, which is reported as such." },
          notes: [
            "These are Bing's own numbers. Bing counts clicks, impressions and positions differently from Google Search Console: never add them together or treat them as the same measure.",
            "Bing's report endpoints take no date range. This server applies startDate/endDate/lastDays to the rows Bing returns; with none given you get everything Bing returned, newest first.",
            "The query report is documented as updated weekly and does not say which queries it includes.",
            "A missing value is not zero. An empty result means Bing reported nothing.",
          ],
        };
    }
  }

  private context(principal: Principal, auth: { property: PropertyRecord; connection: ProviderConnection }, requestId: string): AuthorizedQueryContext {
    return { userId: principal.userId, requestId, property: auth.property, connection: auth.connection };
  }

  private scope(principal: Principal, auth: Auth, provider: ProviderKey): CacheScope {
    return { userId: principal.userId, provider, connectionId: auth.connection.id, propertyId: auth.property.id };
  }

  /** A caller-owned copy, so one caller mutating its result can never alter another's (or the cached one). */
  private fromCache(value: NormalizedReportResult, fetchedAt: number, requestId: string, stale = false): NormalizedReportResult {
    return {
      ...value,
      requestId,
      rows: value.rows.map((r) => ({ ...r })),
      warnings: value.warnings.map((w) => ({ ...w })),
      cache: { hit: true, ageSeconds: Math.max(0, Math.round((this.now().getTime() - fetchedAt) / 1000)), ...(stale && { stale: true }) },
    };
  }

  private async runReport<Q extends { startDate: string | null; endDate: string | null }>(
    adapter: ReportAdapter<Q>,
    query: Q,
    auth: Auth,
    principal: Principal,
    requestId: string,
    period: PeriodInfo | null,
    warnings: ReportWarning[],
  ): Promise<NormalizedReportResult> {
    const scope = this.scope(principal, auth, adapter.provider);
    const hash = canonicalQueryHash({ query, timeZone: period?.timeZone ?? "none" });

    const hit = await this.deps.cache.get<NormalizedReportResult>(scope, hash);
    if (hit) return this.fromCache(hit.value, hit.fetchedAt, requestId);

    // The flight key carries the whole scope: only the same user, connection, property and request ever share a call.
    const flightKey = [scope.userId, scope.provider, scope.connectionId, scope.propertyId, hash].join(":");
    const { promise, joined } = this.flights.run(flightKey, async () => {
      const raced = await this.deps.cache.get<NormalizedReportResult>(scope, hash);
      if (raced) return this.fromCache(raced.value, raced.fetchedAt, requestId);
      return this.fetchAndStore(adapter, query, auth, principal, requestId, period, warnings, scope, hash);
    });
    const result = await promise;
    if (joined) this.deps.logger.info("report.coalesced", { provider: adapter.provider, requestId });
    return { ...this.copy(result), requestId };
  }

  private copy(r: NormalizedReportResult): NormalizedReportResult {
    return { ...r, rows: r.rows.map((x) => ({ ...x })), warnings: r.warnings.map((w) => ({ ...w })), cache: { ...r.cache } };
  }

  private async fetchAndStore<Q extends { startDate: string | null; endDate: string | null }>(
    adapter: ReportAdapter<Q>,
    query: Q,
    auth: Auth,
    principal: Principal,
    requestId: string,
    period: PeriodInfo | null,
    warnings: ReportWarning[],
    scope: CacheScope,
    hash: string,
  ): Promise<NormalizedReportResult> {
    try {
      this.takeBudget(principal.userId, auth.connection.id);
      const release = this.gate.acquire(principal.userId);
      let result: NormalizedReportResult;
      try {
        result = await this.callWithRetries(adapter, query, this.context(principal, auth, requestId));
      } finally {
        release();
      }
      result.warnings.push(...warnings);
      if (period) result.report.period = { resolvedFrom: period.resolvedFrom, ...(period.lastDays !== undefined && { lastDays: period.lastDays }), timeZone: period.timeZone };
      result.cache = { hit: false, ageSeconds: 0 };
      const ttl = ttlSeconds(adapter.provider, query.endDate, this.now(), { defaultSeconds: this.deps.env.REPORT_CACHE_DEFAULT_TTL_SECONDS });
      await this.deps.cache.set(scope, hash, result, ttl, { ...(query.startDate && { startDate: query.startDate }), ...(query.endDate && { endDate: query.endDate }), rowCount: result.rowCountReturned });
      this.deps.logger.info("report.executed", { provider: adapter.provider, requestId, rows: result.rowCountReturned, mock: result.mock });
      return result;
    } catch (err) {
      const stale = STALE_OK.has(toConnectorError(err, requestId).code)
        ? await this.deps.cache.get<NormalizedReportResult>(scope, hash, { allowStale: true, maxStaleSeconds: this.deps.env.REPORT_MAX_STALE_SECONDS }).catch(() => null)
        : null;
      if (!stale) throw err;
      this.deps.logger.warn("report.served_stale", { provider: adapter.provider, requestId });
      const served = this.fromCache(stale.value, stale.fetchedAt, requestId, true);
      served.warnings.push({ code: "STALE_CACHE", message: "The provider could not be reached, so this is the most recent saved result and may be out of date." });
      return served;
    }
  }

  /** Per-user and per-connection budgets, charged only for real upstream calls. */
  private takeBudget(userId: string, connectionId: string): void {
    const user = this.userLimiter.take(userId);
    if (!user.ok) throw this.rateLimited("You have run too many reports in a short time.", user.retryAfterSeconds);
    const conn = this.connectionLimiter.take(connectionId);
    if (!conn.ok) {
      this.userLimiter.refund(userId);
      throw this.rateLimited("This connection has reached its report limit for now, which protects its quota with the provider.", conn.retryAfterSeconds);
    }
  }

  private rateLimited(message: string, retryAfterSeconds: number): ConnectorException {
    return new ConnectorException("RATE_LIMITED", message, { retryable: true, retryAfterSeconds, suggestedAction: `Try again in ${retryAfterSeconds} seconds.` });
  }

  /** One total deadline across attempts; only transient provider failures are retried, with exponential backoff and jitter. */
  private async callWithRetries<Q>(adapter: ReportAdapter<Q>, query: Q, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const { PROVIDER_REQUEST_TIMEOUT_MS: timeoutMs, REPORT_MAX_RETRIES: maxRetries } = this.deps.env;
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = new Error("timeout");
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    const timedOut = () =>
      new ConnectorException("PROVIDER_UNAVAILABLE", `${adapter.provider.toUpperCase()} did not respond in time.`, {
        provider: adapter.provider,
        retryable: true,
        suggestedAction: "Try again shortly, or narrow the date range or row limit.",
      });
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = this.deps.random ?? Math.random;
    try {
      for (let attempt = 0; ; attempt++) {
        let failure: unknown;
        try {
          return await new Promise<NormalizedReportResult>((resolve, reject) => {
            const onAbort = () => reject(timedOut());
            if (controller.signal.aborted) return onAbort();
            controller.signal.addEventListener("abort", onAbort, { once: true });
            adapter.query(query, { ...ctx, signal: controller.signal }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
          });
        } catch (err) {
          failure = err;
        }
        const delay = this.retryDelayMs(adapter.provider, failure, attempt, random);
        if (delay === null || attempt >= maxRetries || Date.now() + delay >= deadlineAt) throw failure;
        this.deps.logger.warn("report.retry", { provider: adapter.provider, requestId: ctx.requestId, attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
      }
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  /** null = do not retry. Quota, auth and validation failures are never retried: another attempt cannot help and may cost quota. */
  private retryDelayMs(provider: ProviderKey, err: unknown, attempt: number, random: () => number): number | null {
    if (!isConnectorException(err) || !err.retryable) return null;
    if (err.code === "PROVIDER_UNAVAILABLE") {
      if (err.message.includes("did not respond in time")) return null; // the deadline is already spent
      return BACKOFF_BASE_MS * 2 ** attempt + Math.floor(random() * BACKOFF_BASE_MS);
    }
    if ((provider === "gsc" || provider === "bing") && err.code === "PROVIDER_RATE_LIMITED" && err.retryAfterSeconds !== undefined && err.retryAfterSeconds <= MAX_PROVIDER_RETRY_AFTER_SECONDS) {
      return err.retryAfterSeconds * 1000;
    }
    return null;
  }
}

const localBudget = (env: object) => (env as { CLARITY_LOCAL_DAILY_BUDGET?: number }).CLARITY_LOCAL_DAILY_BUDGET ?? 8;

/** Builds a fully mocked service: fixture repository and adapters, in-memory cache and budget. */
export function createMockReportService(env: ReportServiceDeps["env"] & Pick<SharedEnv, "LOG_LEVEL">, overrides: Partial<ReportServiceDeps> = {}): ReportService {
  const sharedQuota = overrides.clarityQuota ?? new MemoryClarityQuotaStore(localBudget(env));
  return new ReportService({
    repo: new MockRepository(),
    cache: new MemoryReportCache(),
    clarityQuota: sharedQuota,
    gsc: createGscAdapter("mock"),
    ga4: createGa4Adapter("mock"),
    clarity: createClarityAdapter("mock", sharedQuota, overrides.now),
    bing: createBingAdapter({ client: new MockBingApiClient(), getAuth: async () => ({ method: "api_key", apiKey: "mockmockmockmockmockmockmockmock" }) }),
    env,
    logger: createLogger({ level: env.LOG_LEVEL }),
    ...overrides,
  });
}

/**
 * Chooses mock or live wiring. Live mode needs a credential-backed GSC adapter from the caller (the server
 * composition root); GA4 and Clarity stay unavailable until their phases, and fail with a clear message.
 */
export function createReportService(
  env: ReportServiceDeps["env"] & Pick<SharedEnv, "LOG_LEVEL" | "DATA_MODE">,
  overrides: Partial<ReportServiceDeps> = {},
): ReportService {
  if (env.DATA_MODE === "live") {
    if (!overrides.gsc || !overrides.repo || !overrides.clarity || !overrides.bing) {
      throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "DATA_MODE=live needs a database and Google credentials, which are not configured.");
    }
    return new ReportService({
      cache: new MemoryReportCache(),
      ga4: createGa4Adapter("live"),
      clarityQuota: new MemoryClarityQuotaStore(localBudget(env)),
      env,
      logger: createLogger({ level: env.LOG_LEVEL }),
      ...overrides,
      repo: overrides.repo,
      gsc: overrides.gsc,
      clarity: overrides.clarity,
      bing: overrides.bing,
    });
  }
  return createMockReportService(env, overrides);
}
