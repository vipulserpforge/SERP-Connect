# Putting the app online on Hostinger (Cloud plan), step by step

This guide puts **both** parts of your project on your Hostinger Cloud plan:

| Part | What it is | Address you will use |
|---|---|---|
| **Web app** | The website where customers sign up and click "Connect Google" | `https://connect.serpforge.io` |
| **MCP server** | The connection point that Claude talks to | `https://mcp.serpforge.io` |

These docs use `connect.serpforge.io` (website) and `mcp.serpforge.io` (MCP server). Use two *sub*-addresses so each part has its own address. The names themselves do not matter to the code: it reads them only from `NEXT_PUBLIC_APP_URL` and `MCP_PUBLIC_URL`.

You do not need to write code. You will click through Hostinger's control panel (called **hPanel**), GitHub, Supabase and Google, and paste values.

---

## Read this first: what is proven and what is not

I wrote this from Hostinger's own documentation ([Node.js overview](https://docs.hostinger.com/node.js/overview), [creating an app](https://docs.hostinger.com/node.js/creating-an-app), [build settings](https://docs.hostinger.com/node.js/build-settings), [environment variables](https://docs.hostinger.com/node.js/environment-variables), [GitHub deploys](https://docs.hostinger.com/node.js/github)). **I have not deployed to your Hostinger account**, so the first deployment may need a retry or two. What I did test on my computer:

- The two start files this guide tells Hostinger to run (`scripts/start-web.mjs` and `scripts/start-mcp.mjs`) really start the built website and the MCP server, and refuse to run with test/mock settings (automated tests).
- The whole app builds with the commands this guide uses (`pnpm build:web`, `pnpm build:mcp`).

What Hostinger's documentation does **not** say, so you must watch for it during the first deploy (each one has a fix in Part 9):

1. **Monorepo:** Hostinger says that only the "root directory" you choose is built. This project is a *monorepo* (the website and MCP server share code in other folders). So this guide sets the root directory to the **whole repository** and tells Hostinger which file to start. If Hostinger rejects that, see Part 9.
2. **pnpm version:** Hostinger does not say which pnpm version it uses; the project asks for pnpm 12.
3. **Port:** Hostinger does not say how apps are told which port to use. The start files read the standard `PORT` setting if one exists.
4. **Domain assignment:** the pages I read do not describe how a Node.js app is attached to a (sub)domain. Follow what hPanel asks.
5. **Sleeping apps:** Hostinger says apps start on demand and **stop after a period without traffic**, then start again on the next request. That is fine for the website, but Claude may wait a few seconds on the first request after a quiet period (Part 8).

---

## Part 1. Before you start

### 1.1 Check your plan

In hPanel (<https://hpanel.hostinger.com>), your plan must be **Cloud Startup, Cloud Professional, Cloud Enterprise** (or Business Web Hosting): these support "Node.js Web Apps". You need **two** Web Apps (one for the website, one for MCP). Hostinger limits the number of Web Apps per plan; if hPanel says you hit the limit when adding the second one, you must upgrade or remove an unused one.

### 1.2 Your code must be on GitHub

Hostinger deploys from a GitHub repository. Your repository is `vipulserpforge/SERP-Connect`. **Right now the latest work has not been committed or pushed** (only the first commit exists). Before Part 4, ask me (Claude) to commit and push the project to the `main` branch, or do it yourself. Hostinger will then build from `main`. Private repositories are fine.

### 1.3 Pick the two addresses

Your addresses: `connect.serpforge.io` (website) and `mcp.serpforge.io` (MCP). Your domain should be managed in Hostinger (hPanel → **Domains**) so DNS and the free SSL certificate (the padlock) are handled for you. If your domain is elsewhere, point it to Hostinger first.

### 1.4 Tools on your own computer

You need a Terminal window in the project folder once, to create a secret key (Part 2). Nothing else.

---

## Part 2. Collect your values (the worksheet)

Each app needs a list of settings called **environment variables**. Collect the values first, then enter them in Part 4 and Part 5.

> **Never paste secrets into chat, email or GitHub.** You will type them only into your own computer and into hPanel.

### 2.1 Make a private folder

Create a folder **outside** the project, for example `Documents/private-serp/`. You will create two small text files in it, `web.env` and `mcp.env`, and delete them after Part 5 (or move them into a password manager).

### 2.2 Create a fresh encryption key for production

This key locks the Google connections stored in the database. Use a **new** one for the live site (the one in `.env.local` is only for your computer). In Terminal:

```
cd ~/Downloads/"SERP Connect"
node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"
```

Copy the line it prints (it starts with `v1:`). **Save it in your password manager now.** If it is ever lost, every customer must reconnect Google. The website and the MCP server must use the **same** key.

### 2.3 Where each value comes from

| Value | Where to find it |
|---|---|
| Supabase URL, publishable key, database URL | Already in your computer's `.env.local` (open it with `open -e .env.local`). They come from Supabase Dashboard → Project Settings |
| Google Client ID and secret | Created in [`GOOGLE-SETUP-SIMPLE.md`](GOOGLE-SETUP-SIMPLE.md) Part 6 |
| Encryption key | Step 2.2 |

### 2.4 Write the two files

Create `web.env` (plain text, one `NAME=value` per line, **no quotes, no spaces around `=`**):

```
AUTH_MODE=supabase
DB_MODE=postgres
DATA_MODE=live
NEXT_PUBLIC_APP_URL=https://connect.serpforge.io
NEXT_PUBLIC_SUPABASE_URL=<from .env.local>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from .env.local>
SUPABASE_DB_URL=<from .env.local>
SECRET_KEYS=<the key from step 2.2>
CREDENTIAL_FINGERPRINT_KEY=<a second key for Microsoft Clarity and Bing API keys, see docs/CLARITY.md>
# Optional, for "Connect with Bing" (see docs/BING.md). Also add the same two to the MCP server's env.
# BING_CLIENT_ID=<from Bing Webmaster Tools>
# BING_CLIENT_SECRET=<from Bing Webmaster Tools>
# PROVIDER_BING_ENABLED=true   (only after pnpm bing:check --yes passes)
GOOGLE_CLIENT_ID=<from Google>
GOOGLE_CLIENT_SECRET=<from Google>
NEXT_PUBLIC_MCP_URL=https://mcp.serpforge.io/mcp
SUPPORT_EMAIL=vipul@serpforge.io
```

Create `mcp.env`:

```
DB_MODE=postgres
DATA_MODE=live
SUPABASE_DB_URL=<from .env.local>
SECRET_KEYS=<the SAME key as web.env>
CREDENTIAL_FINGERPRINT_KEY=<the SAME value as web.env>
GOOGLE_CLIENT_ID=<same as web.env>
GOOGLE_CLIENT_SECRET=<same as web.env>
MCP_PUBLIC_URL=https://mcp.serpforge.io
MCP_AUTH_MODE=oauth
MCP_OAUTH_ISSUER_URL=https://dphftsifxfhxbhtgabso.supabase.co/auth/v1
MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp
```

Notes:
- **Do not add `NODE_ENV` or `PORT`.** The start files set production mode themselves, and Hostinger controls the port. (Setting `NODE_ENV=production` during the build can stop the build tools from installing, so leave it out.)
- `MCP_RESOURCE_AUDIENCE` only works once the Supabase "access token hook" described in [`MCP.md`](MCP.md) is set up. Until the whole Claude connection is ready, the MCP server will reject real tokens, which is the safe behaviour. Do not use a workaround to skip this.
- The values `NEXT_PUBLIC_…` are baked into the website **while it is built**, so they must be entered **before** you press Deploy (Part 4 does this).
- No other variables are required. Optional ones are listed in `.env.example`.

---

## Part 3. Connect Hostinger to GitHub (one time)

You do this inside the first "Add Website" flow (Part 4, step 4): Hostinger shows **Connect with GitHub**. A GitHub window asks you to install the "Hostinger" GitHub App. Choose **Only select repositories** and pick `SERP-Connect`. Click **Install**.

---

## Part 4. Create the website (Web App #1)

1. Sign in to hPanel → **Websites** → **Add Website**.
2. Choose **Node.js web app**.
3. Choose **Import Git repository**.
4. **Connect with GitHub** (Part 3), select the repository `SERP-Connect`, and the branch `main`.
5. On the settings screen, set **exactly** these (change anything Hostinger auto-filled):

   | Setting | Value |
   |---|---|
   | Application type / Framework preset | **Other** |
   | Node.js version | **24** (22 also works if it is 22.12 or newer; if the build says "engine" or "unsupported version", pick 24) |
   | Package manager | **pnpm** |
   | Root directory | the **repository root** (leave empty or `./`). **Do not** accept an automatic `apps/web` |
   | Build script | `build:web` |
   | Output directory | leave **empty** |
   | Entry file | `scripts/start-web.mjs` |

   Hostinger auto-detects Next.js and may suggest `apps/web` as the root. Override it: this app needs the shared folders (`packages/…`) that sit outside `apps/web`.
6. Find **Set environment variables** on this screen. Click **Import .env**, upload `web.env`, and check the list shows all 13 names. (You can also use **Add environment variable** one at a time.)
7. If hPanel asks which **domain** to use, choose `connect.serpforge.io`. If it does not ask, finish the deploy first and then look in the website's dashboard for a domain / "Connect domain" option.
8. Click **Deploy**. Watch the **build log**. The first build takes several minutes. Success ends with the app showing **Running**.
9. Open `https://connect.serpforge.io/api/health`. You should see `{"status":"ok"}`. Then open `https://connect.serpforge.io/` and `https://connect.serpforge.io/privacy`.

If the build or start fails, go to Part 9.

---

## Part 5. Create the MCP server (Web App #2)

Repeat Part 4 with **Add Website** again, the same repository and branch, and these differences:

| Setting | Value |
|---|---|
| Application type / Framework preset | **Other** |
| Node.js version | **24** |
| Package manager | **pnpm** |
| Root directory | the **repository root** (same as before) |
| Build script | `build:mcp` |
| Output directory | empty |
| Entry file | `scripts/start-mcp.mjs` |
| Environment variables | import `mcp.env` |
| Domain | `mcp.serpforge.io` |

After it shows **Running**, test:

- `https://mcp.serpforge.io/healthz` → `{"status":"ok"}`
- `https://mcp.serpforge.io/.well-known/oauth-protected-resource/mcp` → a small block of text starting with `{"resource":"https://mcp.serpforge.io/mcp"`
- Opening `https://mcp.serpforge.io/mcp` in a browser should show an error "unauthorized" (HTTP 401). **That is correct**: only signed-in Claude may use it.

Then **delete `web.env` and `mcp.env`** from your computer (they contain secrets), keeping the values in your password manager.

---

## Part 6. Tell Supabase and Google about the new addresses

Until you do, sign-up emails and Google sign-in will still point to `localhost`.

### 6.1 Supabase

Supabase Dashboard → your project → **Authentication** → **URL Configuration**:
- **Site URL:** `https://connect.serpforge.io`
- **Redirect URLs:** add `https://connect.serpforge.io/auth/callback` (keep the localhost one if you still test on your computer)
- Save.

For Claude connections (later step): **Authentication → OAuth Server** → enable, and set the **Authorization Path** to `/oauth/consent`. Details in [`MCP.md`](MCP.md).

### 6.2 Google

Google Cloud console → Google Auth Platform → **Clients** → your client → **Authorized redirect URIs** → **Add URI**:
```
https://connect.serpforge.io/api/oauth/google/callback
```
Save. (Details, including test users and publishing: [`GOOGLE-SETUP-SIMPLE.md`](GOOGLE-SETUP-SIMPLE.md), Parts 4, 6 and 9.) While the Google app is in Testing, only accounts you listed as test users can connect, and their connections expire after 7 days.

---

## Part 7. Test the live system

Go in this order and tick each one:

- [ ] Website opens at `https://connect.serpforge.io` with a padlock.
- [ ] Create an account, click the email confirmation link; the link opens `connect.serpforge.io` (not localhost).
- [ ] Sign in; the **Integrations** page appears. The "Use with Claude" box shows `https://mcp.serpforge.io/mcp`.
- [ ] **Connect Search Console**, then **Connect GA4** with a Google account that has access; properties appear.
- [ ] **Disconnect** removes them.
- [ ] On your computer, in the project folder, check the MCP side: `pnpm mcp:check https://mcp.serpforge.io/mcp`. Lines marked FAIL tell you what is missing (for example the Supabase OAuth server or audience setting).
- [ ] Check Google settings with the live values without typing the secret on the command line: `pnpm exec tsx --env-file=<path to web.env> scripts/check-google-oauth.mts --probe --secret` (only possible if you still have the file; otherwise skip, the Connect test above already proves it).
- [ ] Finally add the connector in Claude (Settings → Connectors → Add custom connector → `https://mcp.serpforge.io/mcp`) once the Supabase steps in `MCP.md` are done.

---

## Part 8. Daily life: updates, sleeping, logs

- **Update the site:** push changes to `main` on GitHub. Hostinger rebuilds and restarts automatically (one deployment at a time; extra pushes wait in line). You can also click **Redeploy** in the app's dashboard.
- **Change a setting:** hPanel → the app → **Environment variables** → edit → **Save**. Saving **redeploys** the app so the change takes effect. Do this for both apps if a value is shared (for example a rotated Google secret).
- **Logs:** the app's dashboard → **Deployments** (build logs) and **Runtime logs** (what the running app prints). Logs never contain passwords or tokens, but still do not share screenshots publicly.
- **Sleeping:** Hostinger stops apps after a period without traffic and restarts them on the next request. The first request after a quiet spell is slower. Claude waits up to roughly 10 seconds for connection steps, so if the connector sometimes fails only after quiet periods, set up a free uptime monitor (for example UptimeRobot) to open `https://mcp.serpforge.io/healthz` every 5 minutes. I could not confirm that this prevents Hostinger from stopping the app, so test it. If it does not help, a Hostinger VPS (which runs apps continuously) is the fallback.
- **What resets when the app restarts:** the short-term rate-limit counters (in memory). Saved Google connections and cached reports live in the database and are not lost.

---

## Part 9. If something goes wrong

| What you see | Meaning | What to do |
|---|---|---|
| Build log: "pnpm: not found" or a pnpm version error | Hostinger's pnpm differs from the project's | Set Package manager to **pnpm** and Node to 24; if it still fails, tell me the log lines and I can adjust the project's pnpm setting |
| Build log: engine / "Unsupported engine" | Node too old | Choose Node **24** |
| Build log: `Cannot find module '@serp/…'` or `tsc: not found` | The root directory is a sub-folder, or dev tools were skipped | Root directory must be the **repository root**; do not add `NODE_ENV` |
| Build works, app won't start: "Entry file not found" | Wrong entry path | `scripts/start-web.mjs` for the website, `scripts/start-mcp.mjs` for MCP (no leading slash) |
| Page shows "Internal Server Error" and Runtime logs say "Refusing to start in production with …mock…" | A test setting is still on | Make sure `AUTH_MODE=supabase`, `DB_MODE=postgres`, `DATA_MODE=live` (web) and `MCP_AUTH_MODE=oauth` (MCP) |
| Runtime logs: "Invalid environment configuration: NAME" | A value is missing or malformed | Fix that variable in hPanel and Save |
| Runtime logs mention the database | Wrong `SUPABASE_DB_URL` (needs the **pooler** URL including the password) | Copy it again from Supabase → Project Settings → Database |
| 502 / "bad gateway" right after deploy | App is still starting, or it listens on the wrong port | Wait a minute; check Runtime logs; if it stays, contact Hostinger support and tell them the app reads the `PORT` environment variable |
| Sign-up email link goes to localhost | Supabase Site URL not updated | Part 6.1 |
| Google: `redirect_uri_mismatch` | The live address is not registered in Google | Part 6.2, exactly `https://connect.serpforge.io/api/oauth/google/callback` |
| Dashboard Connect button is disabled | `GOOGLE_CLIENT_ID/SECRET` or `DATA_MODE=live` missing in the **web** app | Check variables, Save (redeploys) |
| Connected on the website but Claude's reports fail | MCP app lacks Google variables or has a different `SECRET_KEYS` | Make `mcp.env` values match `web.env` |
| `mcp:check` says the audience/OAuth server is not ready | Supabase side not finished | Follow [`MCP.md`](MCP.md) |
| You can't add the second app | Plan limit | Upgrade, or remove an unused app |

### If Hostinger cannot run this project

If after two honest attempts Hostinger's monorepo handling blocks the build, the options are (best first): a **Hostinger VPS** where you (or I, guided) run the same commands manually with a process manager; or another Node host. Do not split the project into separate repositories without discussing it: the website and MCP server share the same code and database rules.

---

## Quick reference

| | Website | MCP server |
|---|---|---|
| Address | `https://connect.serpforge.io` | `https://mcp.serpforge.io` (endpoint `/mcp`) |
| Build script | `build:web` | `build:mcp` |
| Entry file | `scripts/start-web.mjs` | `scripts/start-mcp.mjs` |
| Root directory | repository root | repository root |
| Health check | `/api/health` | `/healthz` |
| Node / package manager | 24 / pnpm | 24 / pnpm |
| Env file to import | `web.env` | `mcp.env` |
