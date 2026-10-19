import { BingApiError, HttpBingApiClient, discoverBingSites, validateBingApiKey, type BingAuth } from "../packages/provider-bing/src/index.js";

// MANUAL LIVE TEST: the only script in this repository that talks to the real Bing Webmaster API. Read-only (GET only).
//
//   Put ONE of these in .env.local (git-ignored), then run:  pnpm bing:check --yes
//     BING_TEST_API_KEY=<key>            Bing Webmaster Tools > Settings > API Access > API Key
//     BING_TEST_ACCESS_TOKEN=<token>     only if you already have a short-lived OAuth access token
//   Optional: BING_TEST_SITE=https://www.example.com/   (default: the first verified site)
//
// It lists your sites, then reads traffic, query and crawl statistics for ONE site. Bing documents no numeric request limit.
// It never prints the key/token or site-ownership codes, and stores nothing. Remove the key from .env.local afterwards.
const args = new Set(process.argv.slice(2));
const apiKey = process.env.BING_TEST_API_KEY?.trim();
const accessToken = process.env.BING_TEST_ACCESS_TOKEN?.trim();

if (!args.has("--yes")) {
  console.log("This makes up to 4 real read-only requests to Bing Webmaster Tools.\nRun again with --yes to continue.");
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
for (const [name, run] of [
  ["GetRankAndTrafficStats", () => client.getRankAndTrafficStats(auth, site!)],
  ["GetQueryStats", () => client.getQueryStats(auth, site!)],
  ["GetCrawlStats", () => client.getCrawlStats(auth, site!)],
] as const) {
  try {
    const r = await run();
    console.log(`PASS  ${name}: ${r.rows.length} row(s) (${range(r.rows)})${r.skipped ? `, ${r.skipped} unreadable row(s) skipped` : ""}`);
    if (args.has("--show-rows")) console.log(JSON.stringify(r.rows.slice(0, 2), null, 2));
    if (r.rows.length === 0) console.log("      An empty list means Bing reported nothing for this site yet, not that the credential is wrong.");
  } catch (err) {
    problems++;
    if (err instanceof BingApiError) console.log(`FAIL  ${name}: ${err.kind}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}: ${meaning[err.kind]}`);
    else console.log(`FAIL  ${name}: unexpected error.`);
  }
}
if (problems) process.exit(1);
console.log("\nThis proves the credential and our reading of Bing's responses for this one site. OAuth login and token renewal are separate: see docs/BING.md, 'Live checklist'.");
