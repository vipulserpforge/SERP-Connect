# Open issues (things only a person can finish)

Last updated: 21 October 2026

This list holds everything that I could **not** safely fix or verify myself. I changed no live settings in Supabase, Google, Vercel or any server, and I made no destructive production changes.

**How to read it**
- **Blocker** = do this before real customers use the app.
- **Important** = do this soon after launch.
- **Later** = nice to have.
- Each item says: what the problem is, why it matters, exactly what to do (and where to click), and how to check it worked.
- When something is finished, move it to "Resolved" at the bottom and add the date. Claude can update this file for you.

**Big picture:** the code is built, tested and works on my side. But it has **never been run on the real Vercel, on a real VPS, or with a real Claude connector**. So nothing here is "production-ready" yet. It is "ready to deploy and test". The steps for that are in [`docs/mcp-web.md`](docs/mcp-web.md).

---

## BLOCKERS

### 1. Nothing has been deployed yet
- **Problem:** The website has never been put on Vercel and the MCP server has never been put on a VPS. I tested the same steps on my computer (production build, production start, PM2, real database connection), but not on the real services.
- **Why it matters:** Small differences on the real services (for example a Vercel setting) can still cause a failure on the first try.
- **What to do:** Follow [`docs/mcp-web.md`](docs/mcp-web.md) from the top. If something fails, copy the error text (never passwords or keys) and give it to Claude.
- **How to verify:**
  - `https://connect.serpforge.io/api/health` shows `{"status":"ok"}`.
  - `https://mcp.serpforge.io/healthz` shows `{"status":"ok"}`.

### 2. The Supabase "audience hook" is installed but not switched on
- **Problem:** The function exists in your database, but Supabase does not use it until you switch it on.
- **Why it matters:** Without it, the MCP server refuses Claude's sign-in tokens (this is the safe behaviour). Claude cannot connect.
- **What to do:**
  1. Open <https://supabase.com/dashboard> and click your SERP Connect project.
  2. Left menu: **Authentication** → **Hooks**.
  3. Find **Customize Access Token (JWT) Claims** and click **Add hook** (or **Enable**).
  4. Choose **Postgres**, schema `public`, function `custom_access_token_hook`.
  5. Click **Create** / **Save**.
- **How to verify:** Ask Claude to run `pnpm mcp:check https://mcp.serpforge.io/mcp`. The "audience" line must not say FAIL.

### 3. The Supabase OAuth Server is switched off
- **Problem:** When last checked it was off.
- **Why it matters:** This is the "sign in and approve" system Claude uses. Without it the connector cannot sign anyone in.
- **What to do:** (do this **after** the website is live on `connect.serpforge.io`)
  1. Supabase dashboard → **Authentication** → **URL Configuration**: set **Site URL** to `https://connect.serpforge.io` and add `https://connect.serpforge.io/auth/callback` under **Redirect URLs**. Click **Save**.
  2. **Authentication** → **OAuth Server**: turn it **on**.
  3. **Authorization Path:** `/oauth/consent`
  4. Turn on **Dynamic Client Registration** (Claude needs it to introduce itself).
  5. Click **Save**.
- **How to verify:** `pnpm mcp:check https://mcp.serpforge.io/mcp` shows no FAIL lines about the OAuth server or registration.

### 4. Google does not know your live website address yet
- **Problem:** Google only allows sign-in returns to addresses you registered.
- **Why it matters:** "Connect Search Console / GA4" fails with `redirect_uri_mismatch`.
- **What to do:**
  1. Open <https://console.cloud.google.com> and choose your project.
  2. **Google Auth Platform** → **Clients** → click your client.
  3. Under **Authorized redirect URIs** click **Add URI** and paste exactly: `https://connect.serpforge.io/api/oauth/google/callback`
  4. Click **Save** and wait a few minutes.
- **How to verify:** On the live website, sign in and click **Connect Search Console**. Google's page opens with no error, and you return to the dashboard.

### 5. Emails: Supabase's free email service only sends to your own team
- **Problem:** Supabase's built-in email sender only delivers to people in your Supabase organization, and has very low limits.
- **Why it matters:** A new customer who signs up never receives the confirmation email, so they cannot join. The app shows "We cannot send a confirmation email to that address yet."
- **What to do:**
  1. Create an account with an email-sending service (for example Resend, Brevo, Amazon SES or Postmark) and verify your domain `serpforge.io` there. They give you SMTP details (host, port, user, password).
  2. Supabase dashboard → **Authentication** → **Emails** → **SMTP Settings** → turn on **Enable custom SMTP** and enter those details. Use a sender address such as `no-reply@serpforge.io`.
  3. Click **Save**.
- **How to verify:** Sign up on the live site with an email address that is **not** in your Supabase team. The confirmation email arrives, and its link opens `connect.serpforge.io`.

### 6. A real Claude connection has never been tested
- **Problem:** All my tests used a pretend sign-in system with Claude's official connection code. A real Claude has never connected.
- **Why it matters:** The first real attempt may reveal a small mismatch (for example in Claude's registration step).
- **What to do:** After items 1 to 5 are done: in Claude open **Settings** → **Connectors** → **Add custom connector** → paste `https://mcp.serpforge.io/mcp` → sign in → **Allow**.
- **How to verify:** Ask Claude "Run get_connection_status". It lists your connected services. If it fails, send Claude the exact message you see.

### 7. Google app is in "Testing" mode
- **Problem:** While it is in Testing, only people you list as **test users** can connect Google, and their connection stops working after **7 days**.
- **Why it matters:** Real customers cannot use it, and your own connection silently expires every week.
- **What to do:** Follow [`docs/GOOGLE-SETUP-SIMPLE.md`](docs/GOOGLE-SETUP-SIMPLE.md), Part 9 (publish and verify). Google's review takes time, so start early. Google also advises a **separate Google project for the live site** (no `localhost` addresses). If you make one, replace `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in **both** Vercel and the VPS `mcp.env`.
- **How to verify:** Google Cloud console → **Google Auth Platform** → **Audience** shows **In production**.

---

## IMPORTANT

### 8. Supabase warns that "leaked password protection" is off
- **Problem:** Supabase's security check reports (I ran it on your live project) that people can still choose passwords that appear in known data leaks.
- **Why it matters:** Weak, already-stolen passwords make accounts easier to break into.
- **What to do:** Supabase dashboard → **Authentication** → **Sign In / Providers** (or **Policies**) → **Password security** → turn on **Prevent use of leaked passwords**. Note: Supabase may offer this only on a paid plan. If the switch is greyed out, this is why.
- **How to verify:** Supabase → **Advisors** → **Security Advisor** no longer lists "Leaked Password Protection Disabled".

### 9. There is no "forgot password" page
- **Problem:** The app has sign-up and sign-in but no screen for resetting a forgotten password.
- **Why it matters:** A customer who forgets their password cannot get back in on their own.
- **What to do now (workaround):** Supabase dashboard → **Authentication** → **Users** → find the person → **⋯** → **Send password recovery**. They get an email.
- **Proper fix (needs development):** ask Claude to "build a forgot-password and reset-password flow with tests". I did not add it because it needs a real email service (item 5) to test properly.
- **How to verify:** On the live site, request a reset, receive the email, set a new password, sign in.

### 10. There is no way for a customer to delete their account
- **Problem:** No "delete my account and data" button.
- **Why it matters:** Privacy laws (for example GDPR) can require it, and Google may ask for it during app review.
- **What to do now (workaround):** Supabase dashboard → **Authentication** → **Users** → **⋯** → **Delete user**. The database removes the person's connections and saved credentials along with them.
- **Proper fix:** ask Claude to "build account deletion with tests".
- **How to verify:** Delete a test user and confirm their rows disappear (Supabase → **Table Editor** → `provider_connections`).

### 11. No bot protection on sign-up and sign-in
- **Problem:** No CAPTCHA, so scripts can try many sign-ups or password guesses. Supabase has its own basic limits, which help.
- **Why it matters:** Spam accounts and guessing attacks.
- **What to do:** Supabase dashboard → **Authentication** → **Attack Protection** → turn on **CAPTCHA** (Cloudflare Turnstile is free). The website code must also send the CAPTCHA result, so ask Claude to "add Turnstile CAPTCHA to sign-up and sign-in" first.
- **How to verify:** Sign-up and sign-in show a challenge and still work.

### 12. The encryption key is kept in a settings file, not a key vault
- **Problem:** `SECRET_KEYS` lives in Vercel's and the VPS's settings. There is no automatic rotation, and a "real key vault" (KMS) is not implemented.
- **Why it matters:** If the key leaks, saved Google connections could be read. If it is lost, every customer must reconnect.
- **What to do:** (a) Keep a copy in your password manager. (b) Limit who can open Vercel's settings and the VPS. (c) For stronger protection ask Claude to "implement a KMS key provider".
- **How to verify:** Your password manager holds the key, and you can find it under the name you gave it.

### 13. Delete the two settings files on your computer after launch
- **Problem:** `~/Documents/private-serp/web.env` and `mcp.env` contain every secret in plain text.
- **Why it matters:** Anyone who gets into your computer (or a backup) can read them.
- **What to do:** When both apps work, check that your key is in your password manager, then move both files to the Trash and empty it. You can always copy the values from Vercel's settings and from `/home/serp/mcp.env` on the VPS.
- **How to verify:** Finder → `Documents/private-serp` is empty.

### 14. Vercel's free "Hobby" plan is for non-commercial use
- **Problem:** Vercel's terms limit the free plan to personal, non-commercial projects.
- **Why it matters:** Running a business or charging customers on it can break their terms, and they may suspend the project.
- **What to do:** If this is a business, switch to Vercel's **Pro** plan: Vercel dashboard → your name → **Settings** → **Billing**. Read Vercel's current terms first. The app itself works on both.
- **How to verify:** The project shows the plan you chose.

### 15. Vercel's build may not pick the right pnpm version
- **Problem:** The project needs pnpm 12.14.0. I added `ENABLE_EXPERIMENTAL_COREPACK=1` and a tolerance setting (`pmOnFail: ignore`), and tested a mismatch locally with pnpm 11. I could not run Vercel's own build.
- **Why it matters:** If it fails, the website will not deploy.
- **What to do:** If the build log mentions pnpm or Node, open Vercel → the project → **Settings** → **General** → **Node.js Version** → choose **24.x**. Check that `ENABLE_EXPERIMENTAL_COREPACK` is `1`. Then **Deployments** → latest → **⋯** → **Redeploy**. If it still fails, send Claude the log.
- **How to verify:** The deployment shows **Ready**.

### 16. The VPS setup scripts were checked for syntax, not run on a real Ubuntu server
- **Problem:** `deploy/vps/setup-server.sh`, `deploy.sh` and the Nginx file were not run on Linux. I tested the same install, build and PM2 start on macOS, and checked the scripts for syntax errors. Nginx is not installed on my machine, so I could not test the Nginx file.
- **Why it matters:** A typo or a Linux difference may show up on the first run.
- **What to do:** Follow section 5 of [`docs/mcp-web.md`](docs/mcp-web.md). If a command fails, send Claude the exact error.
- **How to verify:** `nginx -t` on the VPS says "syntax is ok", and `https://mcp.serpforge.io/healthz` shows `ok`.

### 17. Harden and back up the VPS
- **Problem:** A new server is not locked down by default.
- **Why it matters:** Servers on the internet get attacked within hours.
- **What to do:** On the VPS, as `root`:
  1. Turn on automatic security updates: `apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades`
  2. Use an SSH key instead of a password (your provider's dashboard shows how).
  3. Take a snapshot or backup from your provider's dashboard once everything works.
  4. Check the firewall: `ufw status` must list only ports 22, 80 and 443.
- **How to verify:** `ufw status` shows `Status: active` with just those ports.

### 18. Google, Search Console, GA4, Bing and Clarity were never tested with real data
- **Problem:** All reports were tested with pretend ("mock") providers. Real response shapes, limits and delays are unverified. Microsoft Clarity's and Bing's real behaviour is explained in [`docs/CLARITY.md`](docs/CLARITY.md) and [`docs/BING.md`](docs/BING.md).
- **Why it matters:** The first real report may show a field the code did not expect.
- **What to do:** After item 4, connect your own Search Console and GA4 on the live website and open a report. For Clarity, run `pnpm clarity:check --yes` with your token (it uses 1 of the 10 daily requests).
- **How to verify:** A report shows real numbers that match what you see in Google's own tools.

---

## LATER

### 19. Limits are counted per server instance
- **Problem:** Request limits and the short-term cache are kept in memory per running copy. On Vercel there can be several copies, so the limits are looser than they look. (The Clarity daily budget is stored in the database and is exact.)
- **Why it matters:** A determined signed-in user could send somewhat more requests than the limit. It does not expose anyone else's data.
- **What to do:** If this becomes a problem, ask Claude to "move the rate limits to the database". Nothing to click now.

### 20. No browser-based tests
- **Problem:** The end-to-end tests drive the apps with web requests, not a real browser with JavaScript.
- **Why it matters:** A visual or click problem in a page could slip through.
- **What to do:** After deploying, click through the pages yourself using the checklist in section 8 of [`docs/mcp-web.md`](docs/mcp-web.md).

### 21. Supabase's database certificate expires in 2031
- **Problem:** The project ships Supabase's root certificate (valid until 26 April 2031) so the database connection can be verified.
- **Why it matters:** If Supabase changes certificates earlier, database connections fail with a "certificate" error.
- **What to do if it happens:** Supabase → **Project Settings** → **Database** → **SSL Configuration** → **Download certificate**. Put its text in a setting named `SUPABASE_DB_CA` (on Vercel and in `/home/serp/mcp.env`) and redeploy / `pm2 restart serp-mcp --update-env`. There is deliberately no setting that turns the certificate check off.
- **How to verify:** `https://connect.serpforge.io/dashboard` loads after signing in.

---

## RESOLVED

Each of these was verified on my computer on 21 October 2026 unless noted.

| # | What was wrong | What I did | How I checked |
|---|---|---|---|
| R1 | **The database address in your settings would not work on Vercel.** `db.<project>.supabase.co` only works over IPv6, and Vercel cannot use IPv6. | Found your project's IPv4 "pooler" address (`aws-0-ap-southeast-1.pooler.supabase.com:6543`) and put it in `~/Documents/private-serp/web.env` and `mcp.env`. Documented it in `.env.example`, `docs/DEPLOYMENT.md` and `docs/mcp-web.md`. | Connected to your real database with it (read-only), using the built code. Both files work. |
| R2 | **The database connection did not verify the server's certificate** (`rejectUnauthorized: false`), so the connection could be intercepted. | The certificate is now verified against Node's trusted roots plus Supabase's public root CA, which ships in `packages/db/src/supabase-ca.ts`. Setting for a changed certificate: `SUPABASE_DB_CA`. There is deliberately no switch to turn the check off. | 6 new unit tests. A real connection to your database with verification on. The old setting fails with `SELF_SIGNED_CERT_IN_CHAIN`, which shows the check is real. |
| R3 | **9 test files failed** because my audience-hook migration granted rights to a Supabase-only role that the test database does not have. | The grant now runs only if that role exists. The live database already has the hook and is unchanged. | `pnpm test`: 785 of 785 pass. |
| R4 | **3 Clarity tests only passed on 19 October** (a frozen test clock was mixed with the real clock). | Tests and the mock adapter now use one clock consistently. | Tests pass today, on a different date. |
| R5 | **Website functions could be cut off on Vercel's free plan** (older default limit is 10 seconds; report calls can take up to 20). | Added `maxDuration` (30 or 60 seconds, within the free plan's 60-second ceiling) to the routes and pages that call Google, Bing or Clarity. | Production build passes. Not tested on Vercel itself (see item 15). |
| R6 | **Too many database connections on Vercel** (every function copy keeps its own pool of 5). | The pool is 2 on Vercel and 5 elsewhere; `DB_POOL_MAX` overrides it. | 6 unit tests. |
| R7 | **Missing browser security headers.** | Added HSTS, a permissions policy and a partial Content-Security-Policy (no framing, no plugins, no `<base>` hijacking). | Checked on the running production build: all headers present; all pages still work. |
| R8 | **No request flood protection on the MCP address.** | Nginx now limits each visitor address to 20 requests per second (bursts of 40). | Config reviewed. Nginx is not installed here, so it is untested (see item 16). |
| R9 | **No linter.** | Added ESLint with bug-focused rules (forgotten `await`, unreachable code, unused variables) and ran it in CI (`.github/workflows/ci.yml`). | `pnpm lint` finishes with no errors. It found only test leftovers and one dead variable (fixed). |
| R10 | **Unused code:** 4 unused package links (`@serp/provider-ga4` and `@serp/provider-gsc` in the MCP server; `@serp/contracts` in `packages/cache` and `packages/provider-google`), one dead variable in the Bing page, and dead lines in two tests. | Removed them. | Typecheck, lint, 785 tests, production builds and end-to-end tests all pass afterwards. |
| R11 | **Hostinger build stopped on a pnpm version clash.** (Fixed on 21 October earlier.) | `pmOnFail: ignore` in `pnpm-workspace.yaml`. | Reproduced and fixed with pnpm 11.24. |
| R12 | **Documentation out of date or duplicated.** | Updated `README.md`, `PROJECT-STATUS.md`, `docs/DEPLOYMENT.md`, `docs/MCP.md`, `docs/SECRETS.md`, `.env.example`; added `docs/mcp-web.md`. Removed `docs/HOSTINGER-DEPLOY.md` (replaced by `mcp-web.md`) and `docs/GOOGLE-SETUP.md` (a technical copy of `GOOGLE-SETUP-SIMPLE.md`; its one unique table now lives in Part 12 of that guide). | No link to a removed file remains (checked by search). |

### Checked and found fine (no change needed)
- **No secrets in the code or its history.** Scanned all tracked files and the full git history for Google secrets, Supabase secret keys, private keys, database passwords and tokens. Nothing found. `.env.local` is ignored by git.
- **No known vulnerable packages** (`pnpm audit`, including development tools).
- **Access control:** signed-out visitors cannot reach `/dashboard`, `/oauth/consent`, `/api/connections` or `/api/reports` (checked on a running production build). Cross-site report requests and wrong content types are refused. The `next=` redirect cannot send people to another website. The existing tests also cover one customer never seeing another customer's data.
- **MCP server:** it needs a real access token, answers 401 with the right discovery link, refuses mock sign-in in production, handles Streamable HTTP, and ran under PM2 with your real production settings (health, discovery page and 401 all correct).
- **Supabase security advisor:** only two notes. "RLS enabled, no policy" on server-only tables is intentional. "Leaked password protection" is item 8.
