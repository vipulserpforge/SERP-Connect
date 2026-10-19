import { MemoryReportCache, type ReportCache } from "@serp/cache";
import {
  ConnectorException,
  loadSharedEnv,
  type AuthorizedQueryContext,
  type NormalizedReportResult,
  type ProviderConnection,
  type PropertyRecord,
  type ProviderKey,
  type ReportAdapter,
} from "@serp/contracts";
import { MockRepository } from "@serp/db";
import { createLogger } from "@serp/observability";
import { MemoryClarityQuotaStore, createClarityAdapter } from "@serp/provider-clarity";
import { ReportService, type ReportServiceDeps } from "@serp/reporting";

export const USER_A = "user-a";
export const USER_B = "user-b";

/** 2026-10-19 12:00 UTC: 05:00 in Pacific Time (PDT), 08:00 in New York, 01:00 on the 20th in Auckland. */
export const NOON = Date.parse("2026-10-19T12:00:00Z");

const conn = (id: string, userId: string): ProviderConnection => ({
  id,
  userId,
  provider: "google",
  providerAccountId: `sub-${id}`,
  accountLabel: id,
  status: "connected",
  grantedScopes: [],
  lastValidatedAt: null,
  lastErrorCode: null,
});
const prop = (id: string, userId: string, connectionId: string, provider: ProviderKey, externalPropertyId: string, timezone: string | null = null): PropertyRecord => ({
  id,
  userId,
  connectionId,
  provider,
  externalPropertyId,
  displayName: id,
  propertyType: null,
  timezone,
  enabledForMcp: true,
});

/**
 * Two customers who both own "sc-domain:shared.example" and GA4 property "100" (different time zones),
 * so a cache that keyed on the provider-native id alone would visibly leak between them.
 */
export const seed = () => ({
  connections: [conn("conn-a1", USER_A), conn("conn-a2", USER_A), conn("conn-b1", USER_B), conn("conn-a-ga4", USER_A), conn("conn-b-ga4", USER_B)],
  properties: [
    prop("prop-a1", USER_A, "conn-a1", "gsc", "sc-domain:shared.example"),
    prop("prop-a2", USER_A, "conn-a2", "gsc", "sc-domain:second.example"),
    prop("prop-b1", USER_B, "conn-b1", "gsc", "sc-domain:shared.example"),
    prop("prop-a-ga4-nz", USER_A, "conn-a-ga4", "ga4", "100", "Pacific/Auckland"),
    prop("prop-a-ga4-ny", USER_A, "conn-a-ga4", "ga4", "200", "America/New_York"),
    prop("prop-b-ga4", USER_B, "conn-b-ga4", "ga4", "100", "Asia/Kolkata"),
  ],
});

export interface Call {
  query: { startDate: string; endDate: string } & Record<string, unknown>;
  ctx: AuthorizedQueryContext;
}

/** An adapter that records every upstream call and answers with rows naming exactly who asked. */
export class FakeAdapter implements ReportAdapter<never> {
  readonly mock = true;
  readonly calls: Call[] = [];
  /** Replace to simulate slow, failing or incomplete upstream behaviour. */
  behave: (call: Call, n: number) => Promise<NormalizedReportResult> | NormalizedReportResult = (call) => this.ok(call);
  constructor(readonly provider: "gsc" | "ga4") {}

  ok(call: Call, extra: Partial<NormalizedReportResult> = {}): NormalizedReportResult {
    const { query, ctx } = call;
    return {
      provider: this.provider,
      property: { id: ctx.property.externalPropertyId, name: ctx.property.displayName },
      report: { startDate: query.startDate, endDate: query.endDate, dateSemantics: "fake", dimensions: [], metrics: ["clicks"], sort: [], limit: 10 },
      rows: [{ owner: ctx.userId, connection: ctx.connection.id, property: ctx.property.id, start: query.startDate, end: query.endDate }],
      rowCountReturned: 1,
      rowCountReportedByProvider: 1,
      fetchedAt: new Date(NOON).toISOString(),
      cache: { hit: false, ageSeconds: 0 },
      completeness: "complete",
      mock: true,
      warnings: [],
      requestId: ctx.requestId,
      ...extra,
    };
  }

  async query(query: never, ctx: AuthorizedQueryContext): Promise<NormalizedReportResult> {
    const call = { query: query as Call["query"], ctx };
    this.calls.push(call);
    return this.behave(call, this.calls.length);
  }
}

export const unavailable = (retryable = true) => new ConnectorException("PROVIDER_UNAVAILABLE", "Provider is temporarily unavailable.", { retryable, provider: "gsc" });

export interface Harness {
  service: ReportService;
  gsc: FakeAdapter;
  ga4: FakeAdapter;
  cache: ReportCache;
  clock: { ms: number };
  sleeps: number[];
  principal: (userId: string) => { userId: string; scopes: string[] };
}

export function harness(opts: { env?: Record<string, number | boolean>; deps?: Partial<ReportServiceDeps>; cache?: ReportCache } = {}): Harness {
  const clock = { ms: NOON };
  const sleeps: number[] = [];
  const gsc = new FakeAdapter("gsc");
  const ga4 = new FakeAdapter("ga4");
  const cache = opts.cache ?? new MemoryReportCache({ now: () => clock.ms });
  const env = { ...loadSharedEnv({}), ...opts.env };
  const service = new ReportService({
    repo: new MockRepository(seed()),
    cache,
    clarityQuota: new MemoryClarityQuotaStore(),
    gsc: gsc as never,
    ga4: ga4 as never,
    clarity: createClarityAdapter("mock"),
    env,
    logger: createLogger({ level: "error" }),
    now: () => new Date(clock.ms),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...opts.deps,
  });
  return { service, gsc, ga4, cache, clock, sleeps, principal: (userId) => ({ userId, scopes: [] }) };
}

export const gscQuery = (over: Record<string, unknown> = {}) => ({
  propertyId: "sc-domain:shared.example",
  startDate: "2026-09-01",
  endDate: "2026-09-28",
  dimensions: ["query"],
  ...over,
});
export const ga4Query = (over: Record<string, unknown> = {}) => ({
  propertyId: "100",
  startDate: "2026-09-01",
  endDate: "2026-09-28",
  dimensions: ["pagePath"],
  metrics: ["sessions"],
  ...over,
});
