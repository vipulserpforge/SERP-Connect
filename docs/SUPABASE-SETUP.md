# Supabase setup: applying the migrations and turning on real sign-in

You do **not** create tables by hand. Everything is in `supabase/migrations/`:

| File | What it does |
|---|---|
| `20261019130000_core_schema.sql` | Tables, composite ownership foreign keys, indexes, `updated_at` triggers |
| `20261019130100_rls_and_grants.sql` | Enables RLS on every table, revokes default API access, grants back only what browsers need, creates the policies |
| `20261019130200_signup_and_budget_functions.sql` | Profile-on-signup trigger and the atomic daily-budget function (in the non-exposed `private` schema) |
| `20261019140000_oauth_states.sql` | Server-only table for single-use, hashed OAuth `state` values (no browser access) |

Project ref (from `.mcp.json`): `dphftsifxfhxbhtgabso`. The project is currently empty, so the migrations apply cleanly.

## 1. Apply the migrations (pick one)

**A. Supabase CLI (recommended; keeps migration history in sync)**

```bash
brew install supabase/tap/supabase        # once
supabase login                            # opens a browser
supabase link --project-ref dphftsifxfhxbhtgabso
supabase db push                          # shows the pending migrations and asks to confirm
```

**B. SQL editor (no tooling)**: open the project's SQL Editor and run the four files **in order**. This works but does not record migration history, so prefer A if you plan to use the CLI later.

**C. Ask me**: tell me to apply them and I will run them through the Supabase MCP connection already configured in this repo, then check the security advisors. I have not applied anything yet.

After applying, confirm in Table Editor that every table shows "RLS enabled".

## 2. Configure Auth in the dashboard (Authentication section)

1. **URL Configuration**: Site URL `http://localhost:3000` (use your real domain in production). Add redirect URL `http://localhost:3000/auth/callback`.
2. **Providers → Email**: enabled. Leave **Confirm email** on (the app expects it and shows "check your email"). Consider raising the minimum password length to match the app's 8 characters.
3. **Rate limits and CAPTCHA**: enable CAPTCHA (Authentication → Attack Protection) before a public launch.
4. Google *sign-in* is not enabled yet; it needs the Google Cloud OAuth client from the final phase.

## 3. Local environment

Copy `.env.example` to `.env.local` and set:

```
AUTH_MODE=supabase
DB_MODE=postgres
NEXT_PUBLIC_SUPABASE_URL=https://dphftsifxfhxbhtgabso.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key: Project Settings → API Keys>
SUPABASE_DB_URL=<Project Settings → Database → Connection string (pooler), with your DB password>
```

- The publishable/anon key is meant for browsers. **Never** put the secret/service-role key or the database password in a `NEXT_PUBLIC_` variable.
- `SUPABASE_DB_URL` is read only by server code. `.env.local` is git-ignored.

Then `pnpm dev:web`, open http://localhost:3000/signup, confirm the email, sign in.

## 4. How isolation works (defense in depth)

1. **Identity separation**: `auth.users.id` is the only SaaS identity. Provider accounts live in `provider_connections.provider_account_id`; nothing matches them to the sign-up email.
2. **Database constraints**: `properties`, `report_cache` and MCP allowlist rows reference connections/properties through composite keys `(id, user_id)`, so Postgres rejects a row that points at another tenant's data, even from privileged code.
3. **RLS + grants**: browser roles can only read their own rows. Secrets, cache and budgets are not reachable from the Data API at all. Users cannot create or edit connections, change a property's owner, or write audit rows.
4. **Server-side ownership checks**: the app talks to Postgres through `PgRepository`, which filters every statement by the session user's id (a direct connection bypasses RLS). The user id comes only from `auth.getUser()`, never from forms or tool input.

## 5. Testing

```bash
pnpm test        # unit + RLS/tenant tests on an in-process Postgres (PGlite) running the real migration files
pnpm test:e2e    # builds the web app and drives sign-up/login/logout against a fake Auth server
```

These do not touch your Supabase project. Remaining gap: nothing here has run against a live Supabase project yet. After step 1 and 2, do a manual sign-up and run Supabase's security advisors (I can run `get_advisors` for you).

## Sign-up troubleshooting

- `email_address_invalid` (shown as "That email address was not accepted"): Supabase rejects example/test/placeholder domains such as `example.com` or `test.com`. Sign up with a real mailbox.
- `email_address_not_authorized` (shown as "We cannot send a confirmation email…"): Supabase's built-in email service only sends to members of your Supabase organization. To let other people sign up, configure a custom SMTP provider under Authentication → SMTP Settings.
- Anything else shows the generic "We could not create the account" message; the exact Supabase code is in the web server log as `signup.failed` (`authErrorCode`).

## Email confirmation link says "invalid or expired"

Supabase's default template sends a PKCE link that only works in the same browser that signed up, and email scanners or a second click can use it up. Fix it once in the dashboard:

1. Authentication → Email Templates → **Confirm signup**.
2. Replace the link with: `<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">Confirm your email</a>`
3. Authentication → URL Configuration: **Site URL** must be the app address you are using (e.g. `http://localhost:3000`), and `.../auth/callback` must be in Redirect URLs.
4. Sign up again (old links stay invalid) and open the new link.

## "Continue with Google" sign-in

The login and sign-up pages have a **Continue with Google** button. It only signs people in to this app (email + profile). Connecting Search Console/GA4 is a separate step on the dashboard.

1. **Google Cloud** → Google Auth Platform → Clients → open your web client → under *Authorized redirect URIs* add `https://dphftsifxfhxbhtgabso.supabase.co/auth/v1/callback` → Save. (Keep the existing `/api/oauth/google/callback` URI; both are needed.)
2. **Supabase** → Authentication → Sign In / Providers → **Google** → enable it, paste the same Client ID and Client secret → Save. (The secret goes only into this Supabase page, never into chat or git.)
3. **Supabase** → Authentication → URL Configuration: Site URL = your app address; Redirect URLs include `<app address>/auth/callback`.
4. While the Google app is in *Testing*, only accounts listed under Audience → Test users can sign in.

Flow: button → Google → Supabase → `/auth/callback` (exchanges the code for a session) → `/dashboard`.
