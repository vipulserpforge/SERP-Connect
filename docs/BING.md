# Bing Webmaster Tools

Read-only access to a customer's Bing Webmaster Tools data, next to Google Search Console, GA4 and Clarity. Bing is its own provider: its numbers are never merged with Google's.

**Status: built and tested against a local fake of Bing. Not yet verified against the real Bing API.** `PROVIDER_BING_ENABLED` stays `false` until you pass the live check below.

## What it can do (capability matrix)

Sources: Microsoft's Bing Webmaster documentation, read 19 Oct 2026 (`learn.microsoft.com/en-us/bingwebmaster/`). SOAP and POX are retired by Microsoft and are never used; everything is the JSON/REST API, GET only.

| Feature | Endpoint | Status | Notes |
|---|---|---|---|
| List sites | `GetUserSites` | **Enabled** (documented) | Only `Url` and `IsVerified` are kept. Ownership codes in the response are dropped at the boundary. |
| Daily clicks and impressions | `GetRankAndTrafficStats` | **Enabled** (documented) | Updated daily. Takes no date range: Bing returns its whole series and this app filters it. |
| Search queries | `GetQueryStats` | **Enabled** (documented) | Updated **weekly**, so recent days are normally missing. No date range. |
| Crawl and index statistics | `GetCrawlStats` | **Enabled** (documented) | Updated daily, last 6 months. |
| Traffic by page | `GetPageStats` | **Disabled, unverified** | Microsoft's sample response is labelled as query data and shows no page field. Enable only after the real shape is confirmed. |
| Inbound links | `GetLinkCounts` | **Disabled, unverified** | Meaning of the `page` parameter is not documented. |
| Submit URLs/sitemaps, add/remove sites, settings | various | **Out of scope** | This connector is read-only. The write scope (`webmaster.manage`) is never requested. |

The same table lives in code: `packages/provider-bing/src/constants.ts` (`BING_CAPABILITIES`).

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

`get_connection_status` (includes Bing, with method and health), `list_bing_sites`, `query_bing_report` (`report` = `traffic` | `queries` | `crawl`, optional `lastDays` or `startDate`+`endDate`, `sortBy`, `limit`). Arguments cannot name a user or connection.

## Live checklist (you do this; mocks cannot prove it)

1. Add `BING_TEST_API_KEY=<your key>` to `.env.local` (never in chat), run `pnpm bing:check --yes`. It makes up to 4 read-only GETs, prints PASS/FAIL per endpoint and the date range returned, never the key. Delete the key afterwards.
2. If it passes, the API-key path is verified for your account. Also check that `PASS` lines show non-empty traffic for a site you know has traffic; if the shape differs, paste the *printed output* (not any key) back to me.
3. Create the OAuth client, set the env vars, restart, and press **Connect with Bing** with a test account. Confirm the sites appear and a traffic report loads.
4. Wait for the access token to expire (about an hour) and load a report again. This proves renewal works.
5. Then set `PROVIDER_BING_ENABLED=true` in both apps.

## Known limitations (unverified until step 1-4 pass)

- **Token renewal:** Microsoft's table says `grant_type=authorization_code` for refreshing, while its sample and RFC 6749 use `refresh_token`. The app sends `refresh_token`. Step 4 confirms it.
- **Hosts:** API-key calls go to `ssl.bing.com` (documented), OAuth calls to `www.bing.com` (the only documented example). Whether Bing accepts both credentials on both hosts is not documented.
- No documented PKCE, no revocation endpoint, no numeric quota, no site-level "verified" detail beyond `IsVerified`.
- `GetPageStats` and `GetLinkCounts` are disabled until their real behaviour is known.
- Query data is weekly; row counts per call are not documented.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Connecting with a Bing login is not set up" | `BING_CLIENT_ID`/`SECRET` missing. Use an API key or configure the client. |
| Redirect back with an error code | Redirect URI at Bing differs from the one the app sends (must match exactly, incl. https and trailing slash). |
| "Bing rejected the authorization code" | Codes work once and expire in minutes. Start again. |
| Connection says **needs attention** | The key was regenerated/revoked or the grant was removed. Press Reconnect / Replace key. |
| Connected but no sites | No verified site on that Bing account. Verify one in Bing Webmaster Tools, then Refresh sites. |
| Empty query report | Query data is weekly; or the site has no Bing traffic yet. |
| "Rate limited" | Bing throttled the account. Wait a few minutes; results are cached for 6 hours. |
| API key rejected on save | Keys are letters and digits only; check for spaces or a truncated copy. |
