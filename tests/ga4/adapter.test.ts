import { describe, expect, it } from "vitest";
import { ConnectorException, QueryGa4Schema, type AuthorizedQueryContext } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import { GA4_EARLIEST_START_DATE, addDays, todayInTimeZone, validateGa4DateRange } from "@serp/query-planner";
import { Ga4ApiError, GoogleGa4Adapter, MockGa4ApiClient, buildRunReportRequest, toGa4ConnectorError, type Ga4RunReportRequest, type Ga4RunReportResponse } from "@serp/provider-ga4";

const NOW = new Date("2026-10-19T12:00:00Z");
// 14:00Z is already 01:00 on the 20th in Sydney (UTC+11) but still 10:00 on the 19th in New York (UTC-4).
const LATE = new Date("2026-10-19T14:00:00Z");
const PROPERTY = "123456789"; // New York, has custom fields
const ctxFor = (propertyId = PROPERTY, connectionId = "c1", userId = MOCK_USER_A_ID, tz: string | null = "America/New_York"): AuthorizedQueryContext => ({
  userId,
  requestId: "req-1",
  property: { id: `p-${propertyId}`, userId, connectionId, provider: "ga4", externalPropertyId: propertyId, displayName: "Example GA4", propertyType: "ga4_property", timezone: tz, enabledForMcp: true },
  connection: { id: connectionId, userId, provider: "google", providerAccountId: "sub", accountLabel: "a***@x.test", status: "connected", grantedScopes: [], lastValidatedAt: null, lastErrorCode: null },
});
const parse = (over: Record<string, unknown> = {}) => QueryGa4Schema.parse({ propertyId: PROPERTY, startDate: "2026-09-01", endDate: "2026-09-30", ...over });

function setup(opts: { maxConcurrentPerProperty?: number } = {}) {
  const client = new MockGa4ApiClient({ now: () => NOW });
  const rejected: string[] = [];
  const tokens: string[] = [];
  const adapter = new GoogleGa4Adapter({
    client,
    now: () => NOW,
    getAccessToken: async (c) => {
      tokens.push(c.connection.id);
      return `tok-${c.connection.id}`;
    },
    onAuthRejected: async (c) => void rejected.push(c.connection.id),
    ...opts,
  });
  return { client, adapter, rejected, tokens };
}
const reject = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as ConnectorException;

describe("schema validation", () => {
  it.each([
    ["bad date", { startDate: "2026/09/01" }],
    ["field with spaces", { metrics: ["active users"] }],
    ["field with a path", { dimensions: ["../x"] }],
    ["too many dimensions", { dimensions: Array.from({ length: 10 }, (_, i) => `d${i}`) }],
    ["too many metrics", { metrics: Array.from({ length: 11 }, (_, i) => `m${i}`) }],
    ["no metrics", { metrics: [] }],
    ["bad match type", { dimensionFilters: [{ field: "country", matchType: "REGEX", value: "x" }] }],
    ["bad operator", { metricFilters: [{ field: "sessions", operator: "BETWEEN", value: 1 }] }],
    ["non-finite filter value", { metricFilters: [{ field: "sessions", operator: "EQUAL", value: Infinity }] }],
    ["limit too high", { limit: 100000 }],
    ["negative offset", { offset: -1 }],
    ["extra field", { rowLimit: 5 }],
  ])("rejects %s", (_n, over) => {
    expect(QueryGa4Schema.safeParse({ propertyId: PROPERTY, startDate: "2026-09-01", endDate: "2026-09-30", ...over }).success).toBe(false);
  });
});

describe("field validation against the property's own metadata", () => {
  it("accepts standard and property-specific custom fields", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ dimensions: ["customEvent:signup_plan"], metrics: ["customEvent:signup_count", "eventCount"], limit: 5 }), ctxFor());
    expect(r.rows.map((x) => x["customEvent:signup_plan"]).sort()).toEqual(["enterprise", "free", "pro"]);
  });

  it("the same custom field is unknown on a property that lacks it", async () => {
    const { adapter } = setup();
    const err = await reject(adapter.query(parse({ propertyId: "987654321", dimensions: ["customEvent:signup_plan"] }), ctxFor("987654321", "c1", MOCK_USER_A_ID, "Asia/Kolkata")));
    expect(err).toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
    expect(err.message).toMatch(/unknown dimension "customEvent:signup_plan"/);
  });

  it("names the bad field and suggests close matches", async () => {
    const { adapter } = setup();
    const err = await reject(adapter.query(parse({ dimensions: ["pagePth"], metrics: ["sesions"] }), ctxFor()));
    expect(err.code).toBe("DIMENSION_METRIC_INCOMPATIBLE");
    expect(err.message).toContain('"pagePth"');
    expect(err.message).toContain('did you mean "pagePath"');
    expect(err.message).toContain('did you mean "sessions"');
    expect(err.suggestedAction).toMatch(/get_supported_metrics/);
  });

  it("says when a metric is used as a dimension and vice versa", async () => {
    const { adapter } = setup();
    const err = await reject(adapter.query(parse({ dimensions: ["sessions"], metrics: ["country"] }), ctxFor()));
    expect(err.message).toMatch(/"sessions" is a metric, not a dimension/);
    expect(err.message).toMatch(/"country" is a dimension, not a metric/);
  });

  it("validates filter fields by kind and requires orderBy to be a requested field", async () => {
    const { adapter } = setup();
    const f1 = await reject(adapter.query(parse({ dimensionFilters: [{ field: "sessions", matchType: "EXACT", value: "1" }] }), ctxFor()));
    expect(f1.message).toMatch(/"sessions" is a metric/);
    const f2 = await reject(adapter.query(parse({ metricFilters: [{ field: "country", operator: "GREATER_THAN", value: 1 }] }), ctxFor()));
    expect(f2.message).toMatch(/"country" is a dimension/);
    const o = await reject(adapter.query(parse({ orderBy: { field: "eventCount" } }), ctxFor()));
    expect(o).toMatchObject({ code: "INVALID_QUERY" });
  });

  it("rejects repeated fields", async () => {
    const { adapter } = setup();
    expect((await reject(adapter.query(parse({ metrics: ["sessions", "sessions"] }), ctxFor()))).message).toMatch(/Metrics must not repeat/);
    expect((await reject(adapter.query(parse({ dimensions: ["country", "country"] }), ctxFor()))).message).toMatch(/Dimensions must not repeat/);
  });

  it("invalid requests never run a report", async () => {
    const { adapter, client } = setup();
    await reject(adapter.query(parse({ metrics: ["bogus"] }), ctxFor()));
    expect(client.calls.map((c) => c.op)).not.toContain("runReport");
  });
});

describe("compatibility", () => {
  it("rejects combinations GA4 cannot report, naming the fields", async () => {
    const { adapter, client } = setup();
    const err = await reject(adapter.query(parse({ dimensions: ["itemName"], metrics: ["sessions"] }), ctxFor()));
    expect(err).toMatchObject({ code: "DIMENSION_METRIC_INCOMPATIBLE" });
    expect(err.message).toContain("itemName (dimension)");
    expect(err.message).toContain("sessions (metric)");
    expect(err.suggestedAction).toMatch(/Remove|separate/);
    expect(client.calls.map((c) => c.op)).not.toContain("runReport");
  });

  it("allows compatible combinations (item dimension with item metric)", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ dimensions: ["itemName"], metrics: ["itemRevenue", "itemsViewed"], limit: 3 }), ctxFor());
    expect(r.rows).toHaveLength(3);
  });

  it("caches metadata and compatibility per user, connection and property", async () => {
    const { adapter, client } = setup();
    await adapter.query(parse({ limit: 2 }), ctxFor());
    await adapter.query(parse({ limit: 3 }), ctxFor());
    const count = (op: string) => client.calls.filter((c) => c.op === op).length;
    expect(count("getMetadata")).toBe(1);
    expect(count("checkCompatibility")).toBe(1);
    expect(count("runReport")).toBe(2);
    // Another connection (e.g. another tenant) never reuses the cached answers.
    await adapter.query(parse({ limit: 2 }), ctxFor(PROPERTY, "c2"));
    expect(count("getMetadata")).toBe(2);
    expect(count("checkCompatibility")).toBe(2);
  });

  it("re-checks after the cache expires", async () => {
    let now = NOW.getTime();
    const client = new MockGa4ApiClient({ now: () => NOW });
    const adapter = new GoogleGa4Adapter({ client, now: () => new Date(now), getAccessToken: async () => "t", metadataTtlMs: 1000 });
    await adapter.query(parse({ limit: 1 }), ctxFor());
    now += 2000;
    await adapter.query(parse({ limit: 1 }), ctxFor());
    expect(client.calls.filter((c) => c.op === "getMetadata")).toHaveLength(2);
  });
});

describe("request building", () => {
  it("builds filters, ordering and paging for the Data API", () => {
    const one = buildRunReportRequest(parse({ dimensionFilters: [{ field: "country", matchType: "EXACT", value: "India" }], limit: 30, offset: 60 }));
    expect(one.dimensionFilter).toEqual({ filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "India", caseSensitive: false } } });
    expect(one).toMatchObject({ limit: "30", offset: "60", returnPropertyQuota: true, dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }] });
    expect(one.orderBys).toEqual([{ desc: true, metric: { metricName: "activeUsers" } }]); // explicit default: first metric desc

    const many = buildRunReportRequest(
      parse({
        dimensionFilters: [{ field: "country", matchType: "CONTAINS", value: "a" }, { field: "pagePath", matchType: "BEGINS_WITH", value: "/blog" }],
        metricFilters: [{ field: "activeUsers", operator: "GREATER_THAN_OR_EQUAL", value: 5 }],
        dimensions: ["pagePath"],
        orderBy: { field: "pagePath", direction: "asc" },
      }),
    );
    expect(many.dimensionFilter!.andGroup!.expressions).toHaveLength(2);
    expect(many.metricFilter).toEqual({ filter: { fieldName: "activeUsers", numericFilter: { operation: "GREATER_THAN_OR_EQUAL", value: { doubleValue: 5 } } } });
    expect(many.orderBys).toEqual([{ desc: false, dimension: { dimensionName: "pagePath", orderType: "ALPHANUMERIC" } }]);
  });
});

describe("reports over the mock API", () => {
  it("PRD example: top 30 pages by active users, with named columns, numeric types and ordering", async () => {
    const { adapter, tokens } = setup();
    const r = await adapter.query(parse({ dimensions: ["pagePath"], metrics: ["activeUsers", "sessions", "screenPageViews", "eventCount"], limit: 30 }), ctxFor());
    expect(r.rows).toHaveLength(30);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(["activeUsers", "eventCount", "pagePath", "screenPageViews", "sessions"]);
      expect(typeof row.activeUsers).toBe("number");
      expect(String(row.pagePath)).toMatch(/^\//);
    }
    const users = r.rows.map((x) => Number(x.activeUsers));
    expect(users).toEqual([...users].sort((a, b) => b - a));
    expect(r).toMatchObject({ provider: "ga4", mock: true, rowCountReturned: 30, requestId: "req-1" });
    expect(r.report.sort).toEqual([{ field: "activeUsers", direction: "desc" }]);
    expect(r.report.dateSemantics).toContain("America/New_York");
    expect(r.providerMetadata).toMatchObject({ timeZone: "America/New_York", currencyCode: "USD", metricTypes: { activeUsers: "TYPE_INTEGER" } });
    expect(tokens.every((t) => t === "c1")).toBe(true);
  });

  it("reformats GA4's YYYYMMDD dates and returns float metrics as numbers", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ dimensions: ["date"], metrics: ["engagementRate", "averageSessionDuration"], orderBy: { field: "date", direction: "asc" }, limit: 40 }), ctxFor());
    const dates = r.rows.map((x) => String(x.date));
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]! >= "2026-09-01" && dates.at(-1)! <= "2026-09-30").toBe(true);
    expect(r.rows.every((x) => typeof x.engagementRate === "number" && Number(x.engagementRate) <= 1)).toBe(true);
    expect(r.providerMetadata!.metricTypes).toMatchObject({ engagementRate: "TYPE_FLOAT", averageSessionDuration: "TYPE_SECONDS" });
  });

  it("paginates: warns about more rows and the next offset, and pages do not overlap", async () => {
    const { adapter } = setup();
    const page1 = await adapter.query(parse({ dimensions: ["pagePath"], limit: 10 }), ctxFor());
    expect(page1.completeness).toBe("partial");
    const warn = page1.warnings.find((w) => w.code === "MORE_ROWS_AVAILABLE")!;
    expect(warn.message).toContain("offset 10");
    expect(page1.providerMetadata!.pagination).toMatchObject({ offset: 0, limit: 10, nextOffset: 10 });
    const total = page1.rowCountReportedByProvider!;
    expect(total).toBeGreaterThan(30);

    const page2 = await adapter.query(parse({ dimensions: ["pagePath"], limit: 10, offset: 10 }), ctxFor());
    const seen = new Set(page1.rows.map((r) => r.pagePath));
    expect(page2.rows.some((r) => seen.has(r.pagePath))).toBe(false);

    const last = await adapter.query(parse({ dimensions: ["pagePath"], limit: 100, offset: 30 }), ctxFor());
    expect(last.rows).toHaveLength(total - 30);
    expect(last.completeness).toBe("complete");
    expect(last.providerMetadata!.pagination).toMatchObject({ nextOffset: null });
  });

  it("applies dimension filters (including on fields not in the report) and metric filters", async () => {
    const { adapter } = setup();
    const all = await adapter.query(parse({ dimensions: ["country"], metrics: ["sessions"], limit: 50 }), ctxFor());
    const india = await adapter.query(parse({ dimensions: ["deviceCategory"], metrics: ["sessions"], dimensionFilters: [{ field: "country", matchType: "EXACT", value: "india" }] }), ctxFor());
    expect(india.rows.reduce((n, r) => n + Number(r.sessions), 0)).toBe(Number(all.rows.find((r) => r.country === "India")!.sessions));

    const blog = await adapter.query(parse({ dimensions: ["pagePath"], limit: 50, dimensionFilters: [{ field: "pagePath", matchType: "BEGINS_WITH", value: "/blog" }] }), ctxFor());
    expect(blog.rows.length).toBeGreaterThan(5);
    expect(blog.rows.every((r) => String(r.pagePath).startsWith("/blog"))).toBe(true);

    const big = await adapter.query(parse({ dimensions: ["pagePath"], metricFilters: [{ field: "activeUsers", operator: "GREATER_THAN", value: 500 }], limit: 50 }), ctxFor());
    expect(big.rows.every((r) => Number(r.activeUsers) > 500)).toBe(true);
  });

  it("returns an honest empty result with a NO_DATA warning", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ dimensionFilters: [{ field: "pagePath", matchType: "EXACT", value: "/nope" }] }), ctxFor());
    expect(r.rows).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("NO_DATA");
  });

  it("uses the report's own time zone, and warns when it differs from the stored one", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ limit: 1 }), ctxFor(PROPERTY, "c1", MOCK_USER_A_ID, "Europe/Paris"));
    expect(r.report.dateSemantics).toContain("America/New_York");
    expect(r.warnings.map((w) => w.code)).toContain("TIMEZONE_CHANGED");
    const unknown = await adapter.query(parse({ limit: 1 }), ctxFor(PROPERTY, "c3", MOCK_USER_A_ID, null));
    expect(unknown.report.dateSemantics).toContain("America/New_York"); // learned from Google, not guessed
  });

  it("does not return rows for a day the property's local calendar has not reached", async () => {
    const client = new MockGa4ApiClient({ now: () => LATE });
    const adapter = new GoogleGa4Adapter({ client, now: () => LATE, getAccessToken: async () => "t" });
    const q = (id: string) => parse({ propertyId: id, startDate: "2026-10-18", endDate: "2026-10-20", dimensions: ["date"], limit: 10 });
    const ny = await adapter.query(q(PROPERTY), ctxFor());
    expect(ny.rows.map((r) => r.date)).not.toContain("2026-10-20");
    const syd = await adapter.query(q("444555666"), ctxFor("444555666", "c1", MOCK_USER_A_ID, "Australia/Sydney"));
    expect(syd.rows.map((r) => r.date)).toContain("2026-10-20");
  });

  describe("provider flags become warnings and completeness", () => {
    const run = async (override: Partial<Ga4RunReportResponse>, over: Record<string, unknown> = {}) => {
      const { adapter, client } = setup();
      client.override = override;
      return adapter.query(parse({ limit: 5, ...over }), ctxFor());
    };
    it("thresholding", async () => {
      const r = await run({ subjectToThresholding: true });
      expect(r.completeness).toBe("partial");
      expect(r.warnings.map((w) => w.code)).toContain("THRESHOLDING_APPLIED");
    });
    it("(other) row", async () => {
      const r = await run({ dataLossFromOtherRow: true });
      expect(r.completeness).toBe("partial");
      expect(r.warnings.map((w) => w.code)).toContain("OTHER_ROW_AGGREGATION");
    });
    it("sampling", async () => {
      const r = await run({ sampling: [{ samplesReadCount: "250", samplingSpaceSize: "1000" }] });
      expect(r.completeness).toBe("partial");
      expect(r.warnings.find((w) => w.code === "SAMPLED_DATA")!.message).toContain("25%");
    });
    it("restricted metrics", async () => {
      const r = await run({ restrictedMetrics: ["totalRevenue"] });
      expect(r.warnings.find((w) => w.code === "RESTRICTED_METRICS")!.message).toContain("totalRevenue");
    });
    it("low quota", async () => {
      const r = await run({ quota: { tokensPerHour: { consumed: 39000, remaining: 1000 }, tokensPerDay: { consumed: 10, remaining: 199990 } } });
      expect(r.warnings.find((w) => w.code === "LOW_QUOTA")!.message).toContain("tokensPerHour");
      expect(r.warnings.find((w) => w.code === "LOW_QUOTA")!.message).not.toContain("tokensPerDay");
    });
    it("distinct-user metrics across rows", async () => {
      const r = await run({}, { metrics: ["activeUsers"] });
      expect(r.warnings.map((w) => w.code)).toContain("UNIQUE_METRICS_NOT_ADDITIVE");
      const noUsers = await run({}, { metrics: ["sessions"] });
      expect(noUsers.warnings.map((w) => w.code)).not.toContain("UNIQUE_METRICS_NOT_ADDITIVE");
    });
  });
});

describe("permissions and API failures become clear, safe errors", () => {
  it("a property the account cannot read is PROPERTY_NOT_ACCESSIBLE", async () => {
    const { adapter, client } = setup();
    client.deniedProperties.add(PROPERTY);
    const err = await reject(adapter.query(parse(), ctxFor()));
    expect(err).toMatchObject({ code: "PROPERTY_NOT_ACCESSIBLE", provider: "ga4" });
    expect(err.suggestedAction).toMatch(/role|account/i);
  });

  it.each<[string, string, boolean]>([
    ["unauthenticated", "AUTH_EXPIRED", false],
    ["insufficient_scope", "FORBIDDEN", false],
    ["no_resource_access", "PROPERTY_NOT_ACCESSIBLE", false],
    ["quota", "PROVIDER_RATE_LIMITED", true],
    ["api_disabled", "PROVIDER_CAPABILITY_UNAVAILABLE", false],
    ["invalid_request", "INVALID_QUERY", false],
    ["unavailable", "PROVIDER_UNAVAILABLE", true],
    ["bad_response", "PROVIDER_UNAVAILABLE", true],
  ])("%s -> %s (retryable=%s)", async (kind, code, retryable) => {
    // Failing the very first call (metadata) and the last call (runReport) must behave the same.
    for (const skip of [0, 2]) {
      const { adapter, client } = setup();
      client.failures = [...Array(skip).fill(undefined), new Ga4ApiError(kind as never, 403, undefined, "someReason")].filter(Boolean) as Ga4ApiError[];
      if (skip === 2) {
        // let metadata and compatibility succeed, then fail the report
        const original = client.runReport.bind(client);
        client.runReport = async (...a) => {
          throw new Ga4ApiError(kind as never, 403, undefined, "someReason");
          void original;
        };
      }
      const err = await reject(adapter.query(parse(), ctxFor()));
      expect(err).toBeInstanceOf(ConnectorException);
      expect(err).toMatchObject({ code, retryable });
      expect(err.message).not.toMatch(/someReason|tok-|Bearer/);
    }
  });

  it("flags the connection for reconnect only when Google rejects the token itself", async () => {
    const { adapter, client, rejected } = setup();
    client.failures = [new Ga4ApiError("unauthenticated", 401)];
    await reject(adapter.query(parse(), ctxFor()));
    expect(rejected).toEqual(["c1"]);
    client.failures = [new Ga4ApiError("quota", 429)];
    await reject(adapter.query(parse(), ctxFor("123456789", "c9")));
    client.failures = [new Ga4ApiError("no_resource_access", 403)];
    await reject(adapter.query(parse(), ctxFor("123456789", "c8")));
    expect(rejected).toEqual(["c1"]);
  });

  it("explains quota exhaustion without promising an instant retry", () => {
    const e = toGa4ConnectorError(new Ga4ApiError("quota", 429));
    expect(e.message).toMatch(/hourly and daily/);
    expect(e.suggestedAction).toMatch(/narrower/);
  });

  it("unknown thrown values do not leak details", () => {
    const e = toGa4ConnectorError(new Error("connect ECONNREFUSED 10.0.0.5:443 token=abc"));
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e.message).not.toMatch(/ECONNREFUSED|10\.0|abc/);
  });

  it("credential-layer errors pass through and nothing is sent to Google", async () => {
    const client = new MockGa4ApiClient({ now: () => NOW });
    const adapter = new GoogleGa4Adapter({
      client,
      getAccessToken: async () => {
        throw new ConnectorException("AUTH_REVOKED", "Access to this account was revoked.");
      },
    });
    await expect(adapter.query(parse(), ctxFor())).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(client.calls).toEqual([]);
  });
});

describe("concurrency", () => {
  it("never runs more reports at once per property than configured, and still completes them all", async () => {
    const { adapter, client } = setup({ maxConcurrentPerProperty: 2 });
    let active = 0;
    let peak = 0;
    const real = client.runReport.bind(client);
    client.runReport = async (token: string, id: string, req: Ga4RunReportRequest) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await real(token, id, req);
      } finally {
        active--;
      }
    };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => adapter.query(parse({ limit: i + 1 }), ctxFor())));
    expect(results.map((r) => r.rows.length)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("date validation uses the property's reporting time zone", () => {
  it("computes 'today' per time zone", () => {
    expect(todayInTimeZone("Australia/Sydney", LATE)).toBe("2026-10-20");
    expect(todayInTimeZone("America/New_York", LATE)).toBe("2026-10-19");
  });
  it("accepts a date that is 'today' in Sydney but would be the future in New York", () => {
    expect(() => validateGa4DateRange("2026-10-10", "2026-10-20", "Australia/Sydney", LATE)).not.toThrow();
    expect(() => validateGa4DateRange("2026-10-10", "2026-10-20", "America/New_York", LATE)).toThrowError(/future/);
  });
  it("rejects dates before GA4 existed, reversed ranges, and future dates", () => {
    expect(() => validateGa4DateRange("2015-01-01", "2015-02-01", "UTC", NOW)).toThrowError(new RegExp(GA4_EARLIEST_START_DATE));
    expect(() => validateGa4DateRange("2026-09-30", "2026-09-01", "UTC", NOW)).toThrowError(/after endDate/);
  });
  it("warns about today, still-processing days, and an unknown time zone", () => {
    const codes = (tz: string | null, end: string) => validateGa4DateRange("2026-10-01", end, tz, NOW).warnings.map((w) => w.code);
    expect(codes("America/New_York", "2026-10-19")).toEqual(expect.arrayContaining(["PARTIAL_DAY", "RECENT_DATA_INCOMPLETE"]));
    expect(codes("America/New_York", "2026-10-10")).toEqual([]);
    expect(codes(null, addDays("2026-10-19", -10))).toEqual(["TIMEZONE_UNKNOWN"]);
  });
});
