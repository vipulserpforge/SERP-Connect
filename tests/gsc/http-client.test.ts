import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GscApiError, HttpGscApiClient, classifyGoogleError, type SearchAnalyticsRequest } from "@serp/provider-gsc";

// Local stand-in for www.googleapis.com. No Google account, project or credentials involved.
const TOKEN = "test-access-token-value-123";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}
let server: Server;
let base = "";
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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webmasters/v3`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen = [];
  queue = [];
});

const client = (extra: ConstructorParameters<typeof HttpGscApiClient>[0] = {}) =>
  new HttpGscApiClient({ baseUrl: base, sleep: async () => undefined, ...extra });

const body: SearchAnalyticsRequest = {
  startDate: "2026-09-01",
  endDate: "2026-09-30",
  dimensions: ["query", "page"],
  searchType: "web",
  rowLimit: 10,
  startRow: 0,
  dataState: "final",
};

describe("sites.list", () => {
  it("returns sites with permission levels and sends the bearer token in a header only", async () => {
    queue = [{ status: 200, body: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://x.example/", permissionLevel: "somethingNew" }] } }];
    const sites = await client().listSites(TOKEN);
    expect(sites).toEqual([
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://x.example/", permissionLevel: "unknown" },
    ]);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/webmasters/v3/sites", auth: `Bearer ${TOKEN}` });
    expect(seen[0]!.url).not.toContain(TOKEN);
  });

  it("treats an account with no sites (field omitted) as an empty list, not an error", async () => {
    queue = [{ status: 200, body: {} }];
    expect(await client().listSites(TOKEN)).toEqual([]);
  });

  it("rejects a malformed body", async () => {
    queue = [{ status: 200, body: { siteEntry: [{ permissionLevel: "siteOwner" }] } }];
    await expect(client().listSites(TOKEN)).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("searchAnalytics.query", () => {
  it("URL-encodes the site, posts the body, and parses rows", async () => {
    queue = [
      {
        status: 200,
        body: {
          rows: [{ keys: ["seo", "https://e.com/a"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.2 }],
          responseAggregationType: "byPage",
          metadata: { first_incomplete_date: "2026-09-30" },
        },
      },
    ];
    const r = await client().querySearchAnalytics(TOKEN, "sc-domain:example.com", body);
    expect(seen[0]!.url).toBe("/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect(seen[0]!.body).toEqual(body);
    expect(r).toEqual({
      rows: [{ keys: ["seo", "https://e.com/a"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.2 }],
      responseAggregationType: "byPage",
      firstIncompleteDate: "2026-09-30",
    });
  });

  it("an omitted rows field means no data", async () => {
    queue = [{ status: 200, body: { responseAggregationType: "auto" } }];
    expect((await client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body)).rows).toEqual([]);
  });

  it.each([
    ["wrong number of keys", { rows: [{ keys: ["only-one"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }] }],
    ["non-numeric metric", { rows: [{ keys: ["a", "b"], clicks: "1", impressions: 2, ctr: 0.5, position: 1 }] }],
    ["missing metric", { rows: [{ keys: ["a", "b"], clicks: 1, impressions: 2, ctr: 0.5 }] }],
  ])("refuses %s rather than mislabel data", async (_n, reply) => {
    queue = [{ status: 200, body: reply }];
    await expect(client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body)).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("rejects non-JSON success bodies", async () => {
    queue = [{ status: 200, raw: "<html>proxy error</html>" }];
    await expect(client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body)).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("error classification", () => {
  const err = (status: number, reason?: string, retryAfter: string | null = null) =>
    classifyGoogleError(status, reason ? { error: { errors: [{ reason }] } } : { error: {} }, retryAfter);

  it.each([
    [401, undefined, "unauthenticated"],
    [403, "forbidden", "no_resource_access"],
    [403, undefined, "no_resource_access"],
    [404, undefined, "no_resource_access"],
    [403, "insufficientPermissions", "insufficient_scope"],
    [403, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficient_scope"],
    [403, "rateLimitExceeded", "quota"],
    [403, "dailyLimitExceeded", "quota"],
    [403, "quotaExceeded", "quota"],
    [429, undefined, "quota"],
    [403, "accessNotConfigured", "api_disabled"],
    [403, "SERVICE_DISABLED", "api_disabled"],
    [400, "invalid", "invalid_request"],
    [500, undefined, "unavailable"],
    [503, "backendError", "unavailable"],
  ])("HTTP %i %s -> %s", (status, reason, kind) => {
    expect(err(status, reason).kind).toBe(kind);
  });

  it("reads Retry-After only when it is a plain number", () => {
    expect(err(429, undefined, "7").retryAfterSeconds).toBe(7);
    expect(err(429, undefined, "Wed, 21 Oct 2026 07:28:00 GMT").retryAfterSeconds).toBeUndefined();
  });

  it("never keeps Google's free-text message or odd reasons", () => {
    const e = classifyGoogleError(403, { error: { message: `secret ${TOKEN}`, errors: [{ reason: "<script>alert(1)</script>" }] } }, null);
    expect(JSON.stringify(e) + e.message + String(e.reason)).not.toContain(TOKEN);
    expect(e.reason).toBeUndefined();
  });
});

describe("retry, timeout and transport safety", () => {
  it("retries a transient 503 and then succeeds", async () => {
    queue = [{ status: 503 }, { status: 200, body: { rows: [] } }];
    await expect(client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body)).resolves.toMatchObject({ rows: [] });
    expect(seen).toHaveLength(2);
  });

  it("honors a short Retry-After on 429, then gives up after maxRetries", async () => {
    const sleeps: number[] = [];
    queue = [{ status: 429, headers: { "retry-after": "2" } }, { status: 429 }, { status: 429 }, { status: 429 }];
    const err = await client({ sleep: async (ms) => void sleeps.push(ms) }).querySearchAnalytics(TOKEN, "sc-domain:e.com", body).catch((e) => e);
    expect(err).toMatchObject({ kind: "quota" });
    expect(seen).toHaveLength(3); // 1 try + 2 retries
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("does not wait out a long Retry-After; it reports it instead", async () => {
    queue = [{ status: 429, headers: { "retry-after": "600" } }];
    const err = await client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body).catch((e) => e);
    expect(err).toMatchObject({ kind: "quota", retryAfterSeconds: 600 });
    expect(seen).toHaveLength(1);
  });

  it.each([[401], [403], [404], [400]])("never retries HTTP %i", async (status) => {
    queue = [{ status }, { status: 200, body: { rows: [] } }];
    await expect(client().querySearchAnalytics(TOKEN, "sc-domain:e.com", body)).rejects.toBeInstanceOf(GscApiError);
    expect(seen).toHaveLength(1);
  });

  it("times out as unavailable", async () => {
    queue = [{ status: 200, body: {}, delayMs: 300 }];
    const err = await client({ timeoutMs: 50, maxRetries: 0 }).listSites(TOKEN).catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
  });

  it("does not follow redirects (the bearer token must not travel to another host)", async () => {
    const hits: string[] = [];
    const other = createServer((req, res) => {
      hits.push(req.headers.authorization ?? "none");
      res.end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal`;
    queue = [{ status: 302, headers: { location: target } }];
    const err = await client({ maxRetries: 0 }).listSites(TOKEN).catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
    expect(hits).toEqual([]);
    other.close();
  });

  it("errors never contain the access token", async () => {
    queue = [{ status: 403, body: { error: { message: `bad ${TOKEN}` } } }];
    const err = await client().listSites(TOKEN).catch((e) => e);
    expect(String(err.message) + String(err.stack) + JSON.stringify(err)).not.toContain(TOKEN);
  });
});
