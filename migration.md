# Moving from `visibll.in` to `serpforge.io`

A step-by-step guide for a non-coder. Follow it top to bottom and tick the boxes.

| | Old address | New address |
|---|---|---|
| Website (Vercel) | `connect.visibll.in` | `connect.serpforge.io` |
| MCP server (VPS) | `mcp.visibll.in` | `mcp.serpforge.io` |
| Connector link customers paste into Claude | `https://mcp.visibll.in/mcp` | `https://mcp.serpforge.io/mcp` |
| Email sender (Mailtrap sending domain) | `no-reply@visibll.in` | `no-reply@connect.serpforge.io` |

`serpforge.io` itself (the bare domain, no `connect.` or `mcp.`) is a separate site on Hostinger and is **not** touched by this guide. Only two DNS records are added for the subdomains, plus the five Mailtrap email records in 1.5. All of them live under `connect.` so your main site's email (SPF, MX) is not touched.

---

## 0. Read this first

### What breaks if you skip a step

Five things in this project are tied to the domain name. Miss one and that feature stops. Everything else keeps working.

| # | Where | What is tied to the domain | What breaks if you forget |
|---|---|---|---|
| 1 | **Supabase** (database hook) | The "audience" stamped on Claude's tokens is `https://mcp.visibll.in/mcp` | Claude cannot connect to the new MCP server (it says unauthorized) |
| 2 | **Google Cloud** | The allowed return address `.../api/oauth/google/callback` | "Connect Search Console / GA4" fails with `redirect_uri_mismatch` |
| 3 | **Supabase** (website address) | Site URL and Redirect URLs | Sign-up and password-reset emails link to the old domain |
| 4 | **Vercel** (website settings) | `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_MCP_URL` are saved into the website when it is built | Dashboard still shows the old connector link; Google/Bing return to the old domain |
| 5 | **Mailtrap** (sign-up emails) | Mailtrap only sends from a domain it has verified. Supabase's sender must be on a verified domain | New users never get their confirmation email |

Also: **the website code has the old address written in one file** (`apps/web/src/lib/mcp-url.ts`). Section 3 changes it.

### What does NOT change

- Your Supabase project, database, users and their stored Google/Bing/Clarity connections stay as they are. Nothing is copied or exported.
- Your Google **Client ID and Client Secret** stay the same. Do not make a new Google project for this move.
- `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY` and the database password stay the same. **Never change these during a domain move**: customers' saved connections would become unreadable.
- Your VPS stays the same machine with the same IP.

### Two things customers will notice

1. **Everyone who connected Claude to the old connector must remove it and add the new link.** Their old tokens say "valid only for `mcp.visibll.in`", and the new server refuses them on purpose. This takes 30 seconds per person. See section 10.
2. **Google may ask you to re-verify the app** if it is already published (section 7).

### Safest order (why it is in this order)

1. Prepare and point DNS first. Nothing breaks yet because the old domain still works.
2. Bring the new website up **next to** the old one.
3. Cut over the MCP server and the Supabase hook **together** (5-minute window; this is the only moment Claude is briefly offline).
4. Finish Google and email.
5. Test. Then turn the old domain into redirects.

If anything goes wrong, jump to section 12 (Rollback).

### Time and warnings

- Total time: about 2 to 3 hours of work, spread over a day because DNS and Google changes need waiting.
- Do the cut-over (section 5 and 6) at a quiet time.
- Do **not** delete anything on the old domain until section 11, at least a week later.
- Never paste passwords, secrets or keys into chat messages. When you ask Claude for help, copy only the error text.

### What to have ready

- [ ] Login to **Hostinger** (hPanel), where `serpforge.io` DNS lives. Section 1 uses Hostinger's screens.
- [ ] Login to your **Namecheap** (for `visibll.in`, needed later for redirects and for rollback).
- [ ] Logins for **Vercel**, **Supabase**, **Google Cloud console**, **Bing Webmaster Tools** (only if you use "Connect with Bing"), your **Mailtrap** account (Email Sending), and **Google Search Console**.
- [ ] SSH login to the VPS: `ssh serp@172.93.223.194` (the IP from `docs/mcp-web.md`). Use `root` where the guide says so.
- [ ] This project open in Claude Code on your Mac, with GitHub access.

---

## 1. DNS: point the two new subdomains

**What is DNS?** The internet's phone book. You tell it "when someone asks for `mcp.serpforge.io`, go to my VPS".

### 1.1 Open the Hostinger DNS editor

1. Log in to **hPanel** at <https://hpanel.hostinger.com>.
2. Top menu **Domains** → click **Manage** next to `serpforge.io`.
3. Left menu **DNS / Nameservers** → tab **DNS records**.

**Check the nameservers first** (tab **Nameservers**). If they are Hostinger's (`ns1.dns-parking.com` / `ns2.dns-parking.com`), edit records here. If they point somewhere else (for example Cloudflare), add the records at that provider instead; records added in Hostinger would be ignored.

You will only **add** two records. Do not edit or delete the existing ones (the `@` and `www` records and the mail records keep your main `serpforge.io` site and email working). If the list has a wildcard record with Name `*`, leave it: a specific record like `mcp` always wins over it.

### 1.2 Add the MCP record (VPS)

In the **Add Record** form:

| Field | Value |
|---|---|
| Type | **A** |
| Name | `mcp` (just `mcp`, not `mcp.serpforge.io`) |
| Points to | `172.93.223.194` (your VPS IP) |
| TTL | `300` (or the lowest offered) |

Click **Add Record**. If Hostinger says a record with that name already exists, stop and look at it before changing it.

### 1.3 Add the website record (Vercel)

Do **not** guess this one. Vercel shows the exact value in section 4.4. Come back here after that step and add:

| Field | Value |
|---|---|
| Type | **CNAME** (or **A** if Vercel says so) |
| Name | `connect` |
| Points to | exactly what Vercel shows (often `cname.vercel-dns.com`) |
| TTL | `300` |

### 1.4 Check the MCP record worked

On your Mac, open **Terminal** and run:

```
nslookup mcp.serpforge.io 8.8.8.8
```

**You should see** `172.93.223.194` in the answer. If you see "NXDOMAIN" or another IP, wait 10 minutes and try again. Do not continue to section 5 until this shows your VPS IP.

### 1.5 Email records for Mailtrap (do this early: Mailtrap's review can take hours)

Sign-up emails go out through **Mailtrap**. Mailtrap only sends from a domain you have proven you own. You will verify **`connect.serpforge.io`** (the same subdomain as the website), so the sender becomes `no-reply@connect.serpforge.io`. This keeps all the email records under `connect.` and leaves the SPF and mail (MX) records of your main `serpforge.io` untouched.

1. Log in to Mailtrap → **Email Sending** → **Sending Domains** (<https://mailtrap.io/domains>) → **Add Domain**.
2. Type `connect.serpforge.io` → **Add**. (Add the **new** one next to the old `visibll.in`; do not remove the old one yet.)
3. Mailtrap shows a **Domain Verification** page with **five** records to add: **four CNAME** (Domain Verification, two DKIM, Custom Tracking Domain) and **one TXT** (DMARC). Do **not** type them from this guide. Copy the exact Type, Name and Value of each from that page (hover a record and click to copy).
4. Add each one in Hostinger → `serpforge.io` → **DNS records** → **Add Record**.

**The Hostinger Name box.** Mailtrap shows the full name, for example `abc123._domainkey.connect.serpforge.io`. In Hostinger's **Name** box type only the part **before** `.serpforge.io`, which here is `abc123._domainkey.connect`. Hostinger adds `.serpforge.io` by itself; if you type the full name it ends up doubled (`...serpforge.io.serpforge.io`) and never verifies. Paste the **Value** exactly as shown.

**Record names to expect** (sit under `connect`, never at `connect` itself):

| Mailtrap record | Type | Name looks like (what you type in Hostinger) |
|---|---|---|
| Domain Verification | CNAME | `something.connect` |
| DKIM (two) | CNAME | `something._domainkey.connect` |
| Custom Tracking Domain | CNAME | `something.connect` |
| DMARC | TXT | `_dmarc.connect` |

> **Stop if** any Mailtrap record has a Name that is exactly `connect.serpforge.io` (so you would type just `connect`). Your website already uses a `connect` CNAME that points to Vercel, and a name cannot hold that CNAME and another record. Do not delete the Vercel record. Ask Claude with the record list from Mailtrap (no secrets in it).

5. Back in Mailtrap click **Re-check DNS Records**. Mailtrap also rechecks by itself every hour. Dots turn from red to green (Status **Verified**).
6. Mailtrap then asks for **Sender information** (business or personal details; once per account, you may already have done it for `visibll.in`) and runs an automatic **Compliance Check**. Some domains get a manual review. The domain must show **Verified** before you switch Supabase over in 6.4.

Because the DNS lookup is quick but the Mailtrap review is not, do this as soon as section 1.2 is done.

---

## 2. Take a safety copy of your settings (5 minutes)

Before changing anything, save what works today.

- [ ] In Vercel → your project → **Settings** → **Environment Variables**, take a screenshot of all names and (for the non-secret ones) values. Keep it in `~/Documents/private-serp/`.
- [ ] On the VPS, run `cp ~/mcp.env ~/mcp.env.visibll-backup` (one line, as the `serp` user).
- [ ] In Supabase → **Authentication** → **URL Configuration**, screenshot the Site URL and Redirect URLs.
- [ ] In Supabase → **Authentication** → **Emails** → **SMTP Settings**, screenshot the host, port, username and sender (**not** the password). Note where the old Mailtrap token is saved.
- [ ] In Google Cloud → **Google Auth Platform** → **Clients** → your client, screenshot **Authorized redirect URIs**.

This is your Rollback kit (section 12).

---

## 3. Change the website code (ask Claude)

The old domain is written into some project files. You do not edit them yourself. In Claude Code, in this project folder, paste this message:

> Move this project from `visibll.in` to `serpforge.io`. Replace `connect.visibll.in` with `connect.serpforge.io`, `mcp.visibll.in` with `mcp.serpforge.io`, and `visibll.in` with `serpforge.io` in: `apps/web/src/lib/mcp-url.ts`, `deploy/vps/*` (nginx, setup-server.sh, mcp.env.example, ecosystem.config.cjs), and all docs (`docs/*.md`, `ISSUES.md`). **Do not edit** the old migration `supabase/migrations/20261022100000_mcp_audience_hook_visibll.sql`. Instead add a new migration `supabase/migrations/20261029100000_mcp_audience_hook_serpforge.sql` that re-creates `custom_access_token_hook` with the audience `https://mcp.serpforge.io/mcp`. Then run `pnpm typecheck`, `pnpm lint` and `pnpm test` and show me the result. Do not commit yet.

### What Claude should change (so you can check its work)

| File | Change |
|---|---|
| `apps/web/src/lib/mcp-url.ts` | `https://mcp.visibll.in/mcp` → `https://mcp.serpforge.io/mcp` |
| `deploy/vps/nginx-mcp.conf.example` | `server_name mcp.serpforge.io;` and the comment lines |
| `deploy/vps/setup-server.sh` | `DOMAIN="${DOMAIN:-mcp.serpforge.io}"` and the `sed` line (`mcp\.serpforge\.io`) |
| `deploy/vps/mcp.env.example` | `MCP_PUBLIC_URL=https://mcp.serpforge.io` and `MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp` |
| `deploy/vps/ecosystem.config.cjs` | comment only |
| `docs/*.md`, `ISSUES.md` | the text addresses |
| **new** `supabase/migrations/20261029100000_mcp_audience_hook_serpforge.sql` | see below |

The new migration must contain exactly:

```sql
-- The MCP server moved to https://mcp.serpforge.io. Re-create the Custom Access Token Hook with the new audience.
-- The audience below must equal MCP_RESOURCE_AUDIENCE of the MCP server.

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

Rules:
- **Do not apply this SQL yet.** It goes live at the cut-over (section 5.5). It only affects tokens given to Claude, never normal website logins.
- Check afterwards that no `visibll` remains except in the old migration files and in this `migration.md`: ask Claude "search the project for `visibll` and list every hit".

### 3.1 Save the code to GitHub (do not deploy yet)

Ask Claude: "Commit these changes on a new branch called `domain-serpforge` and push it. Do not merge to main yet." The VPS and Vercel read `main`, so pushing a branch changes nothing live.

---

## 4. Vercel: bring the new website address up (old one keeps working)

### 4.1 Add the new domain

1. Vercel → your project → **Settings** → **Domains**.
2. Type `connect.serpforge.io` → **Add**.
3. Pick the option that says it is a normal domain (**not** a redirect) for now.

### 4.2 Add the DNS record

Vercel shows a record to create. Add it at the `serpforge.io` DNS panel (section 1.3). Back in Vercel the domain turns **green** after a few minutes and HTTPS (the padlock) is automatic.

> Old `connect.visibll.in` stays in the list. Do not remove it yet.

### 4.3 Change the website settings

Vercel → **Settings** → **Environment Variables**. Change or add these for **Production**:

| Name | New value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://connect.serpforge.io` |
| `NEXT_PUBLIC_MCP_URL` | `https://mcp.serpforge.io/mcp` |
| `GOOGLE_REDIRECT_URI` (only if it is set) | `https://connect.serpforge.io/api/oauth/google/callback` |
| `BING_REDIRECT_URI` (only if it is set) | `https://connect.serpforge.io/api/oauth/bing/callback` |
| `SUPPORT_EMAIL` | an address on the new domain, for example `support@serpforge.io` (make sure you can receive mail there), or leave your current one |

Leave everything else (Supabase keys, `GOOGLE_CLIENT_ID`/`SECRET`, `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY`) **exactly as it is**.

Why: `NEXT_PUBLIC_…` values are baked into the site when it is built. Changing them has no effect until the next build (4.5).

### 4.4 (Referenced in 1.3) The DNS value

If you skipped it: Settings → **Domains** → click **Edit** / **Learn more** next to `connect.serpforge.io`. It shows the Type, Name and Value to add.

### 4.5 Deploy the new code

1. Ask Claude: "Merge branch `domain-serpforge` into `main` and push." (This is the moment the VPS code could also update, but it will not until you run `deploy.sh` in section 5.)
2. Vercel starts a new deployment by itself. Wait for **Ready**. If nothing started: **Deployments** → latest → **⋯** → **Redeploy**.

### 4.6 Test the new website

Open each address. You should see:

| Address | You should see |
|---|---|
| `https://connect.serpforge.io/api/health` | `{"status":"ok"}` |
| `https://connect.serpforge.io/` | the home page with a padlock |
| `https://connect.serpforge.io/privacy` | the privacy page with your support email |
| `https://connect.serpforge.io/login` | the login page (do not sign in yet; Supabase is not updated) |
| the dashboard's connector box (section 10) | shows `https://mcp.serpforge.io/mcp` |

Both `connect.visibll.in` and `connect.serpforge.io` now show the same website. That is fine for now.

---

## 5. VPS and Supabase hook: the cut-over (5 minutes)

Do 5.1 to 5.4 first (preparation, no downtime). Then do 5.5 to 5.7 **in one go**.

### 5.1 Check you can reach the VPS

On your Mac Terminal: `ssh serp@172.93.223.194`. If it works you will see a prompt like `serp@vps:~$`.

### 5.2 Nginx: add the new name (keep the old one for now)

Nginx is the "doorman" on the VPS that accepts requests from the internet. Switch to root: `sudo -i` (or log in as root). Then:

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

### 5.3 HTTPS certificate for the new name

Section 1.4 must be done first (DNS points at the VPS). Run:

```
certbot --nginx -d mcp.serpforge.io -m YOUR-EMAIL --agree-tos --no-eff-email --redirect
```

(Replace `YOUR-EMAIL` with your email.) **You should see** "Congratulations! You have successfully enabled HTTPS on https://mcp.serpforge.io". Certificates renew by themselves.

At this moment `https://mcp.serpforge.io/healthz` already answers (the server is still using the old settings). It should show `{"status":"ok"}`.

### 5.4 Prepare the new settings file (do not restart yet)

Still on the VPS as the `serp` user (`exit` from root, or `su - serp`):

```
nano ~/mcp.env
```

Change **exactly these two lines** (leave every other line alone):

```
MCP_PUBLIC_URL=https://mcp.serpforge.io
MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp
```

If the file has a line `MCP_ALLOWED_ORIGINS=` with a value, change `visibll.in` to `serpforge.io` there too. Do **not** save a restart yet. Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.

Do **not** change `MCP_OAUTH_ISSUER_URL`: it points at Supabase and stays the same.

> The audience in `mcp.env` and the Supabase hook (5.5) **must be the same text**: `https://mcp.serpforge.io/mcp`. If they differ, Claude is rejected.

### 5.5 Cut over: Supabase hook, then restart (do these two within minutes)

**A. Switch the Supabase hook to the new audience.**

Ask Claude in this project: "Apply the migration `20261029100000_mcp_audience_hook_serpforge.sql` to my Supabase project." Or do it by hand: Supabase dashboard → **SQL Editor** → **New query**, paste the SQL from section 3, **Run**. **You should see** "Success. No rows returned".

The hook was already switched on in the dashboard earlier (Authentication → Hooks → *Customize Access Token (JWT) Claims*, Postgres, schema `public`, function `custom_access_token_hook`). Check it is still ticked; you do not need to change its settings, because the function is replaced in place.

**B. Restart the MCP server on the VPS.**

```
bash ~/SERP-Connect/deploy/vps/deploy.sh
```

**You should see** `OK: MCP server is running ({"status":"ok"})`. (The script downloads `main`, builds and restarts the server. It reads the changed `~/mcp.env`.)

### 5.6 Check the new MCP server

Open these in a browser:

| Address | You should see |
|---|---|
| `https://mcp.serpforge.io/healthz` | `{"status":"ok"}` with a padlock |
| `https://mcp.serpforge.io/.well-known/oauth-protected-resource/mcp` | text starting `{"resource":"https://mcp.serpforge.io/mcp"` |
| `https://mcp.serpforge.io/mcp` | an "unauthorized" error. **This is correct.** |

Then ask Claude: "Run `pnpm mcp:check https://mcp.serpforge.io/mcp`". No line should say **FAIL** (the Supabase website address and Google parts are not finished yet, so "OAuth server" lines can wait until section 6).

### 5.7 The old MCP address stops working (expected)

`https://mcp.visibll.in` still answers but now the server expects the new audience, so old connectors are refused. If you need the old MCP address alive for some days, see section 12 (Rollback). The recommended path is to tell customers to re-add the connector (section 10).

---

## 6. Supabase: website address and emails

Supabase dashboard → your SERP Connect project.

### 6.1 Website address

**Authentication** → **URL Configuration**:

1. **Site URL:** `https://connect.serpforge.io`
2. **Redirect URLs** → **Add URL**: `https://connect.serpforge.io/auth/callback`
3. Keep `https://connect.visibll.in/auth/callback` in the list **for now** (so anyone mid-sign-up on the old link still gets in). You remove it in section 11.
4. Keep `http://localhost:3000/auth/callback` if you still develop on your Mac.
5. **Save.**

### 6.2 OAuth Server (Claude's sign-in)

**Authentication** → **OAuth Server**. It should already be on from your first setup. Only check:

- Enabled: **on**
- **Authorization Path:** `/oauth/consent` (a path, so it works on any domain; no change)
- **Dynamic Client Registration:** **on**

If the page asks for a **Site URL**, it uses the value from 6.1.

### 6.3 Hooks

**Authentication** → **Hooks** → *Customize Access Token (JWT) Claims* is **on**, function `public.custom_access_token_hook`. The function itself was updated in 5.5.

### 6.4 Sending email from the new domain (Mailtrap)

Without this, confirmation emails still say "from visibll.in". Do this only after Mailtrap shows `connect.serpforge.io` as **Verified** (1.5).

1. In Mailtrap → **Sending Domains** → click `connect.serpforge.io` → **Integration** → **SMTP**. Note the **Host**, **Port**, **Username** and **Password** it shows (typically host `live.smtp.mailtrap.io`, port `587`, username `api`; always trust what the page shows).
2. The password is an **API token**. If your existing token is limited to the old `visibll.in` domain, it will be refused for the new one. In Mailtrap → **Settings** → **API Tokens** → **Add Token**, give it access to `connect.serpforge.io` (Email Sending), and use that token as the password. Keep it private (never paste it in a chat or commit it).
3. Supabase → **Authentication** → **Emails** → **SMTP Settings** (custom SMTP stays on) and change:

   | Field | New value |
   |---|---|
   | Sender email | `no-reply@connect.serpforge.io` |
   | Sender name | unchanged (for example `SERP Connect`) |
   | Host / Port | from Mailtrap (step 1) |
   | Username | from Mailtrap (step 1) |
   | Password | the API token from step 2 |

   **Save.**
4. **Authentication** → **Emails** → **Templates**: look at *Confirm sign up* and *Reset password*. If any template has text with the old domain hard-coded, change it. Links using `{{ .ConfirmationURL }}` pick up the new Site URL by themselves.

Do **not** remove `visibll.in` from Mailtrap yet. Section 11.4 removes it, after a week of proof that nothing still sends from it.

### 6.5 Test sign-up

On `https://connect.serpforge.io`, sign up with a non-Gmail address (for example a Yahoo or work address) that is **not** in your Supabase team. The email must arrive (check spam), show the sender `no-reply@connect.serpforge.io`, and its button must open `connect.serpforge.io`. In Mailtrap → **Email Logs** you should see it as **Delivered**. Then log in.

---

## 7. Google Cloud console

Open <https://console.cloud.google.com> and choose your project (the one with your Client ID).

### 7.1 Add the new return address

**Google Auth Platform** → **Clients** → click your client.

1. **Authorized redirect URIs** → **Add URI** → paste **exactly**:

   `https://connect.serpforge.io/api/oauth/google/callback`

   No space, no `/` at the end, `https`.
2. **Keep** the old line `https://connect.visibll.in/api/oauth/google/callback` for now. Remove it in section 11.
3. **Authorized JavaScript origins:** leave **empty** (the app does not need any).
4. **Save.** It can take a few minutes to apply.

> Both boxes look alike. The addresses go **only** in **Authorized redirect URIs**.

### 7.2 Add the new domain to the consent screen

**Google Auth Platform** → **Branding**:

| Field | New value |
|---|---|
| **Application home page** | `https://connect.serpforge.io/` |
| **Application privacy policy link** | `https://connect.serpforge.io/privacy` |
| **Application terms of service link** (if you set one) | the new address |
| **Authorized domains** | **Add domain** → `serpforge.io` (no `https://`, no `connect.`). Keep `visibll.in` until section 11 |
| **Developer contact email** | unchanged |

**Save.**

### 7.3 Prove you own `serpforge.io`

Google only accepts an authorized domain you have verified.

1. Open <https://search.google.com/search-console> and sign in with the **same Google account that owns the Google Cloud project**.
2. If `serpforge.io` is already a verified property there (likely, since it is your main site), you are done.
3. Otherwise **Add property** → **Domain** → `serpforge.io` → copy the TXT record → in Hostinger **DNS records** add a **TXT** record with Name `@` and the value Google gave → **Verify**.

### 7.4 Testing mode: nothing to re-verify

Your Google app is in **Testing** mode, so Google does no review of the new addresses and there is no verification to redo. The usual Testing rules continue as before: only your listed **test users** can connect Google, and a connection stops after 7 days. The move does not change that. Existing connections stay tied to the **Client ID**, which has not changed.

When you later publish the app (`docs/GOOGLE-SETUP-SIMPLE.md`, Part 9), do it with the new `serpforge.io` addresses only, so you never have to verify the old domain.

### 7.5 Test Google

On the new website, sign in and click **Connect Search Console**. Google's page opens with no error, and you return to `connect.serpforge.io`. If you see `redirect_uri_mismatch`, the line in 7.1 has a typo or has not applied yet (wait 5 minutes, check spaces).

### 7.6 Bing (only if you use "Connect with Bing")

Bing Webmaster Tools → **Settings** → **API Access** → **OAuth Client**: add the redirect `https://connect.serpforge.io/api/oauth/bing/callback` (keep the old one for now). The Vercel setting `BING_REDIRECT_URI` was changed in 4.3.

Customers who connected with their own Bing API key are not affected.

### 7.7 Microsoft Clarity

Nothing to change. Customers paste their own Clarity token; no web address is registered.

---

## 8. Test the whole thing end to end

### 8.1 Website

- [ ] `https://connect.serpforge.io/api/health` → `{"status":"ok"}`
- [ ] Sign up works; the email arrives from `no-reply@connect.serpforge.io` (and shows in Mailtrap Email Logs); its link opens `connect.serpforge.io`
- [ ] Log in and log out work
- [ ] Dashboard shows the connector link `https://mcp.serpforge.io/mcp`
- [ ] **Connect Search Console**, **Connect GA4** work (no `redirect_uri_mismatch`)
- [ ] Previously connected properties still show as connected
- [ ] `/privacy` loads and shows the support email

### 8.2 MCP server and Claude

- [ ] `https://mcp.serpforge.io/healthz` → `{"status":"ok"}`
- [ ] `pnpm mcp:check https://mcp.serpforge.io/mcp` (ask Claude to run it) shows no FAIL lines
- [ ] In Claude: **Settings** → **Connectors** → **Add custom connector** → paste `https://mcp.serpforge.io/mcp` → sign in → **Allow**
- [ ] Ask Claude: "Run get_connection_status". It lists your connected services
- [ ] Ask Claude for a real Search Console report; numbers come back

### 8.3 Existing data

- [ ] Log in as an existing customer on the new website. Their data is still there (nothing was moved).

---

## 9. Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| Claude says "unauthorized" or cannot connect after adding the new link | The audience in the Supabase hook and `MCP_RESOURCE_AUDIENCE` do not match, or the server was not restarted | Both must be exactly `https://mcp.serpforge.io/mcp`. Re-check 5.4 and 5.5, then run `deploy.sh` again |
| Claude still talks to the old connector | You did not remove the old connector | Section 10 |
| `redirect_uri_mismatch` | The Google line in 7.1 is missing, has a typo, or has not applied | Fix and wait 5 minutes |
| Sign-up email link opens `visibll.in` | Supabase Site URL not changed | 6.1, then request a new email (old emails keep the old link) |
| Sign-up email says "from visibll.in" | SMTP sender not changed | 6.4 |
| Mailtrap shows a record as **Missing** | Name typed in full (doubled `.serpforge.io`), a typo, or DNS not yet refreshed | Compare with Mailtrap, fix the Name (1.5), wait 15 minutes, click **Re-check DNS Records** |
| Sign-up shows "error sending confirmation email" | Mailtrap domain not Verified yet, or the API token is not allowed for the new domain, or the sender address is not on the verified domain | Check Mailtrap → Sending Domains status, create a new token (6.4 step 2), and make sure the sender is exactly `no-reply@connect.serpforge.io`. Supabase → **Logs** → **Auth** shows the exact error |
| Email lands in spam | DMARC or tracking record missing | All five Mailtrap records must show Verified (1.5) |
| Dashboard still shows `mcp.visibll.in` | Website not rebuilt after the settings change | Vercel → Deployments → ⋯ → **Redeploy** (4.5). Check 3 (`mcp-url.ts`) was merged |
| `https://mcp.serpforge.io` shows "502 Bad Gateway" | MCP server is not running | On the VPS run `pm2 status` then `pm2 logs serp-mcp --lines 50` and give Claude the error text (never the `mcp.env` contents) |
| `nginx -t` complains about `limit_req_zone` "already defined" | The line exists in both site files | Delete it from the new file (5.2) |
| Certbot fails | DNS not yet pointing at the VPS, or port 80/443 closed | Check 1.4. `ufw status` should show 80 and 443 allowed |
| Vercel domain shows "Invalid Configuration" | DNS record missing or wrong | Compare with what Vercel shows (4.4). Wait 10 minutes |
| Google connection works for you but not a customer | App is in Testing mode and they are not a listed test user (or their 7 days passed) | Google Auth Platform → **Audience** → add them under **Test users**. Not caused by the move |
| New DNS record has no effect | `serpforge.io` uses nameservers other than Hostinger's | Edit the records at the provider the nameservers point to (1.1) |

---

## 10. Tell your customers

Send this (adjust the wording):

> We moved to a new address. **Website:** https://connect.serpforge.io. To keep using Claude with your data, please:
> 1. In Claude open **Settings** → **Connectors**, and **remove** the old SERP Connect connector.
> 2. Click **Add custom connector** and paste `https://mcp.serpforge.io/mcp`.
> 3. Sign in and click **Allow**.
>
> Your connected Google, Bing and Clarity accounts do not need to be reconnected.

---

## 11. After about a week: clean up the old domain

Only when everything above has been working for a week and no customer is complaining.

### 11.1 Redirect the old website address

Vercel → **Settings** → **Domains** → next to `connect.visibll.in` click **Edit** → choose **Redirect to Another Domain** → `connect.serpforge.io` → status **308 Permanent Redirect** → **Save**. Old bookmarks and links now land on the new site.

### 11.2 Remove the old return addresses

- Supabase → **Authentication** → **URL Configuration** → remove `https://connect.visibll.in/auth/callback`.
- Google Cloud → **Clients** → remove `https://connect.visibll.in/api/oauth/google/callback`; **Branding** → remove `visibll.in` from **Authorized domains**.
- Bing OAuth client: remove the old redirect.

### 11.3 Retire the old MCP name on the VPS

As root on the VPS:

```
rm /etc/nginx/sites-enabled/mcp.visibll.in
nginx -t && systemctl reload nginx
```

Keep the file in `sites-available/` as a backup if you like. The old certificate stops renewing; that is fine.

### 11.4 Mailtrap: remove the old `visibll.in`

Do this only after a week with no email problems, and after confirming Supabase's **SMTP Settings** show `no-reply@connect.serpforge.io` (not `visibll.in`). Also make sure nothing else you run (another app, a form, a newsletter) still sends from `@visibll.in`.

1. Mailtrap → **Sending Domains** → `visibll.in` → **Delete** (the domain's settings/menu). Mailtrap stops accepting mail from it.
2. Mailtrap → **Settings** → **API Tokens**: delete the old token that was used for `visibll.in`.
3. Namecheap → Domain List → **Manage** `visibll.in` → **Advanced DNS**: delete the Mailtrap records you added for it (the four CNAME records and the `_dmarc` TXT record: Domain Verification, two DKIM, tracking, DMARC). Compare each with what Mailtrap showed for the old domain; delete only those.
4. Leave the Namecheap records for the website redirect and anything else in place. Keeping the `visibll.in` registration for a year protects old links.
5. In Hostinger, you keep the five new records for `connect.serpforge.io`. Do not delete them.

### 11.5 Keep your own records tidy

- Delete the old backup `~/mcp.env.visibll-backup` on the VPS (it has secrets).
- Update third-party places that link to the old address: your social profiles, email signatures, Search Console property, Ahrefs/Ubersuggest projects, Google Business profile, directory listings.
- If the old domain had search traffic, add a **Change of Address** in Google Search Console (Settings → Change of address) from `visibll.in` to `serpforge.io`. It only works when both are verified properties and the redirects in 11.1 exist.

---

## 12. Rollback (if something goes badly wrong)

You can go back **at any time before section 11** without data loss, because nothing was copied or deleted.

### Website rolled back

Vercel → **Settings** → **Environment Variables**: set `NEXT_PUBLIC_APP_URL=https://connect.visibll.in`, `NEXT_PUBLIC_MCP_URL=https://mcp.visibll.in/mcp` and the redirect variables back to the old domain. **Redeploy**. Supabase Site URL back to `https://connect.visibll.in`.

### MCP server rolled back

1. On the VPS: `cp ~/mcp.env.visibll-backup ~/mcp.env` (the safety copy from section 2).
2. Re-apply the **old** audience in Supabase: ask Claude "apply `20261022100000_mcp_audience_hook_visibll.sql` to my Supabase project", or paste its SQL in the **SQL Editor**.
3. Restart: `pm2 startOrReload ~/SERP-Connect/deploy/vps/ecosystem.config.cjs --update-env`.
4. `https://mcp.visibll.in/healthz` shows `{"status":"ok"}` again.

Customers who added the new connector in the meantime would need to re-add the old one.

### Email rolled back

Supabase → **Authentication** → **Emails** → **SMTP Settings**: set the sender back to `no-reply@visibll.in` and the password to the old Mailtrap token. This works as long as you have not yet done section 11.4.

### Google

The old redirect line was never removed (until section 11), so the old website keeps working.

### If you are not sure what broke

Stop changing things. Copy the **exact error text** (never keys or passwords) and give it to Claude along with the section number you were on.

---

## 13. Final checklist

**DNS**
- [ ] `mcp.serpforge.io` → VPS IP
- [ ] `connect.serpforge.io` → Vercel
- [ ] Five Mailtrap records for `connect.serpforge.io` added in Hostinger (4 CNAME + 1 TXT) and shown **Verified** in Mailtrap

**Code**
- [ ] `mcp-url.ts`, `deploy/vps/*` and docs updated
- [ ] New Supabase migration added
- [ ] Tests pass; merged to `main`

**Vercel**
- [ ] `connect.serpforge.io` added, green, HTTPS on
- [ ] `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_MCP_URL`, (`GOOGLE_REDIRECT_URI`, `BING_REDIRECT_URI`, `SUPPORT_EMAIL`) updated
- [ ] Redeployed after the settings change

**VPS**
- [ ] Nginx has `mcp.serpforge.io`; `nginx -t` OK
- [ ] HTTPS certificate issued
- [ ] `~/mcp.env`: `MCP_PUBLIC_URL`, `MCP_RESOURCE_AUDIENCE` changed
- [ ] `deploy.sh` ran; `/healthz` OK

**Supabase**
- [ ] Hook migration applied (audience `https://mcp.serpforge.io/mcp`)
- [ ] Hook is switched on
- [ ] Site URL + Redirect URL for `connect.serpforge.io`
- [ ] OAuth Server on, path `/oauth/consent`, Dynamic Client Registration on
- [ ] SMTP settings use Mailtrap with sender `no-reply@connect.serpforge.io` and a token for the new domain

**Google Cloud**
- [ ] Redirect URI `https://connect.serpforge.io/api/oauth/google/callback`
- [ ] Branding: home page, privacy link, authorized domain `serpforge.io`
- [ ] `serpforge.io` verified in Search Console
- [ ] (App stays in Testing mode: no re-verification needed)

**Mailtrap**
- [ ] `connect.serpforge.io` added and Verified (Compliance Check passed)
- [ ] Test sign-up with a non-Gmail address delivered
- [ ] After a week: old `visibll.in` domain, old token and old DNS records removed

**Final**
- [ ] Section 8 tests pass
- [ ] Customers told (section 10)
- [ ] After a week: section 11 clean-up
