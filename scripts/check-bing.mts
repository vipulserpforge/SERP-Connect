import { BingApiError, HttpBingApiClient, discoverBingSites, validateBingApiKey, type BingAuth } from "../packages/provider-bing/src/index.js";

// MANUAL LIVE TEST: the only script in this repository that talks to the real Bing Webmaster API. Read-only (GET only).
//
//   Put ONE of these in .env.local (git-ignored), then run:  pnpm bing:check --yes
//     BING_TEST_API_KEY=<key>            Bing Webmaster Tools > Settings > API Access > API Key
//     BING_TEST_ACCESS_TOKEN=<token>     only if you already have a short-lived OAuth access token
//   Optional: BING_TEST_SITE=https://www.example.com/   (default: the first verified site)
//
// It lists your sites, then calls every read method this connector supports for ONE site and prints a method / result table. Bing documents no numeric request limit.
// It never prints the key/token or site-ownership codes, and stores nothing. Remove the key from .env.local afterwards.
const args = new Set(process.argv.slice(2));
const apiKey = process.env.BING_TEST_API_KEY?.trim();
const accessToken = process.env.BING_TEST_ACCESS_TOKEN?.trim();

if (!args.has("--yes")) {
  console.log("This makes about 40 real read-only requests to Bing Webmaster Tools.\nRun again with --yes to continue.");
  process.exit(2);
}
if (!apiKey && !accessToken) {
  console.log("Set BING_TEST_API_KEY (or BING_TEST_ACCESS_TOKEN) in .env.local (never paste it into chat), then run again.");
  process.exit(2);
}
let auth: BingAuth;
if (apiKey) {
  try {
    auth = { method: "api_key", apiKey: validateBingApiKey(apiKey) };
  } catch {
    console.log("BING_TEST_API_KEY does not look like a Bing API key (letters and digits only; check for spaces or a truncated copy).");
    process.exit(2);
  }
} else {
  auth = { method: "oauth", accessToken: accessToken! };
}

const meaning: Record<string, string> = {
  unauthenticated: "Bing rejected the credential (invalid, expired or revoked). Generate a new key under Settings → API Access.",
  forbidden: "The account is blocked or not allowed to use the API.",
  not_found: "That site is not available to this Bing account (not added, or not verified).",
  throttled: "Bing is rate limiting this account. Wait a few minutes and run again.",
  invalid_request: "Bing rejected the request parameters.",
  capability: "Bing says this method is deprecated or unavailable. Check the API documentation for changes.",
  unavailable: "Bing could not be reached or answered with a server error.",
  bad_response: "Bing answered with something that was not the documented JSON shape.",
};
const fail = (err: unknown): never => {
  if (err instanceof BingApiError) console.log(`FAIL  ${err.kind}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}${err.apiErrorCode !== undefined ? ` [ApiErrorCode ${err.apiErrorCode}]` : ""}: ${meaning[err.kind]}`);
  else console.log("FAIL  Unexpected error.");
  process.exit(1);
};

const client = new HttpBingApiClient({ timeoutMs: 30_000 });
console.log(`Method under test: ${auth.method === "api_key" ? "API key (ssl.bing.com, apikey parameter)" : "OAuth bearer token (www.bing.com)"}`);
let site = process.env.BING_TEST_SITE?.trim();
try {
  const sites = await client.getUserSites(auth);
  const { properties, skipped } = discoverBingSites(sites);
  console.log(`PASS  GetUserSites: ${sites.length} site(s); ${properties.length} verified, ${skipped.length} not usable.`);
  for (const p of properties.slice(0, 10)) console.log(`      - ${p.externalPropertyId}`);
  for (const s of skipped.slice(0, 10)) console.log(`      - ${s.url} (${s.reason})`);
  site ||= properties[0]?.externalPropertyId;
} catch (err) {
  fail(err);
}
if (!site) {
  console.log("NOTE  No verified site to read reports from. Verify a site in Bing Webmaster Tools and run again.");
  process.exit(1);
}
console.log(`Reading reports for ${site}`);
let problems = 0;
const range = (rows: Array<{ date: string }>) => (rows.length ? `${rows.map((r) => r.date).sort()[0]} .. ${rows.map((r) => r.date).sort().at(-1)}` : "no rows");
const describeError = (name: string, err: unknown) => {
  problems++;
  if (err instanceof BingApiError) console.log(`FAIL  ${name}: ${err.kind}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}${err.apiErrorCode !== null ? ` [ApiErrorCode ${err.apiErrorCode}]` : ""}: ${meaning[err.kind]}`);
  else console.log(`FAIL  ${name}: unexpected error.`);
};

// The three reports already confirmed live, then the ones that follow Microsoft's published format but were never seen live.
// --show-rows prints up to 2 rows of each (data only, never a credential) so a differing shape can be pasted back.
type Step = readonly [string, () => Promise<unknown>];
interface Result {
  method: string;
  ok: boolean;
  detail: string;
  quirks: string;
}
const results: Result[] = [{ method: "GetUserSites", ok: true, detail: "answered", quirks: "" }];

/** Field names that were null in every row: usually a field Bing leaves out (or one we named wrong). Names only, never values. */
const alwaysNull = (rows: Array<Record<string, unknown>>) => (rows.length === 0 ? [] : Object.keys(rows[0]!).filter((k) => rows.every((r) => r[k] === null || r[k] === undefined)));

function report(name: string, r: unknown) {
  const x = r as { rows?: Array<Record<string, unknown>>; skipped?: number; links?: unknown[]; details?: unknown[]; totalPages?: number | null; crawlRate?: number[]; ajaxEnabled?: boolean | null } | null;
  let detail: string;
  let quirks = "";
  let sample: unknown = r;
  if (x && Array.isArray(x.rows)) {
    const dated = x.rows.length > 0 && typeof x.rows[0]!.date === "string";
    detail = `${x.rows.length} row(s)${dated ? ` (${range(x.rows as Array<{ date: string }>)})` : ""}`;
    const nulls = alwaysNull(x.rows);
    const q: string[] = [];
    if (x.skipped) q.push(`${x.skipped} unreadable row(s) skipped`);
    if (nulls.length) q.push(`always empty: ${nulls.join(", ")}`);
    if (x.rows.length === 0) q.push("empty list (Bing reported nothing)");
    // Undocumented methods: show which field names Bing actually sent.
    if (/DeepLink|PagePreview|CountryRegion|ConnectedPages|SiteMoves|GetKeyword|GetRelatedKeywords/.test(name) && x.rows.length > 0) q.push(`fields: ${Object.keys(x.rows[0]!).join(", ")}`);
    quirks = q.join("; ");
    sample = x.rows.slice(0, 2);
  } else if (x && Array.isArray(x.links)) {
    detail = `${x.links.length} link row(s), TotalPages ${x.totalPages ?? "not reported"}`;
    sample = x.links.slice(0, 2);
  } else if (x && Array.isArray(x.details)) {
    detail = `${x.details.length} link(s), TotalPages ${x.totalPages ?? "not reported"}`;
    sample = x.details.slice(0, 2);
  } else if (x && Array.isArray(x.crawlRate)) {
    detail = `${x.crawlRate.length} crawl-rate value(s), ajax ${x.ajaxEnabled ?? "not stated"}`;
    quirks = `values: ${[...new Set(x.crawlRate)].join(", ")}`;
  } else {
    detail = x ? "answered" : "no data (null)";
    if (x) quirks = `fields: ${Object.keys(x).join(", ")}`;
  }
  results.push({ method: name, ok: true, detail, quirks });
  console.log(`PASS  ${name}: ${detail}${quirks ? ` [${quirks}]` : ""}`);
  if (args.has("--show-rows")) console.log(JSON.stringify(sample, null, 2));
}

async function runAll(list: Step[]) {
  for (const [name, run] of list) {
    try {
      report(name, await run());
    } catch (err) {
      describeError(name, err);
      const e = err instanceof BingApiError ? err : null;
      results.push({ method: name, ok: false, detail: e ? `${e.kind}${e.httpStatus ? ` HTTP ${e.httpStatus}` : ""}${e.apiErrorCode !== null ? ` ApiErrorCode ${e.apiErrorCode}` : ""}` : "unexpected error", quirks: e ? (meaning[e.kind] ?? "") : "" });
    }
  }
}

await runAll([
  ["GetRankAndTrafficStats", () => client.getRankAndTrafficStats(auth, site!)],
  ["GetQueryStats", () => client.getQueryStats(auth, site!)],
  ["GetCrawlStats", () => client.getCrawlStats(auth, site!)],
  ["GetPageStats", () => client.getPageStats(auth, site!)],
  ["GetCrawlIssues", () => client.getCrawlIssues(auth, site!)],
  ["GetBlockedUrls", () => client.getBlockedUrls(auth, site!)],
  ["GetFeeds", () => client.getFeeds(auth, site!)],
  ["GetLinkCounts (page 0)", () => client.getLinkCounts(auth, site!, 0)],
  ["GetUrlSubmissionQuota", () => client.getUrlSubmissionQuota(auth, site!)],
  ["GetContentSubmissionQuota", () => client.getContentSubmissionQuota(auth, site!)],
  ["GetCrawlSettings", () => client.getCrawlSettings(auth, site!)],
  ["GetQueryParameters", () => client.getQueryParameters(auth, site!)],
  ["GetDeepLinkBlocks", () => client.getDeepLinkBlocks(auth, site!)],
  ["GetActivePagePreviewBlocks", () => client.getActivePagePreviewBlocks(auth, site!)],
  ["GetCountryRegionSettings", () => client.getCountryRegionSettings(auth, site!)],
  ["GetConnectedPages", () => client.getConnectedPages(auth, site!)],
  ["GetSiteMoves", () => client.getSiteMoves(auth, site!)],
  ["GetSiteRoles", () => client.getSiteRoles(auth, site!, false)],
]);

// Drill-down reports need a real page, query or sitemap from the answers above (re-read cheaply from the client, not stored).
const pages = await client.getPageStats(auth, site!).then((r) => r.rows).catch(() => []);
const queries = await client.getQueryStats(auth, site!).then((r) => r.rows).catch(() => []);
const feeds = await client.getFeeds(auth, site!).then((r) => r.rows).catch(() => []);
// The highest-impression query, and a page it reaches, so the drill-downs read real rows instead of empty lists.
const query = [...queries].sort((x, y) => (y.impressions ?? 0) - (x.impressions ?? 0))[0]?.query;
const queryPages = query ? await client.getQueryPageStats(auth, site!, query).then((r) => r.rows).catch(() => []) : [];
const page = queryPages[0]?.page ?? pages[0]?.page;
const feed = feeds[0]?.url;
const host = (() => {
  try {
    return new URL(site!).host;
  } catch {
    return site!;
  }
})();
const drill: Step[] = [];
if (page) {
  drill.push(["GetUrlInfo", () => client.getUrlInfo(auth, site!, page)]);
  drill.push(["GetUrlTrafficInfo", () => client.getUrlTrafficInfo(auth, site!, page)]);
  drill.push(["GetUrlLinks (page 0)", () => client.getUrlLinks(auth, site!, page, 0)]);
  drill.push(["GetPageQueryStats", () => client.getPageQueryStats(auth, site!, page)]);
}
if (query) {
  drill.push(["GetQueryPageStats", () => client.getQueryPageStats(auth, site!, query)]);
  drill.push(["GetQueryTrafficStats", () => client.getQueryTrafficStats(auth, site!, query)]);
  drill.push(["GetKeywordStats (this site's query, us, en-US)", () => client.getKeywordStats(auth, query, "us", "en-US")]);
  drill.push(["GetKeywordStats (\"seo\", us, en-US)", () => client.getKeywordStats(auth, "seo", "us", "en-US")]);
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  drill.push(["GetKeyword (\"seo\", us, en-US, last 30 days)", () => client.getKeyword(auth, "seo", "us", "en-US", start, end)]);
  drill.push(["GetKeyword (this site's query)", () => client.getKeyword(auth, query, "us", "en-US", start, end)]);
  drill.push(["GetRelatedKeywords (\"seo\", us, en-US, last 30 days)", () => client.getRelatedKeywords(auth, "seo", "us", "en-US", start, end)]);
}
if (page && query) drill.push(["GetQueryPageDetailStats", () => client.getQueryPageDetailStats(auth, site!, query, page)]);
drill.push(["GetChildrenUrlInfo (site root, page 0)", () => client.getChildrenUrlInfo(auth, site!, host, 0, {})]);
drill.push(["GetChildrenUrlTrafficInfo (site root, page 0)", () => client.getChildrenUrlTrafficInfo(auth, site!, host, 0)]);
if (feed) drill.push(["GetFeedDetails", () => client.getFeedDetails(auth, site!, feed)]);
else console.log("NOTE  No sitemap is submitted, so GetFeedDetails was not tried.");
if (!page || !query) console.log("NOTE  No page or query rows came back, so the drill-down reports that need one were not tried.");
await runAll(drill);

console.log("\n| Method | Result | Detail | Field notes |\n|---|---|---|---|");
for (const r of results) console.log(`| ${r.method} | ${r.ok ? "works" : "FAILS"} | ${r.detail} | ${r.quirks || ""} |`);
problems = results.filter((r) => !r.ok).length;
if (problems) process.exit(1);
console.log("\nThis proves the credential and our reading of Bing's responses for this one site. OAuth login and token renewal are separate: see docs/BING.md, 'Live checklist'.");
