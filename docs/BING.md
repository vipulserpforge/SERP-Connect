# Bing Webmaster Tools

Read-only access to a customer's Bing Webmaster Tools data, next to Google Search Console, GA4 and Clarity. Bing is its own provider: its numbers are never merged with Google's.

**Status (27 Oct 2026):** run against one real property (`serpforge.io`, API key) with `pnpm bing:check --yes`: **31 of 32 read methods answered**; `GetSiteMoves` answers HTTP 404 on both Bing hosts. Reports marked "yes" below were read with real rows by this code; "empty" means the call works but this property had no data, so the row shape was not seen; the warnings `UNVERIFIED_REPORT` and `UNDOCUMENTED_SHAPE` stay on those. OAuth login and token renewal are still not tested live. `PROVIDER_BING_ENABLED` must be `true` on **both** the web app and the MCP server.

**Live findings that changed the code (27 Oct 2026):** (1) Bing rejects the JSON-quoted argument form shown in Microsoft's samples (`query=%22blue widgets%22`): addresses fail with `SiteUriSchemeIsNotSupported` / `InvalidUrl` and keyword arguments with `InvalidParameter`. Every string argument is now sent bare. (2) `GetKeyword` / `GetRelatedKeywords` take plain `YYYY-MM-DD` dates; the `/Date(ms)/` form is rejected. (3) `GetKeyword` sends no `Date`, and sends `Query: null` when Bing has no data for the keyword. (4) `GetCrawlSettings` sends `CrawlBoostAvailable`, `CrawlBoostEnabled` and `CrawlRate` (24 numbers), not the `AjaxEnabled` in Microsoft's sample. (5) `GetFeeds` `Status` is free text (`Success`, `403 (Forbidden)`, `The feed was empty.`) and `Type` is `Sitemap`, `Sitemap Index` or empty.

## What it can do (capability matrix)

Sources: Microsoft's Bing Webmaster documentation (`learn.microsoft.com/en-us/bingwebmaster/` and the `IWebmasterApi` reference), read 19 and 26 Oct 2026. SOAP and POX are retired by Microsoft and are never used; everything is the JSON/REST API, GET only. The same table lives in code: `packages/provider-bing/src/constants.ts` (`BING_CAPABILITIES`, `BING_READ_METHODS_NOT_COVERED`).

| `report` | Bing method | Needs | Live-verified | Notes |
|---|---|---|:-:|---|
| (sites) | `GetUserSites` | | yes | Only `Url` and `IsVerified` are kept; ownership codes are dropped. |
| `traffic` | `GetRankAndTrafficStats` | | yes | Daily. Takes no date range: Bing returns the whole series, this app filters it. |
| `queries` | `GetQueryStats` | | yes | **Weekly**; recent days are normally missing. |
| `crawl` | `GetCrawlStats` | | yes | Daily, last 6 months. |
| `pages` | `GetPageStats` | | yes | Weekly. Microsoft's return type is `QueryStats`; its sample puts the page URL in `Query`. |
| `query_pages` | `GetQueryPageStats` | `query` | yes | Pages for one query. |
| `page_queries` | `GetPageQueryStats` | `page` | yes | Queries for one page. |
| `query_page_detail` | `GetQueryPageDetailStats` | `query`, `page` | yes | Daily detail incl. `Position`. |
| `crawl_issues` | `GetCrawlIssues` | | empty | `Issues` is a flags number; decoded names, unknown bits reported raw. |
| `blocked_urls` | `GetBlockedUrls` | | empty | Microsoft shows no sample for this method; fields come from the `BlockedUrl` object. |
| `crawl_problems` | issues + blocked + latest `GetCrawlStats` day | | no | Composite; a failing part is reported, an auth failure is not hidden. |
| `inbound_links` | `GetLinkCounts` | | empty | Paged (page 0..TotalPages-1). Max 5 pages per call; a longer list is flagged partial. |
| `url_links` | `GetUrlLinks` | `url` | empty | Linking pages and anchor text. |
| `sitemaps` | `GetFeeds` | | yes | Sitemap/feed status. |
| `url_info` | `GetUrlInfo` | `url` | yes | `domain:example.com` works as a prefix (Microsoft). |
| `url_traffic` | `GetUrlTrafficInfo` | `url` | yes | |
| `submission_quota` | `GetUrlSubmissionQuota` | | yes | Reads the quota only. |
| `keyword_stats` | `GetKeywordStats` | `keyword` | partly | Bing-wide volume, not the site's traffic. `us` / `en-US` work (defaults, disclosed in `warnings`); other values are undocumented. A site's own niche queries often return nothing; `seo` returned 25 weekly rows. |
| `query_traffic` | `GetQueryTrafficStats` | `query` | yes | Daily clicks and impressions for one **top** query (Microsoft: only top queries are saved). |
| `children_url_info` | `GetChildrenUrlInfo` | `url`, `pageNumber` | empty | **The only POST** (JSON body, filters sent as Any). Returned an empty list for the site root, a folder and `domain:` on this property: Bing treated the root as one page with no children. |
| `children_url_traffic` | `GetChildrenUrlTrafficInfo` | `url`, `pageNumber` | empty | Same as above. Page through with `pageNumber`; an empty page is the end. |
| `crawl_settings` | `GetCrawlSettings` | | yes | 24 crawl-rate numbers (what each position means is not documented) plus `CrawlBoostAvailable` / `CrawlBoostEnabled` in metadata. |
| `feed_details` | `GetFeedDetails` | `feedUrl` | yes | Details for a sitemap index. |

Site settings and market data (`get_bing_site_settings`, `query_bing_keywords`):

| `report` | Bing method | Live-verified | Notes |
|---|---|:-:|---|
| `blocked_urls` | `GetBlockedUrls` | empty | Also in `query_bing_report`. |
| `deep_link_blocks` | `GetDeepLinkBlocks` | empty | No published response shape; fields shown as Bing sends them (`shape: unverified`). |
| `page_preview_blocks` | `GetActivePagePreviewBlocks` | empty | Same. |
| `country_region_settings` | `GetCountryRegionSettings` | empty | Same. |
| `query_parameters` | `GetQueryParameters` | empty | `Parameter`, `IsEnabled`, `Source` (enum number, passed through), `Date`. |
| `connected_pages` | `GetConnectedPages` | empty | No published response shape. |
| `site_moves` | `GetSiteMoves` | **no: HTTP 404** | Bing's JSON API answers 404 for this method on `ssl.bing.com` and `www.bing.com`, so it returns an error. Kept so it works if Bing enables it. |
| `site_roles` | `GetSiteRoles` | yes | Other people's emails and roles are returned (by design); `DelegatedCode` is dropped at the parse boundary. Only `Role` 2 = ReadWrite is named in Microsoft's sample; this property also returned 0 for four users, passed through unnamed. Needs `includeAllSubdomains` (default false). |
| `submission_quota` | `GetUrlSubmissionQuota` | yes | Also in `query_bing_report`. |
| `content_submission_quota` | `GetContentSubmissionQuota` | yes | Reads only. |
| `keyword_stats` | `GetKeywordStats` | partly | Also in `query_bing_report`. |
| `keyword` | `GetKeyword` | yes | One object: `Query`, `Impressions`, `BroadImpressions`, **no date**. `Query` is `null` when Bing has no data; the row then carries the keyword you asked about and a `KEYWORD_NO_DATA` warning. Defaults to the last 30 days. |
| `related_keywords` | `GetRelatedKeywords` | yes | Up to 100 related keywords with impressions, no date. Defaults to the last 30 days. |

Keyword reports need no site. They go through the user's own Bing connection: pass `propertyId` (any of their Bing sites) or the first enabled Bing site is used. Another customer's site can never be used.

**Not covered, and why:** `GetFetchedUrls` / `GetFetchedUrlDetails` (only exist if the connector starts a fetch, which is a write), the obsolete `GetDeepLink*`, and anything that is not in the API: country / device / search-appearance breakdowns, AI Performance, Copilot citations and Site Scan. Every other read method in `IWebmasterApi` is now exposed.

**Suggested write actions (not built, listed only):** `SubmitUrl` / `SubmitUrlBatch` (ask Bing to index pages now), `SubmitFeed` (submit a sitemap), `SubmitContent`, `AddSite` / `RemoveSite` / `VerifySite`, `SaveCrawlSettings`, `SubmitSiteMove`, `AddBlockedUrl` / `RemoveBlockedUrl`, and the query-parameter add/remove/enable methods. This connector is read-only and the OAuth scope `webmaster.manage` is never requested. The same list is in code (`BING_SUGGESTED_WRITES`) and in `get_supported_metrics`.

**What the Bing Webmaster web UI shows that the API does not expose:** the public `IWebmasterApi` has **no country, device or search-appearance methods** (there is no `GetCountryStats`), so the country split, device split and search-type filters in the Search Performance screen cannot be reproduced here. IndexNow submission history and the SEO / Site Scan reports are also not in the API. If a user asks for a Bing country or device breakdown, the honest answer is that Bing does not provide it through its API.

## How customers connect

Each customer connects their own Bing account. Two explicit methods, stored per connection (never mixed, never a silent fallback):

1. **Connect with Bing (OAuth 2.0, recommended).** Authorization-code flow, scope `webmaster.read` only. Needs the operator's OAuth client (below).
2. **Bing API key.** The customer pastes their own key. It is validated, encrypted at rest and never shown again. Generate it in Bing Webmaster Tools: **Settings → API Access → API Key** (it is tied to the user who generated it, so the user must have access to the sites). To **rotate**: generate a new key there, then use *Replace key* on the dashboard; the old key can then be regenerated/discarded at Bing.

Switching a connection between the two methods is an explicit button; the old secret is replaced.

After connecting, press **Refresh sites**. Only sites Bing reports as verified are stored; unverified ones are listed as skipped. Each stored site has a "Visible to Claude" switch (on by default). The app never claims a site is verified unless Bing says so.

## Operator setup (OAuth only; skip if you only offer API keys)

1. Sign in at <https://www.bing.com/webmasters>, open **Settings → API Access → OAuth Client** and create a client (follow Microsoft's page `bingwebmaster/getting-access`).
2. Register the redirect URI **exactly**: `https://<your-web-app-domain>/api/oauth/bing/callback` (and `http://localhost:3000/api/oauth/bing/callback` for local testing, if Microsoft allows it for your client).
3. Put the values in the host's secret store / `.env.local`, **never in chat or git**:

| Variable | App | Secret? | Notes |
|---|---|---|---|
| `BING_CLIENT_ID` | web + MCP | no | |
| `BING_CLIENT_SECRET` | web + MCP | **yes** | server-side only; never `NEXT_PUBLIC_` |
| `BING_REDIRECT_URI` | web | no | optional; defaults to `<NEXT_PUBLIC_APP_URL>/api/oauth/bing/callback` |
| `CREDENTIAL_FINGERPRINT_KEY` | web + MCP | **yes** | needed to save API keys (same key as Clarity) |
| `PROVIDER_BING_ENABLED` | web + MCP | no | `true` only after the live check passes |

The MCP server needs the OAuth variables too, because it renews expired access tokens. Without the client, OAuth is hidden/unavailable and API keys still work.

## Database

Migration `supabase/migrations/20261019160000_bing_webmaster.sql` (applied to the project on 19 Oct 2026): adds `provider_connections.auth_method`, lets `oauth_states` serve Bing (no PKCE, because Microsoft documents none) and bind a reconnect to its connection. Run `pnpm test` to re-verify it against all migrations.

## Security design

- OAuth `state`: random, stored only as a hash, single use, 10-minute expiry, bound to the signed-in user (and to the connection when reconnecting). A Google state cannot complete a Bing flow and vice versa. The code exchange happens on the server only; denied, malformed, expired, replayed and mismatched callbacks end in a short fixed error code on the dashboard, never upstream text.
- Tokens and API keys use the same envelope encryption as Google credentials, bound to user + connection. Decrypted just in time, never logged, audited, cached or returned.
- Token renewal: one refresh at a time per connection (and a compare-and-swap across instances). A refresh response without a new refresh token keeps the old one. A revoked/expired grant marks the connection **needs attention** and stops retrying; a temporary outage or our own misconfigured client does not.
- Every operation re-checks that the connection and site belong to the signed-in user. Another customer's site looks identical to a non-existent one.
- Bing and Supabase identities are unrelated: the Bing connection is just a row owned by the Supabase user id.
- Disconnect deletes the secret and cached reports immediately. **Microsoft documents no token-revocation endpoint**, so the customer should also remove the app's access in their Microsoft/Bing account if they want the grant gone at Bing.

## Data semantics

- Bing counts clicks, impressions and positions its own way and includes more surfaces than classic web search. **Do not add or compare Bing and Google numbers 1:1.** Every response is labelled as Bing; the MCP tool descriptions say so.
- Dates arrive as `/Date(ms±hhmm)/`; the app reads them as the calendar date in Bing's own offset. `lastDays` windows are resolved in UTC.
- Missing values stay missing (never turned into 0). An empty list means Bing reported nothing.
- Results are cached for 6 hours per user, connection, site, report and parameters. Failures (including auth failures) are never cached; when Bing is down, saved results are served marked as stale.
- **No invented limits:** Bing publishes no numeric request quota. On a throttle (HTTP 429 or error codes 4/5) the app waits for `Retry-After` (up to 4 s) and retries within bounds, then returns a clear "rate limited, try later" error.

## MCP tools (read-only)

- `get_connection_status`: includes Bing with `authMethod`, `providerEnabled` (false when the server has Bing switched off) and a plain-English `note` when the key was rejected or the provider is off.
- `list_bing_sites`: the verified, enabled sites.
- `query_bing_report`: `report` (see the matrix), optional `lastDays` or `startDate`+`endDate`, `compare` (previous period of the same length, percent change), `aggregate` (default true: one row per query/page with CTR and average position), `contains`, `minImpressions`, `maxCtr`, `onlyDeclining`, `mergeUrlVariants`, `sortBy` (`date`, `clicks`, `impressions`, `ctr`, `position`, `clicksChange`, `impressionsChange`, `count`), `limit`, plus `query` / `page` / `url` / `keyword` / `country` / `language` where the report needs them. Arguments cannot name a user or connection.
- `get_bing_site_settings`: `propertyId`, `report` (`blocked_urls`, `deep_link_blocks`, `page_preview_blocks`, `country_region_settings`, `query_parameters`, `connected_pages`, `site_moves`, `site_roles`, `submission_quota`, `content_submission_quota`), `includeAllSubdomains` (site_roles), `contains`, `limit`. Snapshots, no dates.
- `query_bing_keywords`: `report` (`keyword_stats`, `keyword`, `related_keywords`), `keyword`, optional `propertyId`, `country`, `language`, `startDate`+`endDate` or `lastDays`, `limit`. Bing-wide market data.
- `get_bing_insights`: presets `top_queries`, `top_pages`, `low_ctr_queries`, `declining_pages` (default 14 days vs the 14 before), `crawl_problems`, `top_inbound_links`, `sitemap_status`. Each is a `query_bing_report` call with defaults, so it shares the cache, rate limits and checks.
- `get_supported_metrics` (`provider: "bing"`): every report with its Bing method, the tool that serves it, granularity (daily / weekly / snapshot), freshness, whether it is verified live and whether its shape is documented, the presets, the methods not covered and the writes that were deliberately not built.

Every answer has: a plain-language `summary` that says it is Bing data, `rows`, `totals`, `comparison` (when asked), `warnings` and a suggested `nextStep`. `providerMetadata.granularity` says daily, weekly or snapshot, and `providerMetadata.pagination` gives `rowsFound`, `rowsReturned`, `limit` (default 100), `hasMore` and a hint to narrow (`contains`, dates, `minImpressions`) or, for the children reports, which `pageNumber` to ask for next.

**Normalization:** dates are ISO days (Bing's `/Date(ms±hhmm)/` read in its own offset); `ctr` = clicks / impressions (null when impressions are 0 or missing); `avgPosition` = Bing's `AvgImpressionPosition` weighted by impressions, `avgClickPosition` weighted by clicks; page addresses that differ only by trailing slash, `#anchor`, query string, default port or host case are merged (`mergeUrlVariants`, on by default, reported in `warnings`); Bing's yes/no fields become `"yes"`/`"no"`; a missing value stays `null`, never 0.

**Warnings you can get:** `UNVERIFIED_REPORT`, `INCOMPLETE_RECENT_DATA` (Bing's newest row is well before the end of the window), `MISSING_DAYS`, `WEEKLY_DATA` (window under 14 days for a weekly report), `LOW_VOLUME` (under 100 impressions), `URL_VARIANTS_MERGED`, `COMPARISON_UNAVAILABLE`, `WINDOW_DEFAULTED`, `LINK_PAGES_LIMIT`, `PART_UNAVAILABLE`, `ASSUMED_LOCALE`, `ROW_LIMIT_REACHED`, `EMPTY_RESULT`, `NO_ROWS_IN_WINDOW`, `STALE_CACHE`, `UNDOCUMENTED_SHAPE` (Microsoft publishes no response sample for the method), `CRAWL_RATE_SLOTS`, `KEYWORD_NO_DATA`.

**Reliability:** retries with backoff, per-user and per-connection rate limits, a 6-hour per-user cache, serving the last saved result (marked stale) when Bing is down, and structured logs (`report.executed`, `report.served_stale`) that never contain keys or tokens all live in the shared reporting layer.

## Live checklist (you do this; mocks cannot prove it)

1. Add `BING_TEST_API_KEY=<your key>` (and optionally `BING_TEST_SITE=https://serpforge.io/`) to `.env.local` (never in chat), run `pnpm bing:check --yes` (add `--show-rows` to print up to 2 rows per method). It makes about 40 read-only requests (every method this connector uses, with a real page, query and sitemap picked from your own data) and prints a method / works-or-fails / field-notes table, never the key. Delete the key afterwards.
2. If it passes, the API-key path is verified for your account. Paste the *printed output* (not any key) back so each PASS can be added to `LIVE_VERIFIED_REPORTS`; a FAIL with `bad_response` means Bing's real shape differs from Microsoft's sample and the parser needs a one-line change.
2b. Cross-check totals against the Bing Webmaster UI: Search Performance > last 28 days > clicks and impressions should match `query_bing_report` `traffic` for the same days (small differences on the newest days are expected: Bing's data lags).
3. Create the OAuth client, set the env vars, restart, and press **Connect with Bing** with a test account. Confirm the sites appear and a traffic report loads.
4. Wait for the access token to expire (about an hour) and load a report again. This proves renewal works.
5. Then set `PROVIDER_BING_ENABLED=true` in both apps.

## Known limitations (unverified until step 1-4 pass)

- **Token renewal:** Microsoft's table says `grant_type=authorization_code` for refreshing, while its sample and RFC 6749 use `refresh_token`. The app sends `refresh_token`. Step 4 confirms it.
- **Hosts:** API-key calls go to `ssl.bing.com` (documented), OAuth calls to `www.bing.com` (the only documented example). Whether Bing accepts both credentials on both hosts is not documented.
- No documented PKCE, no revocation endpoint, no numeric quota, no site-level "verified" detail beyond `IsVerified`.
- Reports marked "empty" in the matrix answered correctly but this property had no data, so their row shape was not seen (they still warn `UNVERIFIED_REPORT` / `UNDOCUMENTED_SHAPE`). Run the check on a property that has crawl issues, inbound links, blocked URLs or folders to close them.
- Arguments are sent bare. Microsoft's samples show JSON-quoted strings; the live API rejects them (see the status note above).
- `GetCrawlIssues` flag numbers: Microsoft's sample shows only 32 = ContainsMalware; the other names are decoded from the crawl-statistics categories and unknown bits are shown raw.
- Query and page data is weekly and its row counts per call are not documented; no country, device or search-appearance data exists in the API.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Claude says Bing is "switched off on this server" / `get_supported_metrics` fails although `get_connection_status` shows the account connected | `PROVIDER_BING_ENABLED` is missing or `false` on the **MCP server** (and the web app). A missing line counts as `false`. Add `PROVIDER_BING_ENABLED=true` to `mcp.env` on the VPS and to Vercel, then restart/redeploy. `get_connection_status` now shows `providerEnabled: false` and a note when this is the cause. |
| "Bing rejected the stored access" | API key: generate a new one in Bing Webmaster Tools under Settings > API Access and use **Replace key**. OAuth: press **Reconnect**. |
| "Connecting with a Bing login is not set up" | `BING_CLIENT_ID`/`SECRET` missing. Use an API key or configure the client. |
| Redirect back with an error code | Redirect URI at Bing differs from the one the app sends (must match exactly, incl. https and trailing slash). |
| "Bing rejected the authorization code" | Codes work once and expire in minutes. Start again. |
| Connection says **needs attention** | The key was regenerated/revoked or the grant was removed. Press Reconnect / Replace key. |
| Connected but no sites | No verified site on that Bing account. Verify one in Bing Webmaster Tools, then Refresh sites. |
| Empty query report | Query data is weekly; or the site has no Bing traffic yet. |
| "Rate limited" | Bing throttled the account. Wait a few minutes; results are cached for 6 hours. |
| API key rejected on save | Keys are letters and digits only; check for spaces or a truncated copy. |
