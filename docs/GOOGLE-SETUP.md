# Google Cloud setup (operator guide)

> Non-technical, click-by-click version for the **External** consent screen (Testing, then publish and verify): [`GOOGLE-SETUP-SIMPLE.md`](GOOGLE-SETUP-SIMPLE.md). This page is the technical reference.

You (the operator) create **one** Google Cloud project and **one** OAuth client. Every customer connects their own Google account through that client with a normal consent screen. Customers never create projects, keys or clients.

Sources (checked 19 Oct 2026): [Using OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server), [Manage App Audience](https://support.google.com/cloud/answer/15549945), [Manage OAuth Clients](https://support.google.com/cloud/answer/15549257), [Production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance), [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Search Console API authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing), [GA4 Data API quickstart](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart-client-libraries). Google's console changes names and layout often; where a label below differs, follow the intent. I could not sign in to your Google account, so every console click below is from the docs, not observed.

## 0. What the code actually uses (so you register the right things)

| Fact | Value | Where in the code |
|---|---|---|
| OAuth flow | Authorization code + PKCE (S256), `access_type=offline`, `prompt=select_account consent`, `include_granted_scopes=true` | `packages/provider-google/src/index.ts` |
| Client type | **Web application** (we hold a client secret on the server) | |
| Scopes requested | `openid email` + **one** of `https://www.googleapis.com/auth/webmasters.readonly` (Search Console) or `https://www.googleapis.com/auth/analytics.readonly` (GA4), per Connect click | `connectScope()` |
| Callback route | **`/api/oauth/google/callback`** (the only OAuth route in the app) | `apps/web/src/app/api/oauth/google/[action]/route.ts` |
| Redirect URI sent to Google | `GOOGLE_REDIRECT_URI` if set, otherwise `NEXT_PUBLIC_APP_URL` + `/api/oauth/google/callback` | `apps/web/src/lib/server.ts` |
| APIs called | Search Console API; Google Analytics **Data** API (`runReport`, `metadata`, `checkCompatibility`); Google Analytics **Admin** API (`accountSummaries`, `properties.get`) | `packages/provider-gsc`, `packages/provider-ga4` |
| Authorized JavaScript origins | **None needed** (the flow is entirely server-side) | |
| Which processes need the Google id and secret | **Both** the web app (code exchange) **and** the MCP server (it refreshes tokens when Claude asks for a report) | `apps/mcp-server/src/live.ts` |

The redirect URIs to register, exactly (Google compares scheme, host, port, path, case and trailing slash exactly; no wildcards):
- Local testing: `http://localhost:3000/api/oauth/google/callback` (Google allows http only for localhost)
- Production: `https://<your-app-domain>/api/oauth/google/callback` (https required; no raw IP addresses)

`pnpm google:check` prints the exact URI your current settings will send.

## 1. Create or select the project

1. Open <https://console.cloud.google.com/> signed in as the Google account that should own this (use a company account, not a personal one, if this is a business).
2. Project picker (top bar) → **New project** → name e.g. `serp-connector` → choose the organization/folder if you have one → **Create**. Or pick an existing project you own.
3. Make sure that project is selected for every step below.

Recommendation: use this project for **testing** (localhost redirect, test users). Google's production-readiness guidance is that the production project should not contain test redirect URIs or developer-only origins, so create a second project (`serp-connector-prod`) with only the production client when you go live and repeat sections 2-4 there.

## 2. Enable the APIs

Console → **APIs & Services → Library**, search each, open it, click **Enable**:
1. **Google Search Console API**
2. **Google Analytics Data API**
3. **Google Analytics Admin API** (the Data API quickstart does not mention it, but property discovery calls it, so it must be enabled)

If an API is not enabled, the app reports "Google API access is not configured on this server yet" instead of data.

## 3. Configure the OAuth consent screen (Google Auth Platform)

Console → **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>). If prompted, click **Get started**.

1. **Branding**: app name (what customers see), user support email (a monitored address), developer contact email. For production also: app home page URL (`https://<your-app-domain>/`), privacy policy URL (`https://<your-app-domain>/privacy`) and **Authorized domains** (your domain). Google requires a public home page that describes the app and links to the privacy policy, on a domain you verified in Search Console.
2. **Audience**: choose **External** (customers have arbitrary Google accounts). *Internal* only admits members of your own Google Workspace organization (others get `org_internal`). Leave **Publishing status = Testing** for now.
3. **Test users** (Audience page → *Test users* → **Add users**): add every Google account you will test with, including the account that owns the Search Console / GA4 properties. Up to 100 test users per project, counted for the project's lifetime. An account that is not listed gets an `access_denied` screen.
4. **Data Access** (scopes): **Add or remove scopes** and add:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`
   - plus the identity scopes `openid` and `.../auth/userinfo.email`

   Add nothing else (Google asks for the minimum scopes; this app is read-only). The Data Access page marks which scopes Google classes as sensitive or restricted: **look there and note it, I could not confirm it from the docs.** Sensitive scopes need verification before you publish (section 7).

**Testing-mode limits that will surprise you:** a test user's authorization (including the refresh token) **expires 7 days after consent**, so connections stop working weekly and the dashboard will show them as needing attention until the account is reconnected. Testers also see Google's "unverified app" warning (Advanced → Go to <app>). Both are expected; neither applies once the app is published and verified.

## 4. Create the OAuth client

Console → **Google Auth Platform → Clients** (<https://console.cloud.google.com/auth/clients>) → **Create client**:
1. Application type: **Web application**. Name: `serp-connector web` (any label).
2. **Authorized JavaScript origins**: leave empty.
3. **Authorized redirect URIs** → **Add URI**: `http://localhost:3000/api/oauth/google/callback` (add the production URI here only in the production project's client).
4. Leave "Use this client for an AI-powered agent" unchecked (it grants no extra scopes).
5. **Create**. Google shows the **Client ID** and **Client secret**. The secret is shown only once at creation; if you lose it, add a new secret on the client's page (**Add secret**), switch over, then disable and delete the old one. The same page is how you rotate a leaked secret.

## 5. Put the credentials in the right place (never in chat, never in Git)

You will have two values: Client ID (`<number>-<id>.apps.googleusercontent.com`, not secret) and Client secret (secret).

**Local development**: edit `.env.local` in the project root with your editor (it is git-ignored; `git check-ignore -v .env.local` confirms it). Do not type the secret on a shell command line (it lands in shell history) and do not paste it in a chat or an issue.
```
DATA_MODE=live
GOOGLE_CLIENT_ID=<paste client id>
GOOGLE_CLIENT_SECRET=<paste client secret, no quotes or spaces>
# optional; the default below is what is used if you leave it out:
# GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/google/callback
```
`DATA_MODE=live` also requires `DB_MODE=postgres`, a database URL and a **stable** `SECRET_KEYS` (already in your `.env.local`; keep it, because stored Google tokens cannot be decrypted without it). Delete the downloaded `client_secret_*.json` afterwards or keep it outside the repository (`.gitignore` also blocks `client_secret*.json`; do not rely on that).

Restart the web app (and the MCP server if you use it), because both read the environment at start.

**Production (Hostinger)**: set the same variables in hPanel → each Web App → **Environment variables** (web app and MCP server), never in a file in the repository. Steps in [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md), full table in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## 6. Verify, then test the real OAuth flow

1. `pnpm google:check`: offline. It must show no FAIL, and it prints the redirect URI to register.
2. `pnpm google:check --probe --secret`: asks Google whether it knows your client id and redirect URI, and whether the secret is accepted (it sends a deliberately fake code, so nothing is connected). The redirect-URI probe relies on how Google's sign-in endpoint behaves today (it is not a documented contract), so a PASS is encouraging, not proof. A FAIL tells you what Google objected to.
3. Real flow (the actual proof):
   1. `pnpm dev` (web on http://localhost:3000). Sign in with your app account.
   2. Dashboard → **Connect Search Console**. Your browser should go to `accounts.google.com`; pick a **test user**; click through the unverified-app warning; approve the read-only permission.
   3. You return to the dashboard with "Search Console account connected" and your properties listed. Repeat with **Connect GA4** on the same Google account: the grants merge instead of replacing each other.
   4. Request a report (`POST /api/reports/gsc`, or through Claude once the MCP server is deployed). Disable and re-enable a property; click **Disconnect** and confirm the access disappears at <https://myaccount.google.com/permissions>.
   5. Plan an account A / B / C test: A = your app login, B = a Google account with Search Console access, C = a Google account with GA4 access, plus one account with **no** access (expect an empty list, not an error) and one **not** in the test-user list (expect Google's `access_denied`).

**What I did and did not test.** The code path up to the redirect to Google is covered by `tests/e2e/google-live-config.e2e.ts` (built app, `DATA_MODE=live`, placeholder client: exact redirect URI, scopes, PKCE, state, denial and forged-state handling, no secret leakage). The probe was run against real Google with a nonexistent client and correctly reported `invalid_client`. **No real client existed, so no real Google sign-in, token exchange, property discovery or report has been run. That is your step 3.**

## 7. Going from Testing to production

1. Deploy over HTTPS on a domain you own; verify the domain in Search Console (as an Owner/Editor of the Cloud project).
2. Publish the home page and privacy policy (`/privacy` exists as a **draft** written from the code's behaviour; review it, set `SUPPORT_EMAIL`, and have it checked by whoever advises you on legal matters). It must disclose how Google data is accessed, used, stored and shared, and comply with Google's Limited Use rules.
3. Audience → **Publish app**. If the scopes are sensitive, submit for verification: a YouTube demo video (unlisted) showing the grant flow with the consent screen, app name and client id in the address bar and what each scope enables; a justification for each scope; the verified domain; the privacy policy. Google says this typically takes 3-5 business days. Until verified, users see the unverified-app warning and a user cap applies.
4. Create the production client in the production project with only `https://<domain>/api/oauth/google/callback`, store its secret in the production secret stores, and run `pnpm google:check --probe --secret` with production values.

## 8. Troubleshooting

| You see | Meaning | Fix |
|---|---|---|
| Google page: `redirect_uri_mismatch` | The URI the app sent is not registered **exactly** | Run `pnpm google:check`, register that exact string (scheme, port, path, no trailing slash) |
| Google page: `invalid_client` / "OAuth client was not found" | Wrong or missing client id, or wrong project | Re-copy the Client ID |
| Google page: `access_denied` / "has not completed verification" | Account is not a test user (Testing) | Audience → Test users → Add |
| Dashboard: "not configured" | `GOOGLE_CLIENT_ID`/`SECRET` missing in this process, or `DATA_MODE` is still `mock` | Set them, restart |
| Connected, then "needs attention" a week later | Testing-mode 7-day token expiry | Reconnect; publish the app |
| Dashboard: "Google API access is not configured on this server yet" | An API from section 2 is not enabled | Enable it in the same project as the client |
| `invalid_client` during the callback | Secret is wrong or was rotated | Add a new secret, update both services |
| No properties after connecting | The Google account has no Search Console / GA4 access | Use an account that does |
| Report works in the web app but not through Claude | MCP server lacks the Google variables or uses a different `SECRET_KEYS` | Give it the same values as the web app |
