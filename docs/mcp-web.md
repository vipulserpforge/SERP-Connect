# Website on Vercel + MCP server on your own VPS (step by step)

This guide puts the two parts of SERP Connect in two different places and connects them:

| Part | Where it runs | Its address |
|---|---|---|
| **Website** (customers sign up, click "Connect Google") | **Vercel** | `https://connect.visibll.in` |
| **MCP server** (the connection point Claude talks to) | **Your private VPS** | `https://mcp.visibll.in` |

You do not write code. You click, copy and paste. Every step says **what to do**, **what you should see**, and **why**.

---

## 0. The big picture (read this once)

```
 Customer's browser ──► connect.visibll.in ──► Vercel (website)
                                                    │
                                                    ▼
                                             Supabase (database + sign-in)
                                                    ▲
                                                    │
 Claude ──► mcp.visibll.in ──► Nginx ──► MCP server (PM2) on your VPS
```

- The two parts **do not talk to each other directly**. They share the same Supabase database, the same secret key (`SECRET_KEYS`) and the same Google settings. That is why the settings files must match (Part 2).
- **Vercel** builds the website from GitHub every time you push to `main`.
- **Your VPS** runs the MCP server all the time (it never "goes to sleep"), so the Claude connector stays reliable.
- **Nginx** is a doorman on the VPS: it receives visitors on the normal web ports and passes them to the MCP server. It also holds the HTTPS padlock.
- **PM2** is a babysitter on the VPS: it starts the MCP server, restarts it if it crashes, and starts it again after a reboot.

### What is tested and what is not

Tested on my computer, in a clean copy of the project:
- The MCP server installs, builds and starts under **PM2** with your real `mcp.env`. Its health check, its Claude discovery page and its "unauthorized" answer all behave correctly.
- The install used on the VPS (only what the MCP server needs) works with the project's locked package list.
- The website builds with the same command Vercel will use (`pnpm build:web`).

**Not tested** (I have no access to your Vercel account or your VPS): the real Vercel build and the real VPS commands. The first run may need a retry. Section 9 has fixes for the likely problems.

---

## 1. What you need before you start

| Need | Details |
|---|---|
| **GitHub** | Your code is already on `vipulserpforge/SERP-Connect`, branch `main`. |
| **Vercel account** | Free signup at <https://vercel.com> (use "Continue with GitHub"). See the note on plans below. |
| **A VPS** | Operating system **Ubuntu 24.04** (or 22.04; **not** CentOS, AlmaLinux or Windows), **1 GB RAM minimum, 2 GB comfortable**, a public IP address, and `root` login. When ordering, set the **Hostname** to `mcp.visibll.in`, choose a long unique root password, leave NS1/NS2 as they are, and add no extra disk or IP. |
| **Access to DNS for `visibll.in`** | Wherever your domain's DNS is managed (your domain registrar or host). You will add two records: `mcp` (to the VPS) and `connect` (to Vercel). |
| **An email-sending service (SMTP)** | For sign-up and password emails (section 7.5). Free options: Resend, Brevo. |
| **Your two settings files** | `~/Documents/private-serp/web.env` and `~/Documents/private-serp/mcp.env` (already created). |
| **A Mac Terminal** | Press **Cmd + Space**, type `Terminal`, press Enter. You paste commands into it. |

> **Vercel plan note:** Vercel's free **Hobby** plan is for personal, **non-commercial** use. If SERP Connect is a business or charges customers, use Vercel's paid **Pro** plan. Check Vercel's current terms before you launch.

> **Golden rule:** never paste passwords or keys into chat, email or GitHub. Only into your Mac, Vercel's settings page and the VPS.

---

## 1a. The order of work (follow this exactly)

Doing the steps in this order avoids most problems:

| # | Do this | Section |
|---|---|---|
| 1 | Buy the VPS (Ubuntu 24.04) and note its IP address | 1 |
| 2 | Add the DNS record `mcp` → your VPS IP | 4 |
| 3 | Set up the VPS, start the MCP server, turn on HTTPS | 5 |
| 4 | Put the website on Vercel, add `connect.visibll.in` | 6 |
| 5 | Supabase: website address, email (SMTP), audience hook, OAuth Server | 7.1 to 7.5 |
| 6 | Google: add the new return address and website details | 7.6 |
| 7 | Test everything and connect Claude | 8 |

Your `web.env` and `mcp.env` files were already updated to the `visibll.in` addresses. The Supabase database hook was also already updated to `https://mcp.visibll.in/mcp`.

---

## 2. Which settings go where

You already made two files. Each part gets its own file:

| File on your Mac | Goes to | Number of settings |
|---|---|---|
| `web.env` | **Vercel** (website) | 13 |
| `mcp.env` | **VPS** (MCP server) | 11 |

These must be **identical in both files**, or Claude's reports will fail:
`SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPABASE_DB_URL`. They are identical today. If you change one later, change it in **both** places.

**The database address in both files is already the IPv4 "pooler" address** (`aws-0-ap-southeast-1.pooler.supabase.com:6543`). This matters: Supabase's other address, `db.<project>.supabase.co`, only works over IPv6, and **Vercel cannot reach it**. If you ever rebuild these files from `.env.local`, copy the **Transaction pooler** string from Supabase → Project Settings → Database → Connection string instead.

**Back up the key now:** open `web.env` in TextEdit, copy the value after `SECRET_KEYS=` into your password manager, and close the file. If it is lost, every customer must reconnect Google.

---

## 3. What was added to the project (for your information)

Nothing in the app itself was changed. Only new files were added:

```
apps/web/vercel.json              Tells Vercel how to install and build the website
deploy/vps/
  setup-server.sh                 One-time preparation of the VPS (Node, pnpm, PM2, Nginx, firewall)
  deploy.sh                       Update command: download new code, build, restart, check
  ecosystem.config.cjs            PM2 settings: how to run the MCP server
  nginx-mcp.conf.example          Nginx settings: pass web traffic to the MCP server
  mcp.env.example                 Empty template of the MCP settings (no secrets)
docs/mcp-web.md                   This guide
```

Real secrets are **never** stored in the project. They stay in `web.env` / `mcp.env`, in Vercel's settings page, and in one private file on the VPS.

**Before you begin, make sure this is on GitHub.** Ask Claude: "commit and push the deploy files to main". Vercel and your VPS both download the code from GitHub, so they cannot see files that are only on your Mac.

---

## 4. Part A: Point your addresses (DNS)

You will add two DNS records. Do the MCP one first, because it takes a while to spread across the internet.

1. Log in to wherever DNS for `visibll.in` is managed. In Hostinger this is hPanel → **Domains** → `visibll.in` → **DNS / Nameservers** → **DNS records**.
2. **Add this record** (replace `YOUR.VPS.IP` with your VPS's public IP address, from your VPS provider's dashboard):

   | Type | Name | Points to / Value | TTL |
   |---|---|---|---|
   | **A** | `mcp` | `YOUR.VPS.IP` | 300 (or the lowest allowed) |

3. The website record comes later in Part D, when Vercel tells you the exact value.
4. **Check it spread:** open <https://dnschecker.org>, type `mcp.visibll.in`, choose type **A**, press Search. When most places show your IP address, it is ready. It can take from 5 minutes to a few hours.

> Delete any old record for `mcp` (for example one pointing to Hostinger). Two records for the same name cause random failures.

---

## 5. Part B: Set up the VPS

All commands in this part are typed into **Terminal on your Mac**, after you connect to the VPS. Where you see `YOUR.VPS.IP`, use your real IP.

### 5.1 Connect to the VPS

1. In Terminal type: `ssh root@YOUR.VPS.IP` and press Enter.
2. If it asks "Are you sure you want to continue connecting?", type `yes` and press Enter.
3. Enter the password (or your provider's key). Typed passwords stay invisible. That is normal.
4. **You should see** a prompt like `root@something:~#`. You are now "inside" the VPS. Everything you type now runs there.

> If your provider gave you a normal user instead of `root`, put `sudo` in front of the commands that need it, or run `sudo -i` first to become root.

### 5.2 Create the app user and install Git

This makes a separate, limited user called `serp` to run the app (safer than running as root).

Paste these two lines:

```
adduser --disabled-password --gecos "" serp
apt-get update -y && apt-get install -y git
```

### 5.3 Let the VPS download your private code from GitHub

The VPS needs a read-only "key" to download your repository.

1. Switch to the app user:

   ```
   su - serp
   ```
   The prompt changes to `serp@...$`.

2. Create the key (this makes two files; press nothing if it asks nothing):

   ```
   ssh-keygen -t ed25519 -C "serp-vps" -N "" -f ~/.ssh/id_ed25519
   ```

3. Show the public half and copy it:

   ```
   cat ~/.ssh/id_ed25519.pub
   ```
   It prints one long line starting with `ssh-ed25519`. Select the whole line and copy it (Cmd + C).

4. In your browser open `https://github.com/vipulserpforge/SERP-Connect` → **Settings** → **Deploy keys** → **Add deploy key**.
   - **Title:** `serp-vps`
   - **Key:** paste the line.
   - Leave **Allow write access** **unticked** (read-only is safer).
   - Click **Add key**.

5. Back in Terminal, trust GitHub and download the project:

   ```
   ssh-keyscan github.com >> ~/.ssh/known_hosts
   git clone git@github.com:vipulserpforge/SERP-Connect.git
   ```
   **You should see** "Cloning into 'SERP-Connect'..." and then it finishes.

6. Go back to root:

   ```
   exit
   ```
   The prompt returns to `root@...#`.

### 5.4 Run the one-time server setup

Paste this single line:

```
bash /home/serp/SERP-Connect/deploy/vps/setup-server.sh
```

It takes a few minutes. It installs Node 24, pnpm, PM2, Nginx and a firewall, and prepares the Nginx site for `mcp.visibll.in`.

**You should see** at the end: `Server is ready. Node v24…, pnpm 12.14.0, PM2 …`.

What the firewall does: it lets in **only** SSH (port 22), web (80) and secure web (443). The MCP server's own port (8787) stays closed to the internet. Only Nginx can reach it.

> If your VPS uses a different SSH port, run it as `SSH_PORT=2222 bash /home/serp/SERP-Connect/deploy/vps/setup-server.sh` (use your port), otherwise you can lock yourself out.

### 5.5 Put the MCP settings on the VPS

1. **On your Mac** (open a **new Terminal window**, do not use the VPS window), copy the file's contents to your clipboard without showing it:

   ```
   pbcopy < ~/Documents/private-serp/mcp.env
   ```
   Nothing is printed. That is correct.

2. **In the VPS window**, become the app user and open a new file:

   ```
   su - serp
   nano ~/mcp.env
   ```

3. Paste with **Cmd + V**. You should see the 11 lines.
4. Save: press **Ctrl + O**, then **Enter**. Exit: press **Ctrl + X**.
5. Make the file private (only `serp` can read it):

   ```
   chmod 600 ~/mcp.env
   ```

6. Quick check that it has 11 settings (this prints only a number):

   ```
   grep -c '=' ~/mcp.env
   ```
   **You should see** `11`.

### 5.6 First start of the MCP server

Still as `serp`, paste:

```
bash ~/SERP-Connect/deploy/vps/deploy.sh
```

It prints 5 numbered steps (download, install, build, restart, check). The first run takes a few minutes.

**You should see** at the end: `OK: MCP server is running ({"status":"ok"})`.

Make PM2 remember the app for reboots (you already did the other half in 5.4):

```
pm2 save
```

Useful commands for later (as `serp`):

| Command | What it does |
|---|---|
| `pm2 status` | Shows if the app is `online` |
| `pm2 logs serp-mcp --lines 50` | Shows the latest messages |
| `pm2 restart serp-mcp` | Restarts it |

Then go back to root for the next step: type `exit`.

### 5.7 Turn on HTTPS (the padlock)

**Only do this when DNS is ready** (Part A, step 4 showed your IP). As `root`, paste (replace `YOUR-EMAIL` with your real email address; it is used only for certificate expiry warnings):

```
certbot --nginx -d mcp.visibll.in -m YOUR-EMAIL --agree-tos --no-eff-email --redirect
```

**You should see** "Successfully received certificate" and "Congratulations".

Certificates renew by themselves. To confirm the renewal works, run `certbot renew --dry-run`.

### 5.8 Test the MCP server from the internet

On your Mac, open these addresses in your browser:

| Address | You should see |
|---|---|
| `https://mcp.visibll.in/healthz` | `{"status":"ok"}` with a padlock |
| `https://mcp.visibll.in/.well-known/oauth-protected-resource/mcp` | text starting with `{"resource":"https://mcp.visibll.in/mcp"` |
| `https://mcp.visibll.in/mcp` | an "unauthorized" error. **This is correct.** Only a signed-in Claude may use it. |

If one fails, see section 9.

---

## 6. Part C: Put the website on Vercel

### 6.1 Import the project

1. Sign in at <https://vercel.com> (with GitHub).
2. Click **Add New…** → **Project**.
3. Find **SERP-Connect** in the list and click **Import**. If it is missing, click **Adjust GitHub App Permissions**, allow the repository, and come back.

### 6.2 Project settings (do each one before you press Deploy)

1. **Project Name:** `serp-connect` (any name).
2. **Framework Preset:** it should say **Next.js**. Leave it.
3. **Root Directory:** click **Edit**, choose **`apps/web`**, click **Continue**.
   - Why: that is the website's folder. The project already contains a `vercel.json` there that tells Vercel to build from the whole project, because the website needs the shared folders.
4. Leave **Build Command**, **Output Directory** and **Install Command** as they are (the `vercel.json` file fills them in).
5. **Environment Variables:**
   1. Open `~/Documents/private-serp/web.env` on your Mac in TextEdit, select everything and copy it.
   2. In Vercel, click inside the first **Key** box and paste (Cmd + V). Vercel splits the lines into separate settings automatically.
   3. Check there are **13** settings. All must be set for **Production** (the default).
   4. Click **Add** (or add one more by hand): `ENABLE_EXPERIMENTAL_COREPACK` = `1`. Why: this makes Vercel use the project's pnpm version (12.14.0).
   - These `NEXT_PUBLIC_…` values are baked in while the website is **built**, so they must be here **before** you deploy.
6. Click **Deploy** and wait. The first build takes several minutes.

**You should see** confetti and "Congratulations", with a preview address like `serp-connect-xxxx.vercel.app`.

### 6.3 Choose the Node version

If the build complains about Node: open the project → **Settings** → **General** → **Node.js Version** → choose **24.x** (22.x also works) → **Save**, then redeploy (Deployments → the latest → **⋯** → **Redeploy**).

### 6.4 Connect your address

1. In the Vercel project open **Settings** → **Domains**.
2. Type `connect.visibll.in` and click **Add**.
3. Vercel shows a DNS record to create. Usually it is:

   | Type | Name | Value |
   |---|---|---|
   | **CNAME** | `connect` | the value Vercel shows (often `cname.vercel-dns.com`) |

   **Use exactly what Vercel shows** if it differs.
4. Add that record in your DNS page (same place as Part A).
5. Go back to Vercel. In a few minutes the domain shows a green tick and Vercel adds the HTTPS padlock by itself.

### 6.5 Test the website

Open these addresses:

| Address | You should see |
|---|---|
| `https://connect.visibll.in/api/health` | `{"status":"ok"}` |
| `https://connect.visibll.in/` | the home page, with a padlock |
| `https://connect.visibll.in/privacy` | the privacy page showing your support email (the `SUPPORT_EMAIL` setting) |

---

## 7. Part D: Connect everything (Supabase and Google)

Now tell Supabase and Google your new addresses.

### 7.1 Supabase: your website address

1. Open <https://supabase.com/dashboard> → your SERP Connect project.
2. Left menu → **Authentication** → **URL Configuration**.
3. **Site URL:** `https://connect.visibll.in`
4. **Redirect URLs** → **Add URL**: `https://connect.visibll.in/auth/callback`
5. Click **Save**.

Why: otherwise sign-up emails still link to `localhost`.

### 7.2 Supabase: switch on the audience hook

The hook function is already installed in your database. You only switch it on.

1. **Authentication** → **Hooks**.
2. **Customize Access Token (JWT) Claims** → **Add hook** (or **Enable**).
3. Type **Postgres**, schema `public`, function `custom_access_token_hook`.
4. **Create** / **Save**.

Why: it makes the tokens given to Claude valid **only** for `https://mcp.visibll.in/mcp`.

### 7.3 Supabase: switch on the OAuth Server (the Claude sign-in)

Do this **after** 6.5 works and 7.1 is saved.

1. **Authentication** → **OAuth Server** → turn it **on**.
2. **Authorization Path:** `/oauth/consent`
3. Allow **Dynamic Client Registration** (Claude needs it to introduce itself).
4. **Save**.

### 7.4 Check Supabase has no old address left

1. **Authentication** → **URL Configuration**: Site URL must be `https://connect.visibll.in`, and no `localhost` or `serpforge.io` address should remain in **Redirect URLs** (you can keep `http://localhost:3000/auth/callback` if you still develop on your Mac).
2. **Authentication** → **Hooks**: if you had already switched the hook on, nothing to change. The function inside the database was already updated to `https://mcp.visibll.in/mcp`.

### 7.5 Supabase: sign-up emails (SMTP)

Why: Supabase's built-in email sender only delivers to people in your own Supabase team and is limited to a few emails per hour. Real customers will not get their confirmation email without your own sender.

1. Create a free account at an email service, for example <https://resend.com> or <https://brevo.com>.
2. In that service add your domain **`visibll.in`** and follow its steps. It shows you a few DNS records (SPF, DKIM, sometimes DMARC). **Add each one in your DNS page** and wait until the service says **Verified**.
3. In that service create SMTP credentials. You get: **host**, **port** (use `465` or `587`), **username**, **password**.
4. Supabase → **Authentication** → **Emails** (or **Settings**) → **SMTP Settings** → turn on **Enable custom SMTP** and enter:
   - **Sender email:** `no-reply@visibll.in`
   - **Sender name:** `SERP Connect`
   - **Host / Port / Username / Password:** from step 3
5. Click **Save**.
6. Optional but nice: **Authentication** → **Emails** → **Templates** → check that the **Confirm sign up** and **Reset password** emails look right. They use `{{ .ConfirmationURL }}` and will open `connect.visibll.in` because of the Site URL (7.1).
7. **Test:** sign up on the live site with an email that is **not** in your Supabase team. The email must arrive (check spam), and its button must open `connect.visibll.in`.

### 7.6 Google: new addresses

Open <https://console.cloud.google.com> → select your project → **Google Auth Platform**.

1. **Clients** → click your OAuth client → **Authorized redirect URIs** → **Add URI**, paste exactly (no space, no `/` at the end):

   ```
   https://connect.visibll.in/api/oauth/google/callback
   ```
   Remove the old `serpforge.io` address if it is listed. Click **Save**. It can take a few minutes to apply.
2. **Branding** (the consent screen):
   - **Application home page:** `https://connect.visibll.in/`
   - **Application privacy policy link:** `https://connect.visibll.in/privacy`
   - **Authorized domains:** add `visibll.in` (not `connect.visibll.in`, no `https://`). Remove `serpforge.io`.
3. **Data access** (scopes): nothing changes.
4. Google may ask you to **verify ownership of `visibll.in`** (Google Search Console → add the domain, using a DNS record). Do this with the Google account that owns the project.
5. While the Google app is in **Testing**, only accounts listed as **test users** can connect, and their connection expires after 7 days. Before real customers, click **Publish app** and go through Google's verification (full steps in `GOOGLE-SETUP-SIMPLE.md`).

If you also use Bing or Clarity, they need no address changes.

---

## 8. Part E: Test the whole system

Tick each one, in order:

- [ ] `https://connect.visibll.in` opens with a padlock.
- [ ] Create an account with an outside email address. The confirmation email arrives, and its link opens `connect.visibll.in` (not `localhost`).
- [ ] Sign in. The **Integrations** page appears, and the "Use with Claude" box shows `https://mcp.visibll.in/mcp`.
- [ ] **Connect Search Console**, then **Connect GA4**, with a Google account that has access. Your properties appear.
- [ ] **Disconnect** removes them.
- [ ] In this project, ask Claude to run the check `pnpm mcp:check https://mcp.visibll.in/mcp`. A line marked **FAIL** names what is missing.
- [ ] In Claude: **Settings** → **Connectors** → **Add custom connector** → paste `https://mcp.visibll.in/mcp` → sign in → **Approve**.
- [ ] Ask Claude: "Run get_connection_status".
- [ ] **Reboot test (once):** on the VPS as root run `reboot`. Wait two minutes, then open `https://mcp.visibll.in/healthz`. If it shows `ok`, PM2 restarts the app after a reboot as it should.

When everything works, move `web.env` and `mcp.env` to the Trash and empty it (keep the values in your password manager).

---

## 9. If something goes wrong

If it does not help, send Claude the error text. **Never include passwords or keys.**

### Vercel (website)

| What you see | What it means | What to do |
|---|---|---|
| Build log: `This project is configured to use 12.14.0 of pnpm. Your current pnpm is v…` | Vercel uses a different pnpm version | Make sure `ENABLE_EXPERIMENTAL_COREPACK=1` is set (6.2 step 5). The project also contains `pmOnFail: ignore`, so a mismatch is tolerated. Redeploy |
| Build log: `Cannot find module '@serp/…'` | Vercel built from the wrong folder | Root Directory must be `apps/web` and "Include source files outside of the Root Directory" must be **on** (Settings → General) |
| Build log mentions Node version | Node too old | Settings → General → Node.js Version → 24.x, then redeploy |
| Build log: `Invalid environment configuration: NAME` | A setting is missing or wrong | Fix it in Settings → Environment Variables, then redeploy |
| Page error 500 | A live setting is wrong | Vercel → the deployment → **Logs**; usually a wrong `SUPABASE_DB_URL` (needs the **pooler** address with the password) |
| Logs say `ENETUNREACH` or `connect ETIMEDOUT` to the database | The direct (IPv6-only) database address is used | Use the **pooler** address (section 2) |
| Logs say `self-signed certificate in certificate chain` | The database certificate was not recognised | The project ships Supabase's root certificate. If Supabase changed it, set `SUPABASE_DB_CA` to the new certificate text (Supabase → Project Settings → Database → SSL Configuration → Download certificate) |
| Sign-up email goes to localhost | Supabase Site URL not updated | 7.1 |
| `redirect_uri_mismatch` from Google | The address is not registered | 7.6, exactly as written |
| "Connect" button greyed out | Google settings or `DATA_MODE=live` missing | Check the 13 settings, then redeploy |
| The new setting does not work | Vercel applies settings only on a new deployment | Deployments → **Redeploy** |

### VPS (MCP server)

| What you see | What it means | What to do |
|---|---|---|
| `ssh` says "Connection timed out" | Firewall or wrong IP | Check the IP; check your provider's firewall allows port 22 |
| Setup script: "Run this as root" | You ran it as `serp` | `exit` to root, run it again |
| `deploy.sh`: `Permission denied (publickey)` | The deploy key is missing | Redo 5.3 steps 3–4 |
| `deploy.sh`: "did not answer" | The app started but crashed | `pm2 logs serp-mcp --lines 50` |
| Logs say "Invalid environment configuration: NAME" | A setting in `~/mcp.env` is missing or wrong | `nano ~/mcp.env`, fix, save, then `pm2 restart serp-mcp --update-env` |
| Logs say "Refusing to start in production with …mock…" | A test setting is on | `~/mcp.env` must have `MCP_AUTH_MODE=oauth`, `DATA_MODE=live`, `DB_MODE=postgres` |
| Logs mention the database | Wrong `SUPABASE_DB_URL` | Copy it again from Supabase → Project Settings → Database (the **pooler** address) |
| Logs say `ENETUNREACH` | The VPS cannot use IPv6 and the direct database address was used | Use the **pooler** address (section 2) |
| `certbot` fails with "DNS problem" | The address does not point to the VPS yet | Part A, step 4; wait, retry |
| Browser: "502 Bad Gateway" | Nginx cannot reach the app | `pm2 status` (must be `online`); if not: `pm2 restart serp-mcp` |
| Browser: "This site can't be reached" | DNS or firewall | Check DNS (Part A), and that the firewall allows 80 and 443 (`ufw status`) |
| Claude: connector fails to connect | Supabase steps not done, or addresses mismatch | 7.2 and 7.3; run `pnpm mcp:check https://mcp.visibll.in/mcp` |
| Claude says it cannot sign in | OAuth Server is off | 7.3 |
| Connected on the website but Claude's reports fail | Different `SECRET_KEYS` on Vercel and the VPS | Make the values identical (section 2) |

---

## 10. Later: updates and everyday tasks

### Update the website
Push to `main` on GitHub. **Vercel rebuilds and publishes automatically.** Watch it in the Vercel dashboard → **Deployments**.

### Update the MCP server
It does **not** update by itself. After you push to `main`:

1. Connect: `ssh root@YOUR.VPS.IP`, then `su - serp`.
2. Run: `bash ~/SERP-Connect/deploy/vps/deploy.sh`
3. **You should see** `OK: MCP server is running`.

Always update the website and the MCP server in the same session when a change touches both.

### Change a setting
- **Website:** Vercel → Settings → Environment Variables → edit → then **Redeploy**.
- **MCP server:** `su - serp`, `nano ~/mcp.env`, change, **Ctrl + O**, **Enter**, **Ctrl + X**, then `pm2 restart serp-mcp --update-env`.
- **Shared values** (`SECRET_KEYS`, Google ID/secret, database URL): change in **both**.

### Look at logs
- **Website:** Vercel → the project → **Logs**.
- **MCP server:** `pm2 logs serp-mcp --lines 100`.

### Keep the VPS safe
- Turn on automatic security updates once (as root): `apt-get install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades`.
- Use SSH keys instead of a password if your provider allows it.
- Never open port 8787 in the firewall.
- Take a snapshot or backup from your provider's dashboard after the first successful setup.

### What if the VPS dies?
The app holds no data (everything is in Supabase). Make a new VPS, repeat Part B, and point the `mcp` DNS record to the new IP. Customers do not lose anything.

---

## 11. Quick reference

| | Website | MCP server |
|---|---|---|
| Runs on | Vercel | Your VPS |
| Address | `https://connect.visibll.in` | `https://mcp.visibll.in` (connector link ends in `/mcp`) |
| Settings live in | Vercel → Environment Variables | `/home/serp/mcp.env` |
| Settings file to use | `web.env` (13 names) | `mcp.env` (11 names) |
| Updates | Automatic when you push to `main` | `bash ~/SERP-Connect/deploy/vps/deploy.sh` |
| Health check | `/api/health` | `/healthz` |
| Logs | Vercel → Logs | `pm2 logs serp-mcp` |
| DNS record | CNAME `connect` → Vercel's value | A `mcp` → your VPS IP |
| Restart | Vercel → Redeploy | `pm2 restart serp-mcp` |
| Plan note | Free Hobby is non-commercial only | Needs 1 GB+ RAM |
