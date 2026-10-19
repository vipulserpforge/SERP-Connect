# Reporting layer

One service (`@serp/reporting` → `ReportService`) answers every report request, whether it comes from the dashboard
(`POST /api/reports/{gsc|ga4}`, signed-in session) or from Claude through the MCP server (`query_gsc_report`,
`query_ga4_report`). Neither entry point talks to a provider directly.

## Request pipeline

1. **Enabled?** The provider must be switched on for this server.
2. **Validate** the input with the shared zod schema (unknown fields are rejected; user ids, connection ids and
   credentials are never accepted from the caller).
3. **Authorize** the property: it must belong to the caller and be enabled; the connection is resolved from it.
4. **Resolve dates** (`resolveReportDates`): either `startDate` + `endDate`, or `lastDays` (exactly one form).
5. **Normalize** the request (`canonicalizeGscQuery` / `canonicalizeGa4Query`): trimmed, case-folded where the provider
   is case-insensitive, filters de-duplicated and sorted, row limit capped.
6. **Check availability** with the provider's own rules (below) and collect warnings.
7. **Cache lookup** by scope + hash. A hit costs no provider quota and no rate-limit budget.
8. **Single flight:** identical in-flight requests (same user, provider, connection, property, hash) share one call.
9. **Budget:** per-user and per-connection token buckets, then a per-user concurrency cap. Over budget → `RATE_LIMITED`
   (retryable, with `retryAfterSeconds`).
10. **Call the adapter** under one overall deadline, with controlled retries.
11. **Finalize and cache**: warnings merged, `report.period` and `cache` set, entry stored with a TTL.
12. On a provider outage or throttle, serve the last saved report (flagged `cache.stale`, warning `STALE_CACHE`).

## Two calendars, preserved

| | Search Console | GA4 |
|---|---|---|
| Dates are read in | Pacific Time | The property's reporting time zone (UTC + `TIMEZONE_UNKNOWN` if not stored) |
| `lastDays` ends on | 2 days ago (finalized). `dataState: "all"` ends yesterday | Yesterday |
| History | about 16 months; older start dates are rejected | back to 2015-08-14 |
| Recent data | `RECENT_DATA_INCOMPLETE` for the last ~2 days | `PARTIAL_DAY` / `RECENT_DATA_INCOMPLETE`, processing delay noted |
| Future days | rejected | rejected |

The time zone is part of the cache hash, and `report.period.timeZone` always tells the caller which calendar was used.
A relative range resolves to concrete dates *before* hashing, so "last 7 days" tomorrow is a different cache entry.

## Cache separation

Entries are addressed by `(user, provider, connection, property, hash)`. The hash covers the canonical request: dates,
dimensions, metrics, filters, ordering, row limit and offset, data state, the time zone, and a rules version.
There is no API to read by hash alone.

* Scope parts must match `^[A-Za-z0-9_-]{1,64}$`, so no part can contain a separator and forge another key.
* The memory cache re-checks the stored scope on every read (defense in depth), and each user has their own entry quota.
* The PostgreSQL cache (`report_cache`, server-only) has composite foreign keys, so the database itself refuses a row
  that pairs one user's connection or property with another user's id. Rows disappear with the connection or user.
* Callers receive copies, so mutating a result cannot change what others receive.
* Disconnecting a connection calls `invalidateConnection`, which deletes its cached reports immediately.
* Single-flight keys carry the same scope, so two users are never served by one upstream call.

TTLs: Search Console 20 min when the range touches the last 3 days, otherwise 6 h; GA4 10 min / 2 h; Clarity 6 h; Bing 6 h (no date range upstream; windows are applied locally, see `BING.md`)
(protects its 10-requests-per-day budget).

## Time, retries and limits

| Setting | Default | Meaning |
|---|---|---|
| `PROVIDER_REQUEST_TIMEOUT_MS` | 20000 | One deadline for the whole report, retries included. On expiry the call is aborted → `PROVIDER_UNAVAILABLE` ("did not respond in time") |
| `REPORT_MAX_RETRIES` | 2 | Retries for transient provider failures, 250 ms × 2ⁿ plus jitter |
| `REPORT_RATE_LIMIT_PER_USER_PER_MINUTE` | 60 | Upstream calls per user |
| `REPORT_RATE_LIMIT_PER_CONNECTION_PER_MINUTE` | 30 | Upstream calls per Google connection (its quota is shared by its properties) |
| `REPORT_MAX_STALE_SECONDS` | 86400 | Oldest saved report served when the provider fails |

Retried: `PROVIDER_UNAVAILABLE` marked retryable; Search Console quota errors that carry a `Retry-After` of 4 s or less.
**Never retried:** GA4 quota errors (retrying burns more quota), expired or revoked auth, permission errors, invalid
requests, the spent deadline, and unexpected errors. The HTTP clients created by `createLiveAdapters` do not retry, so
there is one retry policy.

Stale data is served only for provider outages and throttling, never to hide an auth, permission or validation error.

## Errors

All failures use the shared envelope `{ code, message, retryable, requestId, suggestedAction?, retryAfterSeconds? }`.
`RATE_LIMITED` (our throttle) maps to HTTP 429 with a `Retry-After` header. The web route also requires
`application/json`, a same-origin `Origin`, and a body of 32 KB or less; responses are `no-store`.

## Known limits

* Token buckets, the concurrency cap and single flight are **per process**. With several web or MCP instances each has
  its own limits; the PostgreSQL cache is shared, so results are still deduplicated across instances after the first call.
* The memory cache is per process and used when `DB_MODE=mock`.
* `PgReportCache` has been exercised on PGlite using the real migrations, not on the hosted Supabase project.
* Nothing here has run against real Google APIs.
