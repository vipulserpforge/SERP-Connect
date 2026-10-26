# Fix: "Can't add the Bing API token / connect Bing"

**Cause:** saving a Bing API key needs a secret called `CREDENTIAL_FINGERPRINT_KEY`. On the live site it was missing, so the app refused to save with: *"Clarity and Bing API-key connections are not configured on this server yet."*

**A second cause was found:** `PROVIDER_BING_ENABLED` was missing from `web.env` and `mcp.env`. When it is missing it counts as `false`, so Bing is switched off on the live site even with a good key. It is now `true` in all three files.

**Fix:** put the key you generated into **three places** (your Mac, Vercel, the VPS). It must be the **exact same value** everywhere.

> **Golden rule:** never paste the key into chat, email, GitHub or a screenshot. Only into the three places below.

---

## What is already done on your Mac

These three files were already updated (the key is the one you generated; it is not written in this document):

| File | Key | `PROVIDER_BING_ENABLED=true` |
|---|---|---|
| `.env.local` (project folder) | added | already there |
| `~/Documents/private-serp/web.env` | replaced (it held an older key) | added |
| `~/Documents/private-serp/mcp.env` | replaced (it held an older key) | added |

**Still to do:** the live Vercel site and the VPS do not read these files by themselves. Do steps 2 and 3 below. Step 1 only needs a restart.

---

## 0. Check your key first

A good key is 44 characters long, ends with `=`, and looks like `k3J9...x2Q=`. If you lost it, make a new one (this is safe, see the note at the end):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the line it prints. Use that same line in every step below.

---

## 1. Your Mac (for local testing and `pnpm bing:check`)

Already done (see the table above). The only thing left is to stop and restart `pnpm dev:web` (and `pnpm dev:mcp` if it is running) so they read the new value.

To check without showing the key, run this in the project folder. It must print `1`:
```
grep -c '^CREDENTIAL_FINGERPRINT_KEY=' .env.local
```

---

## 2. Web app on Vercel

1. Go to <https://vercel.com> → your project → **Settings** → **Environment Variables**.
2. If `CREDENTIAL_FINGERPRINT_KEY` is already in the list (it probably is, with the older key), click **⋯ → Edit** on it. Otherwise click **Add New**.
   - **Key:** `CREDENTIAL_FINGERPRINT_KEY`
   - **Value:** the new key. Open `~/Documents/private-serp/web.env` on your Mac and copy the value after the `=`.
   - **Environments:** tick **Production** (and Preview if you use it).
   - Turn on **Sensitive** if offered.
3. Click **Save**.
4. Also add `PROVIDER_BING_ENABLED` = `true` (it was missing, which means "off"). If it exists with `false`, edit it to `true`.
5. **Redeploy** (Vercel only picks up new variables on a new deployment): **Deployments** tab → the top deployment → **⋯** → **Redeploy**.

---

## 3. MCP server on the VPS

1. `~/Documents/private-serp/mcp.env` on your Mac already has the new key and `PROVIDER_BING_ENABLED=true`. Nothing to edit.
2. Copy the file to the server (same command as in `docs/mcp-web.md`, section 5):
   ```
   scp ~/Documents/private-serp/mcp.env root@172.93.223.194:/home/serp/mcp.env
   ```
3. Log in to the server and fix the file's owner and permissions:
   ```
   ssh root@172.93.223.194
   chown serp:serp /home/serp/mcp.env && chmod 600 /home/serp/mcp.env
   grep -c 'CREDENTIAL_FINGERPRINT_KEY' /home/serp/mcp.env
   grep 'PROVIDER_BING_ENABLED' /home/serp/mcp.env
   ```
   The first check must print `1` (it only counts the line, it does not show the key). The second must print `PROVIDER_BING_ENABLED=true`.
4. Restart the MCP server so it reads the file:
   ```
   su - serp
   pm2 restart serp-mcp --update-env
   pm2 status
   ```
   `serp-mcp` must say **online**. If not: `pm2 logs serp-mcp --lines 50`.

---

## 4. Test the fix

1. Open the live dashboard, scroll to the **Bing** card.
2. Paste your Bing API key (see step A below) and press **Connect**.
3. It should save and say connected. If it still fails, copy the **exact message** and tell Claude.

---

# Next steps (in order)

### A. Get your Bing API key
1. Sign in at <https://www.bing.com/webmasters>.
2. Make sure your website is added and **verified** there. Only verified sites are imported.
3. Click the gear icon → **Settings** → **API Access** → **API Key** → **Generate API Key**.
4. Copy it. It is letters and numbers only (about 32 characters). No spaces.

### B. Run the safety check from your Mac (read-only)
1. In `.env.local` add a temporary line: `BING_TEST_API_KEY=your-bing-key`
2. Run:
   ```
   pnpm bing:check --yes
   ```
3. You should see PASS for list sites, traffic, queries and crawl.
4. **Delete the `BING_TEST_API_KEY` line afterwards.**

### C. Connect on the live dashboard
Do step 4 above. Then press **Refresh sites**. Your verified sites appear, each with a "Visible to Claude" switch.

### D. Ask Claude to read Bing data
In Claude, ask: *"List my Bing sites"* then *"Show Bing traffic for the last 28 days for <your site>"*. Remember Bing's numbers are never the same as Google's, and query data updates weekly.

### E. Optional: "Connect with Bing" login button (OAuth)
Skip this if the API key works. It is only needed if you want customers to connect without pasting a key.
1. In Bing Webmaster Tools: **Settings → API Access → OAuth Client** → create a client.
2. Register this redirect address **exactly**: `https://connect.visibll.in/api/oauth/bing/callback`
3. Add `BING_CLIENT_ID` and `BING_CLIENT_SECRET` to **Vercel** and to **mcp.env on the VPS**, then redeploy and restart as in steps 2 and 3.
4. Press **Connect with Bing** with a test account and confirm sites load. Wait about an hour and load a report again to prove token renewal works.

---

## Good to know

- **Same key on both servers.** If web and MCP have different values, the two apps will not recognise each other's saved fingerprints (quota tracking breaks).
- **Changing the key is not a disaster.** The old key on your Mac was replaced; the only effect is that Clarity quota history starts fresh. Nobody has to reconnect. (`SECRET_KEYS` is the different key that must **never** be lost.)
- **Never commit** `.env.local`, `web.env` or `mcp.env` to GitHub.

## If it still fails

| Message | Fix |
|---|---|
| "not configured on this server yet" | The key is missing on the server you are using. Redo step 2 (and redeploy) or step 3. |
| "must be 32 bytes, base64-encoded" | The key was pasted wrong (extra space, cut off, or in quotes). Generate a new one with step 0. |
| "That does not look like a Bing Webmaster API key" | Copy the Bing key again. Letters and digits only. |
| Bing card says unavailable | `PROVIDER_BING_ENABLED` is not `true` on that server. |
| Connected but no sites | No verified site on that Bing account. Verify one at Bing, then press **Refresh sites**. |
