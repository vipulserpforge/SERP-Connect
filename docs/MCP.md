# Remote MCP server

`apps/mcp-server` is a standalone Node server using the official `@modelcontextprotocol/sdk` (1.32.x) over **Streamable HTTP** at `POST {MCP_PUBLIC_URL}/mcp`. It is stateless (a fresh MCP server and transport per request), read-only, and speaks protocol versions up to 2025-11-25.

## Tools

| Tool | Purpose |
|---|---|
| `get_connection_status` | Which providers are connected for the signed-in user, and their health. |
| `list_gsc_properties` | Search Console properties the user enabled for Claude. |
| `query_gsc_performance` | Search Console search analytics for one property. |
| `list_ga4_properties` | GA4 properties the user enabled for Claude. |
| `query_ga4_report` | GA4 report for one property. |
| `get_clarity_insights` | Clarity (unavailable until the Clarity adapter exists; returns a clear error). |
| `list_bing_sites` | Bing Webmaster sites the user enabled (verified only). |
| `query_bing_report` | Bing traffic, queries or crawl report for one site. Bing data only; never merge with Google. See `BING.md`. |
| `get_supported_metrics` | Metrics, dimensions and limits per provider. |

Every tool has a description written for the model, a strict zod input schema (unknown arguments are rejected, so a `userId` argument is an error, never a lookup), and a JSON output schema. Successes and failures share one envelope; failures carry a fixed code and message, never upstream text, stack traces, tokens or other users' data. All tools are annotated read-only.

## Authentication and authorization

- The user identity comes **only** from the verified access token's `sub`. Nothing in tool arguments, headers or the body is used to choose a user.
- Tokens are verified locally against the issuer's JWKS: asymmetric algorithms only (HS*/none refused), issuer, audience, expiry, `sub` (UUID), role `authenticated`, not anonymous, and an OAuth `client_id` claim (so an ordinary browser-session JWT is not accepted as an MCP grant). `MCP_REQUIRED_SCOPES` is enforced when set (403 `insufficient_scope`).
- Unauthenticated requests get `401` with `WWW-Authenticate: Bearer resource_metadata="..."`. Protected Resource Metadata (RFC 9728) is served at `/.well-known/oauth-protected-resource/mcp` (and the root form). If the identity provider's keys cannot be fetched the server answers `503` with `Retry-After`, not 401, so clients do not loop through re-authorization.
- Browser requests with an `Origin` not in `MCP_ALLOWED_ORIGINS` get 403 (DNS-rebinding protection). Auth is checked before method handling.
- A per-user concurrency limiter and the reporting layer's rate limits sit behind the tools ([`REPORTING.md`](REPORTING.md)).

### Authorization flow checked against the docs (current spec revision 2026-07-28, Claude's connector docs)

Claude acts as the OAuth client; this server is the resource server; **Supabase Auth's OAuth 2.1 server** is the authorization server.
Flow: unauthenticated call → 401 + `resource_metadata` → PRM names the authorization server → Claude reads RFC 8414 / OIDC discovery → registers (CIMD if the server advertises it, otherwise Dynamic Client Registration) → authorization code + PKCE (S256) with `resource` (RFC 8707) → user lands on this app's `/oauth/consent` page, signs in and approves → Claude exchanges the code and later refreshes (rotating refresh tokens) → bearer token on each MCP request.

Claude-specific requirements honored: 401 on missing token; the PRM `resource` equals the exact URL a user enters; one authorization server listed; callback `https://claude.ai/api/mcp/auth_callback` must be allowed by the authorization server (Claude Code uses a loopback callback with any port); form-encoded token endpoint; 10 s / 30 s latency limits (verification is local).

## What was and was not tested

Tested here (all automated, mock identity provider with real RSA/EC keys and real JWKS over HTTP):
- the official SDK **client** (`StreamableHTTPClientTransport` + OAuth provider) completing discovery, dynamic registration, PKCE, `resource` binding, consent, token exchange, refresh rotation and revocation against the server;
- 80 server tests: tool listing and schemas, tenant isolation (two users, forged `userId`/`user_id` arguments, cross-user property ids), wrong audience/issuer/signature/algorithm/expiry/anonymous/non-OAuth tokens, Origin handling, size/type limits, JWKS outage, safe errors, concurrency limits; mutation checks confirmed those tests fail when each guard is removed;
- the consent page, approve/deny redirects, cross-user authorization ids, XSS escaping and grant revocation in the web app (e2e, fake Auth server).

**Not tested: a real Claude connector.** Claude must reach a public HTTPS URL (Anthropic egress `160.79.104.0/21`), and your Supabase project's OAuth server is currently **disabled** (verified: `feature_disabled`). `pnpm mcp:check` probes a deployed server + issuer for the things Claude needs and reports gaps; run it after deployment.

## Production configuration still required

1. **Supabase Dashboard → Authentication → OAuth Server:** enable it; set the Authorization Path to `/oauth/consent` (Site URL must be the deployed web origin); decide whether to allow Dynamic Client Registration (needed for Claude unless Supabase advertises CIMD).
2. **Audience binding.** Supabase tokens carry `aud: "authenticated"` and have no documented RFC 8707 support. Preferred: a Custom Access Token Hook that sets `aud` to your MCP URL, then `MCP_RESOURCE_AUDIENCE=https://<mcp-host>/mcp`. The hook function is `supabase/migrations/20261021100000_mcp_audience_hook.sql` (already applied to project `dphftsifxfhxbhtgabso`, audience `https://mcp.serpforge.io/mcp`); it changes `aud` only for tokens that carry a `client_id`, so website sessions are untouched. It must then be switched on in Dashboard → Authentication → Hooks → Custom Access Token → Postgres function `public.custom_access_token_hook`. Otherwise the server refuses to start with the generic audience unless you set `MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE=true` (accepts any Supabase token for this project that has a `client_id`; weaker, understand it before using).
3. Deploy `apps/mcp-server` on Hostinger as its own Node.js Web App at its own subdomain (steps in [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md); build script `build:mcp`, entry file `scripts/start-mcp.mjs`) and set, in hPanel → Environment variables: `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL`, `MCP_OAUTH_ISSUER_URL` (`https://<ref>.supabase.co/auth/v1`), optionally `MCP_JWKS_URL`, `MCP_ALLOWED_ORIGINS`, `MCP_REQUIRED_SCOPES`, plus `AUTH_MODE=supabase`, `DB_MODE=postgres`, `DATA_MODE=live`, `DATABASE_URL`, `SECRET_KEYS`/KMS settings. Production refuses mock modes.
4. Set `NEXT_PUBLIC_MCP_URL` in the web app so the dashboard shows the connector address.
5. Google Cloud OAuth client and credentials (final phase) so live data exists.
6. Run `pnpm mcp:check`, then in Claude: Settings → Connectors → Add custom connector → your `/mcp` URL → sign in → approve. Verify with `get_connection_status`.
7. A real KMS-backed key provider and rate limiting/CAPTCHA on auth, as listed in `PROJECT-STATUS.md`.

## Local use with mocks

`MCP_AUTH_MODE=mock` accepts `Authorization: Bearer mock:<userId>` (development only; refused in production). Example: `pnpm --filter @serp/mcp-server dev`, then point the MCP Inspector at `http://localhost:8787/mcp`.
