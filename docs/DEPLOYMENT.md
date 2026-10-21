# Deployment guide

**Recommended hosting: the web dashboard on Vercel (Hobby plan is for non-commercial use; Pro for business use) and the MCP server on your own VPS** (always-on Node process behind Nginx and PM2). The click-by-click guide for non-coders is [`mcp-web.md`](mcp-web.md). The files for it are `apps/web/vercel.json` and `deploy/vps/*`.

**Alternative: Hostinger Cloud plan, two Node.js Web Apps.** No step-by-step guide is kept for it any more (see the git history for the old `docs/HOSTINGER-DEPLOY.md`). The settings below describe that alternative, and the variables further down apply to both options. This page is the technical summary.

**Database address (important on every host):** use Supabase's **pooler** connection string (IPv4, port 6543). The direct `db.<ref>.supabase.co` address is IPv6-only and cannot be reached from Vercel. The server certificate is verified against Supabase's root CA, which ships in `packages/db/src/supabase-ca.ts`.

**Vercel notes:** Root Directory `apps/web`, settings imported from `web.env`, plus `ENABLE_EXPERIMENTAL_COREPACK=1`. Routes that call Google, Bing or Clarity set `maxDuration` (30 or 60 s, within the free plan's 60 s ceiling). Rate limits and the in-memory pieces are per function instance there.

Two services share one Postgres (Supabase) and one set of encryption keys:

| Service | Build | Start | Public URL |
|---|---|---|---|
| Web dashboard (`apps/web`, Next.js) | build script `build:web` | entry file `scripts/start-web.mjs` | `NEXT_PUBLIC_APP_URL` (e.g. `https://app.example.com`) |
| MCP server (`apps/mcp-server`, Node >= 22.12) | build script `build:mcp` | entry file `scripts/start-mcp.mjs` | `MCP_PUBLIC_URL` (e.g. `https://mcp.example.com`), endpoint `/mcp` |

### Hostinger settings (both apps)

Application type **Other**, Node.js **24** (22 works if >= 22.12), package manager **pnpm**, **root directory = repository root** (Hostinger builds only the root directory, and both apps need the shared `packages/*`), output directory empty, environment variables entered in hPanel (before the first deploy, because `NEXT_PUBLIC_*` values are baked in at build time). Do not set `NODE_ENV` or `PORT` yourself: the start scripts default `NODE_ENV` to production (the mock-mode safeguards depend on it), and the host provides the port.

Behaviour to be aware of ([Hostinger Node.js overview](https://docs.hostinger.com/node.js/overview)): apps run on demand and stop after a period without traffic, restarting on the next request. In-memory rate limits reset on restart; saved connections and cached reports are in Postgres. Not yet verified on a real Hostinger account: monorepo build with these settings, Hostinger's pnpm version, port handling, and cold-start time against Claude's 10 s connection limit.

Both must run over HTTPS in production. Production refuses mock modes (`AUTH_MODE`, `DB_MODE`, `DATA_MODE`, `MCP_AUTH_MODE`).

## Order of work

1. **Supabase**: migrations, Auth URLs, key: [`SUPABASE-SETUP.md`](SUPABASE-SETUP.md). After the sites have addresses, set Site URL and the `/auth/callback` redirect to the live app address.
2. **Google Cloud**: project, APIs, consent screen, client: [`GOOGLE-SETUP-SIMPLE.md`](GOOGLE-SETUP-SIMPLE.md). Run `pnpm google:check --probe --secret` with production values before deploying.
3. **Encryption keys**: generate `SECRET_KEYS` once ([`SECRETS.md`](SECRETS.md)), store it in a password/secret manager. Both services need the **same** value; losing it makes stored Google tokens unrecoverable.
4. **Deploy the web app**, then **the MCP server** ([`mcp-web.md`](mcp-web.md)), setting the variables below in Vercel's **Environment Variables** (website) and in `~/mcp.env` on the VPS (MCP server). Delete any `.env` file you used afterwards; never commit them.
5. **Claude connector**: Supabase OAuth server, audience binding, `pnpm mcp:check`: [`MCP.md`](MCP.md).
6. **Smoke test**: sign up, Connect Search Console and GA4 with a test user, request a report, disconnect. Then publish and verify the Google app (GOOGLE-SETUP section 7).

## Variables per service

| Variable | Web | MCP | Secret? | Notes |
|---|:-:|:-:|:-:|---|
| `NODE_ENV=production` | yes | yes | no | |
| `AUTH_MODE=supabase`, `DB_MODE=postgres`, `DATA_MODE=live` | yes | yes (`DB_MODE`, `DATA_MODE`) | no | `DATA_MODE=live` needs the Google variables |
| `NEXT_PUBLIC_APP_URL` | yes | | no | Exact public origin of the web app; it is also the default base of the Google redirect URI |
| `GOOGLE_REDIRECT_URI` | optional | | no | Only to override; must be `https://<app-domain>/api/oauth/google/callback` and registered in Google exactly |
| `GOOGLE_CLIENT_ID` | yes | yes | no | |
| `GOOGLE_CLIENT_SECRET` | yes | yes | **yes** | Host secret store only |
| `SECRET_KEYS` | yes | yes | **yes** | Identical in both |
| `CREDENTIAL_FINGERPRINT_KEY` | yes | yes | **yes** | Identical in both. Needed to save Microsoft Clarity tokens; see [`CLARITY.md`](CLARITY.md) |
| `BING_CLIENT_ID`, `BING_CLIENT_SECRET` | optional | optional | secret: **yes** | Only for "Connect with Bing" (API keys work without). Both apps; secret server-side only; see [`BING.md`](BING.md) |
| `BING_REDIRECT_URI` | optional | | no | Default `<app>/api/oauth/bing/callback`; register it at Bing exactly |
| `PROVIDER_BING_ENABLED` | yes | yes | no | Keep `false` until `pnpm bing:check --yes` passes ([`BING.md`](BING.md)) |
| `CLARITY_LOCAL_DAILY_BUDGET` | optional | optional | no | Default 1000 = no app-side limit (Clarity itself still allows 10/day per project); set 8 to keep spare |
| `SUPABASE_DB_URL` | yes | yes | **yes** | **Pooler** URI (IPv4, port 6543) including the database password. Optional: `SUPABASE_DB_CA`, `DB_POOL_MAX` (see `.env.example`) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | | no | Public values; set at **build** time for the web app |
| `NEXT_PUBLIC_MCP_URL` | yes | | no | Shown on the dashboard |
| `SUPPORT_EMAIL` | yes | | no | Shown on `/privacy` |
| `MCP_PUBLIC_URL`, `MCP_AUTH_MODE=oauth`, `MCP_OAUTH_ISSUER_URL`, `MCP_RESOURCE_AUDIENCE`, `MCP_ALLOWED_ORIGINS` | | yes | no | See `MCP.md` |

Blank variables are treated as unset. Call `pnpm google:check` with the production values loaded to validate the Google side; it never prints the secret.

## Known gaps before real customers

See "Outstanding issues" in [`../PROJECT-STATUS.md`](../PROJECT-STATUS.md) and [`../ISSUES.md`](../ISSUES.md): notably KMS-backed keys, auth rate limiting, and the unverified Google/Claude paths.
