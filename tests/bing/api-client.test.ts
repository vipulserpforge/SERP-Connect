/**
 * Bing REST client, date parsing, response normalization, discovery and the capability matrix.
 * DATA SOURCE: MOCK. A fake `fetch` returns bodies shaped like Microsoft's documented samples; nothing contacts Bing.
 */
import { describe, expect, it } from "vitest";
import {
  BING_API_KEY_BASE_URL,
  BING_CAPABILITIES,
  BING_OAUTH_BASE_URL,
  BingApiError,
  HttpBingApiClient,
  discoverBingSites,
  enabledBingCapabilities,
  kindForApiErrorCode,
  parseBingDate,
  parseSites,
  toBingConnectorError,
  validateBingApiKey,
  validateBingConnectionName,
  type BingApiErrorKind,
} from "@serp/provider-bing";

const KEY = "0123456789abcdef0123456789abcdef";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Seen {
  url: URL;
  init: RequestInit;
}
function client(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const c = new HttpBingApiClient({
    fetch: (async (input: URL | string, init: RequestInit) => {
      const s = { url: new URL(String(input)), init };
      seen.push(s);
      return respond(s);
    }) as typeof fetch,
  });
  return { c, seen };
}
const apiKey = { method: "api_key", apiKey: KEY } as const;
const oauth = { method: "oauth", accessToken: "access-token-value-123" } as const;

describe("requests (JSON/REST only)", () => {
  it("API key: GET on the documented ssl.bing.com JSON path with the key as the apikey query parameter", async () => {
    const { c, seen } = client(() => json({ d: [] }));
    await c.getUserSites(apiKey);
    const { url, init } = seen[0]!;
    expect(url.origin + url.pathname).toBe(`${BING_API_KEY_BASE_URL}GetUserSites`);
    expect(url.searchParams.get("apikey")).toBe(KEY);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init.redirect).toBe("error");
  });

  it("OAuth: GET on the www.bing.com JSON path with Authorization: Bearer and NO apikey parameter", async () => {
    const { c, seen } = client(() => json({ d: [] }));
    await c.getRankAndTrafficStats(oauth, "https://example.com/");
    const { url, init } = seen[0]!;
    expect(url.origin + url.pathname).toBe(`${BING_OAUTH_BASE_URL}GetRankAndTrafficStats`);
    expect(url.searchParams.get("siteUrl")).toBe("https://example.com/");
    expect(url.searchParams.has("apikey")).toBe(false);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer access-token-value-123");
  });

  it("never uses the retired SOAP or POX protocols", async () => {
    const { c, seen } = client(() => json({ d: [] }));
    await c.getUserSites(apiKey);
    await c.getQueryStats(oauth, "https://example.com/");
    await c.getCrawlStats(apiKey, "https://example.com/");
    for (const s of seen) {
      expect(s.url.pathname).toMatch(/^\/webmaster\/api\.svc\/json\//);
      expect(s.url.pathname).not.toMatch(/\/(soap|pox)/i);
    }
    expect(BING_API_KEY_BASE_URL).not.toMatch(/pox|soap/i);
    expect(BING_OAUTH_BASE_URL).not.toMatch(/pox|soap/i);
  });

  it("does not fall back to the other credential type, retry, or follow redirects", async () => {
    const { c, seen } = client(() => json({ ErrorCode: 3, Message: "InvalidApiKey" }, 400));
    await expect(c.getUserSites(oauth)).rejects.toMatchObject({ kind: "unauthenticated" });
    expect(seen).toHaveLength(1);
  });
});

describe("date format", () => {
  it("reads Microsoft's example (/Date(1316156400000-0700)/) as 2011-09-16", () => {
    expect(parseBingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
  });
  it("applies the offset: the same instant is a different calendar date east and west of UTC", () => {
    expect(parseBingDate("/Date(1316156400000+0000)/")).toBe("2011-09-16"); // 07:00 UTC
    expect(parseBingDate("/Date(1316131200000-0700)/")).toBe("2011-09-15"); // 00:00 UTC = 17:00 previous day at -07:00
    expect(parseBingDate("/Date(1316131200000+0900)/")).toBe("2011-09-16");
  });
  it("accepts a value with no offset and rejects everything else", () => {
    expect(parseBingDate("/Date(1316156400000)/")).toBe("2011-09-16");
    for (const bad of ["2011-09-16", "", "/Date()/", "/Date(abc)/", "Date(1316156400000)", "/Date(99999999999999999999)/", "/Date(-99999999999999)/"]) {
      expect(parseBingDate(bad)).toBeNull();
    }
  });
});

describe("normalization", () => {
  it("traffic: numbers and dates, absent values stay null (never 0), unreadable rows are counted", async () => {
    const { c } = client(() =>
      json({
        d: [
          { __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100 },
          { Date: "/Date(1316242800000-0700)/", Clicks: 0 },
          { Date: "not a date", Clicks: 1, Impressions: 2 },
          { Clicks: "x" },
        ],
      }),
    );
    const r = await c.getRankAndTrafficStats(apiKey, "https://example.com/");
    expect(r.rows).toEqual([
      { date: "2011-09-16", clicks: 15, impressions: 100 },
      { date: "2011-09-17", clicks: 0, impressions: null },
    ]);
    expect(r.skipped).toBe(2);
  });

  it("queries: keeps Bing's field names mapped, positions as numbers", async () => {
    const { c } = client(() =>
      json({ d: [{ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", AvgClickPosition: 18, AvgImpressionPosition: 17, Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100, Query: "query" }] }),
    );
    expect((await c.getQueryStats(apiKey, "https://example.com/")).rows).toEqual([
      { query: "query", date: "2011-09-16", clicks: 15, impressions: 100, avgClickPosition: 18, avgImpressionPosition: 17 },
    ]);
  });

  it("crawl: maps every documented field", async () => {
    const { c } = client(() =>
      json({
        d: [{ AllOtherCodes: 0, BlockedByRobotsTxt: 0, Code2xx: 9998, Code301: 0, Code302: 0, Code4xx: 1, Code5xx: 1, ContainsMalware: 5, CrawlErrors: 0, CrawledPages: 0, Date: "/Date(1316156400000-0700)/", InIndex: 1000, InLinks: 2048 }],
      }),
    );
    expect((await c.getCrawlStats(apiKey, "https://example.com/")).rows[0]).toEqual({
      date: "2011-09-16", crawledPages: 0, crawlErrors: 0, inIndex: 1000, inLinks: 2048, code2xx: 9998, code301: 0, code302: 0, code4xx: 1, code5xx: 1, allOtherCodes: 0, blockedByRobotsTxt: 0, containsMalware: 5,
    });
  });

  it("empty and null bodies are an empty list, a non-list is a bad response", async () => {
    expect((await client(() => json({ d: [] })).c.getQueryStats(apiKey, "https://e.com/")).rows).toEqual([]);
    expect((await client(() => json({ d: null })).c.getQueryStats(apiKey, "https://e.com/")).rows).toEqual([]);
    await expect(client(() => json({ d: { not: "a list" } })).c.getQueryStats(apiKey, "https://e.com/")).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("sites and ownership codes", () => {
  const body = {
    d: [
      { __type: "Site:#Microsoft.Bing.Webmaster.Api", AuthenticationCode: "258CAD36B9EEE22F1CFDEB4C239D26BB", DnsVerificationCode: "258cad36b9eee22f1cfdeb4c239d26bb.example.com", IsVerified: true, Url: "http://example.com" },
      { IsVerified: false, Url: "https://pending.example.org/", AuthenticationCode: "SECRET2" },
      { Url: "https://unknown-state.example.net/" },
      { Url: "" },
    ],
  };

  it("drops the site-ownership codes at the boundary: nothing downstream can store, show or log them", () => {
    const sites = parseSites(body);
    expect(JSON.stringify(sites)).not.toMatch(/258CAD36|258cad36|SECRET2|AuthenticationCode|DnsVerificationCode/i);
    expect(sites).toEqual([
      { url: "http://example.com", isVerified: true },
      { url: "https://pending.example.org/", isVerified: false },
      { url: "https://unknown-state.example.net/", isVerified: null },
    ]);
  });

  it("only sites Bing states are verified become properties; unknown is not verified", () => {
    const d = discoverBingSites(parseSites(body));
    expect(d.properties.map((p) => p.externalPropertyId)).toEqual(["http://example.com"]);
    expect(d.skipped).toEqual([
      { url: "https://pending.example.org/", reason: "unverified" },
      { url: "https://unknown-state.example.net/", reason: "verification_unknown" },
    ]);
  });

  it("an account with no sites is an empty, successful discovery", () => {
    expect(discoverBingSites([])).toEqual({ properties: [], skipped: [] });
  });

  it("de-duplicates repeated site addresses", () => {
    expect(discoverBingSites([{ url: "https://a.com/", isVerified: true }, { url: "https://a.com/", isVerified: true }]).properties).toHaveLength(1);
  });
});

describe("error handling", () => {
  const cases: Array<[string, () => Response, BingApiErrorKind]> = [
    ["400 InvalidApiKey (3)", () => json({ ErrorCode: 3, Message: "InvalidApiKey" }, 400), "unauthenticated"],
    ["400 ThrottleUser (4)", () => json({ ErrorCode: 4, Message: "ThrottleUser" }, 400), "throttled"],
    ["400 ThrottleHost (5)", () => json({ ErrorCode: 5, Message: "x" }, 400), "throttled"],
    ["400 UserBlocked (6)", () => json({ ErrorCode: 6, Message: "x" }, 400), "forbidden"],
    ["400 UserNotFound (10)", () => json({ ErrorCode: 10, Message: "x" }, 400), "forbidden"],
    ["400 NotFound (11)", () => json({ ErrorCode: 11, Message: "x" }, 400), "not_found"],
    ["400 NotAuthorized (14)", () => json({ ErrorCode: 14, Message: "x" }, 400), "not_found"],
    ["400 InvalidUrl (7)", () => json({ ErrorCode: 7, Message: "x" }, 400), "invalid_request"],
    ["400 InvalidParameter (8)", () => json({ ErrorCode: 8, Message: "x" }, 400), "invalid_request"],
    ["400 Deprecated (16)", () => json({ ErrorCode: 16, Message: "x" }, 400), "capability"],
    ["400 InternalError (1)", () => json({ ErrorCode: 1, Message: "x" }, 400), "unavailable"],
    ["400 unknown code", () => json({ ErrorCode: 999, Message: "x" }, 400), "unavailable"],
    ["400 without a body", () => new Response("", { status: 400 }), "invalid_request"],
    ["401", () => json({}, 401), "unauthenticated"],
    ["403", () => json({}, 403), "forbidden"],
    ["404 (endpoint gone)", () => json({}, 404), "capability"],
    ["429", () => json({}, 429), "throttled"],
    ["500", () => json({}, 500), "unavailable"],
    ["503", () => json({}, 503), "unavailable"],
    ["200 carrying an ErrorCode", () => json({ ErrorCode: 3, Message: "InvalidApiKey" }, 200), "unauthenticated"],
    ["200 with HTML", () => new Response("<html>maintenance</html>", { status: 200 }), "bad_response"],
  ];
  for (const [name, respond, kind] of cases) {
    it(`${name} -> ${kind}`, async () => {
      await expect(client(respond).c.getUserSites(apiKey)).rejects.toMatchObject({ kind });
    });
  }

  it("honours Retry-After on throttling and exposes it for the caller", async () => {
    const err = await client(() => json({}, 429, { "retry-after": "7" })).c.getUserSites(apiKey).catch((e) => e);
    expect(err).toBeInstanceOf(BingApiError);
    expect(err.retryAfterSeconds).toBe(7);
    expect(toBingConnectorError(err)).toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true, retryAfterSeconds: 7 });
  });

  it("network failures and timeouts are 'unavailable'", async () => {
    const failing = new HttpBingApiClient({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(failing.getUserSites(apiKey)).rejects.toMatchObject({ kind: "unavailable" });
    const slow = new HttpBingApiClient({ timeoutMs: 30, fetch: ((_: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch });
    await expect(slow.getUserSites(apiKey)).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("the API key never appears in an error, its message, or its serialization", async () => {
    const { c } = client(() => json({ ErrorCode: 3, Message: `InvalidApiKey ${KEY}` }, 400));
    const err = await c.getUserSites(apiKey).catch((e) => e);
    const converted = toBingConnectorError(err);
    for (const text of [String(err.message), JSON.stringify(err), converted.message, JSON.stringify(converted), String((err as Error).stack)]) expect(text).not.toContain(KEY);
  });

  it("maps to the shared safe errors", () => {
    const map = (kind: BingApiErrorKind) => toBingConnectorError(new BingApiError(kind));
    expect(map("unauthenticated").code).toBe("AUTH_EXPIRED");
    expect(map("forbidden").code).toBe("FORBIDDEN");
    expect(map("not_found").code).toBe("PROPERTY_NOT_ACCESSIBLE");
    expect(map("throttled").code).toBe("PROVIDER_RATE_LIMITED");
    expect(map("invalid_request").code).toBe("INVALID_QUERY");
    expect(map("capability").code).toBe("PROVIDER_CAPABILITY_UNAVAILABLE");
    expect(map("unavailable")).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(toBingConnectorError(new Error("boom")).code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("covers every documented ApiErrorCode (0-16)", () => {
    for (let code = 0; code <= 16; code++) expect(kindForApiErrorCode(code)).toBeTruthy();
  });
});

describe("input validation", () => {
  it("accepts a normal API key and trims it", () => {
    expect(validateBingApiKey(`  ${KEY}\n`)).toBe(KEY);
  });
  it("rejects keys with spaces, symbols or the wrong length (nothing odd can reach a URL)", () => {
    for (const bad of ["", "short", `${KEY}&x=1`, `${KEY} ${KEY}`, `${KEY}\n${KEY}`, "a".repeat(65), "x".repeat(15), "key/with/slash0000000"]) {
      expect(() => validateBingApiKey(bad), bad).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
    }
  });
  it("validates connection names", () => {
    expect(validateBingConnectionName("  My   Bing account ")).toBe("My Bing account");
    for (const bad of ["a", "x".repeat(61), "<script>", "a\u0000b"]) expect(() => validateBingConnectionName(bad)).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });
});

describe("capability matrix", () => {
  const READ_METHODS = [
    "GetUserSites", "GetRankAndTrafficStats", "GetQueryStats", "GetCrawlStats", "GetPageStats", "GetQueryPageStats", "GetPageQueryStats", "GetQueryPageDetailStats",
    "GetCrawlIssues", "GetBlockedUrls", "GetLinkCounts", "GetUrlLinks", "GetFeeds", "GetUrlInfo", "GetUrlTrafficInfo", "GetUrlSubmissionQuota", "GetKeywordStats",
    "GetQueryTrafficStats", "GetChildrenUrlInfo", "GetChildrenUrlTrafficInfo", "GetCrawlSettings", "GetFeedDetails", "GetDeepLinkBlocks", "GetActivePagePreviewBlocks",
    "GetCountryRegionSettings", "GetQueryParameters", "GetConnectedPages", "GetSiteMoves", "GetSiteRoles", "GetContentSubmissionQuota", "GetKeyword", "GetRelatedKeywords",
  ];
  it("enables only documented read-only reports", () => {
    expect(enabledBingCapabilities().map((c) => c.id)).toEqual([
      "sites", "traffic", "queries", "crawl", "pages", "query_pages", "page_queries", "query_page_detail", "crawl_issues", "blocked_urls", "inbound_links", "url_links", "sitemaps", "url_info", "url_traffic", "submission_quota", "keyword_stats",
      "query_traffic", "children_url_info", "children_url_traffic", "crawl_settings", "feed_details", "deep_link_blocks", "page_preview_blocks", "country_region_settings", "query_parameters",
      "connected_pages", "site_moves", "site_roles", "content_submission_quota", "keyword", "related_keywords",
    ]);
    for (const c of enabledBingCapabilities()) expect(["verified", "documented"]).toContain(c.status);
  });
  it("only the reports checked against a live account are marked verified", () => {
    expect(enabledBingCapabilities().filter((c) => c.status === "verified").map((c) => c.id)).toEqual(["sites", "traffic", "queries", "crawl"]);
  });
  it("keeps write operations disabled", () => {
    expect(BING_CAPABILITIES.find((c) => c.id === "writes")).toMatchObject({ enabled: false, status: "write_out_of_scope" });
  });
  it("every enabled endpoint is a GET (or the one documented read-only POST) on a documented read method", () => {
    for (const c of enabledBingCapabilities()) {
      expect(c.method).toBe(c.endpoint === "GetChildrenUrlInfo" ? "POST" : "GET");
      expect(READ_METHODS).toContain(c.endpoint);
    }
  });
  it("no enabled endpoint is a write", () => {
    for (const c of enabledBingCapabilities()) expect(c.endpoint).not.toMatch(/^(Add|Remove|Submit|Save|Enable|Fetch|Verify|Update)/);
  });
});
