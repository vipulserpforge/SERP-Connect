# SEO Analytics MCP Connector

Next.js dashboard plus a standalone Node.js MCP server that lets Claude query a user's Search Console, GA4, Clarity and Bing data. Current progress is in [`PROJECT-STATUS.md`](PROJECT-STATUS.md).

Everything runs on **mock data** today. No Google Cloud project or provider credentials are needed.

## Requirements

- Node.js 22.12+ (`.nvmrc` pins 22; 24 is also tested)
- pnpm 12 (`npm i -g pnpm`)

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspaces |
| `pnpm dev:web` | Build shared packages, then Next.js dev server on :3000 |
| `pnpm dev:mcp` | Build shared packages, then MCP server (watch mode) on :8787 |
| `pnpm build` | Build every package and both apps |
| `pnpm build:web` / `pnpm build:mcp` | Build one app (and the packages it needs) independently |
| `pnpm start:web` / `pnpm start:mcp` | Run a built app |
| `pnpm typecheck` | Type-check everything |
| `pnpm lint` | ESLint (bug-focused rules: forgotten `await`, unreachable code, unused variables) |
| `pnpm test` | Unit, RLS and tenant-isolation tests (no build needed; Postgres runs in-process) |
| `pnpm test:e2e` | Builds the web app and tests sign-up/login/logout end to end against a fake Auth server |

Optional: `cp .env.example .env.local`. Both apps read that one file. Defaults already work without it.

## Layout

```
apps/web          Next.js dashboard and application API routes
apps/mcp-server   Streamable-HTTP MCP server (stateless, one McpServer per request)
packages/
  contracts       Zod schemas, error model, env parsing, shared types
  db              Repository interface + mock repo; Supabase client at @serp/db/supabase (server only)
  auth            Principal, token verifiers, property authorization
  secrets         AES-256-GCM envelope encryption behind a KeyProvider
  query-planner   Date resolution, provider date rules, cache keys, TTLs
  cache           Report cache interface + in-memory implementation
  provider-*      gsc, ga4, clarity (mock + live placeholder), bing (gated), google (OAuth helpers)
  reporting       ReportService: authorize, validate, cache, call adapter
  observability   Redacting JSON logger
tests/            Tenant isolation and reporting tests
supabase/         SQL migrations (schema, RLS, functions); see docs/SUPABASE-SETUP.md
docs/             SECRETS.md (credentials), MCP.md (remote MCP server, auth, Claude setup), CLARITY.md, BING.md, SUPABASE-SETUP.md, GOOGLE-SETUP-SIMPLE.md (step-by-step Google Cloud setup for non-coders, with a developer reference at the end), mcp-web.md (step-by-step: website on Vercel, MCP server on a VPS)
migration.md      step-by-step guide for moving from visibll.in to serpforge.io
```

Shared packages compile to `dist/` and expose only their public entry points, so both apps consume the same code.

## Database and authentication

Migrations are in `supabase/migrations/`. To apply them and switch from the demo user to real sign-in, follow [`docs/SUPABASE-SETUP.md`](docs/SUPABASE-SETUP.md). Until `AUTH_MODE=supabase`, the dashboard uses a fixed demo user.

## Trying the MCP server

```bash
pnpm dev:mcp
curl -s -X POST localhost:8787/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer mock:00000000-0000-4000-8000-00000000000a' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The mock bearer token is `mock:<userId>`. Mock auth and `DATA_MODE=mock` are refused when `NODE_ENV=production` unless `ALLOW_MOCK_IN_PRODUCTION=true` (local smoke tests only).

## Safety rules baked in

- User identity comes only from the validated token. Tool input never carries a user id (schemas are `.strict()`).
- Properties are resolved against the caller's own enabled records; foreign and unknown ids return the same error.
- Logs pass through a redactor; error responses never include stack traces or upstream bodies.
- The service-role Supabase client lives behind the `@serp/db/supabase` import and the `server-only` guard in the web app.
