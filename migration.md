# Moving from `visibll.in` to `serpforge.io`

A step-by-step guide for a non-coder. The work is split into **Phases**. Each Phase has numbered **Steps**. Do them in order and tick the boxes.

| | Old address | New address |
|---|---|---|
| Website (Vercel) | `connect.visibll.in` | `connect.serpforge.io` |
| MCP server (VPS) | `mcp.visibll.in` | `mcp.serpforge.io` |
| Connector link customers paste into Claude | `https://mcp.visibll.in/mcp` | `https://mcp.serpforge.io/mcp` |
| Email sender (Mailtrap sending domain) | `no-reply@visibll.in` | `no-reply@connect.serpforge.io` |

`serpforge.io` itself (the bare domain, no `connect.` or `mcp.`) is a separate site on Hostinger and is **not** touched by this guide. Only two DNS records are added for the subdomains, plus the five Mailtrap email records. All the email records live under `connect.`, so your main site's email (SPF, MX) is not touched.

## Phases at a glance

| Phase | What you do | Customers affected? |
|---|---|---|
| **Phase 1** | Preparation: logins, safety copy, check the code | No |
| **Phase 2** | DNS: point `mcp.` at the VPS, start Mailtrap verification | No |
| **Phase 3** | Vercel: bring `connect.serpforge.io` up next to the old site | No |
| **Phase 4** | VPS: prepare Nginx, HTTPS and settings for `mcp.serpforge.io` (no restart) | No |
| **Phase 5** | Cut-over: Supabase hook + MCP restart (about 5 minutes) | Claude briefly offline |
| **Phase 6** | Supabase: website address, OAuth, Mailtrap email | No |
| **Phase 7** | Google Cloud and Bing | No |
| **Phase 8** | Test everything | No |
| **Phase 9** | Tell your customers | Yes (they re-add the connector) |
| **Phase 10** | One week later: clean up the old domain | No |

At the end: **Troubleshooting**, **Rollback** and a **Final checklist**.

---

## Read this first

### Why the order matters

1. DNS and the new website come up **next to** the old ones. Nothing breaks, because the old domain still works.
2. The MCP server and the Supabase hook are switched **together** in Phase 5. That is the only moment Claude is briefly offline.
3. Google and email are finished after that, then everything is tested.
4. The old domain is only turned into redirects and removed in Phase 10, a week later.

### What breaks if you skip a step

Five things in this project are tied to the domain name. Miss one and that feature stops. Everything else keeps working.

| # | Where | What is tied to the domain | What breaks if you forget |
|---|---|---|---|
| 1 | **Supabase** (database hook) | The "audience" stamped on Claude's tokens is the MCP address | Claude cannot connect to the new MCP server (it says unauthorized) |
| 2 | **Google Cloud** | The allowed return address `.../api/oauth/google/callback` | "Connect Search Console / GA4" fails with `redirect_uri_mismatch` |
| 3 | **Supabase** (website address) | Site URL and Redirect URLs | Sign-up and password-reset emails link to the old domain |
| 4 | **Vercel** (website settings) | `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_MCP_URL` are saved into the website when it is built | Dashboard shows the old connector link; Google/Bing return to the old domain |
| 5 | **Mailtrap** (sign-up emails) | Mailtrap only sends from a domain it has verified, and Supabase's sender must be on it | New users never get their confirmation email |

### What does NOT change

- Your Supabase project, database, users and their stored Google/Bing/Clarity connections stay as they are. Nothing is copied or exported.
- Your Google **Client ID and Client Secret** stay the same. Do not make a new Google project for this move.
- `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY` and the database password stay the same. **Never change these during a domain move**: customers' saved connections would become unreadable.
- Your VPS stays the same machine with the same IP.

### Rules while you work

- About 2 to 3 hours of work, spread over a day, because DNS, Mailtrap and Google need waiting time.
- Do Phase 5 at a quiet time.
- Do **not** delete anything on the old domain before Phase 10.
- Never paste passwords, secrets or API tokens into a chat. When you ask Claude for help, copy only the error text.
- All code is already in the `main` branch on GitHub. There is no separate branch to merge. Vercel and the VPS both read `main`.

---

# Phase 1: Preparation

### Step 1. Have these ready

- [ ] **Hostinger** (hPanel) login, where `serpforge.io` DNS lives.
- [ ] **Namecheap** login (for `visibll.in`, needed later for the old-domain clean-up and for rollback).
- [ ] Logins for **Vercel**, **Supabase**, **Google Cloud console**, **Mailtrap** (Email Sending), **Google Search Console**, and **Bing Webmaster Tools** (only if you use "Connect with Bing").
- [ ] SSH login to the VPS as **root**: `ssh root@172.93.223.194` (the IP from `docs/mcp-web.md`), with the root password from your VPS provider's email (paste it, nothing shows while you paste). The `serp` account has **no password**, so you cannot log in as `serp` directly. You log in as `root` and switch with `su - serp` where a step says so.
- [ ] This project open in Claude Code on your Mac, with GitHub access.

### Step 2. Take a safety copy of your settings (5 minutes)

Before changing anything, save what works today. This is your Rollback kit.

- [ ] In Vercel → your project → **Settings** → **Environment Variables**, take a screenshot of all names and (for the non-secret ones) values. Keep it in `~/Documents/private-serp/`.
- [ ] On the VPS, run `cp /home/serp/mcp.env /home/serp/mcp.env.visibll-backup` (one line, works as `root`).
- [ ] In Supabase → **Authentication** → **URL Configuration**, screenshot the Site URL and Redirect URLs.
- [ ] In Supabase → **Authentication** → **Emails** → **SMTP Settings**, screenshot the host, port, username and sender (**not** the password). Note where the old Mailtrap token is saved.
- [ ] In Google Cloud → **Google Auth Platform** → **Clients** → your client, screenshot **Authorized redirect URIs**.

### Step 3. Check the code changes are in `main`

The code already points to the new domain and is in `main`. You do not edit anything yourself. Ask Claude in this project:

> Check that `main` on GitHub contains the serpforge.io changes, and that my local `main` is up to date with `origin/main`. List every remaining `visibll` mention in the project.

What is in `main`:

| File | What it now says |
|---|---|
| `apps/web/src/lib/mcp-url.ts` | `https://mcp.serpforge.io/mcp` (the link shown on the dashboard) |
| `deploy/vps/nginx-mcp.conf.example` | `server_name mcp.serpforge.io;` |
| `deploy/vps/setup-server.sh` | default domain `mcp.serpforge.io` |
| `deploy/vps/mcp.env.example` | `MCP_PUBLIC_URL=https://mcp.serpforge.io` and `MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp` |
| `docs/*.md`, `ISSUES.md` | the text addresses |
| `supabase/migrations/20261029100000_mcp_audience_hook_serpforge.sql` | the new Supabase hook (written, **not applied** until Phase 5) |

You should see only these `visibll` mentions left: the old migration `20261022100000_mcp_audience_hook_visibll.sql` (kept on purpose), a few history lines in the docs, and this `migration.md`.

Because the code is in `main`, Vercel builds it automatically. If the dashboard shows `mcp.serpforge.io` before Phase 5 is done, that is expected.

---

# Phase 2: DNS (Hostinger)

**What is DNS?** The internet's phone book. You tell it "when someone asks for `mcp.serpforge.io`, go to my VPS".

### Step 1. Open the Hostinger DNS editor

1. Log in to **hPanel** at <https://hpanel.hostinger.com>.
2. Top menu **Domains** → click **Manage** next to `serpforge.io`.
3. Left menu **DNS / Nameservers** → tab **DNS records**.

**Check the nameservers first** (tab **Nameservers**). If they are Hostinger's (`ns1.dns-parking.com` / `ns2.dns-parking.com`), edit records here. If they point somewhere else (for example Cloudflare), add the records at that provider instead; records added in Hostinger would be ignored.

You will only **add** records. Do not edit or delete the existing ones (the `@` and `www` records and the mail records keep your main `serpforge.io` site and email working). If the list has a wildcard record with Name `*`, leave it: a specific record like `mcp` always wins over it.

### Step 2. Add the MCP record (VPS)

In the **Add Record** form:

| Field | Value |
|---|---|
| Type | **A** |
| Name | `mcp` (just `mcp`, not `mcp.serpforge.io`) |
| Points to | `172.93.223.194` (your VPS IP) |
| TTL | `300` (or the lowest offered) |

Click **Add Record**. If Hostinger says a record with that name already exists, stop and look at it before changing it.

### Step 3. Check the MCP record worked

On your Mac, open **Terminal** and run:

```
nslookup mcp.serpforge.io 8.8.8.8
```

**You should see** `172.93.223.194` in the answer. If you see "NXDOMAIN" or another IP, wait 10 minutes and try again. Do not start Phase 4 until this shows your VPS IP.

### Step 4. Start Mailtrap verification (do this early: Mailtrap's review can take hours)

Sign-up emails go out through **Mailtrap**. Mailtrap only sends from a domain you have proven you own. You will verify **`connect.serpforge.io`** (the same subdomain as the website), so the sender becomes `no-reply@connect.serpforge.io`. This keeps all the email records under `connect.` and leaves the SPF and mail (MX) records of your main `serpforge.io` untouched.

1. Log in to Mailtrap → **Email Sending** → **Sending Domains** (<https://mailtrap.io/domains>) → **Add Domain**.
2. Type `connect.serpforge.io` → **Add**. Add the **new** one next to the old `visibll.in`; do not remove the old one yet.
3. Mailtrap shows a **Domain Verification** page with **five** records: **four CNAME** (Domain Verification, two DKIM, Custom Tracking Domain) and **one TXT** (DMARC). Do **not** type them from this guide. Copy the exact Type, Name and Value of each from that page (hover a record and click to copy).
4. Add each one in Hostinger → `serpforge.io` → **DNS records** → **Add Record**.

**The Hostinger Name box.** Mailtrap shows the full name, for example `abc123._domainkey.connect.serpforge.io`. In Hostinger's **Name** box type only the part **before** `.serpforge.io`, which here is `abc123._domainkey.connect`. Hostinger adds `.serpforge.io` by itself; if you type the full name it ends up doubled (`...serpforge.io.serpforge.io`) and never verifies. Paste the **Value** exactly as shown.

**Record names to expect** (they sit under `connect`, never at `connect` itself):

| Mailtrap record | Type | Name looks like (what you type in Hostinger) |
|---|---|---|
| Domain Verification | CNAME | `something.connect` |
| DKIM (two) | CNAME | `something._domainkey.connect` |
| Custom Tracking Domain | CNAME | `something.connect` |
| DMARC | TXT | `_dmarc.connect` |

> **Stop if** any Mailtrap record has a Name that is exactly `connect.serpforge.io` (so you would type just `connect`). Your website uses a `connect` CNAME that points to Vercel (Phase 3), and one name cannot hold that CNAME and another record. Do not delete the Vercel record. Ask Claude, with the record list from Mailtrap (no secrets in it).

5. Back in Mailtrap click **Re-check DNS Records**. Mailtrap also rechecks by itself every hour. The dots turn from red to green (Status **Verified**).
6. Mailtrap then asks for **Sender information** (business or personal details; once per account, you may already have done it for `visibll.in`) and runs an automatic **Compliance Check**. Some domains get a manual review. The domain must show **Verified** before you use it in Phase 6, Step 4.

Do not wait for Mailtrap. Carry on with Phase 3 while it reviews.

---

# Phase 3: Vercel (bring the new website up)

### Step 1. Add the new domain

1. Vercel → your project → **Settings** → **Domains**.
2. Type `connect.serpforge.io` → **Add**.
3. Choose the normal option (**not** a redirect) for now.

> The old `connect.visibll.in` stays in the list. Do not remove it yet.

### Step 2. Add the website DNS record in Hostinger

Vercel now shows a record to create (Settings → **Domains** → **Edit** / **Learn more** next to `connect.serpforge.io`). Add it in Hostinger → **DNS records** → **Add Record**:

| Field | Value |
|---|---|
| Type | **CNAME** (or **A** if Vercel says so) |
| Name | `connect` |
| Points to | exactly what Vercel shows (often `cname.vercel-dns.com`) |
| TTL | `300` |

**If Hostinger says "DNS resource record is not valid or conflicts with another resource record":** a record named `connect` already exists, and a CNAME cannot share its name with any other record. Hostinger often adds one by itself: an **ALIAS** record named `connect` pointing to `connect.serpforge.io.cdn.hstgr.net`. Delete that one ALIAS row (only after checking nothing is hosted at `connect.serpforge.io` on Hostinger), then add the CNAME again. Do not delete the Mailtrap rows (`mt-link.connect`, `mt07.connect`, `…_domainkey.connect`, `_dmarc.connect`): they have different names. If the ALIAS comes back, delete the `connect` subdomain under hPanel → **Websites** too.

Back in Vercel the domain turns **green** after a few minutes, and the HTTPS padlock is added automatically.

### Step 3. Change the website settings

Vercel → **Settings** → **Environment Variables**. Change or add these for **Production**:

| Name | New value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://connect.serpforge.io` |
| `NEXT_PUBLIC_MCP_URL` | `https://mcp.serpforge.io/mcp` |
| `GOOGLE_REDIRECT_URI` (**only if it already exists** in the list; if not, skip it: the app builds it from `NEXT_PUBLIC_APP_URL`) | `https://connect.serpforge.io/api/oauth/google/callback` |
| `BING_REDIRECT_URI` (**only if it already exists**; if not, skip it, same reason) | `https://connect.serpforge.io/api/oauth/bing/callback` |
| `SUPPORT_EMAIL` (optional) | only change it if it currently ends in `@visibll.in`: use an address you can receive mail at, for example `support@serpforge.io`. Otherwise leave it as it is. It is just the contact shown on `/privacy` |

**Type must be Config for `NEXT_PUBLIC_…` variables.** In the Vercel form choose **Type: Config** (plain text), not **Secret**. Vercel refuses a Secret with a `NEXT_PUBLIC_` name and shows "Remove the public framework prefix to keep this value private…". Those values go to the visitor's browser by design, and these two are only web addresses. A variable already saved as Secret cannot be switched: **Remove** it (⋯ → Remove), then **Add New** with Type **Config** and Environments **Production**. Keep the real secrets (`GOOGLE_CLIENT_SECRET`, `SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, …) as **Secret**.

`NEXT_PUBLIC_APP_URL` is the important one (sign-in redirects and request checks use it). `NEXT_PUBLIC_MCP_URL` is optional: the dashboard's connector link comes from the code (`mcp-url.ts`), not from this setting.

Leave everything else (Supabase keys, `GOOGLE_CLIENT_ID`/`SECRET`, `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`) **exactly as it is**.

Why: `NEXT_PUBLIC_…` values are baked into the site when it is built. Changing them has no effect until the next build (Step 4).

### Step 4. Redeploy

The code is already in `main`, so Vercel has already built it. Rebuild so the new settings take effect:

Vercel → **Deployments** → the latest one → **⋯** → **Redeploy**. Wait for **Ready**.

### Step 5. Test the new website

Open each address. You should see:

| Address | You should see |
|---|---|
| `https://connect.serpforge.io/api/health` | `{"status":"ok"}` |
| `https://connect.serpforge.io/` | the home page with a padlock |
| `https://connect.serpforge.io/privacy` | the privacy page with your support email |
| `https://connect.serpforge.io/login` | the login page (do not sign in yet; Supabase is not updated) |
| the dashboard's connector box | shows `https://mcp.serpforge.io/mcp` |

Both `connect.visibll.in` and `connect.serpforge.io` now show the same website. That is fine for now.

---

# Phase 4: VPS preparation (no restart yet)

Nothing here changes what customers see. The old MCP keeps running until Phase 5.

### Step 1. Check you can reach the VPS

On your Mac Terminal: `ssh root@172.93.223.194` and paste the root password. If it works you will see a prompt like `root@mcp:~#`. (Do **not** use `ssh serp@…`: that account has no password and says "Permission denied".) Steps 2 and 3 run as `root`; Step 4 and Phase 5 run as `serp` (`su - serp`).

### Step 2. Nginx: add the new name (keep the old one for now)

Nginx is the "doorman" on the VPS that accepts requests from the internet. You are already `root` from Step 1. Run:

```
cp /etc/nginx/sites-available/mcp.visibll.in /etc/nginx/sites-available/mcp.serpforge.io
sed -i 's/mcp\.visibll\.in/mcp.serpforge.io/g' /etc/nginx/sites-available/mcp.serpforge.io
```

Careful: the `limit_req_zone` line must exist **only once** across all enabled sites. Open the new file (`nano /etc/nginx/sites-available/mcp.serpforge.io`) and **delete the line that starts with `limit_req_zone`** (the old file already defines it). Keep `limit_req zone=mcp_per_ip …` inside `location /`. Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.

Then:

```
ln -sf /etc/nginx/sites-available/mcp.serpforge.io /etc/nginx/sites-enabled/mcp.serpforge.io
nginx -t
```

**You should see** `syntax is ok` and `test is successful`. If not, stop and ask Claude with the exact error text. Then:

```
systemctl reload nginx
```

### Step 3. HTTPS certificate for the new name

Phase 2, Step 3 must be done first (DNS points at the VPS). Still as root, run:

```
certbot --nginx -d mcp.serpforge.io -m YOUR-EMAIL --agree-tos --no-eff-email --redirect
```

(Replace `YOUR-EMAIL` with your email.) **You should see** "Congratulations! You have successfully enabled HTTPS on https://mcp.serpforge.io". Certificates renew by themselves.

At this moment `https://mcp.serpforge.io/healthz` already answers `{"status":"ok"}` (the server is still using the old settings).

### Step 4. Prepare the new settings file (do not restart yet)

Switch to the `serp` user (the prompt changes from `root@…#` to `serp@…$`):

```
su - serp
```

Then:

```
nano ~/mcp.env
```

Change **exactly these two lines** (leave every other line alone):

```
MCP_PUBLIC_URL=https://mcp.serpforge.io
MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp
```

If the file has a line `MCP_ALLOWED_ORIGINS=` with a value, change `visibll.in` to `serpforge.io` there too. Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`. Do **not** restart anything yet.

Do **not** change `MCP_OAUTH_ISSUER_URL`: it points at Supabase and stays the same.

> The audience in `mcp.env` and the Supabase hook (Phase 5, Step 1) **must be the same text**: `https://mcp.serpforge.io/mcp`. If they differ, Claude is rejected.

---

# Phase 5: The cut-over (about 5 minutes)

Do Steps 1 and 2 **back to back**. This is the only moment Claude is briefly offline.

### Step 1. Switch the Supabase hook to the new audience

Ask Claude in this project: "Apply the migration `20261029100000_mcp_audience_hook_serpforge.sql` to my Supabase project."

Or do it by hand: Supabase dashboard → **SQL Editor** → **New query**, paste this, **Run**. You should see "Success. No rows returned".

```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
begin
  if claims ? 'client_id' and coalesce(claims->>'client_id', '') <> '' then
    claims := jsonb_set(claims, '{aud}', to_jsonb('https://mcp.serpforge.io/mcp'::text));
    event := jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;
```

It only affects tokens given to Claude, never normal website logins.

The hook was already switched on in the dashboard earlier (Authentication → Hooks → *Customize Access Token (JWT) Claims*, Postgres, schema `public`, function `custom_access_token_hook`). Check it is still ticked. You do not need to change its settings, because the function is replaced in place.

### Step 2. Restart the MCP server on the VPS

As the `serp` user on the VPS (`su - serp` if the prompt still says `root@…#`):

```
bash ~/SERP-Connect/deploy/vps/deploy.sh
```

**You should see** `OK: MCP server is running ({"status":"ok"})`. (The script downloads `main`, builds and restarts the server. It reads the changed `~/mcp.env` from Phase 4, Step 4.)

### Step 3. Check the new MCP server

Open these in a browser:

| Address | You should see |
|---|---|
| `https://mcp.serpforge.io/healthz` | `{"status":"ok"}` with a padlock |
| `https://mcp.serpforge.io/.well-known/oauth-protected-resource/mcp` | text starting `{"resource":"https://mcp.serpforge.io/mcp"` |
| `https://mcp.serpforge.io/mcp` | an "unauthorized" error. **This is correct.** |

Then ask Claude: "Run `pnpm mcp:check https://mcp.serpforge.io/mcp`". No line should say **FAIL**. (The Supabase website address and Google parts are not finished yet, so "OAuth server" lines can wait until Phase 6.)

### Step 4. Know that the old MCP address stops working

`https://mcp.visibll.in` still answers, but the server now expects the new audience, so old connectors are refused. This is expected. Customers re-add the connector in Phase 9. If you need the old address alive for some days, see **Rollback**.

---

# Phase 6: Supabase settings and email

Supabase dashboard → your SERP Connect project.

### Step 1. Website address

**Authentication** → **URL Configuration**:

1. **Site URL:** `https://connect.serpforge.io`
2. **Redirect URLs** → **Add URL**: `https://connect.serpforge.io/auth/callback`
3. Keep `https://connect.visibll.in/auth/callback` in the list **for now** (so anyone mid-sign-up on the old link still gets in). You remove it in Phase 10.
4. Keep `http://localhost:3000/auth/callback` if you still develop on your Mac.
5. **Save.**

### Step 2. OAuth Server (Claude's sign-in)

**Authentication** → **OAuth Server**. It should already be on from your first setup. Only check:

- Enabled: **on**
- **Authorization Path:** `/oauth/consent` (a path, so it works on any domain; no change)
- **Dynamic Client Registration:** **on**

If the page asks for a **Site URL**, it uses the value from Step 1.

### Step 3. Hooks

**Authentication** → **Hooks** → *Customize Access Token (JWT) Claims* is **on**, function `public.custom_access_token_hook`. The function itself was updated in Phase 5, Step 1.

### Step 4. Send email from the new domain (Mailtrap)

Without this, confirmation emails still say "from visibll.in". Do this only after Mailtrap shows `connect.serpforge.io` as **Verified** (Phase 2, Step 4).

1. In Mailtrap → **Sending Domains** → click `connect.serpforge.io` → **Integration** → **SMTP**. Note the **Host**, **Port**, **Username** and **Password** it shows (typically host `live.smtp.mailtrap.io`, port `587`, username `api`; always trust what the page shows).
2. The password is an **API token**. If your existing token is limited to the old `visibll.in` domain, it will be refused for the new one. In Mailtrap → **Settings** → **API Tokens** → **Add Token**, give it access to `connect.serpforge.io` (Email Sending), and use that token as the password. Keep it private (never paste it in a chat or commit it).
3. Supabase → **Authentication** → **Emails** → **SMTP Settings** (custom SMTP stays on) and change:

   | Field | New value |
   |---|---|
   | Sender email | `no-reply@connect.serpforge.io` |
   | Sender name | unchanged (for example `SERP Connect`) |
   | Host / Port | from Mailtrap (item 1) |
   | Username | from Mailtrap (item 1) |
   | Password | the API token from item 2 |

   **Save.**
4. **Authentication** → **Emails** → **Templates**: look at *Confirm sign up* and *Reset password*. If any template has text with the old domain hard-coded, change it. Links using `{{ .ConfirmationURL }}` pick up the new Site URL by themselves.

Do **not** remove `visibll.in` from Mailtrap yet. Phase 10 removes it, after a week of proof that nothing still sends from it.

### Step 5. Test sign-up

On `https://connect.serpforge.io`, sign up with a non-Gmail address (for example a Yahoo or work address) that is **not** in your Supabase team. The email must arrive (check spam), show the sender `no-reply@connect.serpforge.io`, and its button must open `connect.serpforge.io`. In Mailtrap → **Email Logs** you should see it as **Delivered**. Then log in.

---

# Phase 7: Google Cloud and Bing

Open <https://console.cloud.google.com> and choose your project (the one with your Client ID).

### Step 1. Add the new return address

**Google Auth Platform** → **Clients** → click your client.

1. **Authorized redirect URIs** → **Add URI** → paste **exactly**:

   `https://connect.serpforge.io/api/oauth/google/callback`

   No space, no `/` at the end, `https`.
2. **Keep** the old line `https://connect.visibll.in/api/oauth/google/callback` for now. You remove it in Phase 10.
3. **Authorized JavaScript origins:** leave **empty** (the app does not need any).
4. **Save.** It can take a few minutes to apply.

> Both boxes look alike. The addresses go **only** in **Authorized redirect URIs**.

### Step 2. Add the new domain to the consent screen

**Google Auth Platform** → **Branding**:

| Field | New value |
|---|---|
| **Application home page** | `https://connect.serpforge.io/` |
| **Application privacy policy link** | `https://connect.serpforge.io/privacy` |
| **Application terms of service link** (if you set one) | the new address |
| **Authorized domains** | **Add domain** → `serpforge.io` (no `https://`, no `connect.`). Keep `visibll.in` until Phase 10 |
| **Developer contact email** | unchanged |

**Save.**

### Step 3. Prove you own `serpforge.io`

Google only accepts an authorized domain you have verified.

1. Open <https://search.google.com/search-console> and sign in with the **same Google account that owns the Google Cloud project**.
2. If `serpforge.io` is already a verified property there (likely, since it is your main site), you are done.
3. Otherwise **Add property** → **Domain** → `serpforge.io` → copy the TXT record → in Hostinger **DNS records** add a **TXT** record with Name `@` and the value Google gave → **Verify**.

### Step 4. Know that nothing needs re-verifying (Testing mode)

Your Google app is in **Testing** mode, so Google does no review of the new addresses and there is no verification to redo. The usual Testing rules continue as before: only your listed **test users** can connect Google, and a connection stops after 7 days. The move does not change that. Existing connections stay tied to the **Client ID**, which has not changed.

When you later publish the app (`docs/GOOGLE-SETUP-SIMPLE.md`, Part 9), do it with the new `serpforge.io` addresses only, so you never have to verify the old domain.

### Step 5. Test Google

On the new website, sign in and click **Connect Search Console**. Google's page opens with no error, and you return to `connect.serpforge.io`. If you see `redirect_uri_mismatch`, the line from Step 1 has a typo or has not applied yet (wait 5 minutes, check for spaces).

### Step 6. Bing (only if you use "Connect with Bing")

Bing Webmaster Tools → **Settings** → **API Access** → **OAuth Client**: add the redirect `https://connect.serpforge.io/api/oauth/bing/callback` (keep the old one for now). The Vercel setting `BING_REDIRECT_URI` was changed in Phase 3, Step 3.

Customers who connected with their own Bing API key are not affected.

### Step 7. Microsoft Clarity

Nothing to change. Customers paste their own Clarity token; no web address is registered.

---

# Phase 8: Test everything

### Step 1. Website

- [ ] `https://connect.serpforge.io/api/health` → `{"status":"ok"}`
- [ ] Sign up works; the email arrives from `no-reply@connect.serpforge.io` (and shows in Mailtrap Email Logs); its link opens `connect.serpforge.io`
- [ ] Log in and log out work
- [ ] Dashboard shows the connector link `https://mcp.serpforge.io/mcp`
- [ ] **Connect Search Console** and **Connect GA4** work (no `redirect_uri_mismatch`)
- [ ] Previously connected properties still show as connected
- [ ] `/privacy` loads and shows the support email

### Step 2. MCP server and Claude

- [ ] `https://mcp.serpforge.io/healthz` → `{"status":"ok"}`
- [ ] `pnpm mcp:check https://mcp.serpforge.io/mcp` (ask Claude to run it) shows no FAIL lines
- [ ] In Claude: **Settings** → **Connectors** → **Add custom connector** → paste `https://mcp.serpforge.io/mcp` → sign in → **Allow**
- [ ] Ask Claude: "Run get_connection_status". It lists your connected services
- [ ] Ask Claude for a real Search Console report; numbers come back

### Step 3. Existing data

- [ ] Log in as an existing customer on the new website. Their data is still there (nothing was moved).

If something fails, see **Troubleshooting** below.

---

# Phase 9: Tell your customers

### Step 1. Send this message (adjust the wording)

> We moved to a new address. **Website:** https://connect.serpforge.io. To keep using Claude with your data, please:
> 1. In Claude open **Settings** → **Connectors**, and **remove** the old SERP Connect connector.
> 2. Click **Add custom connector** and paste `https://mcp.serpforge.io/mcp`.
> 3. Sign in and click **Allow**.
>
> Your connected Google, Bing and Clarity accounts do not need to be reconnected.

Why they must do this: their old tokens say "valid only for `mcp.visibll.in`", and the new server refuses them on purpose. It takes about 30 seconds per person.

---

# Phase 10: One week later, clean up the old domain

Only when everything above has been working for a week and no customer is complaining.

### Step 1. Redirect the old website address

Vercel → **Settings** → **Domains** → next to `connect.visibll.in` click **Edit** → choose **Redirect to Another Domain** → `connect.serpforge.io` → status **308 Permanent Redirect** → **Save**. Old bookmarks and links now land on the new site.

### Step 2. Remove the old return addresses

- Supabase → **Authentication** → **URL Configuration** → remove `https://connect.visibll.in/auth/callback`.
- Google Cloud → **Clients** → remove `https://connect.visibll.in/api/oauth/google/callback`; **Branding** → remove `visibll.in` from **Authorized domains**.
- Bing OAuth client: remove the old redirect.

### Step 3. Retire the old MCP name on the VPS

As root on the VPS (`ssh root@172.93.223.194`):

```
rm /etc/nginx/sites-enabled/mcp.visibll.in
nginx -t && systemctl reload nginx
```

Keep the file in `sites-available/` as a backup if you like. The old certificate stops renewing; that is fine.

### Step 4. Remove the old domain from Mailtrap

Do this only after a week with no email problems, and after confirming Supabase's **SMTP Settings** show `no-reply@connect.serpforge.io` (not `visibll.in`). Also make sure nothing else you run (another app, a form, a newsletter) still sends from `@visibll.in`.

1. Mailtrap → **Sending Domains** → `visibll.in` → **Delete** (the domain's settings/menu). Mailtrap stops accepting mail from it.
2. Mailtrap → **Settings** → **API Tokens**: delete the old token that was used for `visibll.in`.
3. Namecheap → Domain List → **Manage** `visibll.in` → **Advanced DNS**: delete the Mailtrap records you added for it (the four CNAME records and the `_dmarc` TXT record: Domain Verification, two DKIM, tracking, DMARC). Compare each with what Mailtrap showed for the old domain; delete only those.
4. Leave the other Namecheap records in place. Keeping the `visibll.in` registration for a year protects old links.
5. In Hostinger, keep the five new records for `connect.serpforge.io`. Do not delete them.

### Step 5. Keep your own records tidy

- Delete the old backup `~/mcp.env.visibll-backup` on the VPS (it has secrets).
- Update third-party places that link to the old address: social profiles, email signatures, Search Console property, Ahrefs/Ubersuggest projects, Google Business profile, directory listings.
- If the old domain had search traffic, add a **Change of Address** in Google Search Console (Settings → Change of address) from `visibll.in` to `serpforge.io`. It only works when both are verified properties and the redirect from Step 1 exists.

---

# Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| Claude says "unauthorized" or cannot connect after adding the new link | The audience in the Supabase hook and `MCP_RESOURCE_AUDIENCE` do not match, or the server was not restarted | Both must be exactly `https://mcp.serpforge.io/mcp`. Re-check Phase 4 Step 4 and Phase 5, then run `deploy.sh` again |
| Claude still talks to the old connector | The old connector was not removed | Phase 9 |
| `redirect_uri_mismatch` | The Google line in Phase 7 Step 1 is missing, has a typo, or has not applied | Fix and wait 5 minutes |
| Sign-up email link opens `visibll.in` | Supabase Site URL not changed | Phase 6 Step 1, then request a new email (old emails keep the old link) |
| Sign-up email says "from visibll.in" | SMTP sender not changed | Phase 6 Step 4 |
| Mailtrap shows a record as **Missing** | Name typed in full (doubled `.serpforge.io`), a typo, or DNS not yet refreshed | Compare with Mailtrap, fix the Name (Phase 2 Step 4), wait 15 minutes, click **Re-check DNS Records** |
| Sign-up shows "error sending confirmation email" | Mailtrap domain not Verified yet, the API token is not allowed for the new domain, or the sender is not on the verified domain | Check Mailtrap → Sending Domains status, create a new token (Phase 6 Step 4 item 2), and make sure the sender is exactly `no-reply@connect.serpforge.io`. Supabase → **Logs** → **Auth** shows the exact error |
| Email lands in spam | DMARC or tracking record missing | All five Mailtrap records must show Verified (Phase 2 Step 4) |
| Dashboard still shows `mcp.visibll.in` | Website not rebuilt after the settings change | Vercel → Deployments → ⋯ → **Redeploy** (Phase 3 Step 4). Ask Claude to check that `mcp-url.ts` in `main` says `serpforge.io` |
| `https://mcp.serpforge.io` shows "502 Bad Gateway" | MCP server is not running | On the VPS run `pm2 status` then `pm2 logs serp-mcp --lines 50` and give Claude the error text (never the `mcp.env` contents) |
| `nginx -t` complains about `limit_req_zone` "already defined" | The line exists in both site files | Delete it from the new file (Phase 4 Step 2) |
| `ssh serp@…` says "Permission denied" | The `serp` account has no password | Log in with `ssh root@172.93.223.194`, then `su - serp` (Phase 4 Step 1) |
| Certbot fails | DNS not yet pointing at the VPS, or port 80/443 closed | Check Phase 2 Step 3. `ufw status` should show 80 and 443 allowed |
| Vercel: "Remove the public framework prefix to keep this value private…" | `NEXT_PUBLIC_…` variable was saved as **Secret** | Phase 3 Step 3: remove it and re-add with Type **Config** |
| Hostinger: "DNS resource record is not valid or conflicts with another resource record" when adding `connect` | An existing `connect` record (often a Hostinger **ALIAS** to `…cdn.hstgr.net`) blocks the CNAME | Phase 3 Step 2: delete that ALIAS, then add the Vercel CNAME |
| Vercel domain shows "Invalid Configuration" | DNS record missing or wrong | Compare with what Vercel shows (Phase 3 Step 2). Wait 10 minutes |
| Google connection works for you but not a customer | App is in Testing mode and they are not a listed test user (or their 7 days passed) | Google Auth Platform → **Audience** → add them under **Test users**. Not caused by the move |
| New DNS record has no effect | `serpforge.io` uses nameservers other than Hostinger's | Edit the records at the provider the nameservers point to (Phase 2 Step 1) |

---

# Rollback (if something goes badly wrong)

You can go back **at any time before Phase 10** without data loss, because nothing was copied or deleted.

### Website

Vercel → **Settings** → **Environment Variables**: set `NEXT_PUBLIC_APP_URL=https://connect.visibll.in`, `NEXT_PUBLIC_MCP_URL=https://mcp.visibll.in/mcp` and the redirect variables back to the old domain. **Redeploy**. Supabase Site URL back to `https://connect.visibll.in`.

> The dashboard's connector link comes from `mcp-url.ts` in the code, not from Vercel settings. To show the old link again, ask Claude: "Revert the `mcp-url.ts` change and push to `main`."

### MCP server

1. On the VPS: `cp ~/mcp.env.visibll-backup ~/mcp.env` (the safety copy from Phase 1, Step 2).
2. Re-apply the **old** audience in Supabase: ask Claude "apply `20261022100000_mcp_audience_hook_visibll.sql` to my Supabase project", or paste its SQL in the **SQL Editor**.
3. Restart: `pm2 startOrReload ~/SERP-Connect/deploy/vps/ecosystem.config.cjs --update-env`.
4. `https://mcp.visibll.in/healthz` shows `{"status":"ok"}` again.

Customers who added the new connector in the meantime would need to re-add the old one.

### Email

Supabase → **Authentication** → **Emails** → **SMTP Settings**: set the sender back to `no-reply@visibll.in` and the password to the old Mailtrap token. This works as long as you have not yet done Phase 10, Step 4.

### Google

The old redirect line is not removed until Phase 10, so the old website keeps working.

### If you are not sure what broke

Stop changing things. Copy the **exact error text** (never keys or passwords) and give it to Claude along with the Phase and Step you were on.

---

# Final checklist

**Phase 1: Preparation**
- [ ] Logins ready, safety copy taken
- [ ] Code with `serpforge.io` confirmed in `main`

**Phase 2: DNS**
- [ ] `mcp.serpforge.io` → VPS IP (`nslookup` shows it)
- [ ] Five Mailtrap records for `connect.serpforge.io` added in Hostinger (4 CNAME + 1 TXT)

**Phase 3: Vercel**
- [ ] `connect.serpforge.io` added, green, HTTPS on, CNAME added in Hostinger
- [ ] `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_MCP_URL`, (`GOOGLE_REDIRECT_URI`, `BING_REDIRECT_URI`, `SUPPORT_EMAIL`) updated
- [ ] Redeployed after the settings change

**Phase 4: VPS preparation**
- [ ] Nginx has `mcp.serpforge.io`; `nginx -t` OK
- [ ] HTTPS certificate issued
- [ ] `~/mcp.env`: `MCP_PUBLIC_URL`, `MCP_RESOURCE_AUDIENCE` changed

**Phase 5: Cut-over**
- [ ] Hook migration applied (audience `https://mcp.serpforge.io/mcp`)
- [ ] `deploy.sh` ran; `/healthz` OK; `pnpm mcp:check` has no FAIL

**Phase 6: Supabase**
- [ ] Site URL + Redirect URL for `connect.serpforge.io`
- [ ] OAuth Server on, path `/oauth/consent`, Dynamic Client Registration on; hook switched on
- [ ] Mailtrap shows `connect.serpforge.io` **Verified**
- [ ] SMTP settings use Mailtrap, sender `no-reply@connect.serpforge.io`, token for the new domain
- [ ] Test sign-up with a non-Gmail address delivered

**Phase 7: Google and Bing**
- [ ] Redirect URI `https://connect.serpforge.io/api/oauth/google/callback`
- [ ] Branding: home page, privacy link, authorized domain `serpforge.io`
- [ ] `serpforge.io` verified in Search Console
- [ ] Bing redirect added (if used)

**Phase 8: Tests**
- [ ] Website, MCP/Claude and existing-data checks pass

**Phase 9: Customers**
- [ ] Customers told to re-add the connector

**Phase 10: After a week**
- [ ] Old website redirected; old return addresses removed
- [ ] Old Nginx site disabled
- [ ] Old Mailtrap domain, token and Namecheap DNS records removed
- [ ] Old `mcp.env` backup deleted
