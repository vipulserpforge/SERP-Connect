# Putting SERP Connect online (Hostinger), step by step

This guide puts your project on the internet in **two parts**. You only click and paste. You do not write code.

| Part | What it does | Its address |
|---|---|---|
| **Website** | Where customers sign up and click "Connect Google" | `https://connect.serpforge.io` |
| **MCP server** | The connection point that Claude talks to | `https://mcp.serpforge.io` |

Both parts come from the same GitHub project (`vipulserpforge/SERP-Connect`, branch `main`). You will create **two apps** in Hostinger, one for each address.

---

## The big picture

| Step | What you do | Time |
|---|---|---|
| 1 | Check your Hostinger plan and domain | 5 min |
| 2 | Find your two settings files | 5 min |
| 3 | Create the **website** in Hostinger | 15 min |
| 4 | Create the **MCP server** in Hostinger | 15 min |
| 5 | Update **Supabase** | 10 min |
| 6 | Update **Google** | 5 min |
| 7 | Test everything | 10 min |
| 8 | Clean up | 2 min |

### What is already done for you

- [x] The project code is on GitHub (`main`).
- [x] The two settings files are created: `~/Documents/private-serp/web.env` and `~/Documents/private-serp/mcp.env`.
- [x] The Supabase "audience hook" function is installed (you only switch it on, Step 5).
- [x] The documents use your real addresses.

### Words you will see

- **hPanel**: Hostinger's control panel (<https://hpanel.hostinger.com>).
- **Environment variables**: the list of settings an app needs (like database address and keys). They are inside your two `.env` files.
- **Deploy**: Hostinger copies the project from GitHub, builds it and starts it.

> **Golden rule:** never paste passwords or keys into chat, email or GitHub. Only put them into your own computer and into hPanel.

---

## Read this first: what is tested and what is not

I wrote these steps from Hostinger's own documentation. **I have not deployed to your Hostinger account**, so the first deploy may need a retry. Tested on my computer: the project builds with the commands below, and the start files run the website and the MCP server correctly.

Not confirmed by Hostinger's documentation, so watch for them (fixes are in Step 9):
1. Hostinger may try to pick the wrong **root directory** for this project (see Step 3, point 5).
2. Hostinger does not say which **pnpm** version it uses.
3. Hostinger does not describe exactly how an app is attached to an address. Follow what hPanel asks.
4. Hostinger apps **go to sleep** when nobody visits, and wake on the next visit. The first visit after a quiet time is slower.

---

## Step 1. Check your Hostinger plan and domain

**1.1 Your plan**
1. Sign in to <https://hpanel.hostinger.com>.
2. Your plan must be **Cloud Startup**, **Cloud Professional**, **Cloud Enterprise** or **Business Web Hosting**. These support "Node.js Web Apps".
3. You need room for **two** Node.js web apps. If Hostinger says you reached the limit when adding the second app, upgrade the plan or remove an app you do not use.

**1.2 Your domain**
1. In hPanel, click **Domains**.
2. Check that **serpforge.io** is listed there. Then Hostinger takes care of the address setup and the free padlock (SSL) for you.
3. If it is **not** listed (the domain is registered somewhere else), tell Claude where it is registered and ask for help pointing it to Hostinger before you continue.

---

## Step 2. Find your two settings files

They are already created, in the folder `Documents/private-serp` (inside your home folder):

| File | Used for | Number of settings |
|---|---|---|
| `web.env` | the website | 13 |
| `mcp.env` | the MCP server | 11 |

**To see them in Finder:** open Finder, press **Shift + Cmd + G**, paste `~/Documents/private-serp` and press Enter.

> The files are hidden-style names (they end in `.env`). If you cannot see them, press **Shift + Cmd + .** (full stop) in Finder to show hidden files.

**2.1 Back up the main key (important, do it now)**
1. Right-click `web.env` → **Open With** → **TextEdit**.
2. Find the line that starts with `SECRET_KEYS=`.
3. Copy everything after the `=` sign (it starts with `v1:`).
4. Save it in your password manager with a name like "SERP Connect production key".
5. Close the file without changing anything.

Why: this key locks the Google connections stored in your database. If it is ever lost, **every customer must reconnect Google**.

**2.2 What is inside (for your information only, no action)**

`web.env` contains these names: `AUTH_MODE`, `DB_MODE`, `DATA_MODE`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXT_PUBLIC_MCP_URL`, `SUPPORT_EMAIL` (set to `vipul@serpforge.io`).

`mcp.env` contains: `DB_MODE`, `DATA_MODE`, `SUPABASE_DB_URL`, `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MCP_PUBLIC_URL`, `MCP_AUTH_MODE`, `MCP_OAUTH_ISSUER_URL`, `MCP_RESOURCE_AUDIENCE`.

Rules to remember:
- `SECRET_KEYS` and `CREDENTIAL_FINGERPRINT_KEY` must be **identical** in both files. They are.
- Do **not** add `NODE_ENV` or `PORT`. The app and Hostinger handle those.
- Bing (the optional "Connect with Bing" feature) is left out on purpose. See `BING.md` later if you want it.

---

## Step 3. Create the website (App #1)

**3.1 Start**
1. In hPanel, click **Websites** → **Add Website**.
2. Choose **Node.js web app**.
3. Choose **Import Git repository**.

**3.2 Connect GitHub (first time only)**
1. Click **Connect with GitHub**.
2. A GitHub window opens and asks you to install the "Hostinger" app. Choose **Only select repositories**.
3. Pick **SERP-Connect**, then click **Install**.
4. Back in Hostinger, choose repository **SERP-Connect** and branch **main**.

**3.3 Settings.** Set these **exactly**. Change anything Hostinger filled in by itself.

| Setting | What to enter |
|---|---|
| Framework preset / Application type | **Other** |
| Node.js version | **24** |
| Package manager | **pnpm** |
| Root directory | **Leave empty** (or `./`) |
| Build script / Build command | `build:web` |
| Output directory | **Leave empty** |
| Entry file | `scripts/start-web.mjs` |

> **Important about "Root directory":** Hostinger sees "Next.js" and may fill in `apps/web`. **Delete it** and leave the box empty. The website needs other folders of the project that sit outside `apps/web`.

**3.4 Add the settings**
1. Find **Set environment variables** on the same screen.
2. Click **Import .env** and choose `~/Documents/private-serp/web.env`.
3. Check that the list shows **13 names**. If one is missing, click **Add environment variable** and add it by hand.

**3.5 Address (domain)**
- If Hostinger asks which domain to use, choose **connect.serpforge.io**.
- If it does not ask, finish the deploy first and then look for **Connect domain** (or similar) in this app's dashboard.

**3.6 Deploy**
1. Click **Deploy**.
2. Watch the **build log**. The first build takes **several minutes**.
3. Success looks like: the app status shows **Running**.

**3.7 Check it works.** Open these three addresses in your browser:

| Address | You should see |
|---|---|
| `https://connect.serpforge.io/api/health` | `{"status":"ok"}` |
| `https://connect.serpforge.io/` | the website home page |
| `https://connect.serpforge.io/privacy` | the privacy page showing `vipul@serpforge.io` |

If anything fails, go to **Step 9**.

---

## Step 4. Create the MCP server (App #2)

Do **Add Website** again (Step 3.1). The repository (**SERP-Connect**) and branch (**main**) are the same. Only these settings are different:

| Setting | What to enter |
|---|---|
| Framework preset / Application type | **Other** |
| Node.js version | **24** |
| Package manager | **pnpm** |
| Root directory | **Leave empty** |
| Build script / Build command | `build:mcp` |
| Output directory | **Leave empty** |
| Entry file | `scripts/start-mcp.mjs` |
| Environment variables | **Import .env** → `~/Documents/private-serp/mcp.env` (check: **11 names**) |
| Domain | **mcp.serpforge.io** |

Click **Deploy** and wait for **Running**.

**Check it works.** Open these addresses:

| Address | You should see |
|---|---|
| `https://mcp.serpforge.io/healthz` | `{"status":"ok"}` |
| `https://mcp.serpforge.io/.well-known/oauth-protected-resource/mcp` | text starting with `{"resource":"https://mcp.serpforge.io/mcp"` |
| `https://mcp.serpforge.io/mcp` | an "unauthorized" error. **This is correct.** Only a signed-in Claude may use this address. |

---

## Step 5. Update Supabase

Open <https://supabase.com/dashboard>, choose your SERP Connect project, and do the three parts below **in order**.

**5.1 Tell Supabase your website address**
1. Left menu → **Authentication** → **URL Configuration**.
2. **Site URL:** `https://connect.serpforge.io`
3. Under **Redirect URLs** click **Add URL** and add: `https://connect.serpforge.io/auth/callback`
4. Click **Save**.

Why: otherwise sign-up emails still link to `localhost`.

**5.2 Switch on the audience hook**
1. Left menu → **Authentication** → **Hooks**.
2. Find **Customize Access Token (JWT) Claims** and click **Add hook** (or **Enable**).
3. Hook type: **Postgres**.
4. Schema: `public`. Function: `custom_access_token_hook`.
5. Click **Create** / **Save**.

Why: this makes the tokens given to Claude valid only for your MCP server. The function is already installed. It changes tokens for Claude only, never normal website logins.

**5.3 Switch on the OAuth Server (the Claude connection)**
1. Left menu → **Authentication** → **OAuth Server**.
2. Turn it **on**.
3. **Authorization Path:** `/oauth/consent`
4. Allow **Dynamic Client Registration** (Claude needs this to introduce itself).
5. Click **Save**.

Do 5.3 only after Step 3 works, because Supabase uses the Site URL from 5.1.

---

## Step 6. Update Google

1. Open <https://console.cloud.google.com> and select your project.
2. Go to **Google Auth Platform** → **Clients** and click your client.
3. Under **Authorized redirect URIs** click **Add URI** and paste exactly:

   ```
   https://connect.serpforge.io/api/oauth/google/callback
   ```
4. Click **Save**. It can take a few minutes to apply.

Notes:
- No space and no `/` at the end.
- While the Google app is in **Testing**, only accounts listed as **test users** can connect, and their connections expire after 7 days. Details: [`GOOGLE-SETUP-SIMPLE.md`](GOOGLE-SETUP-SIMPLE.md).
- The Google ID and secret in your files are the ones from your computer's test setup. For public customers, Google advises a separate live Google project (see `GOOGLE-SETUP-SIMPLE.md`, Part 9). If you create one, replace `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in **both** Hostinger apps.

---

## Step 7. Test the whole system

Do these in order and tick each one:

- [ ] `https://connect.serpforge.io` opens with a padlock.
- [ ] Create an account and click the link in the confirmation email. It opens `connect.serpforge.io` (not `localhost`).
- [ ] Sign in. The **Integrations** page appears, and the "Use with Claude" box shows `https://mcp.serpforge.io/mcp`.
- [ ] Click **Connect Search Console**, then **Connect GA4**, using a Google account that has access. Your properties appear.
- [ ] Click **Disconnect**. They disappear.
- [ ] Ask Claude (in this project) to run the connection check: `pnpm mcp:check https://mcp.serpforge.io/mcp`. Any line marked **FAIL** tells you what is still missing.
- [ ] In Claude: **Settings** → **Connectors** → **Add custom connector** → paste `https://mcp.serpforge.io/mcp` → sign in → approve. Then ask Claude: "Run get_connection_status".

---

## Step 8. Clean up

When Steps 3 and 4 both work:
1. Check that your key is saved in your password manager (Step 2.1).
2. Move `web.env` and `mcp.env` to the Trash and empty the Trash. They contain secrets.

> If you may need to redeploy soon, keep the files until everything is stable. You can always copy the values from hPanel → the app → **Environment variables**.

---

## Step 9. If something goes wrong

Find your message in the table. If it does not help, send Claude the error text from the **build log** (hPanel → the app → **Deployments**) or **Runtime logs**. Do **not** include passwords or keys.

| What you see | What it means | What to do |
|---|---|---|
| Build log: "pnpm: not found" or a pnpm version error | Hostinger's pnpm differs from the project's | Check Package manager = **pnpm**, Node = **24**. If it still fails, send Claude the log lines |
| Build log: "engine" / "Unsupported engine" | Node version too old | Choose Node **24** |
| Build log: `Cannot find module '@serp/…'` or `tsc: not found` | Root directory is not the whole project | Leave Root directory **empty**. Do not add `NODE_ENV` |
| "Entry file not found" | Typing mistake in the entry file | Website: `scripts/start-web.mjs`. MCP: `scripts/start-mcp.mjs`. No `/` at the start |
| "Internal Server Error" and the logs say "Refusing to start in production with …mock…" | A test setting is on | Make sure `AUTH_MODE=supabase`, `DB_MODE=postgres`, `DATA_MODE=live` (website) and `MCP_AUTH_MODE=oauth` (MCP) |
| Logs say "Invalid environment configuration: NAME" | A setting is missing or wrong | Fix that setting in hPanel and **Save** |
| Logs mention the database | Wrong `SUPABASE_DB_URL` | Copy it again from Supabase → Project Settings → Database (the **pooler** address with the password) |
| "502" or "bad gateway" right after deploy | The app is still starting | Wait a minute and refresh. If it stays, contact Hostinger support and tell them the app reads the `PORT` setting |
| Sign-up email link goes to localhost | Supabase Site URL not updated | Step 5.1 |
| Google says `redirect_uri_mismatch` | The address is not registered in Google | Step 6, exactly as written |
| "Connect" button on the dashboard is greyed out | Google settings or `DATA_MODE=live` missing in the **website** app | Check the settings, then **Save** (this redeploys) |
| Connected on the website, but Claude's reports fail | The MCP app is missing Google settings, or has a different `SECRET_KEYS` | Make `mcp.env` values match `web.env` |
| The connection check says "audience" or "OAuth server" not ready | Supabase steps not finished | Step 5.2 and 5.3, and [`MCP.md`](MCP.md) |
| You cannot add the second app | Plan limit | Upgrade or remove an unused app |

**If Hostinger cannot run this project at all:** after two honest attempts, the next best option is a Hostinger **VPS** (a server that runs apps all the time), where Claude can guide you through the same steps. Do not split the project into separate repositories without asking Claude first.

---

## Later: everyday tasks

- **Update the site:** when new code is pushed to `main` on GitHub, Hostinger rebuilds and restarts automatically. Or click **Redeploy** in the app's dashboard.
- **Change a setting:** hPanel → the app → **Environment variables** → edit → **Save**. Saving redeploys the app. If a value is shared (like the Google secret), change it in **both** apps.
- **See logs:** the app's dashboard → **Deployments** (build) and **Runtime logs** (running app).
- **Sleeping apps:** Hostinger stops apps after quiet periods and restarts them on the next visit. Claude waits only about 10 seconds for connection steps, so the connector may fail on the first try after a long quiet time. A free monitor such as UptimeRobot, set to open `https://mcp.serpforge.io/healthz` every 5 minutes, may help. I could not confirm that it stops Hostinger from putting the app to sleep, so test it. If it does not help, a Hostinger VPS is the fix.
- **What resets on restart:** only short-term rate-limit counters. Google connections and saved reports live in the database and are safe.

---

## Quick reference

| | Website | MCP server |
|---|---|---|
| Address | `https://connect.serpforge.io` | `https://mcp.serpforge.io` (connector link: `/mcp`) |
| Build script | `build:web` | `build:mcp` |
| Entry file | `scripts/start-web.mjs` | `scripts/start-mcp.mjs` |
| Root directory | empty (whole project) | empty (whole project) |
| Node / package manager | 24 / pnpm | 24 / pnpm |
| Settings file to import | `web.env` (13 names) | `mcp.env` (11 names) |
| Health check | `/api/health` | `/healthz` |
| Contact email on privacy page | `vipul@serpforge.io` | (not used) |
