# Connecting Claude to SERP Connect (the MCP server)

The **MCP server** is the connection point that lets Claude read a customer's Search Console, GA4 and Bing data, **only after that customer signs in and approves**. It is read-only: Claude can look at reports, never change anything.

- Its address: `https://mcp.serpforge.io`
- The link customers paste into Claude: `https://mcp.serpforge.io/mcp`

This page has two parts: the **checklist** (what you do, in order) and the **technical reference** (for developers, you can skip it).

---

## Checklist: what is done and what is left

### Done

- [x] **MCP server code is finished and tested.** Automated tests run a full fake sign-in with Claude's official connection code, plus 80 safety tests (for example: one customer can never see another customer's data).
- [x] **Code is on GitHub** (`main`), ready for Vercel and your VPS.
- [x] **Settings file for the MCP server is ready:** `~/Documents/private-serp/mcp.env` (11 settings, with your real addresses).
- [x] **Audience hook is installed in Supabase.** The small function `custom_access_token_hook` is in your database and tested. It marks tokens given to Claude as "valid only for `https://mcp.serpforge.io/mcp`" (already updated for the `serpforge.io` domain). Normal website logins are not affected.
- [x] **Privacy and contact details are set** (`vipul@serpforge.io`).

### Still to do (in this order)

- [ ] **1. Put the website online** at `connect.serpforge.io`. Follow section 6 (Vercel) of [`mcp-web.md`](mcp-web.md).
- [ ] **2. Put the MCP server online** at `mcp.serpforge.io`. Follow section 5 (VPS) of [`mcp-web.md`](mcp-web.md).
- [ ] **3. Tell Supabase your website address.** Section 7.1 of [`mcp-web.md`](mcp-web.md).
- [ ] **4. Switch on the audience hook** (see "How to" below).
- [ ] **5. Switch on the Supabase OAuth Server** (see "How to" below).
- [ ] **6. Add the live address in Google.** Section 7.6 of [`mcp-web.md`](mcp-web.md).
- [ ] **7. Set up your own email sender (SMTP) in Supabase** so sign-up emails reach customers. Section 7.5 of [`mcp-web.md`](mcp-web.md).
- [ ] **8. Run the connection check** (see "How to" below).
- [ ] **9. Add the connector in Claude** and test it (see "How to" below).

---

## How to: the Supabase steps

Open <https://supabase.com/dashboard> and choose your SERP Connect project.

### Switch on the audience hook (checklist item 4)

Why: it makes sure a token meant for your MCP server cannot be used anywhere else.

1. Left menu → **Authentication** → **Hooks**.
2. Find **Customize Access Token (JWT) Claims** and click **Add hook** (or **Enable**).
3. Hook type: **Postgres**.
4. Schema: `public`. Function: `custom_access_token_hook`.
5. Click **Create** / **Save**.

> Do not use the shortcut `MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE=true`. It is weaker, because the server would accept any Supabase token for your project.

### Switch on the OAuth Server (checklist item 5)

Why: this is the "sign in and approve" system Claude uses. When last checked, it was **off** in your project.

Do this **after** the website is online and the Site URL is set (checklist items 1 and 3).

1. Left menu → **Authentication** → **OAuth Server**.
2. Turn it **on**.
3. **Authorization Path:** `/oauth/consent`
4. Allow **Dynamic Client Registration**. Claude needs it to introduce itself.
5. Click **Save**.

Claude's return address, `https://claude.ai/api/mcp/auth_callback`, must be allowed. If Supabase asks, allow it.

---

## How to: check it works

### Run the connection check (checklist item 8)

Ask Claude (in this project): **"Run `pnpm mcp:check https://mcp.serpforge.io/mcp`"**.

It reads out a list of checks. Lines marked **FAIL** tell you what is still missing:

| If it says… | It means… | Fix |
|---|---|---|
| OAuth server not enabled / `feature_disabled` | Supabase OAuth Server is off | "Switch on the OAuth Server" above |
| Audience not ready | The hook is not switched on | "Switch on the audience hook" above |
| Cannot reach server | The MCP app is not running | Check the app on the VPS: `pm2 status` (see section 9 of `mcp-web.md`) |
| No registration method | Dynamic Client Registration is off | Allow it in the OAuth Server settings |

### Add it in Claude (checklist item 9)

1. In Claude open **Settings** → **Connectors** → **Add custom connector**.
2. Paste `https://mcp.serpforge.io/mcp`.
3. A sign-in page from your website opens. Sign in and click **Approve**.
4. Test it: ask Claude **"Run get_connection_status"**. It should list the providers you connected on the website (Search Console, GA4, ...).

Not tested yet: a **real** Claude connection. Everything so far was tested with a fake sign-in system, so expect that the first real attempt may need one or two fixes.

---

## What Claude can do (the tools)

| Tool | What it does |
|---|---|
| `get_connection_status` | Shows which services the customer connected and whether each is healthy |
| `list_gsc_properties` | Lists the customer's Search Console sites they allowed for Claude |
| `query_gsc_performance` | Search Console search results data for one site |
| `list_ga4_properties` | Lists the GA4 properties they allowed for Claude |
| `query_ga4_report` | A GA4 report for one property |
| `get_clarity_insights` | Microsoft Clarity data (not available yet; gives a clear message) |
| `list_bing_sites` | Lists the customer's verified Bing sites |
| `query_bing_report` | Bing traffic, queries or crawl data for one site. Bing data is never mixed with Google (see [`BING.md`](BING.md)) |
| `get_supported_metrics` | Lists what can be asked from each service |

---

## Later (not needed to launch)

- [ ] **Stronger key storage:** move the encryption key into a professional key-management service, and add bot protection (CAPTCHA) and rate limiting on sign-in.

---

# Technical reference (for developers)

You do not need this section to launch.

`apps/mcp-server` is a standalone Node server using the official `@modelcontextprotocol/sdk` (1.32.x) over **Streamable HTTP** at `POST {MCP_PUBLIC_URL}/mcp`. It is stateless (a fresh MCP server and transport per request), read-only, and speaks protocol versions up to 2025-11-25.

Every tool has a description written for the model, a strict zod input schema (unknown arguments are rejected, so a `userId` argument is an error, never a lookup), and a JSON output schema. Successes and failures share one envelope; failures carry a fixed code and message, never upstream text, stack traces, tokens or other users' data. All tools are annotated read-only.

## Authentication and authorization

- The user identity comes **only** from the verified access token's `sub`. Nothing in tool arguments, headers or the body is used to choose a user.
- Tokens are verified locally against the issuer's JWKS: asymmetric algorithms only (HS*/none refused), issuer, audience, expiry, `sub` (UUID), role `authenticated`, not anonymous, and an OAuth `client_id` claim (so an ordinary browser-session JWT is not accepted as an MCP grant). `MCP_REQUIRED_SCOPES` is enforced when set (403 `insufficient_scope`).
- Unauthenticated requests get `401` with `WWW-Authenticate: Bearer resource_metadata="..."`. Protected Resource Metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` (and the root form). If the identity provider's keys cannot be fetched the server answers `503` with `Retry-After`, not 401, so clients do not loop through re-authorization.
- Browser requests with an `Origin` not in `MCP_ALLOWED_ORIGINS` get 403 (DNS-rebinding protection). Auth is checked before method handling.
- A per-user concurrency limiter and the reporting layer's rate limits sit behind the tools ([`REPORTING.md`](REPORTING.md)).

### Authorization flow (checked against spec revision 2026-07-28 and Claude's connector docs)

Claude acts as the OAuth client; this server is the resource server; **Supabase Auth's OAuth 2.1 server** is the authorization server.

Flow: unauthenticated call → 401 + `resource_metadata` → PRM names the authorization server → Claude reads RFC 8414 / OIDC discovery → registers (CIMD if the server advertises it, otherwise Dynamic Client Registration) → authorization code + PKCE (S256) with `resource` (RFC 8707) → user lands on this app's `/oauth/consent` page, signs in and approves → Claude exchanges the code and later refreshes (rotating refresh tokens) → bearer token on each MCP request.

Claude-specific requirements honored: 401 on missing token; the PRM `resource` equals the exact URL a user enters; one authorization server listed; callback `https://claude.ai/api/mcp/auth_callback` must be allowed by the authorization server (Claude Code uses a loopback callback with any port); form-encoded token endpoint; 10 s / 30 s latency limits (verification is local).

### Audience binding

Supabase tokens carry `aud: "authenticated"` and have no documented RFC 8707 support. The hook `supabase/migrations/20261021100000_mcp_audience_hook.sql` (applied to project `dphftsifxfhxbhtgabso`) sets `aud` to `https://mcp.serpforge.io/mcp` only for tokens that carry a `client_id`, so website sessions are untouched. It is verified with sample tokens and restricted to `supabase_auth_admin`. It still has to be switched on in the dashboard. The server's `MCP_RESOURCE_AUDIENCE` must equal that value. The move to `serpforge.io` is in migration `20261029100000_mcp_audience_hook_serpforge.sql` (written, **not applied until the cut-over**; see `migration.md`). It replaces the earlier `visibll.in` version, `20261022100000_mcp_audience_hook_visibll.sql`. Without it the server refuses to start with the generic audience unless `MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE=true` (accepts any Supabase token for this project that has a `client_id`; weaker).

## What was and was not tested

Tested (all automated, mock identity provider with real RSA/EC keys and real JWKS over HTTP):
- the official SDK **client** (`StreamableHTTPClientTransport` + OAuth provider) completing discovery, dynamic registration, PKCE, `resource` binding, consent, token exchange, refresh rotation and revocation against the server;
- 80 server tests: tool listing and schemas, tenant isolation (two users, forged `userId`/`user_id` arguments, cross-user property ids), wrong audience/issuer/signature/algorithm/expiry/anonymous/non-OAuth tokens, Origin handling, size/type limits, JWKS outage, safe errors, concurrency limits; mutation checks confirmed those tests fail when each guard is removed;
- the consent page, approve/deny redirects, cross-user authorization ids, XSS escaping and grant revocation in the web app (e2e, fake Auth server);
- the audience hook function against sample website and OAuth tokens.

**Not tested: a real Claude connector.** Claude must reach a public HTTPS URL (Anthropic egress `160.79.104.0/21`), and the Supabase OAuth server was last verified **disabled** (`feature_disabled`). `pnpm mcp:check` probes a deployed server and issuer and reports gaps.

## Production settings reference

MCP app (the file `/home/serp/mcp.env` on the VPS): `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL=https://mcp.serpforge.io`, `MCP_OAUTH_ISSUER_URL=https://dphftsifxfhxbhtgabso.supabase.co/auth/v1`, `MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp`, `DB_MODE=postgres`, `DATA_MODE=live`, `SUPABASE_DB_URL`, `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Optional: `MCP_JWKS_URL`, `MCP_ALLOWED_ORIGINS`, `MCP_REQUIRED_SCOPES`. Production refuses mock modes.

Website app: `NEXT_PUBLIC_MCP_URL=https://mcp.serpforge.io/mcp` so the dashboard shows the connector address.

## Local use with mocks

`MCP_AUTH_MODE=mock` accepts `Authorization: Bearer mock:<userId>` (development only; refused in production). Example: `pnpm --filter @serp/mcp-server dev`, then point the MCP Inspector at `http://localhost:8787/mcp`.
