# Moving from `visibll.in` to `serpforge.io`

A simple guide. Do the **Phases** in order. Inside each Phase, do the **Steps** in order. When a Phase ends with **Done when**, check it before moving on.

| | Old | New |
|---|---|---|
| Website | `connect.visibll.in` | `connect.serpforge.io` |
| MCP server | `mcp.visibll.in` | `mcp.serpforge.io` |
| Link customers paste into Claude | `https://mcp.visibll.in/mcp` | `https://mcp.serpforge.io/mcp` |
| Email sender | `no-reply@visibll.in` | `no-reply@connect.serpforge.io` |

Your main site `serpforge.io` is not touched.

| Phase | What | Customers affected? |
|---|---|---|
| 1 | Get ready | No |
| 2 | DNS records (Hostinger) | No |
| 3 | Website (Vercel) | No |
| 4 | Prepare the server (VPS) | No |
| 5 | Switch the MCP server (5 minutes) | Claude briefly offline |
| 6 | Supabase and email | No |
| 7 | Google and Bing | No |
| 8 | Test | No |
| 9 | Tell customers | They re-add the connector |
| 10 | One week later: remove the old domain | No |

## Good to know

- **Everything is safe to undo until Phase 10.** The old addresses keep working until then.
- **Nothing in your data changes.** Users, database and Google connections stay as they are.
- **Never change** `SECRET_KEYS`, `CREDENTIAL_FINGERPRINT_KEY` or your Google Client ID/Secret.
- **Never paste passwords or keys into a chat.** If something fails, copy only the error message and tell Claude which Phase and Step you were on.
- The code is already in the `main` branch on GitHub. You do not need to change or merge any code.

---

# Phase 1: Get ready

### Step 1. Have these logins open
Hostinger, Vercel, Supabase, Google Cloud, Mailtrap, Google Search Console, and Namecheap (only needed in Phase 10). Bing Webmaster Tools only if you use "Connect with Bing".

### Step 2. Save a copy of your current settings
Take screenshots, so you can go back if needed:
- Vercel → your project → **Settings** → **Environment Variables**
- Supabase → **Authentication** → **URL Configuration**
- Supabase → **Authentication** → **Emails** → **SMTP Settings** (do not capture the password)
- Google Cloud → **Google Auth Platform** → **Clients** → your client → **Authorized redirect URIs**

### Step 3. Check the code is ready
Ask Claude in this project:

> Check that `main` on GitHub has the serpforge.io changes. List any remaining `visibll` mentions.

Only the old migration file, some history notes and this guide should still mention `visibll`.

**Done when:** Claude confirms the code is in `main`.

---

# Phase 2: DNS records (Hostinger)

DNS tells the internet where each address lives.

### Step 1. Open the DNS page
1. Go to <https://hpanel.hostinger.com> and log in.
2. **Domains** → **Manage** next to `serpforge.io` → **DNS / Nameservers** → **DNS records**.

Only **add** records. Do not edit or delete the ones that are already there.

### Step 2. Add the MCP record
Click **Add Record** and enter:

| Type | Name | Points to | TTL |
|---|---|---|---|
| **A** | `mcp` | `172.93.223.194` | `300` |

Type only `mcp` in the Name box (Hostinger adds `.serpforge.io` itself).

### Step 3. Check it worked
Open **Terminal** on your Mac and run:

```
nslookup mcp.serpforge.io 8.8.8.8
```

You should see `172.93.223.194`. If not, wait 10 minutes and run it again.

### Step 4. Start email verification in Mailtrap (this takes a while, so do it now)
1. Mailtrap → **Email Sending** → **Sending Domains** → **Add Domain**.
2. Enter `connect.serpforge.io` and click **Add**. Keep the old `visibll.in` domain for now.
3. Mailtrap shows **5 records** (4 CNAME and 1 TXT). Copy each one exactly into Hostinger → **Add Record**.
4. **Important:** In Hostinger's Name box, leave off the ending `.serpforge.io`. For example, if Mailtrap shows `abc._domainkey.connect.serpforge.io`, type `abc._domainkey.connect`.
5. Back in Mailtrap, click **Re-check DNS Records**. Mailtrap also fills in a short form about you and does an automatic review, which can take some hours.

Do not wait for it. Carry on with Phase 3.

> **Stop if** a Mailtrap record has the Name `connect` exactly, with nothing before it. That would clash with the website record in Phase 3. Ask Claude and share the record list.

**Done when:** `nslookup` shows `172.93.223.194` and all 5 Mailtrap records are added.

---

# Phase 3: Website (Vercel)

### Step 1. Add the new address
Vercel → your project → **Settings** → **Domains** → type `connect.serpforge.io` → **Add**. Keep the old `connect.visibll.in` there for now.

### Step 2. Add the DNS record that Vercel asks for
Vercel shows a record with a **Name** (`connect`) and a **Value** (something like `5a76…vercel-dns-017.com`). In Hostinger → **Add Record**:

| Type | Name | Points to | TTL |
|---|---|---|---|
| **CNAME** | `connect` | the value Vercel shows | `300` |

**If Hostinger says "conflicts with another resource record":** an old record named `connect` is in the way. Hostinger often creates one on its own: an **ALIAS** record named `connect` that points to `…cdn.hstgr.net`. Delete only that row, then add the CNAME again. Do not delete the Mailtrap rows (`mt-link.connect`, `mt07.connect`, `…_domainkey.connect`, `_dmarc.connect`).

Vercel shows a green tick after a few minutes.

### Step 3. Change two settings
Vercel → **Settings** → **Environment Variables**. Change these two (use **Add New**, or remove the old one and add it again):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://connect.serpforge.io` |
| `NEXT_PUBLIC_MCP_URL` | `https://mcp.serpforge.io/mcp` |

- Choose **Type: Config** (not Secret) and **Environment: Production**. If you pick Secret, Vercel shows "Remove the public framework prefix…". A variable already saved as Secret cannot be changed: remove it and add it again as Config.
- `NEXT_PUBLIC_APP_URL` is the important one. `NEXT_PUBLIC_MCP_URL` is optional.
- Do not touch anything else. If `GOOGLE_REDIRECT_URI` or `BING_REDIRECT_URI` are not in your list, you don't need them.
- If `SUPPORT_EMAIL` is there and ends with `@visibll.in`, change it to an address you can read. Otherwise leave it.

### Step 4. Rebuild the website
Vercel → **Deployments** → the top one → **⋯** → **Redeploy**. Wait until it says **Ready**.

### Step 5. Test
Open these in your browser:
- `https://connect.serpforge.io/api/health` shows `{"status":"ok"}`
- `https://connect.serpforge.io` shows your home page with a padlock

**Done when:** both pages load on the new address.

---

# Phase 4: Prepare the server (VPS)

Nothing here affects customers. The old MCP keeps running.

### Step 1. Log in to the server
In Terminal on your Mac:

```
ssh root@172.93.223.194
```

Paste the root password (nothing shows while you paste, that is normal). You should see a line ending in `root@mcp:~#`.

- Use `root`, not `serp`. The `serp` account has no password.
- **Lost the root password?** Reset it in your VPS provider's panel (**Reset root password**, or **Console** then type `passwd`). Do not choose **Reinstall**, it wipes the server. Don't try more than 3 wrong passwords in a row.

### Step 2. Download the latest code on the server
Copy and paste this whole line:

```
sudo -u serp git -C /home/serp/SERP-Connect pull --ff-only origin main
```

### Step 3. Add the new Nginx site
Nginx is the program that receives visitors. Paste these two lines, one at a time:

```
cp /home/serp/SERP-Connect/deploy/vps/nginx-mcp.conf.example /etc/nginx/sites-available/mcp.serpforge.io
sed -i '/^limit_req_zone/d' /etc/nginx/sites-available/mcp.serpforge.io
```

Then turn it on and test it:

```
ln -sf /etc/nginx/sites-available/mcp.serpforge.io /etc/nginx/sites-enabled/mcp.serpforge.io
nginx -t
```

You should see `syntax is ok` and `test is successful`. Then:

```
systemctl reload nginx
```

### Step 4. Get the HTTPS padlock
Replace `YOUR-EMAIL` with your email, then paste:

```
certbot --nginx -d mcp.serpforge.io -m YOUR-EMAIL --agree-tos --no-eff-email --redirect
```

You should see "Congratulations". Open `https://mcp.serpforge.io/healthz`. It should show `{"status":"ok"}`.

### Step 5. Change the server settings
Switch to the `serp` user:

```
su - serp
```

First save a backup of the current settings (you need it only if you undo):

```
cp ~/mcp.env ~/mcp.env.visibll-backup
```

Then paste this whole line (it changes only the two address lines):

```
sed -i 's#^MCP_PUBLIC_URL=.*#MCP_PUBLIC_URL=https://mcp.serpforge.io#; s#^MCP_RESOURCE_AUDIENCE=.*#MCP_RESOURCE_AUDIENCE=https://mcp.serpforge.io/mcp#' ~/mcp.env
```

Check the result:

```
grep -E "^MCP_(PUBLIC_URL|RESOURCE_AUDIENCE|ALLOWED_ORIGINS)" ~/mcp.env
```

You should see the two new `serpforge.io` addresses and no `visibll`. If `MCP_ALLOWED_ORIGINS` is listed with `visibll.in`, tell Claude.

**Do not restart anything yet.**

**Done when:** `https://mcp.serpforge.io/healthz` works and `mcp.env` shows the new addresses.

---

# Phase 5: Switch the MCP server (5 minutes)

Do Step 1 and Step 2 **right after each other**. Claude is briefly offline between them.

### Step 1. Update Supabase
Ask Claude in this project:

> Apply the migration `20261029100000_mcp_audience_hook_serpforge.sql` to my Supabase project.

(It changes the address that Claude's sign-in tokens are valid for. It does not affect normal website logins.)

<details>
<summary>Or do it by hand in Supabase</summary>

Supabase → **SQL Editor** → **New query** → paste → **Run**:

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
</details>

### Step 2. Restart the MCP server
On the server, as the `serp` user (the line should end in `serp@…$`; if not, run `su - serp`):

```
bash ~/SERP-Connect/deploy/vps/deploy.sh
```

You should see `OK: MCP server is running`.

### Step 3. Check
Open `https://mcp.serpforge.io/healthz`. It should show `{"status":"ok"}`. Then ask Claude:

> Run `pnpm mcp:check https://mcp.serpforge.io/mcp`

No line should say FAIL. (Lines about the Supabase sign-in setup can wait until Phase 6.)

The old `mcp.visibll.in` connector stops working now. That is expected (Phase 9 explains how customers fix it).

**Done when:** the health check works and `mcp:check` shows no FAIL.

---

# Phase 6: Supabase and email

### Step 1. Website address
Supabase → **Authentication** → **URL Configuration**:
1. **Site URL:** `https://connect.serpforge.io`
2. **Redirect URLs** → **Add URL:** `https://connect.serpforge.io/auth/callback`
3. Keep the old `connect.visibll.in` line for now.
4. **Save.**

### Step 2. Check the Claude sign-in settings
Supabase → **Authentication** → **OAuth Server**: it should be **on**, with **Authorization Path** `/oauth/consent` and **Dynamic Client Registration** on. Then **Authentication** → **Hooks**: *Customize Access Token (JWT) Claims* should be on. Change nothing if it already is.

### Step 3. Send email from the new domain
Wait until Mailtrap shows `connect.serpforge.io` as **Verified**.
1. Mailtrap → **Sending Domains** → `connect.serpforge.io` → **Integration** → **SMTP**. Note the **Host**, **Port** and **Username**.
2. The password is an API token. Mailtrap → **Settings** → **API Tokens** → **Add Token**, give it access to `connect.serpforge.io`. Copy it (only the new token works for the new domain).
3. Supabase → **Authentication** → **Emails** → **SMTP Settings**, change:
   - **Sender email:** `no-reply@connect.serpforge.io`
   - **Host, Port, Username:** from Mailtrap (item 1)
   - **Password:** the new token (item 2)
4. **Save.**

### Step 4. Test sign-up
On `https://connect.serpforge.io`, sign up with a non-Gmail address that is not already a user. The email should arrive from `no-reply@connect.serpforge.io`, and its button should open `connect.serpforge.io`. In Mailtrap → **Email Logs** it should show **Delivered**.

**Done when:** the confirmation email arrives and works.

---

# Phase 7: Google and Bing

### Step 1. Add the new return address in Google
1. <https://console.cloud.google.com> → your project → **Google Auth Platform** → **Clients** → your client.
2. **Authorized redirect URIs** → **Add URI** → paste exactly:

   `https://connect.serpforge.io/api/oauth/google/callback`

   (No space and no `/` at the end.) Keep the old address for now.
3. Leave **Authorized JavaScript origins** empty. **Save.** It can take a few minutes to apply.

### Step 2. Update the consent screen
**Google Auth Platform** → **Branding**:
- **Application home page:** `https://connect.serpforge.io/`
- **Privacy policy link:** `https://connect.serpforge.io/privacy`
- **Authorized domains:** add `serpforge.io` (keep `visibll.in` for now)
- **Save.**

If Google says it cannot verify `serpforge.io`, open <https://search.google.com/search-console> with the same Google account and add `serpforge.io` as a Domain property. If it is already there (likely), nothing to do.

Your Google app is in Testing mode, so there is no review to redo.

### Step 3. Bing (only if you use "Connect with Bing")
Bing Webmaster Tools → **Settings** → **API Access** → **OAuth Client** → add the redirect `https://connect.serpforge.io/api/oauth/bing/callback`. Keep the old one for now.

### Step 4. Test
On `https://connect.serpforge.io`, log in and click **Connect Search Console**. Google should open with no error and bring you back. If you see `redirect_uri_mismatch`, check the address in Step 1 for a typo and wait 5 minutes.

**Done when:** Connect Search Console works.

---

# Phase 8: Test everything

- [ ] `https://connect.serpforge.io` loads, and you can sign up, log in and log out
- [ ] The dashboard shows the connector link `https://mcp.serpforge.io/mcp`
- [ ] **Connect Search Console** and **Connect GA4** work
- [ ] An existing customer's data is still there
- [ ] In Claude: **Settings** → **Connectors** → **Add custom connector** → `https://mcp.serpforge.io/mcp` → sign in → **Allow**
- [ ] Ask Claude: "Run get_connection_status" and then ask for a Search Console report. You get real numbers.

If something fails, see **Troubleshooting** at the end.

---

# Phase 9: Tell customers

Send this:

> We moved to a new address: https://connect.serpforge.io. To keep using Claude with your data:
> 1. In Claude open **Settings** → **Connectors** and **remove** the old SERP Connect connector.
> 2. Click **Add custom connector** and paste `https://mcp.serpforge.io/mcp`.
> 3. Sign in and click **Allow**.
>
> Your connected Google, Bing and Clarity accounts do not need to be reconnected.

---

# Phase 10: One week later, remove the old domain

Do this only after a week with no problems.

### Step 1. Redirect the old website
Vercel → **Settings** → **Domains** → `connect.visibll.in` → **Edit** → **Redirect to Another Domain** → `connect.serpforge.io` → **Save**.

### Step 2. Remove the old return addresses
- Supabase → **Authentication** → **URL Configuration**: remove the `connect.visibll.in` line.
- Google Cloud → **Clients**: remove the old `connect.visibll.in` redirect. **Branding**: remove `visibll.in` from **Authorized domains**.
- Bing: remove the old redirect (if used).

### Step 3. Turn off the old MCP address
On the server as `root`:

```
rm /etc/nginx/sites-enabled/mcp.visibll.in
nginx -t && systemctl reload nginx
```

### Step 4. Remove the old email domain
First confirm Supabase's SMTP sender shows `no-reply@connect.serpforge.io`, and nothing else you run still sends from `@visibll.in`.
1. Mailtrap → **Sending Domains** → `visibll.in` → delete it. Delete the old API token too.
2. Namecheap → `visibll.in` → **Advanced DNS**: delete the 5 Mailtrap records you added for it. Delete only those.
3. In Hostinger, keep the 5 records for `connect.serpforge.io`.

### Step 5. Tidy up
- On the server, delete the backup: `rm /home/serp/mcp.env.visibll-backup` (if you made one).
- Update links to the old address in social profiles, email signatures and directory listings.

---

# Troubleshooting

| What you see | What to do |
|---|---|
| Claude says "unauthorized" | The Supabase hook and `MCP_RESOURCE_AUDIENCE` must both be exactly `https://mcp.serpforge.io/mcp`. Check Phase 4 Step 5 and Phase 5 Step 1, then run `deploy.sh` again |
| Claude still uses the old connector | Remove it and add the new link (Phase 9) |
| `redirect_uri_mismatch` | Check the Google address in Phase 7 Step 1. Wait 5 minutes |
| Sign-up email links to `visibll.in` | Phase 6 Step 1. Request a new email |
| Email says "from visibll.in", or "error sending confirmation email" | Phase 6 Step 3. Mailtrap must show Verified and the token must be for the new domain |
| Mailtrap shows a record as Missing | You probably typed `.serpforge.io` in the Name box. Fix it (Phase 2 Step 4), wait 15 minutes, click **Re-check DNS Records** |
| Hostinger: "conflicts with another resource record" | Phase 3 Step 2: delete the `connect` ALIAS row |
| Vercel: "Remove the public framework prefix…" | Add the variable again as Type **Config** (Phase 3 Step 3) |
| Vercel shows "Invalid Configuration" | The `connect` record is missing or wrong. Compare with what Vercel shows. Wait 10 minutes |
| Dashboard still shows the old connector link | Vercel → Deployments → **Redeploy** (Phase 3 Step 4) |
| `ssh root@…` says "Permission denied" | Wrong or lost password. See Phase 4 Step 1 |
| `ssh serp@…` says "Permission denied" | `serp` has no password. Log in as `root`, then run `su - serp` |
| `https://mcp.serpforge.io` shows "502 Bad Gateway" | The MCP server is not running. On the server run `pm2 status` and `pm2 logs serp-mcp --lines 50`, and send Claude the error |
| Certbot fails | The DNS record isn't ready yet (Phase 2 Step 3), or ports 80/443 are closed |
| Google works for you but not a customer | The app is in Testing mode. Add them under Google Auth Platform → **Audience** → **Test users** |

---

# Undo (before Phase 10)

- **Website:** In Vercel set `NEXT_PUBLIC_APP_URL` back to `https://connect.visibll.in` and redeploy. In Supabase set Site URL back. To show the old connector link, ask Claude: "Revert the `mcp-url.ts` change and push to `main`."
- **MCP server:** On the server, restore the old settings: `cp /home/serp/mcp.env.visibll-backup /home/serp/mcp.env`. Ask Claude: "Apply `20261022100000_mcp_audience_hook_visibll.sql` to my Supabase project". Then run `pm2 startOrReload ~/SERP-Connect/deploy/vps/ecosystem.config.cjs --update-env` as `serp`.
- **Email:** In Supabase SMTP settings, set the sender back to `no-reply@visibll.in` and the old Mailtrap token.

If you are not sure what broke, stop changing things and ask Claude, with the exact error and the Phase and Step you were on.
