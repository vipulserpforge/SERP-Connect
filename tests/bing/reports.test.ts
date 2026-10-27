/**
 * Bing report methods beyond traffic/queries/crawl: parsers (Microsoft's published sample bodies), request encoding,
 * normalization maths and the report builder.
 * DATA SOURCE: MOCK. Samples are copied from Microsoft's per-method pages; the mock client is deterministic. Nothing contacts Bing.
 */
import { loadSharedEnv, type AuthorizedQueryContext } from "@serp/contracts";
import { MOCK_USER_A_ID } from "@serp/db";
import { createMockReportService } from "@serp/reporting";
import { describe, expect, it } from "vitest";
import {
  BING_READ_METHODS_NOT_COVERED,
  HttpBingApiClient,
  MockBingApiClient,
  aggregateByKey,
  createBingAdapter,
  decodeCrawlIssues,
  missingDays,
  normalizeUrl,
  parseBlockedUrls,
  parseCrawlIssues,
  parseFeeds,
  parseKeywordStats,
  parseLinkCounts,
  parseLinkDetails,
  parsePageStats,
  parseQueryPageDetail,
  parseSubmissionQuota,
  parseUrlInfo,
  parseUrlTraffic,
  pctChange,
  previousWindow,
  totalsOf,
  type BingAuth,
  type BingQuery,
} from "@serp/provider-bing";

const KEY = "0123456789abcdef0123456789abcdef";
const AUTH: BingAuth = { method: "api_key", apiKey: KEY };
const SITE = "https://www.example.com/";
const NOW = new Date("2026-10-19T12:00:00Z");

// ---- parsers, with the bodies Microsoft publishes -------------------------------------------------------

describe("parsers follow Microsoft's published samples", () => {
  it("GetPageStats: QueryStats rows, the Query field carries the page address", () => {
    const r = parsePageStats({ d: [{ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", AvgClickPosition: 18, AvgImpressionPosition: 17, Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100, Query: "https://example.com/url1" }] });
    expect(r.rows).toEqual([{ page: "https://example.com/url1", date: "2011-09-16", clicks: 15, impressions: 100, avgClickPosition: 18, avgImpressionPosition: 17 }]);
  });
  it("GetQueryPageDetailStats: Position, no query field", () => {
    expect(parseQueryPageDetail({ d: [{ Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100, Position: 5 }] }).rows).toEqual([{ date: "2011-09-16", clicks: 15, impressions: 100, position: 5 }]);
  });
  it("GetCrawlIssues: rows need only a URL; Issues stays a raw flag number", () => {
    const r = parseCrawlIssues({ d: [{ HttpCode: 200, Issues: 32, Url: "http://example.com/url1.htm", InLinks: 10 }, { HttpCode: 404 }] });
    expect(r.rows).toEqual([{ url: "http://example.com/url1.htm", httpCode: 200, issues: 32, inLinks: 10 }]);
    expect(r.skipped).toBe(1);
  });
  it("GetLinkCounts and GetUrlLinks: the object answer with TotalPages", () => {
    expect(parseLinkCounts({ d: { Links: [{ Count: 14, Url: "http://example.com/page1.html" }], TotalPages: 3 } })).toEqual({ links: [{ url: "http://example.com/page1.html", count: 14 }], totalPages: 3 });
    expect(parseLinkDetails({ d: { Details: [{ AnchorText: "link", Url: "http://example.com/page1.html" }], TotalPages: 3 } })).toEqual({ details: [{ url: "http://example.com/page1.html", anchorText: "link" }], totalPages: 3 });
    expect(parseLinkCounts({ d: null })).toEqual({ links: [], totalPages: null });
  });
  it("GetFeeds: dates become ISO days, status stays Bing's word", () => {
    const r = parseFeeds({ d: [{ Compressed: false, FileSize: 1024, LastCrawled: "/Date(1315781995040-0700)/", Status: "Success", Submitted: "/Date(1316213995040-0700)/", Type: "Sitemap", Url: "http://example.com/sitemap.xml", UrlCount: 1023 }] });
    expect(r.rows[0]).toEqual({ url: "http://example.com/sitemap.xml", type: "Sitemap", status: "Success", submitted: "2011-09-16", lastCrawled: "2011-09-11", urlCount: 1023, fileSize: 1024, compressed: false });
  });
  it("GetUrlInfo, GetUrlTrafficInfo, GetUrlSubmissionQuota", () => {
    expect(parseUrlInfo({ d: { AnchorCount: 50, DiscoveryDate: "/Date(1315349995266-0700)/", DocumentSize: 0, HttpStatus: 0, IsPage: false, LastCrawledDate: "/Date(1316213995266-0700)/", TotalChildUrlCount: 100, Url: "example.com" } })).toMatchObject({ url: "example.com", anchorCount: 50, discoveryDate: "2011-09-06", lastCrawledDate: "2011-09-16", totalChildUrlCount: 100 });
    expect(parseUrlTraffic({ d: { Clicks: 10, Impressions: 100, IsPage: false, Url: "example.com" } })).toEqual({ url: "example.com", isPage: false, clicks: 10, impressions: 100 });
    expect(parseSubmissionQuota({ d: { DailyQuota: 5, MonthlyQuota: 24 } })).toEqual({ dailyQuota: 5, monthlyQuota: 24 });
    expect(parseUrlInfo({ d: null })).toBeNull();
  });
  it("GetBlockedUrls (fields from the BlockedUrl object) and GetKeywordStats (fields from the class reference)", () => {
    expect(parseBlockedUrls({ d: [{ Date: "/Date(1316156400000-0700)/", EntityType: 0, RequestType: 1, Url: "http://example.com/url1" }] }).rows).toEqual([{ url: "http://example.com/url1", date: "2011-09-16", entityType: 0, requestType: 1 }]);
    expect(parseKeywordStats({ d: [{ Query: "widgets", Date: "/Date(1316156400000-0700)/", Impressions: 10, BroadImpressions: 40 }] }).rows).toEqual([{ query: "widgets", date: "2011-09-16", impressions: 10, broadImpressions: 40 }]);
  });
  it("a body that is not the documented shape is a bad_response, never silently empty", () => {
    expect(() => parseLinkCounts({ d: "nope" })).toThrow();
    expect(() => parseCrawlIssues({ d: {} })).toThrow();
  });
});

// ---- request encoding --------------------------------------------------------------------------------------

describe("request encoding", () => {
  function recording() {
    const seen: URL[] = [];
    const fetchImpl = (async (input: URL | string) => {
      seen.push(new URL(String(input)));
      return new Response(JSON.stringify({ d: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { seen, client: new HttpBingApiClient({ fetch: fetchImpl }) };
  }
  it("sends every string argument bare (the live API rejects Microsoft's JSON-quoted form), key in apikey only", async () => {
    const { seen, client } = recording();
    await client.getQueryPageDetailStats(AUTH, SITE, "blue widgets", "https://www.example.com/a");
    const u = seen[0]!;
    expect(u.pathname).toBe("/webmaster/api.svc/json/GetQueryPageDetailStats");
    expect(u.searchParams.get("siteUrl")).toBe(SITE);
    expect(u.searchParams.get("query")).toBe("blue widgets");
    expect(u.searchParams.get("page")).toBe("https://www.example.com/a");
    expect(u.searchParams.get("apikey")).toBe(KEY);
  });
  it("paged link reports send the page number as a bare integer", async () => {
    const { seen, client } = recording();
    await client.getLinkCounts(AUTH, SITE, 2);
    await client.getUrlLinks(AUTH, SITE, "https://www.example.com/a", 1);
    expect(seen[0]!.searchParams.get("page")).toBe("2");
    expect(seen[1]!.searchParams.get("page")).toBe("1");
    expect(seen[1]!.searchParams.get("link")).toBe("https://www.example.com/a");
  });
  it("keyword stats use q, country and language and no siteUrl", async () => {
    const { seen, client } = recording();
    await client.getKeywordStats(AUTH, "widgets", "us", "en-US");
    expect([...seen[0]!.searchParams.keys()].sort()).toEqual(["apikey", "country", "language", "q"]);
  });
  it("every new method is a GET", async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      methods.push(String(init?.method));
      return new Response(JSON.stringify({ d: null }), { status: 200 });
    }) as typeof fetch;
    const c = new HttpBingApiClient({ fetch: fetchImpl });
    await Promise.all([c.getPageStats(AUTH, SITE), c.getCrawlIssues(AUTH, SITE), c.getBlockedUrls(AUTH, SITE), c.getFeeds(AUTH, SITE), c.getUrlInfo(AUTH, SITE, "x"), c.getUrlSubmissionQuota(AUTH, SITE)]);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
});

// ---- normalization maths -------------------------------------------------------------------------------------

describe("normalization", () => {
  it("normalizeUrl merges trailing slash, #anchor, query string, default port and host case, and keeps the root", () => {
    const variants = ["https://Example.com/a", "https://example.com/a/", "https://example.com/a?utm_source=x#top", "https://example.com:443/a", "https://example.com//a"];
    expect(new Set(variants.map(normalizeUrl))).toEqual(new Set(["https://example.com/a"]));
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com/?x=1")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com/A")).not.toBe(normalizeUrl("https://example.com/a")); // paths are case-sensitive
    expect(normalizeUrl("domain:example.com")).toBe("domain:example.com");
  });
  it("pctChange is null (not 0, not Infinity) with nothing to compare against", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(10, null)).toBeNull();
    expect(pctChange(0, 100)).toBe(-100);
  });
  it("aggregation sums, computes CTR and weights positions by impressions (and click position by clicks)", () => {
    const rows = [
      { date: "2026-10-05", clicks: 10, impressions: 100, avgClickPosition: 2, avgImpressionPosition: 3 },
      { date: "2026-10-12", clicks: 30, impressions: 300, avgClickPosition: 4, avgImpressionPosition: 7 },
    ];
    const [a] = aggregateByKey(rows, () => "q");
    expect(a).toMatchObject({ clicks: 40, impressions: 400, ctr: 0.1, periods: 2 });
    expect(a!.avgPosition).toBeCloseTo((3 * 100 + 7 * 300) / 400, 10); // 6, not the plain mean 5
    expect(a!.avgClickPosition).toBeCloseTo((2 * 10 + 4 * 30) / 40, 10);
  });
  it("missing values stay missing: null clicks are not turned into 0 and a zero-impression row has no CTR", () => {
    const [a] = aggregateByKey([{ date: "2026-10-05", clicks: null, impressions: 0, avgClickPosition: null, avgImpressionPosition: null }], () => "q");
    expect(a).toMatchObject({ clicks: null, impressions: 0, ctr: null, avgPosition: null });
    expect(totalsOf([{ clicks: null, impressions: null }])).toEqual({ clicks: null, impressions: null, ctr: null });
  });
  it("previousWindow is the same length, directly before", () => {
    expect(previousWindow("2026-10-06", "2026-10-19")).toEqual({ startDate: "2026-09-22", endDate: "2026-10-05" });
    expect(previousWindow("2026-10-19", "2026-10-19")).toEqual({ startDate: "2026-10-18", endDate: "2026-10-18" });
  });
  it("missingDays finds gaps inside a daily series only", () => {
    expect(missingDays(["2026-10-01", "2026-10-02", "2026-10-05"])).toEqual(["2026-10-03", "2026-10-04"]);
    expect(missingDays(["2026-10-01"])).toEqual([]);
  });
  it("crawl issue flags decode known bits and report unknown bits raw", () => {
    expect(decodeCrawlIssues(0)).toEqual([]);
    expect(decodeCrawlIssues(null)).toEqual([]);
    expect(decodeCrawlIssues(32)).toEqual(["contains_malware"]); // Microsoft's sample
    expect(decodeCrawlIssues(4 | 16)).toEqual(["http_4xx", "blocked_by_robots_txt"]);
    expect(decodeCrawlIssues(4 | 1024)).toEqual(["http_4xx", "unknown_flag_1024"]);
  });
});

// ---- report builder (mock client) ---------------------------------------------------------------------------------

const ctx = { userId: "u", requestId: "req", property: { externalPropertyId: SITE, displayName: SITE }, connection: { authMethod: "api_key" } } as unknown as AuthorizedQueryContext;

function query(over: Partial<BingQuery> = {}): BingQuery {
  return {
    propertyId: SITE, report: "queries", startDate: null, endDate: null, compare: null, aggregate: true, sortBy: "clicks", sortDirection: "desc", limit: 100,
    query: null, page: null, url: null, keyword: null, country: null, language: null, contains: null, minImpressions: null, maxCtr: null, onlyDeclining: false, mergeUrlVariants: true,
    ...over,
  };
}
const run = (over: Partial<BingQuery>, client = new MockBingApiClient(() => NOW)) => createBingAdapter({ client, getAuth: async () => AUTH, now: () => NOW }).query(query(over), ctx);
const codes = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((w) => w.code);

describe("report builder", () => {
  it("every answer says it is Bing data and is not comparable with Google", async () => {
    for (const report of ["traffic", "queries", "pages", "crawl", "crawl_problems", "sitemaps", "inbound_links", "submission_quota"] as const) {
      const r = await run({ report, sortBy: report === "traffic" || report === "crawl" ? "date" : "clicks" });
      expect(r.provider).toBe("bing");
      expect(r.summary).toMatch(/^Bing Webmaster data for https:\/\/www\.example\.com\//);
      expect(r.nextStep).toMatch(/\S/);
      expect(String(r.providerMetadata?.source)).toMatch(/not Google Search Console/);
    }
    expect((await run({ report: "traffic", sortBy: "date" })).summary).toMatch(/not comparable one-to-one with Google Search Console/);
  });

  it("queries: one row per query, totals equal the sum of the raw rows, CTR is clicks/impressions", async () => {
    const client = new MockBingApiClient(() => NOW);
    const raw = (await client.getQueryStats(AUTH, SITE)).rows;
    const r = await run({}, client);
    expect(r.rows).toHaveLength(4);
    expect(new Set(r.rows.map((x) => x.query)).size).toBe(4);
    expect(r.totals).toMatchObject({ clicks: raw.reduce((s, x) => s + x.clicks!, 0), impressions: raw.reduce((s, x) => s + x.impressions!, 0), queries: 4 });
    for (const row of r.rows) expect(row.ctr).toBeCloseTo((row.clicks as number) / (row.impressions as number), 4);
    const sorted = r.rows.map((x) => x.clicks as number);
    expect(sorted).toEqual([...sorted].sort((a, b) => b - a));
    expect(r.completeness).toBe("unknown_or_provider_limited");
  });

  it("aggregate=false returns Bing's raw rows per date, each with a CTR", async () => {
    const r = await run({ aggregate: false });
    expect(r.rows).toHaveLength(16);
    expect(r.rows[0]).toHaveProperty("date");
    expect(r.rows[0]).toHaveProperty("ctr");
  });

  it("period comparison: previous window of the same length, change in percent, totals consistent", async () => {
    const client = new MockBingApiClient(() => NOW);
    const raw = (await client.getQueryStats(AUTH, SITE)).rows;
    const cur = { startDate: "2026-10-05", endDate: "2026-10-19" }; // two weekly buckets now, two before
    const prev = previousWindow(cur.startDate, cur.endDate);
    const sumIn = (w: { startDate: string; endDate: string }) => raw.filter((x) => x.date >= w.startDate && x.date <= w.endDate).reduce((s, x) => s + x.clicks!, 0);
    const r = await run({ ...cur, compare: prev }, client);
    expect(r.comparison).toMatchObject({ startDate: prev.startDate, endDate: prev.endDate, totals: { clicks: sumIn(prev) } });
    expect(r.totals!.clicks).toBe(sumIn(cur));
    expect(r.comparison!.change.clicks).toBe(pctChange(sumIn(cur), sumIn(prev)));
    expect(r.rows[0]).toHaveProperty("clicksChangePct");
    expect(r.summary).toMatch(/Compared with the previous period/);
  });

  it("a comparison with an empty previous period says so instead of inventing a change", async () => {
    const r = await run({ startDate: "2026-10-12", endDate: "2026-10-19", compare: { startDate: "2020-01-01", endDate: "2020-01-08" } });
    expect(codes(r)).toContain("COMPARISON_UNAVAILABLE");
    expect(r.comparison!.change.clicks).toBeNull();
  });

  it("pages: URL variants are merged (and say so); mergeUrlVariants=false keeps Bing's raw addresses", async () => {
    const merged = await run({ report: "pages" });
    const raw = await run({ report: "pages", mergeUrlVariants: false });
    expect(merged.rows.map((x) => x.page).sort()).toEqual(["https://www.example.com/", "https://www.example.com/repair", "https://www.example.com/widgets"]);
    expect(codes(merged)).toContain("URL_VARIANTS_MERGED");
    expect(raw.rows).toHaveLength(5);
    expect(codes(raw)).not.toContain("URL_VARIANTS_MERGED");
  });

  it("low-CTR preset logic: minImpressions and maxCtr apply to the summed row", async () => {
    const all = await run({});
    const impressionsSorted = all.rows.map((x) => x.impressions as number).sort((a, b) => a - b);
    const threshold = impressionsSorted[1]!;
    const r = await run({ minImpressions: threshold });
    expect(r.rows.every((x) => (x.impressions as number) >= threshold)).toBe(true);
    expect(r.rows.length).toBeLessThan(all.rows.length);
    const lowCtr = await run({ maxCtr: 0.0001 });
    expect(lowCtr.rows).toHaveLength(0);
  });

  it("declining pages: only rows that lost clicks, including pages that vanished, worst first", async () => {
    const client = new MockBingApiClient(() => NOW);
    const raw = (await client.getPageStats(AUTH, SITE)).rows;
    const cur = { startDate: "2026-10-06", endDate: "2026-10-19" };
    const r = await run({ report: "pages", ...cur, compare: previousWindow(cur.startDate, cur.endDate), onlyDeclining: true, sortBy: "clicksChange", sortDirection: "asc" }, client);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.clicks as number).toBeLessThan(row.previousClicks as number);
    const changes = r.rows.map((x) => x.clicksChange as number);
    expect(changes).toEqual([...changes].sort((a, b) => a - b));
    expect(raw.length).toBeGreaterThan(0);
  });

  it("traffic: CTR per day, MISSING_DAYS for a hole, INCOMPLETE_RECENT_DATA when Bing is behind", async () => {
    const client = new MockBingApiClient(() => NOW);
    const orig = client.getRankAndTrafficStats.bind(client);
    client.getRankAndTrafficStats = async (a, s) => {
      const r = await orig(a, s);
      return { ...r, rows: r.rows.filter((x) => x.date !== "2026-10-10") };
    };
    const r = await run({ report: "traffic", sortBy: "date", startDate: "2026-10-01", endDate: "2026-10-19" }, client);
    expect(r.rows[0]).toHaveProperty("ctr");
    expect(codes(r)).toContain("MISSING_DAYS");
    expect(r.warnings.find((w) => w.code === "MISSING_DAYS")!.message).toContain("2026-10-10");

    const behind = await run({ report: "traffic", sortBy: "date", startDate: "2026-10-25", endDate: "2026-11-05" }, client);
    expect(codes(behind)).toContain("NO_ROWS_IN_WINDOW");
    const late = await run({ report: "traffic", sortBy: "date", startDate: "2026-09-01", endDate: "2026-10-30" }, client);
    expect(codes(late)).toContain("INCOMPLETE_RECENT_DATA");
  });

  it("low volume is flagged", async () => {
    const client = new MockBingApiClient(() => NOW);
    client.getRankAndTrafficStats = async () => ({ rows: [{ date: "2026-10-18", clicks: 1, impressions: 20 }], skipped: 0 });
    expect(codes(await run({ report: "traffic", sortBy: "date" }, client))).toContain("LOW_VOLUME");
  });

  it("crawl issues are decoded; crawl_problems combines issues, blocked URLs and the latest crawl day", async () => {
    const issues = await run({ report: "crawl_issues", sortBy: "clicks" });
    expect(issues.rows.map((x) => x.issueNames)).toEqual(expect.arrayContaining(["http_4xx", "http_5xx"]));
    const problems = await run({ report: "crawl_problems", sortBy: "clicks" });
    expect(problems.rows.map((x) => x.kind).sort()).toEqual(["blocked_url", "crawl_issue", "crawl_issue"]);
    expect(problems.totals).toMatchObject({ crawlIssues: 2, blockedUrls: 1 });
    expect(problems.totals).toHaveProperty("crawlErrors");
  });

  it("crawl_problems still answers when one part fails, and says which part is missing", async () => {
    const client = new MockBingApiClient(() => NOW);
    client.getBlockedUrls = async () => {
      throw new (await import("@serp/provider-bing")).BingApiError("bad_response", 200);
    };
    const r = await run({ report: "crawl_problems", sortBy: "clicks" }, client);
    expect(codes(r)).toContain("PART_UNAVAILABLE");
    expect(r.rows.some((x) => x.kind === "crawl_issue")).toBe(true);
    expect(r.totals!.blockedUrls).toBeNull();
  });

  it("crawl_problems does not hide an auth failure behind a partial answer", async () => {
    const client = new MockBingApiClient(() => NOW);
    client.getCrawlIssues = async () => {
      throw new (await import("@serp/provider-bing")).BingApiError("unauthenticated", 400, 3);
    };
    await expect(run({ report: "crawl_problems", sortBy: "clicks" }, client)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("inbound links: counts of URL variants add up; most-linked first", async () => {
    const r = await run({ report: "inbound_links", sortBy: "count" });
    expect(r.rows[0]).toMatchObject({ url: "https://www.example.com/", count: 320 });
    expect(r.rows.find((x) => x.url === "https://www.example.com/widgets")!.count).toBe(100);
    expect(codes(r)).toContain("URL_VARIANTS_MERGED");
  });

  it("inbound links: stops after 5 pages and says the list is partial", async () => {
    const client = new MockBingApiClient(() => NOW);
    let calls = 0;
    client.getLinkCounts = async (_a, _s, page) => {
      calls++;
      return { links: [{ url: `https://www.example.com/p${page}`, count: 1 }], totalPages: 40 };
    };
    const r = await run({ report: "inbound_links", sortBy: "count" }, client);
    expect(calls).toBe(5);
    expect(codes(r)).toContain("LINK_PAGES_LIMIT");
    expect(r.completeness).toBe("unknown_or_provider_limited");
  });

  it("sitemaps: counts the ones Bing did not report as successful", async () => {
    const r = await run({ report: "sitemaps", sortBy: "clicks" });
    expect(r.rows).toHaveLength(2);
    expect(r.totals).toEqual({ feeds: 2, notSuccessful: 1 });
    expect(r.summary).toMatch(/1 not reported as successful/);
  });

  it("single-URL reports return one row; an unknown URL is not an error and not zero", async () => {
    const info = await run({ report: "url_info", url: "https://www.example.com/a", sortBy: "clicks" });
    expect(info.rows).toHaveLength(1);
    expect(info.rows[0]).toMatchObject({ url: "https://www.example.com/a", httpStatus: 200 });
    const client = new MockBingApiClient(() => NOW);
    client.getUrlInfo = async () => null;
    const none = await run({ report: "url_info", url: "https://www.example.com/zzz", sortBy: "clicks" }, client);
    expect(none.rows).toHaveLength(0);
    expect(codes(none)).not.toContain("EMPTY_RESULT");
  });

  it("keyword stats default country and language are disclosed as assumptions", async () => {
    const r = await run({ report: "keyword_stats", keyword: "widgets", sortBy: "date" });
    expect(codes(r)).toContain("ASSUMED_LOCALE");
    expect(r.providerMetadata).toMatchObject({ country: "us", language: "en-US" });
    expect(codes(await run({ report: "keyword_stats", keyword: "widgets", country: "gb", language: "en-GB", sortBy: "date" }))).not.toContain("ASSUMED_LOCALE");
  });

  it("reports whose data was not yet confirmed on a live Bing account say so; the confirmed ones do not", async () => {
    expect(codes(await run({ report: "crawl_issues" }))).toContain("UNVERIFIED_REPORT");
    expect((await run({ report: "crawl_issues" })).providerMetadata).toMatchObject({ verifiedLive: false });
    for (const report of ["traffic", "queries", "crawl", "pages"] as const) {
      const r = await run({ report, sortBy: report === "queries" ? "clicks" : "date" });
      expect(codes(r)).not.toContain("UNVERIFIED_REPORT");
      expect(r.providerMetadata).toMatchObject({ verifiedLive: true });
    }
  });

  it("an empty answer is reported as empty, not as zeros", async () => {
    const client = new MockBingApiClient(() => NOW);
    client.getQueryStats = async () => ({ rows: [], skipped: 0 });
    const r = await run({}, client);
    expect(r.rows).toEqual([]);
    expect(codes(r)).toContain("EMPTY_RESULT");
    expect(r.summary).toMatch(/no search queries/);
  });

  it("the row limit is reported", async () => {
    const r = await run({ limit: 2 });
    expect(r.rows).toHaveLength(2);
    expect(codes(r)).toContain("ROW_LIMIT_REACHED");
  });
});

describe("audit table", () => {
  it("lists the read methods that are not covered, each with a reason", () => {
    expect(BING_READ_METHODS_NOT_COVERED.length).toBeGreaterThan(2);
    for (const m of BING_READ_METHODS_NOT_COVERED) expect(m.reason.length).toBeGreaterThan(10);
    expect(BING_READ_METHODS_NOT_COVERED.map((m) => m.method).join(" ")).toMatch(/GetCountryStats/);
  });
});

// ---- the "connected but disabled" bug --------------------------------------------------------------------------------

describe("a connected Bing account on a server where Bing is switched off", () => {
  const principal = { userId: MOCK_USER_A_ID, scopes: [] as string[] };
  const bingEntry = (s: ReturnType<typeof createMockReportService>) => s.getConnectionStatus(principal).then((all) => all.find((c) => c.provider === "bing")!);

  it("get_connection_status says so instead of only 'connected', and queries explain the server setting", async () => {
    const off = createMockReportService({ ...loadSharedEnv({ NODE_ENV: "test", PROVIDER_BING_ENABLED: "false" }), LOG_LEVEL: "error" });
    const entry = await bingEntry(off);
    expect(entry).toMatchObject({ status: "connected", providerEnabled: false });
    expect(entry.note).toMatch(/switched off on the server \(PROVIDER_BING_ENABLED=false\).*operator/);
    const q = off.queryBing(principal, { propertyId: "https://www.example.com/", report: "traffic" }, "r");
    await expect(q).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE", suggestedAction: expect.stringMatching(/PROVIDER_BING_ENABLED=true.*web app and the MCP server/) });
    await expect(off.queryBingPreset(principal, { propertyId: "https://www.example.com/", preset: "top_queries" }, "r")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    await expect(off.getSupportedMetrics(principal, { provider: "bing" })).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });

  it("with Bing switched on the same connection is queryable and carries no warning note", async () => {
    const on = createMockReportService({ ...loadSharedEnv({ NODE_ENV: "test", PROVIDER_BING_ENABLED: "true" }), LOG_LEVEL: "error" });
    expect(await bingEntry(on)).toMatchObject({ providerEnabled: true, note: null });
    expect((await on.getSupportedMetrics(principal, { provider: "bing" })) as { presets: string[] }).toMatchObject({ presets: expect.arrayContaining(["declining_pages"]) });
  });
});
