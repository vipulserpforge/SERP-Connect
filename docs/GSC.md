# Google Search Console integration

Status: implemented and tested against a **mock Search Console API**. No Google Cloud project, OAuth client or real account has been used. See "Needs live verification" before trusting it in production.

## Flow

1. **Connect**: dashboard "Connect Search Console" -> OAuth (PKCE, `webmasters.readonly`) -> encrypted tokens stored ([`SECRETS.md`](SECRETS.md)).
2. **Discover**: right after connecting (and on "Refresh properties") the server calls `sites.list` with that connection's token, keeps sites the account can query (`siteOwner`, `siteFullUser`, `siteRestrictedUser`), skips `siteUnverifiedUser` and malformed entries, and reconciles the stored properties. Users' enable/disable choices survive a refresh; sites the account lost are removed. An account with no sites gets an honest empty result; nothing is invented.
3. **Query**: MCP tool `query_gsc_performance` -> ownership check (`authorizeProperty`) -> date and combination validation -> cache -> `GoogleGscAdapter` -> `searchAnalytics.query` using the owning connection's token -> normalized rows + warnings.

Code: `packages/provider-gsc` (API client, mock API, validation, normalization, adapter), `packages/credentials/src/discovery.ts`, `packages/reporting`, `apps/mcp-server/src/live.ts` (live wiring; only used with `DATA_MODE=live`).

## What a query supports

Metrics: clicks, impressions, CTR (0-1), average position. Dimensions: date, page, query, country (ISO alpha-3, lowercase in results), device (DESKTOP/MOBILE/TABLET), searchAppearance. Search types: web, image, video, news, discover, googleNews. Filters (AND-combined): equals, notEquals, contains, notContains, includingRegex, excludingRegex. Sort by any metric, either direction. `dataState`: `final` (default) or `all` (includes fresh data).

## Validation and guardrails

| Rule | Behavior |
|---|---|
| Dates | Real calendar dates, start <= end, not in the future, within ~16 months (Pacific Time) -> `DATE_RANGE_UNSUPPORTED` / `INVALID_QUERY` before any API call |
| Dimensions | No repeats; `searchAppearance` only on its own |
| Discover / Google News | `query` dimension and filters rejected |
| Filters | Country must be alpha-3, device one of three values, regex only on page/query and RE2-compatible (no lookaround/backreferences), contains only on page/query |
| Ordering | Google orders by clicks (or date). For any other order the server fetches up to 25,000 rows, sorts and slices, so "top 10 by impressions" is not computed from a biased subset |
| Failures before network | Invalid requests never fetch a token or contact Google |

## Warnings returned with data

`MOCK_DATA`, `RECENT_DATA_INCOMPLETE` (newest 1-2 days), `FRESH_DATA_INCLUDED` / `INCOMPLETE_DATA_FROM` (+ `completeness: partial`) for `dataState=all`, `ANONYMIZED_QUERIES_OMITTED`, `AGGREGATION_BY_PAGE`, `ROW_LIMIT_REACHED`, `SORT_LIMITED_TO_FETCHED_ROWS` (+ `partial`), `NO_DATA`. Results never claim completeness: Google may omit rows.

## Errors (all safe: fixed messages, no upstream text, no tokens)

| Google | Error code | Notes |
|---|---|---|
| 401 | `AUTH_EXPIRED` | connection flagged `needs_attention`; user must reconnect |
| 403 insufficient scope | `FORBIDDEN` | user did not approve Search Console |
| 403 / 404 on a site | `PROPERTY_NOT_ACCESSIBLE` | access removed or never verified; connection stays usable |
| 429, 403 quota reasons | `PROVIDER_RATE_LIMITED` (retryable, `retryAfterSeconds`) | up to 2 short retries; long Retry-After is reported, not waited out |
| 403 API not enabled | `PROVIDER_CAPABILITY_UNAVAILABLE` | server configuration, not the user's fault |
| 400 | `INVALID_QUERY` | |
| 5xx, timeout, network, malformed body | `PROVIDER_UNAVAILABLE` (retryable) | |

## Needs live verification (cannot be proven with mocks)

These are the assumptions encoded from documentation and memory. Verify each once a Google client exists:

1. `sites.list` response shape and the exact `permissionLevel` values; that `siteRestrictedUser` can query; that unverified sites are listed but fail on query.
2. Error reasons/statuses for quota (`rateLimitExceeded`, `quotaExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`), disabled API, and insufficient scope; real `Retry-After` behavior.
3. `searchAnalytics.query` request fields: `searchType`, `dataState`, `dimensionFilterGroups`, `rowLimit` max 25,000, `startRow`; that 25,000 in one request is accepted for all dimension sets.
4. `searchAppearance` must be queried alone; Discover/Google News dimension support (only `query` is rejected here; other dimension support is unverified).
5. Filter semantics: country alpha-3 casing, device values, RE2 regex limits, whether contains works on all dimensions we allow.
6. `responseAggregationType` values and `metadata.first_incomplete_date` format and meaning with `dataState=all`.
7. Date semantics (Pacific Time) and the 16-month retention edge, plus how many days "final" lags.
8. Domain-property vs URL-prefix `siteUrl` URL-encoding in the path.
9. Whether one OAuth grant with both scopes (`include_granted_scopes`) works for GSC and GA4 on the same account.
10. Real-API quota behavior under the per-user concurrency limit (`MAX_MCP_CONCURRENT_REPORTS_PER_USER`).

Not built yet: pagination beyond one page (`startRow` > 0), persisting reports in the Postgres cache, GA4 (next integration), a UI for choosing among many properties.
