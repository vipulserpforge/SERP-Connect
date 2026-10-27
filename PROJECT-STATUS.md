# Project Status

**Last updated:** 19 October 2026
**Current phase:** Phase 8 (Google Cloud setup guide and OAuth readiness tooling) over Phase 7 (whole-system verification) over Phase 6 (remote MCP server with OAuth) built on Phase 5 (shared reporting layer) built on Phase 4 (GA4 integration, mock APIs), Phase 3 (Search Console) and Phase 2 (secure credential management), and tested locally with mock Google. **Migrations 1-4 were applied to your Supabase project (`dphftsifxfhxbhtgabso`) on 19 Oct 2026 via the Supabase connection.** Supabase's advisors report no warnings: only INFO notes (server-only tables intentionally have RLS but no policies; unused indexes on an empty database; two composite foreign keys on `mcp_profile_properties` could get covering indexes later). Google Cloud / OAuth is still not configured (deliberately the final phase).

## Production-readiness review (21 Oct 2026)

Hosting target is now **web dashboard on Vercel + MCP server on a private VPS**: guide [`docs/mcp-web.md`](docs/mcp-web.md), files `apps/web/vercel.json` and `deploy/vps/`. Open items that need a person are in [`ISSUES.md`](ISSUES.md). **Nothing has been deployed to Vercel or a VPS, so the app is not declared production-ready.** Verified locally on Node 24: typecheck, lint, 785 unit tests, production builds of both apps, 52 + 45 end-to-end tests, the MCP server under PM2 with production settings, and the database connection (IPv4 pooler, verified TLS) against your real Supabase project (read-only).

Found and fixed: the audience-hook migration broke 9 test files (it granted to a Supabase-only role); three Clarity tests only passed on 19 Oct because of a mixed frozen/real clock; the database host in `.env.local` is IPv6-only (Vercel cannot reach it) so the deployment settings now use the pooler; database TLS verification (was off); Vercel function time limits; security headers; request rate limiting on the MCP front door; unused dependencies; no linter (ESLint added and wired into CI).

## Earlier hosting decision: Hostinger Cloud plan

This was the first plan (two Node.js Web Apps on a Hostinger Cloud plan); its step-by-step guide has been removed in favour of [`docs/mcp-web.md`](docs/mcp-web.md) (Vercel + VPS). The technical summary stays in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Nothing was ever successfully deployed to Hostinger (the first build stopped on a pnpm version clash, now fixed).
- Added `scripts/start-web.mjs` and `scripts/start-mcp.mjs` (Hostinger runs one root directory and an entry file; this is a monorepo). Both default `NODE_ENV` to production so the mock-mode safeguards cannot be skipped. Verified locally: both start the built apps (web serves `/`, `/privacy`, `/api/health`; MCP serves `/healthz` and the OAuth metadata), and tests show the MCP script refuses mock modes without `NODE_ENV`.
- Unverified on Hostinger itself: building with the repository root as the root directory, Hostinger's pnpm version, port handling, domain attachment, number of Web Apps allowed on your plan, and cold starts after idle (Hostinger stops idle apps; Claude's connection step allows about 10 seconds).
- Your latest work is **not committed or pushed** to GitHub yet; Hostinger deploys from GitHub, so that is the next prerequisite.

## Phase 9: Microsoft Clarity integration (19 Oct 2026)

**Status: built and verified with mocks. NOT yet verified against the real Clarity API, so it is not marked production-ready.** Full details: [`docs/CLARITY.md`](docs/CLARITY.md). (There is no `DEPLOYMENT-GUIDE.md`; deployment steps live in `docs/DEPLOYMENT.md` and `docs/mcp-web.md`.)

Done:
- Official Data Export API client (rolling 24/48/72 h, up to 3 dimensions, 1,000-row cap, 10 requests/day), validated, normalised, with 400/401/403/429/5xx/network/timeout handling and no automatic retries (each would cost quota).
- Customer connection form: encrypted token (existing envelope encryption), no test call on save, "Awaiting verification" until a real request succeeds, rename / replace token / remove with confirmation.
- Durable, concurrency-safe daily budget in Postgres (local 8 of 10), 6 h cache, single-flight, stale fallback, "tracked by this app" quota panel.
- Dashboard report page (`/dashboard/clarity`) reading saved results; fetching only on an explicit button.
- Read-only MCP tools: `list_clarity_projects`, `get_clarity_insights`, `get_clarity_quota_status` (plus existing status/metrics tools).
- Migration `20261019150000_clarity_quota_reservations.sql` **applied to your Supabase project**.

Test results: `pnpm test` 674 passed (33 files); `pnpm test:e2e` 49 passed + 3 skipped (default) and 42 passed (Postgres pass). All use mocks; no Clarity quota is spent.

Your remaining actions:
1. Create `CREDENTIAL_FINGERPRINT_KEY` (command in `docs/CLARITY.md`) and set it in `.env.local` and in both Hostinger env files (same value). Without it, saving a Clarity token is refused in production.
2. Run `pnpm clarity:check --yes` with your own token (uses 1 of 10 daily requests) and tell me what it prints.
3. After deploying, connect a real token in the dashboard, press Verify, fetch a view.

Known limitations: quota count is app-tracked only; reset time (assumed UTC day) and failure accounting are undocumented by Microsoft; different tokens for one Clarity project are counted separately; metric names/meanings beyond Microsoft's sample are unverified; tokens cannot be revoked from the app.

## Phase 8: Google Cloud setup and OAuth readiness

Guide: [`docs/GOOGLE-SETUP-SIMPLE.md`](docs/GOOGLE-SETUP-SIMPLE.md) (developer reference in its Part 12). Deployment: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**No Google Cloud project, OAuth client or credentials exist yet, and no real Google sign-in, token exchange, property discovery or report has been run.** The step-by-step guide is written from Google's current documentation (pages cited in the guide); I could not sign in to Google, so console clicks are unobserved.

What was done:
- Derived the callback from the code: the only OAuth route is `/api/oauth/google/callback`; redirect URI = `GOOGLE_REDIRECT_URI` or `NEXT_PUBLIC_APP_URL` + that path. Local: `http://localhost:3000/api/oauth/google/callback`. One operator-owned Web-application client serves all customers; no JavaScript origins needed.
- Found that the **MCP server also needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and the same `SECRET_KEYS`** (it refreshes tokens); documented.
- `pnpm google:check [--probe] [--secret]`: validates config (never prints the secret), prints the exact redirect URI, and optionally asks Google whether the client id/redirect URI/secret are accepted. Run against real Google with a nonexistent client it correctly reported `invalid_client`. The success path is untested until a real client exists; the redirect-URI probe relies on observed (undocumented) Google behaviour.
- Fixed a real bug: blank variables (as in the copied `.env.example`) crashed startup; blank now means unset (test added).
- Added a public `/privacy` page (a DRAFT written from the code's behaviour, linked from the home page) because verification requires it; it needs your review and `SUPPORT_EMAIL`.
- `.gitignore` now also blocks `client_secret*.json` and service-account key files.
- New tests: 19 checker/probe tests; `tests/e2e/google-live-config.e2e.ts` (built app in `DATA_MODE=live` with a placeholder client: exact redirect URI, scopes, PKCE, state, denial/forged state, no secret in pages/logs/redirects, fail-closed when unconfigured).

Results of the final run: typecheck pass; `pnpm build` pass; `pnpm test` **596 pass** (29 files); `pnpm test:e2e` **41 pass + 3 skipped** (in-memory pass) and **36 pass** (Postgres pass).

You still need to (nothing below is done): create the project, enable the three APIs, configure the consent screen and test users, create the client, put the id/secret into `.env.local` (and later the host secret stores), run `pnpm google:check --probe --secret`, then connect a real test account from the dashboard. Decision: the consent screen will be **External** (guide: `docs/GOOGLE-SETUP-SIMPLE.md`; start in Testing with test users, then publish and verify). Open question for you: Google's console marks whether the two scopes are "sensitive"; if they are, publishing needs verification (demo video, justification, domain verification, reviewed privacy policy; Google says 3-5 business days), and until then Testing mode limits apply (100 test users, 7-day token expiry).

## Phase 7: whole-system verification

Method and data sources: [`docs/TESTING.md`](docs/TESTING.md). **Everything below was verified with mock or fake data. Nothing was verified against real Google APIs, a real Supabase Auth server, or a real Claude connector.**

Results of a clean rebuild on 19 Oct 2026:

| Check | Result |
|---|---|
| `pnpm typecheck` (all packages and both apps) | pass |
| `pnpm build` (web production build, MCP server `dist`, all packages) | pass, no warnings |
| `pnpm test` | **575 pass** (28 files), up from 541 |
| `pnpm test:e2e` | **36 pass** in the in-memory pass (the 3 Postgres-only tests are skipped there), **36 pass** in the Postgres pass (web app only) |
| `pnpm audit --prod` | no known vulnerabilities |

New in this phase:
- `tests/system/`: 34 whole-stack tests: Postgres (real migrations), encrypted credentials, the real Google HTTP clients against a local fake Google, the Postgres report cache, and the MCP server behind signed tokens, with two users who own the same site and GA4 id. Covers connection management, report generation, caching and stale-if-error, token refresh, revoked refresh token, rejected token (401), missing permission (403), quota (429), outage with bounded retries, malformed responses, invalid inputs, disconnect cleanup, and User A vs User B for connections, credentials, reports, cached results, RLS and logs.
- The web e2e suite now also runs against the real `pg` driver (PGlite served over the Postgres wire protocol), asserting actual rows (profiles from the sign-up trigger, encrypted secrets, per-user cache rows, cleanup on disconnect).
- `tests/e2e/mcp-built.e2e.ts` runs the production-built MCP server as a separate process (401 challenge, tool call, production refuses mock modes and unsafe OAuth settings).
- Mutation checks: removing user scoping from property lookup (6 failures) or from the cache lookup (4 failures) is caught.

Product defects found by these tests: **none**. Every failure during development was a mistake in the new tests, which I fixed.

### Outstanding issues (not production-ready)

This application is **not** declared production-ready. Blocking or unverified:
1. **No real Google test.** Google Cloud project, OAuth client, API enablement and a live run with accounts A/B/C are the final phase. Real response shapes, quotas, latency and consent behaviour are unverified.
2. **No real Claude test.** Needs the MCP server on public HTTPS and Supabase's OAuth server (currently disabled), plus an access-token hook to bind tokens to this server (see `docs/MCP.md`).
3. **Real sign-up against your Supabase project is still unverified** (profile row, connection and ciphertext rows). Auth is tested against a fake, the database against PGlite.
4. ~~Remote database TLS does not verify the server certificate~~ **Fixed 21 Oct 2026:** the certificate is verified against Node's roots plus the bundled Supabase root CA (`packages/db/src/supabase-ca.ts`, expires 2031; unit-tested and checked against your real database; no setting can turn the check off).
5. **Key management:** only the local key ring exists; the KMS client is not written.
6. Auth hardening not done: rate limiting/CAPTCHA, password reset page, account deletion.
7. Rate limits, concurrency limits and the Clarity budget are per process (a Postgres-backed Clarity budget is ready in SQL, not wired). No load testing.
8. Clarity and Bing adapters are not implemented. No JavaScript-executing browser tests.
9. No CI run has been observed on GitHub; the workflow in `.github/` has not been run.

## Phase 6: remote MCP server

Details, tools, auth design and production checklist: [`docs/MCP.md`](docs/MCP.md).

- Official SDK, Streamable HTTP, stateless; tools for connection status, GSC/GA4 property lists and queries (plus Clarity placeholder and supported-metrics). Strict inputs, output schemas, one safe error envelope. User identity comes only from the verified token `sub`.
- OAuth resource-server behaviour per the current MCP authorization spec and Claude's connector docs (PRM, 401 challenge, audience/issuer/alg checks, Origin checks, 503 on key outage). Consent page `/oauth/consent` and a connected-apps list with revoke on the dashboard.
- Verified (19 Oct 2026): typecheck, build, 541 unit tests (80 new MCP tests, including an official-SDK client completing the full OAuth flow against a mock server), 33 e2e tests (8 new consent/grant tests), mutation checks for audience, issuer, client_id, scope, Origin and strict inputs.
- **Not verified:** a real Claude connector. It needs a public HTTPS deployment and Supabase's OAuth server, which is currently **disabled** on your project. `pnpm mcp:check` tests a deployment once those exist. Supabase tokens use `aud: "authenticated"`; binding to this server needs an access-token hook (see docs/MCP.md).

## Phase 5: reporting layer

Design, pipeline, settings and limits: [`docs/REPORTING.md`](docs/REPORTING.md). One `ReportService` now serves the dashboard (`POST /api/reports/{gsc|ga4}`) and the MCP server.

| Area | State |
|---|---|
| Requests | Validated with the shared schema; `lastDays` or explicit dates (exactly one form); filters canonicalized (trim, case-fold, de-duplicate, sort) so equivalent requests share a cache entry |
| Time rules | Search Console in Pacific Time, final data ends 2 days back; GA4 in each property's time zone, ends yesterday; 16-month vs 2015 history; time zone is part of the cache hash and returned in `report.period` |
| Cache | Scoped by user, provider, connection, property and request hash (dates, filters, params, time zone); validated key parts; stored-scope check; per-user quota; copies on return; disconnect invalidates. `PgReportCache` on the `report_cache` table (composite FKs) shared by web and MCP when `DB_MODE=postgres` |
| Concurrency | Identical in-flight requests share one upstream call (per scope, never across users); per-user concurrency cap; failures are never cached and never poison later calls |
| Limits | Per-user and per-connection token buckets charged only for upstream calls; `RATE_LIMITED` is retryable with `retryAfterSeconds` (HTTP 429) |
| Timeouts / retries | One overall deadline with abort; bounded retries with backoff for transient failures only; GA4 quota, auth and validation errors never retried |
| Incomplete data | Provider warnings and completeness survive the cache; serves a saved report with `STALE_CACHE` when the provider is down or throttled |
| Fix found on the way | `instanceof ConnectorException` failed across the Next.js bundles and turned expected errors into 500s; replaced with a structural `isConnectorException` everywhere |

Verification (19 Oct 2026, clean): `pnpm -r typecheck` 0 errors; `pnpm build` pass; `pnpm test` **461 / 461** (23 files; +86 in `tests/reporting-layer`: dates and filters, cache isolation, resilience, PostgreSQL cache on PGlite); `pnpm test:e2e` **25 / 25** (+7: session required, cache hit, another customer refused, error statuses, CSRF/content-type/size, GA4 time zone). Mutation checks (cache key without user, flight key without user, stored-scope check removed, copy-on-return removed, retrying quota errors, connection dropped from scope) each failed tests and were restored; two first-round survivors showed test gaps (user isolation hidden by unique ids, shared row arrays) and led to new tests.

**Not verified:** anything against real Google; `PgReportCache` on the hosted Supabase project (tested on PGlite with the same migrations); rate limits, concurrency caps and single flight are per process, so several instances multiply them; the Clarity path only moved to the new cache API. The dashboard has no report screen yet (the endpoint exists).

---

## Phase 4: Google Analytics 4 integration

Details, error table, live-verification checklist and the Google Cloud requirements for later: [`docs/GA4.md`](docs/GA4.md). Built and tested against **mock Analytics Admin and Data APIs**; no Google Cloud project or real account was used.

| Area | State |
|---|---|
| API client | Admin API (`accountSummaries`, `properties.get`) and Data API (`getMetadata`, `checkCompatibility`, `runReport`) over shared Google REST plumbing (timeouts, bounded retry, no redirects, size caps, strict response validation); quota errors are not auto-retried |
| Discovery | On connect and on "Refresh properties": properties with account label and **reporting time zone**, Data API reachability check, roll-ups skipped, user's enable switches preserved |
| Queries | users, sessions, views, events, key events, revenue and custom fields; dimension and metric filters; ordering; `limit`/`offset` pagination |
| Validation | Fields checked against the property's own metadata (with "did you mean"), `checkCompatibility` before reporting, dates checked in the property's time zone |
| Warnings | thresholding, "(other)" row, sampling, restricted metrics, low quota, more rows / next offset, processing delay, non-additive user counts, time-zone mismatch |
| Errors | each Google failure maps to a fixed, readable error; rejected tokens flag the connection; expired tokens refresh transparently; revoked refresh tokens become `AUTH_REVOKED` |
| Wiring | Dashboard (connect, auto-discovery, refresh, messages); MCP `query_ga4_report`; `get_supported_metrics` now returns a property's exact fields; `DATA_MODE=live` composes real credentials for GSC and GA4 |
| Shared | `provider-google/rest.ts` now backs both Search Console and GA4 clients; the mock OAuth account merges grants when a second product is connected |

Verification (19 Oct 2026): `pnpm typecheck` pass; `pnpm build` pass; `pnpm test` **375 / 375** (19 files; +115 for this phase and the shared refactor); `pnpm test:e2e` **18 / 18** (adds connecting GA4 after Search Console on one account in the built app). Three deliberate breakages (skipping the compatibility check, validating dates in UTC, sharing the metadata cache across tenants) each made tests fail, then were restored.

**Needs live verification** (10 items in `docs/GA4.md`): real response shapes and quota bucket names, true compatibility semantics (the mock's rules are an approximation), error reasons, roll-up and sub-property behavior, per-request limits, and the dual-scope grant. Not built: Postgres report cache, comparisons, realtime/cohort reports, GSC-vs-GA4 comparison.

---

## Phase 3: Google Search Console integration

Details, error table and the live-verification checklist: [`docs/GSC.md`](docs/GSC.md). Built and tested against a **mock Search Console API**; no Google Cloud project or real account was used.

| Area | State |
|---|---|
| API client | REST client for `sites.list` and `searchAnalytics.query` (timeouts, bounded retry on 429/5xx, no redirects, response size cap, strict response validation, error classification from Google's structured reasons only) |
| Discovery | After connecting (and via "Refresh properties") the account's sites are stored for the owner; unverified/malformed sites are skipped and reported; enable switches survive refresh; lost sites are removed; empty accounts get an honest message |
| Queries | clicks, impressions, CTR, position by date/page/query/country/device/searchAppearance, search types, filters, sort, `dataState`; dimension/filter/date validation before any token or network use; correct top-N for non-click sorts |
| Warnings | recent days, fresh data, anonymized queries, page aggregation, row limit, truncated sort, no data |
| Errors | each Google failure maps to a fixed, user-presentable error (auth expired, no scope, no site access, rate limited with retry-after, API disabled, invalid query, unavailable); a rejected token flags the connection for reconnect |
| Wiring | Dashboard (auto-discovery, refresh button, messages); MCP `query_gsc_performance` uses the mock API in mock mode; `DATA_MODE=live` composes real credentials (refuses to start without Postgres, `SECRET_KEYS`, Google client) |
| Database | `Repository.syncDiscoveredProperties` (memory + Postgres, owner-scoped) |

Verification (19 Oct 2026): `pnpm typecheck` pass; `pnpm build` pass; `pnpm test` **260 / 260** (16 files, +103 for this phase); `pnpm test:e2e` **17 / 17** (now also covers connect -> discovery -> refresh -> disconnect in the built app). I broke three things on purpose (top-N ordering, the unverified-site filter, the Postgres ownership check); the tests failed each time, then I restored them.

**Needs live verification** (not provable with mocks; full list of 10 items in `docs/GSC.md`): real `sites.list` and `searchAnalytics.query` shapes, quota and permission error reasons, `searchAppearance`/Discover dimension rules, filter semantics, `dataState` and incomplete-date metadata, and the dual-scope grant. Not built: pagination past one page, Postgres report cache, GA4.

---

## Phase 2: credential management

Full design and the production secrets list: [`docs/SECRETS.md`](docs/SECRETS.md).

| Area | State |
|---|---|
| Encryption (`@serp/secrets`) | Envelope encryption: AES-256-GCM, random key per secret, key-encryption key from a versioned `SECRET_KEYS` ring (or a KMS adapter interface). Ciphertext bound to user + connection; key rotation by re-wrap. Dev uses a throwaway key; production refuses to start without `SECRET_KEYS`. |
| Credential service (`@serp/credentials`) | Store, decrypt, refresh (single-flight + version compare-and-swap), mark `needs_attention` on `invalid_grant`, revoke at Google, delete, rewrap. |
| OAuth flow | Server-initiated PKCE with single-use, user-bound, hashed `state` (new `oauth_states` table, migration 4), scope and `id_token` checks, incremental consent so one Google account can serve GSC and GA4. Callback at `/api/oauth/google/callback`. |
| Google client (`@serp/provider-google`) | Real HTTP client (timeouts, no redirects, no upstream text in errors) plus a mock used whenever `DATA_MODE=mock`. Live mode fails closed until credentials exist. |
| Audit + logging | Allow-listed audit metadata; logger redacts tokens, secrets, verifiers, state, ciphertext, emails, JWT/DB-URL shapes. |
| Dashboard | "Connect Search Console / GA4" (mock account in dev), disconnect now revokes and deletes the secret. |

Verification (clean install, rebuild, 19 Oct 2026): `pnpm typecheck` pass; `pnpm build` pass; `pnpm test` **157 / 157** (13 files); `pnpm test:e2e` **17 / 17**.

Security tests include: ciphertext tamper/wrong-user/wrong-key failures; rotation; refresh races; revoke and delete; replayed, expired and cross-user OAuth state; real SQL on in-process Postgres (compare-and-swap, ownership, cascade, no plaintext in any table, browser roles cannot read secrets or states); HTTP client against a fake token endpoint (error classification, redirect refusal, malformed responses); end-to-end connect/disconnect through the built app, forged callback, `/api/connections` never exposes credential fields; the shipped browser bundle contains no secret variable names; a repo scan for secret-shaped strings and tracked `.env` files; log and audit leak checks.

Issue found by the new e2e test and fixed: the callback route used `instanceof ConnectorException`, which fails across separately bundled packages and showed a generic error; it now checks structurally.

**Not verified:** the app itself has not yet run against the real Supabase project (`AUTH_MODE=supabase`, `DB_MODE=postgres` still need your `.env.local`), and nothing has run against real Google; the live Google client is tested only against a local fake endpoint; the KMS provider only with a fake KMS client (no cloud client written); `getAccessToken` is not yet wired into the MCP report adapters (next phase).

**Production secrets you will eventually need** (no action now): `SECRET_KEYS` (+ optional `SECRET_CURRENT_KEY_VERSION`), `SUPABASE_DB_URL`, Supabase URL and publishable key, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, later MCP OAuth issuer settings. Table with timing in `docs/SECRETS.md`.

---

# Phase 1: database and authentication

## What exists

| Area | State |
|---|---|
| Monorepo | pnpm 12 workspaces, Node 22.12+, TypeScript 5.9 strict, 13 shared packages, 2 apps |
| Database | 3 SQL migrations in `supabase/migrations/` (9 tables, RLS, grants, signup trigger, atomic budget function) |
| Auth (web) | Email + password sign-up, login, logout (global session revocation), email-confirmation callback, protected `/dashboard`, session refresh in `proxy.ts` |
| Data access | `PgRepository` (Postgres, every query scoped by `user_id`) shared by web and MCP server; `MockRepository` for no-credential dev |
| Dashboard | Shows the signed-in email, connections and properties, Enable/Disable-for-Claude toggle and Disconnect (both owner-scoped), Sign out |
| MCP server | Unchanged API; can now use Postgres via `DB_MODE=postgres` (still mock bearer tokens until the OAuth phase) |
| Docs | `docs/SUPABASE-SETUP.md` (how to apply migrations and configure Auth), README, `.env.example` updated |

Modes (all default to mock so nothing needs credentials): `AUTH_MODE=mock|supabase`, `DB_MODE=mock|postgres`, `DATA_MODE=mock|live`, `MCP_AUTH_MODE=mock|oauth`. Production refuses to start with any mock mode unless `ALLOW_MOCK_IN_PRODUCTION=true`.

## Schema summary

`profiles`, `provider_connections`, `provider_secrets`, `properties`, `mcp_connection_profiles`, `mcp_profile_properties`, `report_cache`, `provider_request_budgets`, `audit_events`.

- **Identity separation:** the only SaaS identity is `auth.users.id`. Google accounts are rows in `provider_connections` keyed by the provider's stable subject id, never matched by email. Account A (login), B (GSC) and C (GA4) are three unrelated values.
- **Ownership enforced by the database:** child tables use composite foreign keys `(id, user_id)`, so Postgres itself rejects a property, cache row or profile allowlist entry that points at another tenant's connection.
- **RLS on every table.** Browser roles (`authenticated`) are limited by grants first, then by `auth.uid() = user_id` policies: read-only connections (users cannot forge a "connected" state or edit scopes), property toggle limited to the `enabled_for_mcp` column, full management of their own MCP profiles, read-only audit trail (without the metadata column). `anon` has no access. Secrets, cache and budgets have no client grants or policies.
- Indexes on every foreign key and common filter; `updated_at` triggers; cascading deletes so deleting a user or disconnecting a provider removes secrets, properties and cache.

## Verification (clean rebuild, 19 Oct 2026)

| Check | Result |
|---|---|
| `pnpm typecheck` | Pass |
| `pnpm build` (13 packages, MCP server, Next.js) | Pass |
| `pnpm test` | **74 / 74 pass** (8 files) |
| `pnpm test:e2e` (real built Next.js app + fake Auth server) | **14 / 14 pass** |

What the tests prove:
- **RLS / tenant isolation (27 tests, real migration files on in-process Postgres 17 with Supabase's permissive default grants):** each user sees only their own rows; direct lookups of another tenant's id return nothing; `anon` and a missing JWT claim see nothing; secrets, cache and budgets are unreachable; users cannot insert/update connections, audit rows, `user_id`, or any property column except the toggle; a profile cannot allowlist another tenant's property; a property cannot point at another tenant's connection even for privileged code; one SaaS user can hold two different Google accounts (the A/B/C case); the same Google account cannot be linked twice by one user; cascades work; the daily-budget function never exceeds its limit and is not callable by API roles.
- **Server-side checks (`PgRepository`):** listing, lookup, toggle, disconnect and `authorizeProperty` never cross tenants; foreign ids return the same "not connected" error as unknown ids.
- **Auth flow (end to end):** dashboard and API are blocked when signed out (redirect / 401 envelope); sign-up validates input; unconfirmed, wrong-password and unknown-user logins are indistinguishable; sign-up for an existing email gives the same response as a new one; off-site `next` redirects are ignored; two signed-in users see only their own identity and never the demo data; a forged cookie is rejected; after sign-out a copied cookie no longer works because the Auth server revoked the token; the callback rejects bad codes; logs contain no passwords or tokens.
- **Sanity of the tests themselves:** I deliberately broke a policy and the token revocation; the matching tests failed, then I restored both.

Issues found and fixed this phase:
- The log redactor was hiding any field named `code` (it would have hidden auth error codes); auth logs now use `authErrorCode`.
- Sign-up used the request `Origin` header to build the email link; it now uses the configured `NEXT_PUBLIC_APP_URL` only.
- Two test mistakes (not product bugs) were corrected: a permission error aborts a Postgres transaction, so those checks now use one statement per transaction; and the service now converts validation errors into the shared `INVALID_QUERY` envelope.

## What I could NOT verify (be aware)

- **Nothing has run against your real Supabase project.** Auth was tested against a faithful fake of Supabase Auth, and the database against local Postgres (PGlite). Real-project differences (email delivery, dashboard Auth settings, pooler URL, Supabase's own advisors) are untested until you complete the steps below.
- `supabase/config.toml` is a minimal hand-written file; I could not run the Supabase CLI here (not installed).
- The Postgres driver path (`DB_MODE=postgres` through `pg`) was checked only for safe failure with a bad URL, not against a live server.

## What you need to do next

1. **Apply the migrations** (details in `docs/SUPABASE-SETUP.md`): either `supabase link --project-ref dphftsifxfhxbhtgabso` then `supabase db push`, or paste the four SQL files in order into the SQL editor, or tell me to apply them via the Supabase connection. I did not apply them without your go-ahead.
2. **Dashboard → Authentication → URL Configuration:** Site URL `http://localhost:3000`, redirect URL `http://localhost:3000/auth/callback`. Keep email confirmation on.
3. **Create `.env.local`** with `AUTH_MODE=supabase`, `DB_MODE=postgres`, the project URL, the publishable key and the database URL (never the service-role key in a `NEXT_PUBLIC_` variable).
4. Sign up once manually, then I can run Supabase's security advisors and a live isolation check.

## Decisions to confirm

- Email + password for now; Google *sign-in* (PRD FR-001) waits for the Google Cloud client in the final phase.
- Dashboard writes use a direct database connection with explicit `user_id` scoping, with RLS as the second layer for any Data API access (the TRD permits this; it is why both layers are tested).
- `provider_connections` is read-only from the browser by design; rows are created by server code after verified OAuth callbacks.
- In `AUTH_MODE=mock` the login and signup pages redirect to the dashboard because the demo user is always "signed in".

## Still not done

- Postgres-backed Clarity budget (the `private.consume_provider_budget` function is ready; the app still uses the in-memory version). The report cache is now Postgres-backed.
- A report screen in the dashboard (the `/api/reports/*` endpoint exists); cross-instance rate limits.
- Enabling Supabase's OAuth server, access-token hook for audience, deploying the MCP server, testing with real Claude (see docs/MCP.md); MCP profile UI.
- Rate limiting / CAPTCHA on auth (configure in Supabase before public launch), account deletion UI, password reset page.
- Bing live verification (see Phase 10).
- **Final phase:** Google Cloud project, API enablement, OAuth consent screen/client, redirect URIs, live A/B/C account test, verification.

## Phase 10: Bing Webmaster Tools (19 Oct 2026)

**Built and tested against a local fake of Bing. NOT verified against the real Bing API. Not production-ready until you run the live checklist in `docs/BING.md`.** `PROVIDER_BING_ENABLED` is `false` by default.

What exists: REST-only provider (`packages/provider-bing`), OAuth 2.0 (`webmaster.read`) and API-key connections with an explicit per-connection method, encrypted storage and safe token renewal (`packages/credentials/src/bing.ts`), verified-site discovery, read-only reports (traffic, queries, crawl) through the shared cache/limits/retry layer, MCP tools `list_bing_sites` and `query_bing_report`, a dashboard card and report page, `pnpm bing:check` (manual live test), migration `20261019160000_bing_webmaster.sql` (applied to Supabase; advisors show only the pre-existing intentional findings).

Capability matrix: sites, traffic, queries, crawl enabled; page stats and link counts disabled as unverified; all write operations out of scope. Full table in `docs/BING.md`.

Tests (all mocked; 779 pass in total, 106 are Bing-specific): API client, dates, normalization, error mapping, OAuth URL/token exchange/refresh grant, state (replay, expiry, wrong user, Google state), callback failures, refresh (preserved refresh token, concurrency, revoked, outage, bad client), API-key storage/switching/no-fallback, discovery, plus MCP end-to-end with two customers over both methods: isolation, per-user cache, revoked/removed connections, throttling, stale fallback and a no-secret-leak sweep of DB, logs and outputs.

Not verified live / open limitations: refresh `grant_type` (docs contradict), API-key vs OAuth host acceptance, real response shapes, query row volume, no token-revocation endpoint at Bing, no numeric quota published. Remaining manual steps: create a Bing API key or OAuth client yourself, run `pnpm bing:check --yes`, test Connect with Bing and token renewal, then enable the provider. Nothing is committed or pushed.

**Update (19 Oct 2026):** the owner reported that `pnpm bing:check --yes` passed with their own Bing API key. That verifies the **API-key path** (list sites + traffic/query/crawl reads) for that one account. Still unverified live: "Connect with Bing" (OAuth), token renewal, and the OAuth host/grant questions in `docs/BING.md`.

## Phase 10b: Bing audit and extension (26 Oct 2026)

Root cause of "Bing is disabled on this server": `PROVIDER_BING_ENABLED` was missing from `web.env`/`mcp.env` (missing = `false`) while the account itself was connected. `get_connection_status` now returns `providerEnabled` and a plain-English `note`, so "connected" can no longer hide a switched-off provider.

Added (read-only): pages, query/page drill-downs, crawl issues, blocked URLs, inbound links, URL links, sitemaps, URL info/traffic, submission quota, keyword stats; `get_bing_insights` presets; period comparison; CTR/average position; URL-variant merging; summary, totals, warnings and next step in every answer. Not available in Microsoft's API: country, device and search-appearance breakdowns. Full matrix and the list of uncovered methods: `docs/BING.md`.

Tests: 1,003 pass (about 220 added in this phase), all against mocks. **Not verified against the real Bing API**: the new reports (they say so in `warnings`) and OAuth login/renewal. Run `pnpm bing:check --yes --show-rows` with a key in `.env.local` to confirm.

## Phase 10c: Bing Webmaster expansion (27 Oct 2026)

Bing module only; nothing changed for Search Console, GA4, Clarity or auth. Shared files touched in their Bing sections only: `packages/contracts/src/schemas.ts`, `packages/reporting/src/index.ts`, `apps/mcp-server/src/server.ts`.

Added (all read-only): 15 more Bing methods (`GetQueryTrafficStats`, `GetChildrenUrlInfo`, `GetChildrenUrlTrafficInfo`, `GetCrawlSettings`, `GetFeedDetails`, `GetDeepLinkBlocks`, `GetActivePagePreviewBlocks`, `GetCountryRegionSettings`, `GetQueryParameters`, `GetConnectedPages`, `GetSiteMoves`, `GetSiteRoles`, `GetContentSubmissionQuota`, `GetKeyword`, `GetRelatedKeywords`); five new `query_bing_report` reports; new tools `get_bing_site_settings` and `query_bing_keywords`; `providerMetadata.pagination` and `granularity` on every Bing answer (default limit 100); `get_supported_metrics` lists every report with its tool, granularity, shape and live status plus the write actions that were deliberately not built. Delegation codes and ownership codes never leave the parser.

Live test on one real property (27 Oct 2026, `pnpm bing:check --yes`): 31 of 32 methods answered. `GetSiteMoves` returns HTTP 404. The live test also found that Bing rejects the JSON-quoted arguments from Microsoft's samples (now sent bare) and that the keyword methods need ISO dates; the details are in `docs/BING.md`.

Tests: 1,038 pass (35 added). Mock tests cannot prove what Bing really sends; the live table can, and it is why the argument encoding changed. Still not tested live: OAuth login and renewal, and the properties-with-data cases for the methods that answered with empty lists.

Not committed or pushed.

## Phase 10d: Clarity optimization (27 Oct 2026)

Clarity-only. `get_clarity_insights` now takes a `reportType` (overview, by_device, by_country, by_source, by_channel, by_page, frustration_by_page, by_browser_os) and returns a tidy report: merged rows, numbers, UTC window, live/cache label, data age, quota left, LOW_QUOTA and cache-only warnings, 1,000-row truncation flag. Cache key is now (project, numOfDays, dimensions). Plain-language 400/401/403/429 messages. `get_supported_metrics` (Clarity section) lists the report types. Tests: 1,045 pass, using 3 real responses as fixtures. 3 live Clarity calls were used. Snapshot history added (option 1): migration `20261027100000_clarity_snapshots.sql`, tool `get_clarity_history`; 1,049 tests pass. The migration must be applied to Supabase before release.

Not committed or pushed.
