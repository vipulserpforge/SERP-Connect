# Testing

Run everything: `pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e`.

## What each kind of test proves, and what data it uses

**None of these tests talk to real Google, a real Supabase project, or a real Claude connector.** Every Google response is either a built-in mock or the local fake in `tests/system/fake-google.ts`. They prove how *our* code behaves when Google answers in the documented shape; they cannot prove Google's actual behaviour, quotas or latency.

| Layer | Location | Database | Auth | Google |
|---|---|---|---|---|
| Unit and component | `tests/{gsc,ga4,reporting,reporting-layer,security,auth,...}`, `packages/**` | in-memory repository, or PGlite | none / mock | built-in mock clients, plus local HTTP servers for the real REST clients |
| Database and RLS | `tests/db`, `tests/tenant-isolation` | PGlite (real Postgres engine, project migrations, Supabase role shim) | simulated `auth.uid()` | none |
| MCP protocol and OAuth | `tests/mcp` | in-memory | real RS256/ES256-signed tokens from a mock authorization server; the official SDK client runs the OAuth flow | mock reporting service |
| **Whole system** | `tests/system` | PGlite with all migrations | real signed MCP tokens | **real HTTP clients against `fake-google`**; mock consent screen |
| Web e2e, in-memory | `tests/e2e/auth-flow.e2e.ts` | in-memory | fake Supabase Auth server driving the built Next.js app, `@supabase/ssr` and supabase-js | mock |
| Web e2e, Postgres | same file with `E2E_DB=postgres` | PGlite served over the Postgres wire protocol to the real `pg` driver | fake Supabase Auth | mock |
| Live Google wiring | `tests/e2e/google-live-config.e2e.ts`, `tests/security/google-readiness.test.ts` | in-memory | fake Supabase Auth | **placeholder client, no Google call**; stops at the redirect to accounts.google.com |
| Built MCP process | `tests/e2e/mcp-built.e2e.ts` | in-memory | mock bearer; production-mode refusals | mock |

## Cross-tenant checks (User A vs User B)

`tests/system/full-stack.test.ts` runs two customers who deliberately own the *same* Search Console site and GA4 property id. It checks, through the MCP server and the database: property lists and connection status; querying another user's property (indistinguishable from an unknown one, and no Google call is made); internal UUIDs used in place of property ids; arguments naming users, connections or tokens; separate upstream calls, answers and cache rows; per-account GA4 time zones; encrypted secrets and the credential service refusing another user's connection; Row Level Security; foreign disconnect attempts; log hygiene. Mutation checks (property lookup ignoring the user; cache lookup ignoring user/connection/property) make these tests fail, so they are not vacuous.

## Not covered by any automated test

- Real Google APIs (needs the Google Cloud project; deliberately the final phase) and real Google OAuth consent.
- A real Supabase project: email delivery, dashboard Auth settings, pooler behaviour, Supabase's own OAuth server (disabled on the project), TLS to the remote database.
- A real Claude connector over public HTTPS (`pnpm mcp:check` tests a deployment once one exists).
- JavaScript-executing browser tests (forms are driven without JS); accessibility; visual regression.
- Load, soak and multi-instance behaviour (rate limits and concurrency limits are per process).
