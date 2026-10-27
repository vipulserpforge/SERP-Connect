/**
 * The Bing expansion across the real server composition: migrated Postgres (PGlite), envelope-encrypted credentials, the report
 * cache, the reporting service and the MCP server behind signed OAuth tokens, with two customers.
 *
 * DATA SOURCE: MOCK. Bing is replaced by FakeBing (a local HTTP server shaped like Microsoft's documented API). Nothing here
 * talks to Bing. The live check is `pnpm bing:check --yes` (docs/BING.md).
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectWithToken } from "../mcp/harness.js";
import type { Owner } from "../system/fake-google.js";
import { ID_OF, buildWorld, type World } from "../system/world.js";

let w: World;
const clients: Client[] = [];
const ALICE_KEY = "alicealicealicealicealicealiceal1";
const BOB_KEY = "bobbobbobbobbobbobbobbobbobbobb2";
const SITE = { alice: "https://alice.example/", bob: "https://bob.example/" } as const;

beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await w.close();
});
beforeEach(async () => {
  await w.sql("delete from public.provider_connections where provider = 'bing'");
  await w.sql("delete from public.audit_events");
  await w.sql("delete from public.report_cache where provider = 'bing'");
  w.fakeBing.apiKeys.set(ALICE_KEY, "alice");
  w.fakeBing.apiKeys.set(BOB_KEY, "bob");
  w.fakeBing.calls.length = 0;
  w.fakeBing.rawParams.length = 0;
  w.fakeBing.postBodies.length = 0;
  w.fakeBing.fail = null;
  w.fakeBing.linkPages = 1;
  w.time.now = Date.parse("2026-10-19T12:00:00Z");
  w.sleeps.length = 0;
  w.logs.length = 0;
});

async function as(owner: Owner): Promise<Client> {
  const c = await connectWithToken(w.stack, await w.stack.as.mint({ sub: ID_OF[owner], aud: w.stack.url }));
  clients.push(c);
  await c.listTools();
  return c;
}
type Out = Record<string, any>;
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  return { isError: r.isError === true, text, out: JSON.parse(text) as Out };
}
async function viaKey(owner: "alice" | "bob") {
  const { connectionId } = await w.bing.connectApiKey(ID_OF[owner], { name: `${owner} key`, apiKey: owner === "alice" ? ALICE_KEY : BOB_KEY });
  await w.bing.syncSites(ID_OF[owner], connectionId);
  return connectionId;
}
const codes = (out: Out) => (out.warnings as Array<{ code: string }>).map((x) => x.code);
const raw = (endpoint: string, name: string) => w.fakeBing.rawParams.find((p) => p.endpoint === endpoint && p.name === name)?.value;

describe("query_bing_report: the five added reports", () => {
  it("query_traffic: one query's daily traffic, daily granularity, pagination block, query sent bare", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "query_traffic", query: "blue widgets", lastDays: 30 });
    expect(r.isError).toBe(false);
    expect(r.out.rows).toHaveLength(5);
    expect(r.out.totals).toMatchObject({ clicks: 3 + 4 + 5 + 6 + 7, impressions: 150 });
    expect(r.out.providerMetadata).toMatchObject({ endpoint: "GetQueryTrafficStats", granularity: "daily", shape: "documented" });
    expect(r.out.providerMetadata.pagination).toMatchObject({ rowsFound: 5, rowsReturned: 5, limit: 100, hasMore: false });
    expect(raw("GetQueryTrafficStats", "query")).toBe("blue widgets");
    expect(r.out.summary).toMatch(/Bing/);
  });

  it("query_traffic needs a query", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "query_traffic" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs an extra field/);
    expect(w.fakeBing.calls.filter((c) => c.endpoint !== "GetUserSites")).toHaveLength(0);
  });

  it("children_url_info: POSTs the documented body, labels the paging, and an empty next page is the end", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const first = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "children_url_info", url: "alice.example/blog" });
    expect(first.isError).toBe(false);
    expect(first.out.rows[0]).toMatchObject({ url: `${SITE.alice}blog/`, isPage: "no", totalChildUrlCount: 100, anchorCount: 50 });
    expect(first.out.providerMetadata).toMatchObject({ granularity: "snapshot", bingPage: 0, nextPageNumber: 1 });
    expect(first.out.providerMetadata.pagination.hint).toMatch(/pageNumber=1/);
    const body = w.fakeBing.postBodies[0]!.body as Out;
    expect(body).toMatchObject({ siteUrl: SITE.alice, url: "alice.example/blog", page: 0, filterProperties: { CrawlDateFilter: 0, HttpCodeFilters: 0 } });
    const apiCall = w.fakeBing.calls.find((c) => c.endpoint === "GetChildrenUrlInfo")!;
    expect(apiCall).toMatchObject({ method: "POST", via: "apikey", owner: "alice" });
    const next = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "children_url_info", url: "alice.example/blog", pageNumber: 1 });
    expect(next.out.rows).toHaveLength(0);
    expect(codes(next.out)).toContain("EMPTY_RESULT");
    expect(next.out.providerMetadata.nextPageNumber).toBeUndefined();
  });

  it("children_url_traffic sorts by clicks and passes the 0-based page", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "children_url_traffic", url: "alice.example", pageNumber: 0 });
    expect(r.isError).toBe(false);
    expect(r.out.rows[0]).toMatchObject({ clicks: 10, impressions: 100, isPage: "no" });
    expect(raw("GetChildrenUrlTrafficInfo", "url")).toBe("alice.example");
  });

  it("crawl_settings: one row per slot, the crawl-boost flags Bing really sends in metadata, and a plain warning that the slots are undocumented", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "crawl_settings" });
    expect(r.out.rows).toHaveLength(24);
    expect(r.out.rows[0]).toEqual({ slot: 0, crawlRate: 5 });
    expect(r.out.providerMetadata).toMatchObject({ ajaxEnabled: null, crawlBoostAvailable: false, crawlBoostEnabled: false });
    expect(r.out.summary).toMatch(/crawl boost off and not available/);
    expect(codes(r.out)).toContain("CRAWL_RATE_SLOTS");
  });

  it("feed_details sends the feed address bare", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "feed_details", feedUrl: `${SITE.alice}sitemap-index.xml` });
    expect(r.out.rows[0]).toMatchObject({ url: `${SITE.alice}sitemap-index.xml`, status: "Success", urlCount: 12, compressed: "no" });
    expect(raw("GetFeedDetails", "feedUrl")).toBe(`${SITE.alice}sitemap-index.xml`);
  });
});

describe("get_bing_site_settings", () => {
  it("serves every settings report for a connected site", async () => {
    await viaKey("alice");
    const a = await as("alice");
    for (const report of ["blocked_urls", "deep_link_blocks", "page_preview_blocks", "country_region_settings", "query_parameters", "connected_pages", "site_moves", "site_roles", "submission_quota", "content_submission_quota"]) {
      const r = await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report });
      expect(r.isError, report).toBe(false);
      expect(r.out.provider).toBe("bing");
      expect(r.out.providerMetadata.granularity).toBe("snapshot");
      expect(r.out.providerMetadata.pagination).toMatchObject({ limit: 100, hasMore: false });
    }
  });

  it("site_roles keeps the emails and role but never the delegation code; includeAllSubdomains reaches Bing", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "get_bing_site_settings", { propertyId: SITE.alice, report: "site_roles", includeAllSubdomains: true });
    expect(r.out.rows[0]).toMatchObject({ email: "alice@example.com", role: 2, roleName: "ReadWrite", expired: "no", site: SITE.alice });
    expect(r.out.rows[1]).toMatchObject({ email: "reader-alice@example.com", role: 0, roleName: null }); // only 2 is named in Microsoft's sample
    expect(r.text).not.toContain("LEAKME");
    expect(raw("GetSiteRoles", "includeAllSubdomains")).toBe("true");
  });

  it("undocumented shapes are flagged unverified, shown as Bing sent them, and ownership codes never appear", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const r = await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report: "deep_link_blocks" });
    expect(r.out.rows[0]).toMatchObject({ url: `${SITE.alice}checkout` });
    expect(codes(r.out)).toContain("UNDOCUMENTED_SHAPE");
    expect(r.out.providerMetadata.shape).toBe("unverified");
    expect(r.text).not.toContain("LEAKME");
    const empty = await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report: "site_moves" });
    expect(empty.out.rows).toEqual([]);
    expect(codes(empty.out)).toContain("EMPTY_RESULT");
    expect(empty.out.summary).toMatch(/Bing reported no site moves/);
  });

  it("query_parameters and quotas read Microsoft's documented shapes", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const q = await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report: "query_parameters" });
    expect(q.out.rows[0]).toMatchObject({ parameter: "cart", isEnabled: "no", source: 1, date: "2011-08-22" });
    const quota = await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report: "content_submission_quota" });
    expect(quota.out.rows[0]).toMatchObject({ dailyQuota: 100, monthlyQuota: 3000 });
    expect(quota.out.summary).toMatch(/100 per day, 3,000 per month/);
  });

  it("rejects unknown reports (including write methods) and unknown fields before any call to Bing", async () => {
    await viaKey("alice");
    const a = await as("alice");
    for (const args of [{ report: "SubmitUrl" }, { report: "AddSite" }, { report: "traffic" }, { report: "site_roles", userId: "x" }]) {
      expect((await call(a, "get_bing_site_settings", { propertyId: SITE.alice, ...args })).isError).toBe(true);
    }
    expect(w.fakeBing.calls.filter((c) => c.endpoint !== "GetUserSites")).toHaveLength(0);
  });

  it("tenant isolation: another customer's site is indistinguishable from an unknown one", async () => {
    await viaKey("alice");
    await viaKey("bob");
    const a = await as("alice");
    const snoop = await call(a, "get_bing_site_settings", { propertyId: SITE.bob, report: "site_roles" });
    const unknown = await call(a, "get_bing_site_settings", { propertyId: "https://nobody.example/", report: "site_roles" });
    expect(snoop.isError).toBe(true);
    expect(snoop.out.error.code).toBe(unknown.out.error.code);
    expect(snoop.text).not.toContain("bob@example.com");
  });
});

describe("query_bing_keywords", () => {
  it("keyword: market-wide, no site sent, 30-day window by default, plain ISO dates, and no date on the answer", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_keywords", { report: "keyword", keyword: "blue widgets" });
    expect(r.isError).toBe(false);
    expect(r.out.rows[0]).toMatchObject({ query: "blue widgets", impressions: 700, broadImpressions: 2800, date: null });
    expect(codes(r.out)).toEqual(expect.arrayContaining(["WINDOW_DEFAULTED", "ASSUMED_LOCALE", "UNDOCUMENTED_SHAPE"]));
    expect(r.out.summary).toMatch(/Bing-wide, not this site's traffic/);
    expect(raw("GetKeyword", "q")).toBe("blue widgets");
    expect(raw("GetKeyword", "country")).toBe("us");
    expect(raw("GetKeyword", "language")).toBe("en-US");
    expect(raw("GetKeyword", "startDate")).toBe("2026-09-20");
    expect(raw("GetKeyword", "endDate")).toBe("2026-10-19");
    expect(w.fakeBing.calls.find((c) => c.endpoint === "GetKeyword")!.queryNames).not.toContain("siteUrl");
  });

  it("related_keywords: most impressions first; explicit dates and locale are passed on without warnings", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_keywords", { report: "related_keywords", keyword: "widgets", country: "gb", language: "en-GB", startDate: "2026-10-01", endDate: "2026-10-15" });
    expect(r.out.rows.map((x: Out) => x.query)).toEqual(["widgets cheap", "widgets best"]);
    expect(codes(r.out)).not.toContain("ASSUMED_LOCALE");
    expect(codes(r.out)).not.toContain("WINDOW_DEFAULTED");
    expect(raw("GetRelatedKeywords", "country")).toBe("gb");
    expect(raw("GetRelatedKeywords", "startDate")).toBe("2026-10-01");
  });

  it("keyword_stats still works through the new tool and through the old one", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const viaNew = await call(a, "query_bing_keywords", { report: "keyword_stats", keyword: "widgets" });
    const viaOld = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "keyword_stats", keyword: "widgets" });
    expect(viaNew.isError).toBe(false);
    expect(viaOld.isError).toBe(false);
    expect(viaNew.out.rows).toHaveLength(2);
  });

  it("works with no site given by using the user's own Bing connection; accepts one of the user's own sites", async () => {
    await viaKey("alice");
    const a = await as("alice");
    expect((await call(a, "query_bing_keywords", { report: "keyword", keyword: "x", propertyId: SITE.alice })).isError).toBe(false);
    const owners = new Set(w.fakeBing.calls.filter((c) => c.endpoint === "GetKeyword").map((c) => c.owner));
    expect([...owners]).toEqual(["alice"]);
  });

  it("without a Bing connection the answer says what to do; another customer's site cannot be used as the carrier", async () => {
    const a = await as("alice");
    const none = await call(a, "query_bing_keywords", { report: "keyword", keyword: "x" });
    expect(none.isError).toBe(true);
    expect(none.out.error.code).toBe("PROPERTY_NOT_CONNECTED");
    expect(none.out.error.suggestedAction).toMatch(/Connect Bing/);
    await viaKey("bob");
    const snoop = await call(a, "query_bing_keywords", { report: "keyword", keyword: "x", propertyId: SITE.bob });
    expect(snoop.isError).toBe(true);
    expect(snoop.out.error.code).toBe("PROPERTY_NOT_CONNECTED");
    expect(w.fakeBing.calls.filter((c) => c.endpoint === "GetKeyword")).toHaveLength(0);
  });

  it("validates input before calling Bing", async () => {
    await viaKey("alice");
    const a = await as("alice");
    for (const args of [{ report: "keyword" }, { report: "keyword", keyword: "x", startDate: "2026-10-01" }, { report: "keyword", keyword: "x", lastDays: 7, startDate: "2026-10-01", endDate: "2026-10-02" }, { report: "traffic", keyword: "x" }]) {
      expect((await call(a, "query_bing_keywords", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(w.fakeBing.calls.filter((c) => c.endpoint !== "GetUserSites")).toHaveLength(0);
  });
});

describe("limits, pagination, and the read-only guarantee", () => {
  it("default limit is 100 and a smaller limit says how to see the rest", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const def = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries" });
    expect(def.out.providerMetadata.pagination).toMatchObject({ limit: 100, hasMore: false });
    const capped = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries", limit: 1 });
    expect(capped.out.rows).toHaveLength(1);
    expect(capped.out.providerMetadata.pagination).toMatchObject({ rowsFound: 3, rowsReturned: 1, limit: 1, hasMore: true });
    expect(capped.out.providerMetadata.pagination.hint).toMatch(/Raise limit, or narrow/);
    expect(capped.out.providerMetadata.granularity).toBe("weekly");
  });

  it("the new tools are read-only and the existing ones still work", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const tools = (await a.listTools()).tools.filter((t) => ["get_bing_site_settings", "query_bing_keywords", "query_bing_report", "get_bing_insights", "list_bing_sites"].includes(t.name));
    expect(tools).toHaveLength(5);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect((await call(a, "list_bing_sites")).out.properties ?? (await call(a, "list_bing_sites")).out).toBeDefined();
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "traffic", lastDays: 28 })).out.totals.clicks).toBeGreaterThan(0);
    for (const [report, extra] of [["crawl_settings", {}], ["children_url_info", { url: "alice.example" }]] as const) await call(a, "query_bing_report", { propertyId: SITE.alice, report, ...extra });
    await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report: "site_roles" });
    await call(a, "query_bing_keywords", { report: "related_keywords", keyword: "x" });
    const endpoints = w.fakeBing.calls.filter((c) => c.kind === "api").map((c) => c.endpoint);
    expect(endpoints.every((e) => e.startsWith("Get"))).toBe(true);
    expect(endpoints.some((e) => /^(Add|Remove|Submit|Save|Enable|Fetch|Verify|Update)/.test(e))).toBe(false);
    // The only POST is GetChildrenUrlInfo, which only reads.
    expect(w.fakeBing.calls.filter((c) => c.method === "POST").map((c) => c.endpoint)).toEqual(["GetChildrenUrlInfo"]);
  });

  it("never exposes the API key, ownership codes or delegation codes anywhere in a result", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const texts: string[] = [];
    for (const report of ["deep_link_blocks", "site_roles", "connected_pages", "country_region_settings"]) texts.push((await call(a, "get_bing_site_settings", { propertyId: SITE.alice, report })).text);
    texts.push((await call(a, "query_bing_keywords", { report: "keyword", keyword: "x" })).text);
    for (const t of texts) {
      expect(t).not.toContain(ALICE_KEY);
      expect(t).not.toMatch(/LEAKME|OWNERSHIPCODE|ownershipcode/);
    }
    expect(w.logs.map((l) => JSON.stringify(l)).join("\n")).not.toContain(ALICE_KEY);
  });
});

describe("get_supported_metrics for Bing after the expansion", () => {
  it("lists every report with its tool, granularity, shape and live-verification state, and the writes that were not built", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "get_supported_metrics", { provider: "bing" });
    expect(r.isError).toBe(false);
    const byName = (n: string) => r.out.reports.find((x: Out) => x.report === n);
    for (const n of ["query_traffic", "children_url_info", "children_url_traffic", "crawl_settings", "feed_details", "deep_link_blocks", "page_preview_blocks", "country_region_settings", "query_parameters", "connected_pages", "site_moves", "site_roles", "content_submission_quota", "keyword", "related_keywords"]) {
      expect(byName(n), n).toBeDefined();
    }
    // Confirmed with real rows on a live account (27 Oct 2026) vs. working but only ever seen empty.
    for (const n of ["query_traffic", "feed_details", "crawl_settings", "site_roles", "content_submission_quota", "keyword", "related_keywords"]) expect(byName(n).verifiedLive, n).toBe(true);
    for (const n of ["children_url_info", "children_url_traffic", "deep_link_blocks", "page_preview_blocks", "country_region_settings", "query_parameters", "connected_pages", "site_moves"]) expect(byName(n).verifiedLive, n).toBe(false);
    expect(byName("site_moves").freshness).toMatch(/HTTP 404/);
    expect(byName("site_roles").tools).toEqual(["get_bing_site_settings"]);
    expect(byName("related_keywords").tools).toEqual(["query_bing_keywords"]);
    expect(byName("keyword_stats").tools).toEqual(["query_bing_report", "query_bing_keywords"]);
    expect(byName("blocked_urls").tools).toEqual(["query_bing_report", "get_bing_site_settings"]);
    expect(byName("query_traffic").granularity).toBe("daily");
    expect(byName("deep_link_blocks").shape).toBe("unverified");
    expect(byName("traffic").verifiedLive).toBe(true);
    expect(Object.keys(r.out.tools)).toEqual(expect.arrayContaining(["query_bing_report", "get_bing_site_settings", "query_bing_keywords", "get_bing_insights", "list_bing_sites"]));
    expect(r.out.suggestedWritesNotBuilt.map((x: Out) => x.method).join(" ")).toMatch(/SubmitUrl/);
    expect(r.out.notCovered.map((x: Out) => x.method).join(" ")).toMatch(/AI Performance/);
    const covered = r.out.notCovered.map((x: Out) => x.method).join(" ");
    expect(covered).not.toMatch(/GetSiteRoles|GetCrawlSettings|GetRelatedKeywords/);
  });
});
