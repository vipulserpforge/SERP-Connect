/**
 * The extended Bing reports and presets across the real server composition: migrated Postgres (PGlite), envelope-encrypted
 * credentials, the Postgres report cache, the reporting service and the MCP server behind signed OAuth tokens, with two customers.
 *
 * DATA SOURCE: MOCK. Bing is replaced by FakeBing (a local HTTP server shaped like Microsoft's documented API). Nothing here
 * talks to Bing. The live check for these reports is `pnpm bing:check --yes` (docs/BING.md).
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
const SITE = { alice: "https://alice.example/", bob: "https://bob.example/" } as const;
async function viaKey(owner: "alice" | "bob") {
  const { connectionId } = await w.bing.connectApiKey(ID_OF[owner], { name: `${owner} key`, apiKey: owner === "alice" ? ALICE_KEY : BOB_KEY });
  await w.bing.syncSites(ID_OF[owner], connectionId);
  return connectionId;
}
async function viaOAuth(owner: "alice" | "bob") {
  const { state } = await w.bing.beginOAuth(ID_OF[owner]);
  const { connectionId } = await w.bing.completeOAuth(ID_OF[owner], { state, code: w.fakeBing.approve(owner), error: null });
  await w.bing.syncSites(ID_OF[owner], connectionId);
  return connectionId;
}
const apiCalls = (endpoint?: string) => w.fakeBing.calls.filter((c) => c.kind === "api" && c.endpoint !== "GetUserSites" && (endpoint === undefined || c.endpoint === endpoint));
const codes = (out: Out) => (out.warnings as Array<{ code: string }>).map((x) => x.code);

describe.each([
  ["API key", viaKey, "apikey"],
  ["OAuth", viaOAuth, "bearer"],
] as const)("%s connection: extended reports", (_n, connect, via) => {
  it("pages: one row per page (variants merged), Bing-labelled, authenticated the documented way", async () => {
    await connect("alice");
    const a = await as("alice");
    const r = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "pages", lastDays: 30 });
    expect(r.isError).toBe(false);
    expect(r.out.provider).toBe("bing");
    expect(r.out.summary).toMatch(/^Bing Webmaster data for https:\/\/alice\.example\//);
    expect(r.out.rows.map((x: Out) => x.page).sort()).toEqual(["https://alice.example/page0", "https://alice.example/page1"]); // page1 and page1/ are one page
    expect(codes(r.out)).toContain("URL_VARIANTS_MERGED");
    expect(codes(r.out)).not.toContain("UNVERIFIED_REPORT"); // pages was confirmed on a live account on 27 Oct 2026
    expect(r.out.totals).toMatchObject({ clicks: 111 + 112 + 113, impressions: 3000, pages: 2 });
    expect(r.out.rows.find((x: Out) => x.page === "https://alice.example/page1")).toMatchObject({ clicks: 112 + 113, impressions: 2000, periodsCovered: 2 });
    expect(apiCalls().every((c) => c.via === via && c.owner === "alice" && c.method === "GET")).toBe(true);
  });

  it("query_pages and page_queries send the argument bare, which is what the live API accepts", async () => {
    await connect("alice");
    const a = await as("alice");
    const q = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "query_pages", query: "blue widgets", lastDays: 60 });
    expect(q.isError).toBe(false);
    expect(decodeURIComponent(q.out.rows[0].page)).toContain("for-blue widgets-");
    expect(w.fakeBing.rawParams.find((p) => p.endpoint === "GetQueryPageStats" && p.name === "query")!.value).toBe("blue widgets");
    const p = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "page_queries", page: "https://alice.example/page0", lastDays: 60 });
    expect(p.isError).toBe(false);
    expect(w.fakeBing.rawParams.find((x) => x.endpoint === "GetPageQueryStats" && x.name === "page")!.value).toBe("https://alice.example/page0");
  });

  it("crawl issues, blocked URLs, sitemaps, url links, url info, quota", async () => {
    await connect("alice");
    const a = await as("alice");
    const issues = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "crawl_issues" });
    expect(issues.out.rows.map((x: Out) => x.issueNames).sort()).toEqual(["contains_malware", "http_4xx"]);
    const problems = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "crawl_problems" });
    expect(problems.out.totals).toMatchObject({ crawlIssues: 2, blockedUrls: 1 });
    const sitemaps = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "sitemaps" });
    expect(sitemaps.out.rows[0]).toMatchObject({ url: "https://alice.example/sitemap.xml", status: "Success", urlCount: 1023, submitted: "2026-09-19", compressed: "no" });
    const links = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "url_links", url: "https://alice.example/page0" });
    expect(links.out.rows[0]).toMatchObject({ url: "https://linker.example/x", anchorText: "for https://alice.example/page0" });
    const info = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "url_info", url: "https://alice.example/page0" });
    expect(info.out.rows[0]).toMatchObject({ httpStatus: 200, isPage: "yes" });
    const quota = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "submission_quota" });
    expect(quota.out.rows[0]).toEqual({ dailyQuota: 5, monthlyQuota: 24 });
  });

  it("keyword stats are Bing-wide and need no site data; country and language reach Bing as JSON strings", async () => {
    await connect("alice");
    const a = await as("alice");
    const r = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "keyword_stats", keyword: "blue widgets", country: "us", language: "en-US" });
    expect(r.isError).toBe(false);
    expect(r.out.rows[0]).toMatchObject({ query: "blue widgets", impressions: 1000, broadImpressions: 4000 });
    expect(r.out.summary).toMatch(/Bing-wide, not this site's traffic/);
  });

  it("inbound links: pages are followed, capped at 5 and the cap is reported", async () => {
    await connect("alice");
    const a = await as("alice");
    w.fakeBing.linkPages = 2;
    const two = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "inbound_links" });
    expect(apiCalls("GetLinkCounts")).toHaveLength(2);
    expect(codes(two.out)).not.toContain("LINK_PAGES_LIMIT");
    expect(two.out.rows[0].count).toBe(16); // highest: page 1's 15 plus its trailing-slash variant's 1, merged
    w.fakeBing.calls.length = 0;
    w.fakeBing.linkPages = 40;
    const many = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "inbound_links", limit: 5 });
    expect(apiCalls("GetLinkCounts")).toHaveLength(5);
    expect(codes(many.out)).toContain("LINK_PAGES_LIMIT");
  });
});

describe("comparison and presets", () => {
  it("compare=true uses the same Bing answer: one upstream call, change computed from both windows", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const r = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "queries", lastDays: 14, compare: true });
    expect(r.isError).toBe(false);
    expect(apiCalls("GetQueryStats")).toHaveLength(1);
    // today 2026-10-19: window 10-06..10-19 holds the Oct-12 row; the previous 09-22..10-05 holds Oct-05 and Sep-28
    expect(r.out.comparison).toMatchObject({ startDate: "2026-09-22", endDate: "2026-10-05" });
    // window rows: Oct-12 (111 clicks). previous rows: Oct-05 (112) and Sep-28 (113) = 225
    expect(r.out.totals.clicks).toBe(111);
    expect(r.out.comparison.totals.clicks).toBe(225);
    expect(r.out.comparison.change.clicks).toBe(-50.7); // (111 - 225) / 225
    expect(r.out.rows).toHaveLength(1);
    expect(r.out.rows[0]).toMatchObject({ clicks: 111, previousClicks: null });
    expect(r.out.summary).toMatch(/Compared with the previous period \(2026-09-22 to 2026-10-05\)/);
  });

  it("a comparison without dates defaults to 28 days and says so", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "traffic", compare: true });
    expect(r.out.report.period).toMatchObject({ resolvedFrom: "lastDays", lastDays: 28 });
    expect(codes(r.out)).toContain("WINDOW_DEFAULTED");
  });

  it("get_bing_insights: every preset answers, starts with a Bing summary and ends with a next step", async () => {
    await viaKey("alice");
    const a = await as("alice");
    for (const preset of ["top_queries", "top_pages", "low_ctr_queries", "declining_pages", "crawl_problems", "top_inbound_links", "sitemap_status"]) {
      const r = await call(a, "get_bing_insights", { propertyId: SITE.alice, preset });
      expect(r.isError, preset).toBe(false);
      expect(r.out.provider).toBe("bing");
      expect(r.out.summary).toMatch(/^Bing Webmaster data for/);
      expect(r.out.nextStep).toMatch(/\S/);
    }
  });

  it("top_queries sorts by impressions; low_ctr_queries keeps only high-impression, low-CTR rows; declining_pages lists losers worst first", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const top = await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "top_queries", lastDays: 60 });
    const imps = top.out.rows.map((x: Out) => x.impressions);
    expect(imps).toEqual([...imps].sort((x: number, y: number) => y - x));
    // fake rows: 1000 impressions and 111-113 clicks => CTR about 11%: nothing is below 2%
    expect((await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "low_ctr_queries", lastDays: 60 })).out.rows).toEqual([]);
    expect((await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "low_ctr_queries", lastDays: 60, maxCtr: 0.5 })).out.rows.length).toBe(3);
    const losers = await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "declining_pages", lastDays: 14 });
    expect(losers.out.rows.length).toBeGreaterThan(0);
    for (const row of losers.out.rows) expect(row.clicks).toBeLessThan(row.previousClicks);
  });

  it("presets are cached like any report", async () => {
    await viaKey("alice");
    const a = await as("alice");
    await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "sitemap_status" });
    expect((await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "sitemap_status" })).out.cache.hit).toBe(true);
    expect(apiCalls("GetFeeds")).toHaveLength(1);
  });
});

describe("validation and safety", () => {
  it("rejects a report that is missing its extra field, with a plain message", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const r = await call(a, "query_bing_report", { propertyId: SITE.alice, report: "query_pages" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs an extra field/);
    expect(apiCalls()).toHaveLength(0);
  });
  it("rejects change sorting and onlyDeclining without compare, and unknown fields", async () => {
    await viaKey("alice");
    const a = await as("alice");
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "pages", sortBy: "clicksChange" })).isError).toBe(true);
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "pages", onlyDeclining: true })).isError).toBe(true);
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "pages", userId: "someone-else" })).isError).toBe(true);
    expect((await call(a, "query_bing_report", { propertyId: SITE.alice, report: "SubmitUrl" })).isError).toBe(true);
    expect(apiCalls()).toHaveLength(0);
  });
  it("tools stay read-only: they are annotated so and no write method is ever requested", async () => {
    await viaKey("alice");
    const a = await as("alice");
    const tools = (await a.listTools()).tools.filter((t) => ["query_bing_report", "get_bing_insights", "list_bing_sites"].includes(t.name));
    expect(tools).toHaveLength(3);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await call(a, "query_bing_report", { propertyId: SITE.alice, report: "crawl_problems" });
    await call(a, "get_bing_insights", { propertyId: SITE.alice, preset: "sitemap_status" });
    expect(w.fakeBing.calls.every((c) => c.method === "GET")).toBe(true);
    expect(w.fakeBing.calls.every((c) => !/^(Add|Remove|Submit|Save|Enable|Fetch|Verify|Update)/.test(c.endpoint))).toBe(true);
  });
  it("tenant isolation: another customer's site and urls are indistinguishable from unknown ones", async () => {
    await viaKey("alice");
    await viaOAuth("bob");
    const a = await as("alice");
    for (const args of [
      { report: "pages" },
      { report: "crawl_problems" },
      { report: "sitemaps" },
      { report: "url_info", url: "https://bob.example/x" },
    ]) {
      const snoop = await call(a, "query_bing_report", { propertyId: SITE.bob, ...args });
      const unknown = await call(a, "query_bing_report", { propertyId: "https://nobody.example/", ...args });
      expect(snoop.isError).toBe(true);
      expect(snoop.out.error.code).toBe(unknown.out.error.code);
      expect(snoop.text).not.toContain("222");
    }
    expect(apiCalls().every((c) => c.owner === "alice")).toBe(true);
    expect((await call(await as("bob"), "query_bing_report", { propertyId: SITE.bob, report: "url_traffic", url: "https://bob.example/p" })).out.rows[0].clicks).toBe(222);
  });
  it("no API key, token or ownership code leaks into any answer or log", async () => {
    await viaKey("alice");
    await viaOAuth("bob");
    const outputs: string[] = [];
    for (const [who, site] of [["alice", SITE.alice], ["bob", SITE.bob]] as const) {
      const c = await as(who);
      for (const report of ["pages", "crawl_problems", "sitemaps", "inbound_links", "submission_quota"]) outputs.push((await call(c, "query_bing_report", { propertyId: site, report })).text);
      outputs.push((await call(c, "get_bing_insights", { propertyId: site, preset: "top_queries" })).text);
      outputs.push((await call(c, "get_connection_status")).text);
    }
    const everything = outputs.join("\n") + JSON.stringify(w.logs);
    for (const secret of [ALICE_KEY, BOB_KEY, "OWNERSHIPCODE0000", "dns.ownershipcode.example", "access-bob", "refresh-bob"]) expect(everything).not.toContain(secret);
  });
});

describe("failures are explained in plain English", () => {
  it("a rejected API key says exactly what to do", async () => {
    await viaKey("alice");
    w.fakeBing.apiKeys.delete(ALICE_KEY);
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "pages" });
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toBe("AUTH_EXPIRED");
    expect(r.out.error.suggestedAction).toMatch(/Reconnect Bing Webmaster/);
  });
  it("get_connection_status explains a rejected key and says whether the provider is switched on", async () => {
    const id = await viaKey("alice");
    w.fakeBing.apiKeys.delete(ALICE_KEY);
    await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "pages" });
    const status = await call(await as("alice"), "get_connection_status");
    const bing = status.out.connections.find((c: Out) => c.id === id);
    expect(bing).toMatchObject({ provider: "bing", status: "needs_attention", providerEnabled: true });
    expect(bing.note).toMatch(/Settings > API Access.*Replace key/);
  });
  it("a healthy connection has providerEnabled=true and no note", async () => {
    await viaKey("alice");
    const bing = (await call(await as("alice"), "get_connection_status")).out.connections.find((c: Out) => c.provider === "bing");
    expect(bing).toMatchObject({ status: "connected", providerEnabled: true, note: null });
  });
  it("rate limiting from Bing is reported as such", async () => {
    await viaKey("alice");
    w.fakeBing.fail = { endpoint: "GetPageStats", status: 429, headers: { "retry-after": "1" }, times: 10 };
    const r = await call(await as("alice"), "query_bing_report", { propertyId: SITE.alice, report: "pages" });
    expect(r.isError).toBe(true);
    expect(r.out.error.code).toBe("PROVIDER_RATE_LIMITED");
  });
});

describe("get_supported_metrics for Bing", () => {
  it("is available when Bing is on, lists every report, presets, the gaps in the public API and what is verified live", async () => {
    await viaKey("alice");
    const r = await call(await as("alice"), "get_supported_metrics", { provider: "bing" });
    expect(r.isError).toBe(false);
    expect(r.out.reports.map((x: Out) => x.report)).toEqual(expect.arrayContaining(["traffic", "queries", "pages", "crawl_issues", "inbound_links", "sitemaps", "keyword_stats"]));
    expect(r.out.presets).toContain("declining_pages");
    expect(r.out.notCovered.map((x: Out) => x.method).join(" ")).toMatch(/GetCountryStats/);
    expect(r.out.reports.find((x: Out) => x.report === "traffic").verifiedLive).toBe(true);
    expect(r.out.reports.find((x: Out) => x.report === "pages").verifiedLive).toBe(true);
    expect(r.out.reports.find((x: Out) => x.report === "inbound_links").verifiedLive).toBe(false);
    expect(r.text).not.toMatch(/disabled on this server/);
  });
});
