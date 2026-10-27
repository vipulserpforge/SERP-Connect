# Microsoft Clarity integration

Status: **implemented and tested with mocks; not yet tested against the real Clarity API.** Do not treat it as production-ready until you have run the manual live test below with your own token.

Source of truth: [Clarity Data Export API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) (page dated 5 Dec 2025, re-read on 19 Oct 2026).

## What the API gives us, and what it does not

| Fact (from Microsoft's documentation) | How the app respects it |
|---|---|
| `GET https://www.clarity.ms/export-data/api/v1/project-live-insights`, header `Authorization: Bearer <token>` | `HttpClarityApiClient` (`packages/provider-clarity`). Redirects are refused so the header can never be forwarded elsewhere. |
| `numOfDays` is 1, 2 or 3 = "the last 24, 48 or 72 hours" | Only those values are accepted. We describe it as a **rolling window**, never as calendar dates, and never offer custom ranges or history. |
| Up to 3 dimensions: Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel, URL | Validated before any call: unknown, duplicate or more than three are rejected. |
| Max 1,000 rows, no paging | Each metric block that reaches 1,000 rows gets a `ROW_LIMIT_REACHED` warning and `completeness: unknown_or_provider_limited`. |
| 10 requests per project per day | Durable local budget (below). |
| Results are in UTC | Reported as `timeZone: UTC`. |
| Errors: 400, 401, 403, 429 | Mapped to `INVALID_QUERY`, `AUTH_EXPIRED`, `FORBIDDEN`, `CLARITY_DAILY_BUDGET_EXHAUSTED`. 5xx/network/timeouts become `PROVIDER_UNAVAILABLE`. |
| Response is `[{ metricName, information: [ {...}, ... ] }]` with numbers often as strings | Flattened to rows tagged `metricName`; numeric strings become numbers (dimension values stay text); absent fields stay absent, `null` stays `null`, `0` stays `0`. Unknown metrics and fields are kept under their original names. |

Not promised anywhere: arbitrary dates, history beyond 3 days, paging, search rankings/impressions/organic clicks (use Search Console), a list of every metric (the docs say responses may include more than the documented ones, and a response may omit some).

**Not documented by Microsoft, so we do not claim it:** when the daily quota resets, whether failed calls count, whether the limit is per token or per project, and what each metric field means.

## Customer flow (dashboard → Microsoft Clarity card)

1. The customer opens the project in Clarity, **Settings → Data Export → Generate new API token** (project admins only), copies it.
2. In the dashboard they enter a friendly name and paste the token. It goes in the body of a server-action POST over HTTPS (CSRF-protected), never in a URL, never to the browser's storage, logs or analytics.
3. **Saving makes no request to Clarity** (a test call would use quota). The connection shows **Awaiting verification**.
4. **Verify token** (button says it uses 1 request) or the first real report verifies it. Only then does the state become **Connected**, from real evidence. A 401 shows **Invalid credentials**, a 403 **Permission denied**, a 429 **Rate-limited by Clarity** (the token stays valid). In demo mode (`DATA_MODE=mock`) nothing is verified and the app says so.
5. Rename, **Replace token** (reconnect) and **Remove** are on each connection. Removal needs an explicit "Yes, remove" step, destroys the encrypted token and saved reports immediately, and stops all requests. Clarity tokens cannot be revoked from our side: the customer should also delete the token in Clarity.
6. **View reports** opens `/dashboard/clarity`: quick views (overview, devices & browsers, OS, sources, pages, countries), 24/48/72-hour window, metric tabs. **Opening or switching views never calls Clarity**; it shows only saved results. A "Fetch" button (stating the cost) is the only thing that spends quota.

## How the token is protected

- Same envelope encryption as Google tokens (`SECRET_KEYS`, AES-256-GCM, per-secret data key, bound to user + connection so a copied ciphertext will not decrypt elsewhere). No new hardcoded key. Production refuses to start without `SECRET_KEYS`.
- The token is decrypted only inside the one function that calls Clarity, kept in a local variable, and never logged, audited, cached, returned, or used as a key. Tests dump the database, logs, audit rows, cache, tool output and the HTML and assert the token is absent.
- **Fingerprint:** quota grouping and duplicate detection need an identifier, and Clarity does not give one. We use `HMAC-SHA256(token)` keyed by `CREDENTIAL_FINGERPRINT_KEY`, stored as the connection's account id and (shortened) as the property id. It cannot be reversed to the token. If the key is not configured in production, **saving a Clarity token is refused** with a clear message; the rest of the app is unaffected.
- Ownership: every read/write is scoped by the signed-in user's id; ids from forms or tool arguments are only ever looked up inside that user's own rows (a foreign id behaves exactly like a missing one). RLS: `provider_secrets`, `report_cache`, `provider_request_budgets` and the new `provider_request_reservations` have RLS enabled and **no** grants for browser roles; `provider_connections`/`properties` are read-only for the owner.

## Daily request budget

- Provider limit: 10 per project per day (Microsoft's, cannot be removed). **App-side budget: off by default** (`CLARITY_LOCAL_DAILY_BUDGET=1000`); set it to e.g. 8 to keep spare requests. Requests are still counted and shown, and a 429 from Clarity still stops further calls for the day.
- **Durable and concurrency-safe:** `private.reserve_provider_request()` bumps the day's counter *and* writes a ledger row in one SQL statement (`provider_request_reservations`: user, connection, window, status `reserved/succeeded/failed/provider_limited`, HTTP status, timestamps). Tested with 40 simultaneous reservations (exactly 8 succeed) and two store instances sharing one database.
- **Quota group** = the token fingerprint, so two customers pasting the same project token share one budget. Two *different* tokens for the same Clarity project count separately: we cannot tell they are the same project, so in that case the real limit can be reached sooner than our count says. A 429 from Clarity then stops further requests (local budget for the window is set to spent).
- **Window** = UTC calendar day, an **assumption**. Failed calls count as used (not documented whether Clarity counts them). A reservation is never refunded.
- **No retries.** A retry would cost quota, and 401/403/429/400 can never succeed on retry. A 5xx or timeout is reported as retryable *by the user*, with a warning that each attempt costs quota.
- **Caching:** results are saved for 6 hours (`ttlSeconds("clarity")`), scoped to user + connection + property + exact parameters. Repeats are free. Identical concurrent requests share one call. When the budget is spent or Clarity is down, an expired saved result (up to 24 h old, `REPORT_MAX_STALE_SECONDS`) is served and labelled stale. No result and no budget gives `CLARITY_DAILY_BUDGET_EXHAUSTED`.
- The dashboard labels the numbers "tracked by this app", shows the window, remaining local budget and last successful request, and says it is not a counter from Clarity.

## MCP tools (read-only)

| Tool | Purpose | Spends Clarity quota? |
|---|---|---|
| `list_clarity_projects` | The user's connected projects; their `id` is the `propertyId` for the tools below | no |
| `get_clarity_insights` | Behaviour data for one project (`numOfDays` 1-3, up to 3 `dimensions`); cache-first | only on a cache miss |
| `get_clarity_quota_status` | App-tracked usage, remaining budget, window, last success | no |
| `get_connection_status`, `get_supported_metrics` (provider `clarity`) | Existing tools; now include Clarity | no |

The tool descriptions tell Claude that Clarity is on-site behaviour (not search rankings, impressions or organic clicks), that the window is only 24/48/72 hours, that quota is scarce, and not to call it repeatedly to explore. Tools take no user id or connection id: the user comes from the verified OAuth token and the property must be one of that user's enabled properties. Arguments such as `userId` are rejected.

## Setup you must do (plain English)

1. **Apply the database migration** `supabase/migrations/20261019150000_clarity_quota_reservations.sql`. It was already applied to your Supabase project `dphftsifxfhxbhtgabso` on 19 Oct 2026 (it only adds one table and two functions). For any other database, run it in the Supabase SQL editor.
2. **Create the fingerprint key** and add it to BOTH apps' environment settings (`web.env` and `mcp.env`; same value). Run once on your computer:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   Put the output in a password manager, then add `CREDENTIAL_FINGERPRINT_KEY=<that value>` to `.env.local` (for testing on your computer) and to both Hostinger environment files. **Do not paste it into chat or commit it.** If you lose it you only lose quota history and duplicate detection: customers do not need to reconnect.
3. (Optional) `CLARITY_LOCAL_DAILY_BUDGET` (default 1000 = no app-side limit).
4. `SECRET_KEYS` must already be set (same as for Google). No Google Cloud work is needed for Clarity.
5. Redeploy both apps.

## Report types and the clean MCP output (verified live, 27 Oct 2026)

`get_clarity_insights` takes a `reportType` instead of raw dimensions (one Clarity request each; ask for one or two per question):

| reportType | dimensions | answers |
|---|---|---|
| overview | none | totals + top devices, browsers, OS, countries, pages, referrers |
| by_device | Device | mobile vs desktop |
| by_country | Country/Region | where visitors are |
| by_source | Source, Medium | traffic source and medium |
| by_channel | Channel | organic / direct / social / referral / paid |
| by_page | URL | sessions, engagement, scroll depth per page |
| frustration_by_page | URL | pages with rage / dead / quick-back / error clicks |
| by_browser_os | Browser, OS | browser and OS combinations |

Output is one merged row per dimension value with short numeric fields, plus `source` (live/cache), `pulledAt`, `dataAgeMinutes`, the UTC `window`, `rowsReturned`/`rowsAvailable`, `quota` (used, remaining, reset) and warnings (LOW_QUOTA at 2 or fewer left, QUOTA_EXHAUSTED_CACHE_ONLY at 0, truncation at 1,000 rows). The cache key is (project, numOfDays, dimensions), 6 hours, so presets that share dimensions (by_page and frustration_by_page) share one request.

### Where the live API differs from the documentation
- Metric block names have no spaces (`DeadClickCount`, `ScrollDepth`); the URL column is `Url`; numbers are real numbers, not strings.
- With no dimension the response also holds breakdown blocks (Browser, Device, OS, Country, PageTitle, ReferrerUrl as `{name, sessionsCount}` and PopularPages as `{url, visitsCount}`). With a dimension only the 9 metric blocks come back.
- Bot sessions are NOT a subset of sessions: a row can have more bot sessions than sessions, so no "human = total − bot" figure is derived. Both counts are shown, labelled.
- In click/error blocks `sessionsCount` is all sessions in scope; `subTotal` is the event count and `sessionsWithMetricPercentage` the share affected.
- The Traffic block can have more rows than the other blocks (113 URLs vs 54).
- No rate-limit headers; the app's own counter is the only quota view. Test fixtures: `tests/clarity/fixtures/`.

## Saved history (`clarity_snapshots`)

Every **live** pull (not cache hits, not demo data) is saved with its `pulled_at` time in `public.clarity_snapshots` (migration `20261027100000_clarity_snapshots.sql`). `get_clarity_history` reads them back newest first, in the same tidy shape, with no Clarity request and no quota. Details:
- Server-only table (RLS on, no browser grants). Rows are deleted with the user or the connection; pulls older than 90 days are pruned on each save.
- Saving is best-effort: a failed save never fails the report.
- History has gaps by design (a pull happens only when someone asks) and 1-3 day windows overlap, so compare snapshots, not daily totals.
- **Deploy:** apply the migration to Supabase before releasing. Without the table, saving fails quietly (logged as `clarity.snapshot_failed`) and `get_clarity_history` errors.

## Tests

| Test | What | Data |
|---|---|---|
| `tests/clarity/api-client.test.ts` | request building, error mapping, timeouts, validation, normalization (edge cases) | **mock** (fake fetch + Microsoft's sample response) |
| `tests/clarity/quota.test.ts` | budget semantics on the memory and Postgres stores, concurrency, multi-instance, windows, ledger, privileges | **mock** (real SQL on PGlite) |
| `tests/clarity/connection-service.test.ts` | encryption, ownership, rename/reconnect/disconnect, fail-safe key handling | **mock** |
| `tests/clarity/report.test.ts` | presets, clean output, quota warnings, cache labels | **real responses** captured once from Clarity, replayed offline |
| `tests/clarity/snapshots.test.ts` | history store on memory and Postgres: order, shape filter, user scoping, privileges, cascade | **mock** |
| `tests/clarity/system.test.ts` | whole stack: Postgres + encrypted tokens + budget + cache + MCP, two customers, 401/403/429/5xx, stale data, secrecy | **mock** (fake Clarity client) |
| `tests/e2e/auth-flow.e2e.ts` (Clarity block) | built web app: save, verify (demo), fetch on demand, free page views, cross-user attempts, rename/replace/remove | **mock** (built-in demo adapter) |
| `pnpm clarity:check --yes` | **the only real-API test**, run by you | **real Clarity** |

**Nothing in the automated suite contacts clarity.ms or spends quota.**

### Manual live test (uses 1 of your project's 10 daily requests)

1. In Clarity: Settings → Data Export → Generate new API token (name it e.g. `serp-test`).
2. Add `CLARITY_TEST_TOKEN=<token>` to `.env.local` (git-ignored). Never paste it in chat.
3. Run `pnpm clarity:check --yes`. It prints PASS/FAIL, the metric names Clarity returned and row counts, never the token. Add `--show-rows` to see three sample rows.
4. Delete the line from `.env.local`.
5. Then in the dashboard: save the same token, press **Verify token**, open **View reports**, fetch a view, and confirm the numbers look sensible against the Clarity dashboard (last 24 hours, UTC).
6. Tell me what the real response looked like (metric names, any fields I should label). The names and field meanings are the main thing I could not verify.

## Known limitations

- Not verified against the real API: response metric names beyond `Traffic` (the only name in the official sample), field meanings, units, and whether the token's JWT carries a project id we could use instead of the fingerprint.
- Quota reset time and failure accounting are unknown (conservative assumptions above). The app cannot see requests made outside it with the same token.
- A token cannot be revoked from the app; the customer must delete it in Clarity.
- Metric tabs group blocks by name pattern; an unrecognised metric appears under "All metrics" only.
- Only the last 24/48/72 hours exist. For anything longer, use GA4/Search Console.
