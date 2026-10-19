import { ClarityApiError, HttpClarityApiClient, parseClarityResponse, validateClarityToken } from "../packages/provider-clarity/src/index.js";

// MANUAL LIVE TEST: the only script in this repository that talks to the real Microsoft Clarity API.
//
//   Put CLARITY_TEST_TOKEN=<token> in .env.local (it is git-ignored), then run:
//     pnpm clarity:check --yes
//
// It makes exactly ONE request (last 24 hours, no dimensions) and so spends 1 of the project's 10 daily requests.
// It never prints the token, never stores anything, and prints only counts and metric names unless you add --show-rows.
// Remove the token from .env.local afterwards.
const args = new Set(process.argv.slice(2));
const token = process.env.CLARITY_TEST_TOKEN?.trim();

if (!args.has("--yes")) {
  console.log("This makes ONE real request to Clarity and spends 1 of the project's 10 daily requests.\nRun again with --yes to continue.");
  process.exit(2);
}
if (!token) {
  console.log("CLARITY_TEST_TOKEN is not set. Add it to .env.local (never paste it into chat), then run again.");
  process.exit(2);
}
try {
  validateClarityToken(token);
} catch {
  console.log("CLARITY_TEST_TOKEN does not look like a Clarity API token (check for spaces or a truncated copy).");
  process.exit(2);
}

const started = Date.now();
try {
  const body = await new HttpClarityApiClient({ timeoutMs: 30_000 }).exportLiveInsights(token, { numOfDays: 1, dimensions: [] });
  const parsed = parseClarityResponse(body, []);
  console.log(`PASS  Clarity accepted the token (HTTP 200 in ${Date.now() - started} ms).`);
  if (!parsed) {
    console.log("WARN  The response was not the documented array shape. Check https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api for API changes.");
    process.exit(1);
  }
  console.log(`      ${parsed.blocks.length} metric block(s), ${parsed.rows.length} row(s) in total.`);
  for (const b of parsed.blocks) console.log(`      - ${b.metricName}: ${b.rows} row(s)${b.truncated ? " (hit the 1,000-row cap)" : ""}`);
  for (const w of parsed.warnings) console.log(`WARN  ${w.message}`);
  if (parsed.rows.length === 0) console.log("NOTE  An empty result means Clarity reported no data for the last 24 hours (new project or no traffic), not that the token is wrong.");
  if (args.has("--show-rows")) console.log(JSON.stringify(parsed.rows.slice(0, 3), null, 2));
  console.log("\nThis proves the token and our reading of the response shape for this one project. Now save the token in the dashboard and run a report there.");
} catch (err) {
  if (err instanceof ClarityApiError) {
    const meaning: Record<string, string> = {
      unauthorized: "Clarity rejected the token (missing, invalid or expired). Generate a new one under Settings → Data Export.",
      forbidden: "The token is not authorized for this operation. A project admin must generate it.",
      quota: "Clarity says the daily limit (10 requests per project) is used up. Try again tomorrow.",
      invalid_request: "Clarity rejected the request parameters.",
      unavailable: "Clarity could not be reached or answered with a server error.",
      bad_response: "Clarity answered with something that is not JSON.",
    };
    console.log(`FAIL  ${err.kind}${err.httpStatus ? ` (HTTP ${err.httpStatus})` : ""}: ${meaning[err.kind]}`);
  } else {
    console.log("FAIL  Unexpected error.");
  }
  process.exit(1);
}
