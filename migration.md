# Moving from `visibll.in` to `serpforge.io`

A step-by-step guide for a non-coder. Follow it top to bottom and tick the boxes.

| | Old address | New address |
|---|---|---|
| Website (Vercel) | `connect.visibll.in` | `connect.serpforge.io` |
| MCP server (VPS) | `mcp.visibll.in` | `mcp.serpforge.io` |
| Connector link customers paste into Claude | `https://mcp.visibll.in/mcp` | `https://mcp.serpforge.io/mcp` |
| Email sender | `no-reply@visibll.in` | `no-reply@serpforge.io` |

`serpforge.io` itself (the bare domain, no `connect.` or `mcp.`) is a separate site on Hostinger and is **not** touched by this guide. Only two DNS records are added for the subdomains, plus the email records in 1.5 (where the SPF record must be edited, not duplicated).

---

## 0. Read this first

### What breaks if you skip a step

Four things in this project are tied to the domain name. Miss one and that feature stops. Everything else keeps working.

| # | Where | What is tied to the domain | What breaks if you forget |
|---|---|---|---|
| 1 | **Supabase** (database hook) | The "audience" stamped on Claude's tokens is `https://mcp.visibll.in/mcp` | Claude cannot connect to the new MCP server (it says unauthorized) |
| 2 | **Google Cloud** | The allowed return address `.../api/oauth/google/callback` | "Connect Search Console / GA4" fails with `redirect_uri_mismatch` |
| 3 | **Supabase** (website address) | Site URL and Redirect URLs | Sign-up and password-reset emails link to the old domain |
| 4 | **Vercel** (website settings) | `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_MCP_URL` are saved into the website when it is built | Dashboard still shows the old connector link; Google/Bing return to the old domain |

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
- [ ] Logins for **Vercel**, **Supabase**, **Google Cloud console**, **Bing Webmaster Tools** (only if you use "Connect with Bing"), your **email-sending service** (Resend/Brevo/SES/Postmark), and **Google Search Console**.
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

### 1.5 Email records (later)

Sending emails from `no-reply@serpforge.io` needs extra DNS records (SPF, DKIM). Your email-sending service lists them (section 6.4). Add them in the same Hostinger DNS records tab.

**Watch out for SPF.** A domain may have only **one** SPF record (a TXT record whose value starts `v=spf1`). If `serpforge.io` already has one at Name `@` (Hostinger email usually adds `v=spf1 include:_spf.mail.hostinger.com ~all`), do **not** add a second one. Edit the existing one and insert the new service's `include:` before the `~all`, for example:

`v=spf1 include:_spf.mail.hostinger.com include:amazonses.com ~all`

(use the exact `include:` text your sending service gives you). Two SPF records make both fail, which would hurt email for your main site too. Leave the existing MX (mail) records alone.

---

## 2. Take a safety copy of your settings (5 minutes)

Before changing anything, save what works today.

- [ ] In Vercel → your project → **Settings** → **Environment Variables**, take a screenshot of all names and (for the non-secret ones) values. Keep it in `~/Documents/private-serp/`.
- [ ] On the VPS, run `cp ~/mcp.env ~/mcp.env.visibll-backup` (one line, as the `serp` user).
- [ ] In Supabase → **Authentication** → **URL Configuration**, screenshot the Site URL and Redirect URLs.
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

### 6.4 Sending email from the new domain

Without this, confirmation emails still say "from visibll.in".

1. In your email-sending service (Resend, Brevo, SES or Postmark) **add the domain `serpforge.io`**. It shows you DNS records (SPF, DKIM and sometimes DMARC).
2. Add each record in the Hostinger **DNS records** tab. Quirk: in the **Name** box type only the part before `.serpforge.io` (for example `resend._domainkey`, not `resend._domainkey.serpforge.io`). For SPF, **edit the existing `v=spf1` record** instead of adding another (see 1.5).
3. Wait until the service shows **Verified** (minutes to a few hours).
4. Supabase → **Authentication** → **Emails** → **SMTP Settings**: change the **Sender email** to `no-reply@serpforge.io` (keep the host, port, user and password unless the service gave you new ones for the new domain). **Save**.
5. **Authentication** → **Emails** → **Templates**: look at *Confirm sign up* and *Reset password*. If any template has text with the old domain or name hard-coded, change it. Links using `{{ .ConfirmationURL }}` pick up the new Site URL by themselves.

Do **not** remove `visibll.in` from the email service yet. You may still need to send from it until section 11.

### 6.5 Test sign-up

On `https://connect.serpforge.io`, sign up with an email that is **not** in your Supabase team. The email must arrive (check spam) and its button must open `connect.serpforge.io`. Then log in.

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
- [ ] Sign up works; the email arrives from `no-reply@serpforge.io`; its link opens `connect.serpforge.io`
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

### 11.4 Email

Remove `visibll.in` from the email service only if you no longer need to send or receive from it. Delete the DNS records for the old subdomains at Namecheap only when you are sure (the domain registration itself is your decision; keeping it for a year protects your old links).

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

### Google

The old redirect line was never removed (until section 11), so the old website keeps working.

### If you are not sure what broke

Stop changing things. Copy the **exact error text** (never keys or passwords) and give it to Claude along with the section number you were on.

---

## 13. Final checklist

**DNS**
- [ ] `mcp.serpforge.io` → VPS IP
- [ ] `connect.serpforge.io` → Vercel
- [ ] Email records (SPF/DKIM) added and verified

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
- [ ] Sender email `no-reply@serpforge.io`

**Google Cloud**
- [ ] Redirect URI `https://connect.serpforge.io/api/oauth/google/callback`
- [ ] Branding: home page, privacy link, authorized domain `serpforge.io`
- [ ] `serpforge.io` verified in Search Console
- [ ] (App stays in Testing mode: no re-verification needed)

**Final**
- [ ] Section 8 tests pass
- [ ] Customers told (section 10)
- [ ] After a week: section 11 clean-up
