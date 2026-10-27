/**
 * Parsers and request encoding for the Bing expansion methods, checked against the sample responses Microsoft publishes for each
 * method (learn.microsoft.com, IWebmasterApi). DATA SOURCE: Microsoft's documented samples, not a live Bing account.
 */
import { describe, expect, it } from "vitest";
import {
  HttpBingApiClient,
  parseContentQuota,
  parseCrawlSettings,
  parseFeeds,
  parseKeywordPoints,
  parseLoose,
  parseQueryParameters,
  parseSiteRoles,
  parseTraffic,
  parseUrlInfoList,
  parseUrlTrafficList,
} from "../../packages/provider-bing/src/index.js";

describe("parsers against Microsoft's samples", () => {
  it("GetQueryTrafficStats", () => {
    const r = parseTraffic({ d: [{ __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100 }] });
    expect(r.rows).toEqual([{ date: "2011-09-16", clicks: 15, impressions: 100 }]);
  });

  it("GetChildrenUrlInfo", () => {
    const r = parseUrlInfoList({ d: [{ AnchorCount: 50, DiscoveryDate: "/Date(1315349995284-0700)/", DocumentSize: 0, HttpStatus: 0, IsPage: false, LastCrawledDate: "/Date(1316213995284-0700)/", TotalChildUrlCount: 100, Url: "example.com" }] });
    expect(r.rows[0]).toMatchObject({ url: "example.com", isPage: false, anchorCount: 50, totalChildUrlCount: 100, discoveryDate: "2011-09-06", lastCrawledDate: "2011-09-16" });
  });

  it("GetChildrenUrlTrafficInfo", () => {
    expect(parseUrlTrafficList({ d: [{ Clicks: 10, Impressions: 100, IsPage: false, Url: "example.com" }] }).rows).toEqual([{ url: "example.com", isPage: false, clicks: 10, impressions: 100 }]);
  });

  it("GetCrawlSettings reads the JSON array, the XML sample's base64 form, and the fields the live API actually sends", () => {
    expect(parseCrawlSettings({ d: { AjaxEnabled: true, CrawlRate: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] } })).toEqual({ ajaxEnabled: true, crawlBoostAvailable: null, crawlBoostEnabled: null, crawlRate: Array(24).fill(5) });
    expect(parseCrawlSettings({ d: { CrawlBoostAvailable: false, CrawlBoostEnabled: false, CrawlRate: Array(24).fill(5) } })).toEqual({ ajaxEnabled: null, crawlBoostAvailable: false, crawlBoostEnabled: false, crawlRate: Array(24).fill(5) });
    expect(parseCrawlSettings({ d: { AjaxEnabled: true, CrawlRate: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF" } })?.crawlRate).toEqual(Array(24).fill(5));
    expect(parseCrawlSettings({ d: null })).toBeNull();
  });

  it("GetFeedDetails", () => {
    const r = parseFeeds({ d: [{ Compressed: false, FileSize: 1024, LastCrawled: "/Date(1315781995063-0700)/", Status: "Success", Submitted: "/Date(1316213995063-0700)/", Type: "Sitemap", Url: "http://example.com", UrlCount: 1023 }] });
    expect(r.rows[0]).toMatchObject({ status: "Success", urlCount: 1023, lastCrawled: "2011-09-11", submitted: "2011-09-16" });
  });

  it("GetQueryParameters, including a date without an offset", () => {
    const r = parseQueryParameters({ d: [{ Date: "/Date(1314031258933)/", IsEnabled: false, Parameter: "cart", Source: 1 }, { Date: "/Date(1303514052179-0700)/", IsEnabled: false, Parameter: "sfdsdfs", Source: 1 }] });
    expect(r.rows.map((x) => x.parameter)).toEqual(["cart", "sfdsdfs"]);
    expect(r.rows[0]).toMatchObject({ isEnabled: false, source: 1, date: "2011-08-22" });
  });

  it("GetSiteRoles keeps the emails and role, and the delegation code never leaves the parser", () => {
    const r = parseSiteRoles({
      d: [{ Date: "/Date(1316645995221-0700)/", DelegatedCode: "258CAD36B9EEE22F1CFDEB4C239D26BB", DelegatedCodeOwnerEmail: "webmaster@example.com", DelegatorEmail: "webmaster@example.com", Email: "webmaster@example.com", Expired: false, Role: 2, Site: "http://host1.example.com", VerificationSite: "http://example.com" }],
    });
    expect(r.rows[0]).toMatchObject({ email: "webmaster@example.com", role: 2, expired: false, site: "http://host1.example.com", verificationSite: "http://example.com", date: "2011-09-21" });
    expect(JSON.stringify(r)).not.toContain("258CAD36");
  });

  it("GetContentSubmissionQuota", () => {
    expect(parseContentQuota({ d: { __type: "ContentSubmissionQuota:#Microsoft.Bing.Webmaster.Api", DailyQuota: 100, MonthlyQuota: 3000 } })).toEqual({ dailyQuota: 100, monthlyQuota: 3000 });
  });

  it("undocumented shapes: every plain field is kept, dates are read, secrets and __type are dropped, junk is counted", () => {
    const r = parseLoose({
      d: [
        { __type: "DeepLinkBlock:#x", Url: "https://a.example/x", Date: "/Date(1316156400000-0700)/", Active: true, AuthenticationCode: "SECRET1", DnsVerificationCode: "SECRET2", Nested: { Keep: 1, AccessToken: "SECRET3" } },
        "not an object",
        null,
      ],
    });
    expect(r.skipped).toBe(2);
    expect(r.rows[0]).toMatchObject({ url: "https://a.example/x", date: "2011-09-16", active: "yes" });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|__type/);
    expect(parseLoose({ d: { Single: 1 } }).rows).toEqual([{ single: 1 }]);
    expect(parseLoose({ d: null })).toEqual({ rows: [], skipped: 0 });
  });

  it("GetKeyword (one object) and GetRelatedKeywords (a list) share the Keyword shape", () => {
    expect(parseKeywordPoints({ d: { Query: "blue widgets", Date: "/Date(1316156400000-0700)/", Impressions: 5, BroadImpressions: 9 } }).rows).toEqual([{ query: "blue widgets", date: "2011-09-16", impressions: 5, broadImpressions: 9 }]);
    const list = parseKeywordPoints({ d: [{ Query: "a" }, { Query: "b", Impressions: 2 }, 7] });
    expect(list.rows.map((x) => x.query)).toEqual(["a", "b"]);
    expect(list.rows[0]).toMatchObject({ impressions: null, date: null }); // missing is null, never 0
    expect(list.skipped).toBe(1);
  });
});

describe("request encoding", () => {
  const seen: Array<{ url: URL; method: string; body: string | null }> = [];
  const fetchStub = (async (input: URL | string, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), method: String(init?.method), body: typeof init?.body === "string" ? init.body : null });
    return new Response(JSON.stringify({ d: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new HttpBingApiClient({ fetch: fetchStub });
  const auth = { method: "api_key", apiKey: "k".repeat(32) } as const;

  it("string arguments are sent bare, as the live API requires; every method but GetChildrenUrlInfo is a GET", async () => {
    seen.length = 0;
    await client.getQueryTrafficStats(auth, "https://a.example/", "blue widgets");
    await client.getChildrenUrlTrafficInfo(auth, "https://a.example/", "a.example/blog", 2);
    await client.getFeedDetails(auth, "https://a.example/", "https://a.example/sitemap.xml");
    await client.getSiteRoles(auth, "https://a.example/", true);
    await client.getCrawlSettings(auth, "https://a.example/");
    const [traffic, children, feed, roles, crawl] = seen;
    expect(traffic!.url.searchParams.get("query")).toBe("blue widgets");
    expect(traffic!.url.searchParams.get("siteUrl")).toBe("https://a.example/");
    expect(children!.url.searchParams.get("url")).toBe("a.example/blog");
    expect(children!.url.searchParams.get("page")).toBe("2");
    expect(feed!.url.searchParams.get("feedUrl")).toBe("https://a.example/sitemap.xml");
    expect(roles!.url.searchParams.get("includeAllSubdomains")).toBe("true");
    expect(crawl!.url.searchParams.get("apikey")).toBe("k".repeat(32));
    for (const c of seen) {
      expect(c.method).toBe("GET");
      expect(c.url.pathname).toMatch(/\/webmaster\/api\.svc\/json\/Get/);
      expect(c.url.hostname).toBe("ssl.bing.com");
    }
  });

  it("GetChildrenUrlInfo is the one POST: a JSON body with Any filters, and the key stays in the query string", async () => {
    seen.length = 0;
    await client.getChildrenUrlInfo(auth, "https://a.example/", "a.example", 0, {});
    const c = seen[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.pathname.endsWith("/json/GetChildrenUrlInfo")).toBe(true);
    expect(c.url.searchParams.get("apikey")).toBe("k".repeat(32));
    const body = JSON.parse(c.body!);
    expect(body).toEqual({ siteUrl: "https://a.example/", url: "a.example", page: 0, filterProperties: { CrawlDateFilter: 0, DiscoveredDateFilter: 0, DocFlagsFilters: 0, HttpCodeFilters: 0 } });
    expect(c.body).not.toContain("k".repeat(32));
  });

  it("keyword methods send no site, bare text, and plain ISO dates (the /Date(ms)/ form is rejected live)", async () => {
    seen.length = 0;
    await client.getKeyword(auth, "blue widgets", "us", "en-US", "2026-10-01", "2026-10-15");
    await client.getRelatedKeywords(auth, "blue widgets", "us", "en-US", "2026-10-01", "2026-10-15");
    for (const c of seen) {
      expect(c.url.searchParams.has("siteUrl")).toBe(false);
      expect(c.url.searchParams.get("q")).toBe("blue widgets");
      expect(c.url.searchParams.get("country")).toBe("us");
      expect(c.url.searchParams.get("startDate")).toBe("2026-10-01");
      expect(c.url.searchParams.get("endDate")).toBe("2026-10-15");
    }
  });
});
