import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Ga4ApiError, HttpGa4ApiClient, type Ga4RunReportRequest } from "@serp/provider-ga4";

// Local stand-in for analyticsadmin.googleapis.com and analyticsdata.googleapis.com. No Google credentials.
const TOKEN = "test-access-token-value-456";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}
let server: Server;
let root = "";
let seen: Seen[] = [];
let queue: Array<{ status: number; body?: unknown; raw?: string; headers?: Record<string, string>; delayMs?: number }> = [];

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
    const r = queue.shift() ?? { status: 500 };
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
    res.end(r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen = [];
  queue = [];
});

const client = (extra: ConstructorParameters<typeof HttpGa4ApiClient>[0] = {}) =>
  new HttpGa4ApiClient({ adminBaseUrl: `${root}/admin/v1beta`, dataBaseUrl: `${root}/data/v1beta`, sleep: async () => undefined, ...extra });

const request: Ga4RunReportRequest = {
  dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
  dimensions: [{ name: "pagePath" }],
  metrics: [{ name: "activeUsers" }, { name: "engagementRate" }],
  orderBys: [{ desc: true, metric: { metricName: "activeUsers" } }],
  limit: "10",
  offset: "0",
  returnPropertyQuota: true,
};

describe("Admin API: account summaries and property details", () => {
  it("flattens accounts, parses property ids, and pages through results", async () => {
    queue = [
      { status: 200, body: { accountSummaries: [{ account: "accounts/1", displayName: "A", propertySummaries: [{ property: "properties/111", displayName: "One", propertyType: "PROPERTY_TYPE_ORDINARY" }, { property: "universalAnalytics/UA-1", displayName: "legacy" }] }], nextPageToken: "tok2" } },
      { status: 200, body: { accountSummaries: [{ account: "accounts/2", displayName: "B", propertySummaries: [{ property: "properties/222" }] }] } },
    ];
    const accounts = await client().listAccountSummaries(TOKEN);
    expect(accounts).toEqual([
      { accountId: "1", displayName: "A", properties: [{ propertyId: "111", displayName: "One", propertyType: "PROPERTY_TYPE_ORDINARY" }] },
      { accountId: "2", displayName: "B", properties: [{ propertyId: "222", displayName: "222", propertyType: "PROPERTY_TYPE_UNSPECIFIED" }] },
    ]);
    expect(seen[0]).toMatchObject({ method: "GET", auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.url).toContain("/admin/v1beta/accountSummaries?pageSize=200");
    expect(seen[1]!.url).toContain("pageToken=tok2");
    expect(seen.map((s) => s.url).join()).not.toContain(TOKEN);
  });

  it("an account with nothing returns an empty list, not an error", async () => {
    queue = [{ status: 200, body: {} }];
    expect(await client().listAccountSummaries(TOKEN)).toEqual([]);
  });

  it("reads the reporting time zone and currency", async () => {
    queue = [{ status: 200, body: { name: "properties/123", displayName: "P", timeZone: "America/New_York", currencyCode: "USD" } }];
    expect(await client().getProperty(TOKEN, "123")).toEqual({ propertyId: "123", displayName: "P", timeZone: "America/New_York", currencyCode: "USD" });
    expect(seen[0]!.url).toBe("/admin/v1beta/properties/123");
  });

  it("refuses a reply for a different property than asked", async () => {
    queue = [{ status: 200, body: { name: "properties/999" } }];
    await expect(client().getProperty(TOKEN, "123")).rejects.toMatchObject({ kind: "bad_response" });
  });

  it.each([["../etc"], ["12 34"], ["123/../456"], ["abc"], [""], ["1".repeat(30)]])("rejects property id %j before any request", async (id) => {
    await expect(client().getProperty(TOKEN, id)).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(client().runReport(TOKEN, id, request)).rejects.toMatchObject({ kind: "invalid_request" });
    expect(seen).toEqual([]);
  });
});

describe("Data API: metadata and compatibility", () => {
  it("parses standard and custom fields", async () => {
    queue = [
      {
        status: 200,
        body: {
          dimensions: [{ apiName: "pagePath", uiName: "Page path", category: "Page / Screen" }, { apiName: "customEvent:plan", customDefinition: true, deprecatedApiNames: ["old"] }],
          metrics: [{ apiName: "activeUsers", type: "TYPE_INTEGER" }],
        },
      },
    ];
    const m = await client().getMetadata(TOKEN, "123");
    expect(m.dimensions[1]).toMatchObject({ apiName: "customEvent:plan", custom: true, deprecatedApiNames: ["old"] });
    expect(m.metrics[0]).toMatchObject({ apiName: "activeUsers", type: "TYPE_INTEGER", custom: false });
    expect(seen[0]!.url).toBe("/data/v1beta/properties/123/metadata");
  });

  it("returns only the incompatible fields from checkCompatibility", async () => {
    queue = [
      {
        status: 200,
        body: {
          dimensionCompatibilities: [{ dimensionMetadata: { apiName: "itemName" }, compatibility: "INCOMPATIBLE" }, { dimensionMetadata: { apiName: "country" }, compatibility: "COMPATIBLE" }],
          metricCompatibilities: [{ metricMetadata: { apiName: "sessions" }, compatibility: "INCOMPATIBLE" }],
        },
      },
    ];
    const c = await client().checkCompatibility(TOKEN, "123", { dimensions: ["itemName", "country"], metrics: ["sessions"] });
    expect(c).toEqual({ incompatibleDimensions: ["itemName"], incompatibleMetrics: ["sessions"] });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/data/v1beta/properties/123:checkCompatibility" });
    expect(seen[0]!.body).toEqual({ dimensions: [{ name: "itemName" }, { name: "country" }], metrics: [{ name: "sessions" }] });
  });
});

describe("Data API: runReport", () => {
  const good = {
    dimensionHeaders: [{ name: "pagePath" }],
    metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }, { name: "engagementRate", type: "TYPE_FLOAT" }],
    rows: [{ dimensionValues: [{ value: "/a" }], metricValues: [{ value: "10" }, { value: "0.5" }] }],
    rowCount: 1,
    metadata: { timeZone: "Asia/Kolkata", currencyCode: "INR", subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "400" }], schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: "totalRevenue" }] } },
    propertyQuota: { tokensPerDay: { consumed: 10, remaining: 199990 }, tokensPerHour: { consumed: 10, remaining: 39990 }, concurrentRequests: { remaining: 10 }, weirdBucket: { consumed: 1 } },
  };

  it("posts the request and parses rows, flags and quota (ignoring unknown quota buckets)", async () => {
    queue = [{ status: 200, body: good }];
    const r = await client().runReport(TOKEN, "123", request);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/data/v1beta/properties/123:runReport", auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.body).toEqual(request);
    expect(r).toMatchObject({
      dimensionHeaders: ["pagePath"],
      rows: [{ dimensions: ["/a"], metrics: ["10", "0.5"] }],
      rowCount: 1,
      timeZone: "Asia/Kolkata",
      currencyCode: "INR",
      subjectToThresholding: true,
      dataLossFromOtherRow: true,
      sampling: [{ samplesReadCount: "100", samplingSpaceSize: "400" }],
      restrictedMetrics: ["totalRevenue"],
    });
    expect(Object.keys(r.quota).sort()).toEqual(["concurrentRequests", "tokensPerDay", "tokensPerHour"]);
    expect(r.quota.concurrentRequests).toEqual({ consumed: null, remaining: 10 });
  });

  it("a report with no rows parses to an empty result", async () => {
    queue = [{ status: 200, body: { dimensionHeaders: [{ name: "pagePath" }], metricHeaders: [], metadata: { emptyReason: "no data" } } }];
    const r = await client().runReport(TOKEN, "123", request);
    expect(r.rows).toEqual([]);
    expect(r.hasEmptyReason).toBe(true);
  });

  it.each([
    ["too few dimension values", { ...good, rows: [{ dimensionValues: [], metricValues: [{ value: "1" }, { value: "2" }] }] }],
    ["too many metric values", { ...good, rows: [{ dimensionValues: [{ value: "/a" }], metricValues: [{ value: "1" }, { value: "2" }, { value: "3" }] }] }],
    ["negative row count", { ...good, rowCount: -4 }],
    ["rows not an array", { ...good, rows: "nope" }],
  ])("refuses %s rather than mislabel data", async (_n, reply) => {
    queue = [{ status: 200, body: reply }];
    await expect(client().runReport(TOKEN, "123", request)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("rejects non-JSON success bodies", async () => {
    queue = [{ status: 200, raw: "<html>proxy</html>" }];
    await expect(client().runReport(TOKEN, "123", request)).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("error classification, retries and transport safety", () => {
  const status = async (code: number, body?: unknown, headers?: Record<string, string>) => {
    queue = [{ status: code, ...(body !== undefined && { body }), ...(headers && { headers }) }];
    return client({ maxRetries: 0 }).runReport(TOKEN, "123", request).catch((e) => e as Ga4ApiError);
  };

  it.each([
    [401, { error: { status: "UNAUTHENTICATED" } }, "unauthenticated"],
    [403, { error: { status: "PERMISSION_DENIED" } }, "no_resource_access"],
    [403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, "insufficient_scope"],
    [403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, "api_disabled"],
    [404, { error: { status: "NOT_FOUND" } }, "no_resource_access"],
    [429, { error: { status: "RESOURCE_EXHAUSTED" } }, "quota"],
    [403, { error: { status: "RESOURCE_EXHAUSTED" } }, "quota"],
    [400, { error: { status: "INVALID_ARGUMENT" } }, "invalid_request"],
    [500, { error: { status: "INTERNAL" } }, "unavailable"],
    [503, undefined, "unavailable"],
  ])("HTTP %i %j -> %s", async (code, body, kind) => {
    expect(await status(code, body)).toMatchObject({ kind });
  });

  it("never retries quota exhaustion (it is hourly/daily), auth, or bad requests", async () => {
    for (const code of [429, 401, 403, 400]) {
      seen = [];
      queue = [{ status: code, body: { error: { status: code === 429 ? "RESOURCE_EXHAUSTED" : "X" } } }, { status: 200, body: {} }];
      await client({ maxRetries: 2 }).runReport(TOKEN, "123", request).catch(() => undefined);
      expect(seen, `HTTP ${code}`).toHaveLength(1);
    }
  });

  it("retries a transient 503 then succeeds", async () => {
    queue = [{ status: 503 }, { status: 200, body: { dimensionHeaders: [{ name: "pagePath" }], metricHeaders: [], rows: [] } }];
    await expect(client().runReport(TOKEN, "123", { ...request, metrics: [] })).resolves.toMatchObject({ rows: [] });
    expect(seen).toHaveLength(2);
  });

  it("times out as unavailable", async () => {
    queue = [{ status: 200, body: {}, delayMs: 300 }];
    expect(await client({ timeoutMs: 50, maxRetries: 0 }).getProperty(TOKEN, "123").catch((e) => e)).toMatchObject({ kind: "unavailable" });
  });

  it("does not follow redirects, and errors never contain the token or upstream text", async () => {
    const hits: string[] = [];
    const other = createServer((req, res) => {
      hits.push(req.headers.authorization ?? "none");
      res.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    queue = [{ status: 302, headers: { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal` } }];
    expect(await client({ maxRetries: 0 }).listAccountSummaries(TOKEN).catch((e) => e)).toMatchObject({ kind: "unavailable" });
    expect(hits).toEqual([]);
    other.close();

    queue = [{ status: 403, body: { error: { message: `leak ${TOKEN}`, status: "PERMISSION_DENIED" } } }];
    const err = await client({ maxRetries: 0 }).getProperty(TOKEN, "123").catch((e) => e);
    expect(String(err.message) + String(err.stack) + JSON.stringify(err)).not.toContain(TOKEN);
  });
});
