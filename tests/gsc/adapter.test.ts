import { describe, expect, it } from "vitest";
import { ConnectorException, QueryGscSchema, type AuthorizedQueryContext } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import {
  GSC_MAX_ROW_LIMIT,
  GoogleGscAdapter,
  GscApiError,
  MockGscApiClient,
  planGscQuery,
  toGscConnectorError,
  type GscApiErrorKind,
} from "@serp/provider-gsc";

const NOW = new Date("2026-10-19T12:00:00Z");
const ctx: AuthorizedQueryContext = {
  userId: MOCK_USER_A_ID,
  requestId: "req-1",
  property: { id: "p1", userId: MOCK_USER_A_ID, connectionId: "c1", provider: "gsc", externalPropertyId: "sc-domain:example.com", displayName: "example.com", propertyType: "domain", timezone: "America/Los_Angeles", enabledForMcp: true },
  connection: { id: "c1", userId: MOCK_USER_A_ID, provider: "google", providerAccountId: "sub", accountLabel: "a***@x.test", status: "connected", grantedScopes: [], lastValidatedAt: null, lastErrorCode: null },
};

const parse = (over: Record<string, unknown> = {}) =>
  QueryGscSchema.parse({ propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14", ...over });

function setup() {
  const client = new MockGscApiClient({ now: () => NOW });
  const tokens: string[] = [];
  const rejected: string[] = [];
  const adapter = new GoogleGscAdapter({
    client,
    now: () => NOW,
    getAccessToken: async (c) => {
      tokens.push(c.connection.id);
      return "tok-for-" + c.connection.id;
    },
    onAuthRejected: async (c) => void rejected.push(c.connection.id),
  });
  return { client, adapter, tokens, rejected };
}

describe("request validation (before any token or network use)", () => {
  const invalid = (over: Record<string, unknown>, message: RegExp) => {
    const { adapter, client, tokens } = setup();
    return adapter.query(parse(over), ctx).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: ConnectorException) => {
        expect(e).toBeInstanceOf(ConnectorException);
        expect(e.code).toBe("INVALID_QUERY");
        expect(e.message).toMatch(message);
        expect(tokens).toEqual([]); // token never fetched
        expect(client.calls).toEqual([]); // nothing sent to Google
      },
    );
  };

  it("rejects duplicate dimensions", () => invalid({ dimensions: ["page", "page"] }, /repeat/));
  it("rejects searchAppearance combined with other dimensions", () => invalid({ dimensions: ["searchAppearance", "page"] }, /searchAppearance/));
  it("rejects queries for Discover", () => invalid({ type: "discover", dimensions: ["query"] }, /no search queries/));
  it("rejects a query filter for Google News", () => invalid({ type: "googleNews", filters: [{ dimension: "query", operator: "contains", expression: "x" }] }, /no search queries/));
  it("rejects regex filters on country", () => invalid({ filters: [{ dimension: "country", operator: "includingRegex", expression: "us.*" }] }, /Regex filters are only/));
  it("rejects contains on device", () => invalid({ filters: [{ dimension: "device", operator: "contains", expression: "MOB" }] }, /only supported on page and query/));
  it("rejects non-RE2 regex (lookahead)", () => invalid({ filters: [{ dimension: "page", operator: "includingRegex", expression: "^(?!/admin)" }] }, /RE2/));
  it("rejects a broken regex", () => invalid({ filters: [{ dimension: "page", operator: "includingRegex", expression: "([" }] }, /not a valid/));
  it("rejects a malformed country code", () => invalid({ filters: [{ dimension: "country", operator: "equals", expression: "US" }] }, /alpha-3/));
  it("rejects an unknown device", () => invalid({ filters: [{ dimension: "device", operator: "equals", expression: "WATCH" }] }, /DESKTOP, MOBILE or TABLET/));
});

describe("schema-level validation", () => {
  it.each([
    ["bad date format", { startDate: "09/01/2026" }],
    ["impossible date", { endDate: "2026-02-30" }],
    ["unknown dimension", { dimensions: ["hour"] }],
    ["unknown search type", { type: "podcast" }],
    ["limit too high", { limit: 5000 }],
    ["extra field", { rowLimit: 10 }],
    ["bad dataState", { dataState: "fresh" }],
  ])("rejects %s", (_n, over) => {
    expect(QueryGscSchema.safeParse({ propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-14", ...over }).success).toBe(false);
  });
});

describe("request building", () => {
  it("asks Google for exactly `limit` rows when its own order (clicks desc) answers the question", () => {
    const plan = planGscQuery(parse({ limit: 20 }));
    expect(plan.fullFetch).toBe(false);
    expect(plan.request).toMatchObject({ rowLimit: 20, startRow: 0, searchType: "web", dataState: "final", dimensions: ["page"] });
    expect(plan.request.dimensionFilterGroups).toBeUndefined();
  });

  it.each([
    ["sorting by impressions", { sortBy: "impressions" }],
    ["ascending order", { sortDirection: "asc" }],
    ["grouping by date", { dimensions: ["date"] }],
  ])("fetches the maximum page when %s, so top-N is not computed from a biased subset", (_n, over) => {
    const plan = planGscQuery(parse(over));
    expect(plan.fullFetch).toBe(true);
    expect(plan.request.rowLimit).toBe(GSC_MAX_ROW_LIMIT);
  });

  it("normalizes filters (country/device case) into one AND group", () => {
    const plan = planGscQuery(
      parse({
        filters: [
          { dimension: "country", operator: "equals", expression: "usa" },
          { dimension: "device", operator: "notEquals", expression: "tablet" },
          { dimension: "page", operator: "includingRegex", expression: "^https://www\\.example\\.com/blog/" },
        ],
      }),
    );
    expect(plan.request.dimensionFilterGroups).toEqual([
      {
        groupType: "and",
        filters: [
          { dimension: "country", operator: "equals", expression: "USA" },
          { dimension: "device", operator: "notEquals", expression: "TABLET" },
          { dimension: "page", operator: "includingRegex", expression: "^https://www\\.example\\.com/blog/" },
        ],
      },
    ]);
  });
});

describe("reports over the mock API", () => {
  it("maps keys to named dimensions with all four metrics, sorted by clicks desc, and marks the data as mock", async () => {
    const { adapter, tokens } = setup();
    const r = await adapter.query(parse({ dimensions: ["query", "page"], limit: 15 }), ctx);
    expect(r.rows).toHaveLength(15);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(["clicks", "ctr", "impressions", "page", "position", "query"]);
      expect(Number(row.ctr)).toBeGreaterThanOrEqual(0);
      expect(Number(row.ctr)).toBeLessThanOrEqual(1);
      expect(Number(row.position)).toBeGreaterThanOrEqual(1);
      expect(String(row.page)).toMatch(/^https:\/\/www\.example\.com\//);
    }
    const clicks = r.rows.map((x) => Number(x.clicks));
    expect(clicks).toEqual([...clicks].sort((a, b) => b - a));
    expect(r).toMatchObject({ provider: "gsc", mock: true, rowCountReturned: 15, requestId: "req-1" });
    expect(r.report.dateSemantics).toMatch(/Pacific/);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["MOCK_DATA", "ANONYMIZED_QUERIES_OMITTED"]));
    expect(tokens).toEqual(["c1"]); // the token of the authorized connection, nobody else's
  });

  it("supports country, device and date dimensions", async () => {
    const { adapter } = setup();
    const byCountry = await adapter.query(parse({ dimensions: ["country"], limit: 10 }), ctx);
    expect(byCountry.rows.map((r) => r.country).sort()).toEqual(["can", "gbr", "ind", "usa"]);
    const byDevice = await adapter.query(parse({ dimensions: ["device"] }), ctx);
    expect(byDevice.rows.map((r) => r.device).sort()).toEqual(["DESKTOP", "MOBILE", "TABLET"]);
    const byDate = await adapter.query(parse({ dimensions: ["date"], limit: 100 }), ctx);
    const dates = byDate.rows.map((r) => String(r.date)).sort();
    expect(dates[0]! >= "2026-09-01" && dates.at(-1)! <= "2026-09-14").toBe(true);
  });

  it("applies filters, including on dimensions that are not returned", async () => {
    const { adapter } = setup();
    const all = await adapter.query(parse({ dimensions: ["country"] }), ctx);
    const usOnly = await adapter.query(parse({ dimensions: ["device"], filters: [{ dimension: "country", operator: "equals", expression: "usa" }] }), ctx);
    const usaTotal = Number(all.rows.find((r) => r.country === "usa")!.clicks);
    expect(usOnly.rows.reduce((n, r) => n + Number(r.clicks), 0)).toBe(usaTotal);

    const blog = await adapter.query(parse({ dimensions: ["page"], limit: 50, filters: [{ dimension: "page", operator: "includingRegex", expression: "/blog/" }] }), ctx);
    expect(blog.rows.length).toBeGreaterThan(0);
    for (const r of blog.rows) expect(String(r.page)).toContain("/blog/");
  });

  it("sorts by impressions correctly even though Google orders by clicks", async () => {
    const { adapter, client } = setup();
    const r = await adapter.query(parse({ dimensions: ["page"], sortBy: "impressions", limit: 5 }), ctx);
    expect(client.calls[0]!.body!.rowLimit).toBe(GSC_MAX_ROW_LIMIT);
    const everything = await adapter.query(parse({ dimensions: ["page"], sortBy: "impressions", limit: 1000 }), ctx);
    expect(r.rows).toEqual(everything.rows.slice(0, 5));
    const imps = everything.rows.map((x) => Number(x.impressions));
    expect(imps).toEqual([...imps].sort((a, b) => b - a));
    const asc = await adapter.query(parse({ dimensions: ["page"], sortBy: "position", sortDirection: "asc", limit: 5 }), ctx);
    const pos = asc.rows.map((x) => Number(x.position));
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it("warns when the row limit is reached and when nothing comes back", async () => {
    const { adapter } = setup();
    const capped = await adapter.query(parse({ dimensions: ["page"], limit: 3 }), ctx);
    expect(capped.warnings.map((w) => w.code)).toContain("ROW_LIMIT_REACHED");
    const empty = await adapter.query(parse({ filters: [{ dimension: "page", operator: "equals", expression: "https://www.example.com/does-not-exist" }] }), ctx);
    expect(empty.rows).toEqual([]);
    expect(empty.warnings.map((w) => w.code)).toContain("NO_DATA");
  });

  it("reports byPage aggregation", async () => {
    const { adapter } = setup();
    const r = await adapter.query(parse({ dimensions: ["page"] }), ctx);
    expect(r.warnings.map((w) => w.code)).toContain("AGGREGATION_BY_PAGE");
    const noPage = await adapter.query(parse({ dimensions: ["country"] }), ctx);
    expect(noPage.warnings.map((w) => w.code)).not.toContain("AGGREGATION_BY_PAGE");
  });

  it("final data omits the newest days; dataState=all includes them and flags incompleteness", async () => {
    const { adapter } = setup();
    const range = { startDate: "2026-10-10", endDate: "2026-10-19", dimensions: ["date"], limit: 100 };
    const final = await adapter.query(parse(range), ctx);
    const finalDates = final.rows.map((r) => String(r.date));
    expect(finalDates.every((d) => d <= "2026-10-17")).toBe(true);
    expect(final.completeness).toBe("unknown_or_provider_limited");

    const fresh = await adapter.query(parse({ ...range, dataState: "all" }), ctx);
    expect(fresh.rows.map((r) => String(r.date))).toContain("2026-10-19");
    expect(fresh.completeness).toBe("partial");
    expect(fresh.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["FRESH_DATA_INCLUDED", "INCOMPLETE_DATA_FROM"]));
  });

  it("flags a truncated sort when Google returns its maximum page", async () => {
    const { adapter, client } = setup();
    client.override = { rows: Array.from({ length: GSC_MAX_ROW_LIMIT }, (_, i) => ({ keys: [`https://e.com/${i}`], clicks: 100000 - i, impressions: 200000 - i, ctr: 0.5, position: 2 })) };
    const r = await adapter.query(parse({ sortBy: "impressions", limit: 5 }), ctx);
    expect(r.completeness).toBe("partial");
    expect(r.warnings.map((w) => w.code)).toContain("SORT_LIMITED_TO_FETCHED_ROWS");
  });

  it("a different property yields different data (not one shared fixture)", async () => {
    const { adapter } = setup();
    const other = { ...ctx, property: { ...ctx.property, externalPropertyId: "https://www.example.com/", displayName: "www" } };
    const a = await adapter.query(parse({ dimensions: ["country"] }), ctx);
    const b = await adapter.query(parse({ dimensions: ["country"] }), other);
    expect(a.rows).not.toEqual(b.rows);
  });
});

describe("permissions and API failures become clear, safe errors", () => {
  it("an unverified or unknown property is PROPERTY_NOT_ACCESSIBLE", async () => {
    const { adapter } = setup();
    for (const id of ["https://not-verified.example.net/", "sc-domain:never-heard-of.com"]) {
      const err = await adapter.query(parse(), { ...ctx, property: { ...ctx.property, externalPropertyId: id } }).catch((e) => e);
      expect(err).toMatchObject({ code: "PROPERTY_NOT_ACCESSIBLE", provider: "gsc" });
      expect(err.suggestedAction).toMatch(/permission|account/i);
    }
  });

  it.each<[GscApiErrorKind, string, boolean]>([
    ["unauthenticated", "AUTH_EXPIRED", false],
    ["insufficient_scope", "FORBIDDEN", false],
    ["no_resource_access", "PROPERTY_NOT_ACCESSIBLE", false],
    ["quota", "PROVIDER_RATE_LIMITED", true],
    ["api_disabled", "PROVIDER_CAPABILITY_UNAVAILABLE", false],
    ["invalid_request", "INVALID_QUERY", false],
    ["unavailable", "PROVIDER_UNAVAILABLE", true],
    ["bad_response", "PROVIDER_UNAVAILABLE", true],
  ])("%s -> %s (retryable=%s)", async (kind, code, retryable) => {
    const { adapter, client } = setup();
    client.failures = [new GscApiError(kind, 400, kind === "quota" ? 30 : undefined, "someReason")];
    const err = await adapter.query(parse(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorException);
    expect(err).toMatchObject({ code, retryable });
    if (kind === "quota") expect(err.retryAfterSeconds).toBe(30);
    expect(err.message.length).toBeGreaterThan(20);
    expect(err.message).not.toMatch(/someReason|Bearer|tok-for/);
  });

  it("flags the connection for reconnect only when Google rejects the token itself", async () => {
    const { adapter, client, rejected } = setup();
    client.failures = [new GscApiError("unauthenticated", 401)];
    await adapter.query(parse(), ctx).catch(() => undefined);
    expect(rejected).toEqual(["c1"]);
    client.failures = [new GscApiError("quota", 429)];
    await adapter.query(parse(), ctx).catch(() => undefined);
    client.failures = [new GscApiError("no_resource_access", 403)];
    await adapter.query(parse(), ctx).catch(() => undefined);
    expect(rejected).toEqual(["c1"]); // quota and per-site permission do not invalidate the connection
  });

  it("unknown thrown values become a generic unavailable error without leaking details", () => {
    const e = toGscConnectorError(new Error("connect ECONNREFUSED secret-host:5432 token=abc"));
    expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e.message).not.toMatch(/ECONNREFUSED|secret|abc/);
  });

  it("token errors from the credential layer pass through unchanged", async () => {
    const client = new MockGscApiClient({ now: () => NOW });
    const adapter = new GoogleGscAdapter({
      client,
      getAccessToken: async () => {
        throw new ConnectorException("AUTH_REVOKED", "Access to this account was revoked.");
      },
    });
    await expect(adapter.query(parse(), ctx)).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(client.calls).toEqual([]);
  });
});
