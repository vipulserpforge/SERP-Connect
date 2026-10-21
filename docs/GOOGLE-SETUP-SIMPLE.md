# Google setup, step by step (for non-coders)

This is the "follow it from top to bottom" version of the Google Cloud setup, for an **External** app (anyone with a Google account can eventually connect). You do not need to write code. You will click through Google's website, copy two values, paste them into one file on your computer and into your Hostinger hosting, and run a few short commands.

The technical version (with sources) is in [`GOOGLE-SETUP.md`](GOOGLE-SETUP.md). If this guide and Google's screen ever disagree, trust Google's screen: Google renames menus now and then. I could not log in to your Google account, so every click below comes from Google's documentation, not from watching it happen.

---

## Part 0. Read this first (5 minutes)

### What you are setting up

Your app needs permission to read people's Search Console and Google Analytics data. Google grants that permission through something called an **OAuth client**. Think of it as an ID badge for your app. You create **one** badge, and it lives in a Google Cloud **project** that you own. Your customers never create anything in Google Cloud. They just click "Connect" and approve.

### What "External" means, and the three stages every External app goes through

**External** means any person with a Google account can connect, not only people in your own company. You do **not** need a Google Workspace organization for this; a normal Gmail account can own the project.

Google does not open an External app to the public on day one. It goes through three stages:

| Stage | Who can connect | What to expect | How long |
|---|---|---|---|
| **1. Testing** (where you start) | Only people you list by email as **test users** (maximum 100 for the whole life of the project) | Google shows an "unverified app" warning screen that people must click through. **Every connection stops working 7 days after it was approved**, so you and your testers must click Connect again weekly | As long as you need |
| **2. Verification** | Still only test users | You submit the app to Google for review. Google says this typically takes **3 to 5 business days**, longer if they ask questions | Start as soon as the live website works |
| **3. Public** ("In production") | Any Google account | No weekly expiry. If your permissions are classed as sensitive and you are not verified yet, people still see the warning screen and there is a cap on how many can connect | After approval |

Things worth knowing now:

1. **Until you finish stage 3, real customers cannot connect.** Only the test users you added can. Plan your launch date around the review time, not around the website being ready.
2. **Whether Google makes you go through verification depends on whether your two permissions are labelled "sensitive".** Google's documentation I read does not say either way for these two. The console tells you: in Part 5 you will look at the **Data Access** page and write down what it shows. If they are sensitive (assume so until you see otherwise), verification is required to publish.
3. **Google checks your website.** For verification you need a live HTTPS website on a domain you own, with a public home page, a privacy policy page, and a verified domain. Your Hostinger deployment ([`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md)) provides those. This is why it is best to get the website online early, even before customers exist.
4. **The 100 test-user limit counts forever,** even if you later remove people. Add only people who really need to test.

### Two places where the Google values go

The same two Google values (Client ID and Client secret) are needed in two different places. Keep them apart in your head:

| Where | When | How |
|---|---|---|
| **Your computer**: the file `.env.local` in the `SERP Connect` folder | While you test on your own computer (`http://localhost:3000`) | Part 7 of this guide |
| **Hostinger** (your hosting): hPanel → the app → **Environment variables** | For the live website at `https://connect.serpforge.io` and the MCP server | Part 9b below and [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md) |

Your live site and MCP server run on your **Hostinger Cloud plan**. The website and the MCP server are **two separate apps** there, and **both** need the Google Client ID and secret. The file `.env.local` on your computer is never uploaded to Hostinger or GitHub.

### What you will need

- A Google account to own the project (your own Gmail is fine, but a company-owned address is better long term, because changing the owner later is awkward).
- This project's folder on your computer (`SERP Connect`), and a Terminal window opened in it.
- Your domain name (`serpforge.io`) and the two addresses you plan to use: `connect.serpforge.io` and `mcp.serpforge.io`.
- About 45 minutes the first time.

### Safety rules (please follow these)

- The **Client secret** is a password. Never paste it in a chat, an email, a screenshot, or a document that gets shared. Never put it in GitHub.
- You will paste it in two places only: the file named `.env.local` on your computer (Part 7, already blocked from GitHub), and Hostinger's **Environment variables** screen (Part 9b). Nowhere else.
- If you ever leak it by mistake, you can replace it in 2 minutes (Part 7c).

---

## Part 1. Create the Google Cloud project

A "project" is just a container in Google Cloud for your app's settings.

1. Open <https://console.cloud.google.com/> and sign in with the Google account that should own this.
2. If Google shows a "Terms of Service" box, tick it and continue.
3. Click the box in the top bar, left side, next to the words "Google Cloud". It shows a project name or says "Select a project". A window opens.
4. In that window click **New project** (top right).
5. Fill in:
   - **Project name:** `serp-connector` (anything you like; customers will not see this).
   - **Organization / Location:** if you see "No organization", that is fine; leave it. (An organization is only needed for "Internal" apps, which you are not using.)
6. Click **Create**. Wait about 20 seconds. A bell icon in the top bar will show "Create Project: serp-connector" when done.
7. Click the project selector again and **select `serp-connector`**. The project name must now appear in the top bar. **Always check this before each step below**, because it is the most common mistake.

---

## Part 2. Turn on the three Google APIs

An API is a door into one Google product. Each door is closed until you switch it on.

For each of the three APIs below:

1. In the left menu click **APIs & Services**, then **Library**. (If you cannot see the left menu, click the three-line "hamburger" icon at the top left. Direct link: <https://console.cloud.google.com/apis/library>.)
2. In the search box type the name, press Enter, and click the matching result.
3. Click the blue **Enable** button. Wait until you see the API's overview page.

The three APIs:

| # | Type this in the search box | Exact name on the result |
|---|---|---|
| 1 | `Google Search Console API` | Google Search Console API |
| 2 | `Google Analytics Data API` | Google Analytics Data API |
| 3 | `Google Analytics Admin API` | Google Analytics Admin API |

**Check:** go to **APIs & Services → Enabled APIs & services**. You should see all three listed. If one is missing, the app will later say "Google API access is not configured".

---

## Part 3. Branding (what people see on the permission screen)

Fill in everything now, including the website addresses, even though the website may not be online yet. You will come back to confirm them before verification.

1. In the top search bar of the console type `Google Auth Platform` and click it. Direct link: <https://console.cloud.google.com/auth/overview>.
2. If you see a **Get started** button, click it. Google walks you through a short form (app name, support email, audience, contact email). Otherwise, in the left menu click **Branding**. Use the values below either way.
3. **App information**
   - **App name:** the name customers will see, for example `SEO Analytics Connector`. It must be your real product name; Google checks that it is accurate.
   - **User support email:** an inbox you really read (Google emails problems here).
   - **App logo:** optional now. Adding one means the logo goes through Google's review as well, so it is simplest to skip it until the rest is approved.
4. **App domain**
   - **Application home page:** `https://connect.serpforge.io/`
   - **Application privacy policy link:** `https://connect.serpforge.io/privacy` (the app already has this page; see Part 9a)
   - **Application terms of service link:** optional.
   - **Authorized domains:** click **Add domain** and type your main domain, `serpforge.io` (without `https://` and without `connect.`).
5. **Developer contact information:** your email.
6. Click **Save** (or **Next** / **Create** if it is the first-time wizard).

---

## Part 4. Audience: External, Testing, and your test users

1. Left menu → **Audience**. (Direct link: <https://console.cloud.google.com/auth/audience>.)
2. **User type:** choose **External** (in the first-time wizard, pick External when asked; otherwise it shows the current type with a button to change it).
3. **Publishing status:** it should say **Testing**. Leave it as Testing for now. Do **not** click "Publish app" yet.
4. **Test users:** find the **Test users** section and click **Add users**. Add the email address of **every Google account that will connect during testing**:
   - the Google account(s) that own your Search Console sites and GA4 properties,
   - your own login, and anyone helping you test.

   Click **Save**. Remember the limit: 100 people, counted for the whole life of the project.
5. **Check:** the page shows User type **External**, Publishing status **Testing**, and your test users in the list.

> If a person is not on this list, Google will show them `access_denied` when they try to connect. That is expected while you are in Testing.

---

## Part 5. Data Access: the permissions your app asks for

Your app asks for read-only access to two things, plus the person's email address so it can show which account is connected.

1. Left menu → **Data Access**. (Direct link: <https://console.cloud.google.com/auth/scopes>.)
2. Click **Add or remove scopes**. A panel slides in with a long list.
3. Use the filter box in the panel, or scroll to the bottom to the box named **Manually add scopes**. Paste these, **one per line**, then click **Add to table**:

   ```
   https://www.googleapis.com/auth/webmasters.readonly
   https://www.googleapis.com/auth/analytics.readonly
   ```
4. Also make sure these two basic ones are ticked in the list (they are usually near the top): **`.../auth/userinfo.email`** and **`openid`**.
5. Click **Update**, then **Save** at the bottom of the page.
6. In the table, look at the column or label that tells you whether each permission is **Sensitive** or **Restricted**. Write down what you see: webmasters.readonly: ____________ , analytics.readonly: ____________ . If either is Sensitive or Restricted, you must go through Google's verification (Part 9) before the public can connect. Do not add any other permission.

---

## Part 6. Create the OAuth client (your app's ID badge)

1. Left menu → **Clients**. (Direct link: <https://console.cloud.google.com/auth/clients>.)
2. Click **Create client**.
3. **Application type:** choose **Web application**. (Not Desktop, not Android, not Web "single page". It must be "Web application".)
4. **Name:** `serp-connector web`.
5. **Authorized JavaScript origins:** leave empty. Do not add anything.
6. **Authorized redirect URIs:** click **Add URI** and paste this **exactly** (every character, no spaces, no slash at the end):

   ```
   http://localhost:3000/api/oauth/google/callback
   ```
   This is the web address Google sends the person back to after they approve. It must match the app character for character.

   Click **Add URI** again and add the live address, using your real domain:

   ```
   https://connect.serpforge.io/api/oauth/google/callback
   ```
   The `connect.serpforge.io` part must be exactly the address you will use for the dashboard, it must start with `https`, and there is no `/` at the end. (You can add this second line later if the website is not online yet.)

   > **Put these in the right box.** The page has two similar boxes: "Authorized JavaScript origins" and "Authorized redirect URIs". The addresses above go **only** in **Authorized redirect URIs**. Leave the JavaScript origins box empty.
7. Leave "Use this client for an AI-powered agent" **unticked**.
8. Click **Create**. (Later, if you ever edit these addresses on an existing client, you **must click Save at the bottom of that page**, otherwise nothing is stored.)
9. A box appears with two values:
   - **Client ID**: looks like `123456789012-abcdefg1234567.apps.googleusercontent.com`
   - **Client secret**: a long random string. **Google shows it only this once.**
10. Click **Download JSON** only if you want a backup copy. If you do, save it **outside** the `SERP Connect` folder (for example your Documents folder in a folder called "private"), then do not share it.
11. Keep this box open (or copy both values into a password manager such as 1Password) until Part 7 is done. If you close it too early and lose the secret, no harm: open the client, click **Add secret**, and copy the new one.

---

## Part 7. Put the two values into your project

This part is for testing **on your own computer**. (The live Hostinger site gets the same two values in hPanel instead; see Part 9b and [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md).)

You will edit one text file called `.env.local` in the `SERP Connect` folder. It already exists and already holds your Supabase settings, so **do not delete anything in it**. You only change one line and add two.

### 7a. Open the file

The file name starts with a dot, so Finder hides it. Easiest way, in Terminal:

1. Open **Terminal** (press Cmd+Space, type `Terminal`, Enter).
2. Type this and press Enter (this moves into your project folder):
   ```
   cd ~/Downloads/"SERP Connect"
   ```
3. Open the file in TextEdit:
   ```
   open -e .env.local
   ```
   (If you use VS Code, `code .env.local` works too.)

### 7b. Edit it

1. Find the line that says `DATA_MODE=mock` and change it to:
   ```
   DATA_MODE=live
   ```
2. Go to the very end of the file, press Enter to start a new line, and add these two lines. Replace the parts in `<...>` with your values. **No quotes, no spaces around the `=`, no trailing spaces.**
   ```
   GOOGLE_CLIENT_ID=<paste the Client ID here>
   GOOGLE_CLIENT_SECRET=<paste the Client secret here>
   ```
   Example shape (fake): `GOOGLE_CLIENT_ID=123456789012-abcdefg1234567.apps.googleusercontent.com`
3. Leave `NEXT_PUBLIC_APP_URL=http://localhost:3000` as it is. Do **not** add a `GOOGLE_REDIRECT_URI` line; the app builds the correct one itself.
4. Do not touch the `SECRET_KEYS=` line. It encrypts the Google connections you create. If you change or delete it, connections already saved cannot be read and you would have to reconnect.
5. Save (Cmd+S) and close the file. In TextEdit, if it asks about the format, choose "Use Plain Text".

> **If you use TextEdit and it behaves oddly:** choose Format → Make Plain Text first, then Cmd+S.

### 7c. If the secret leaks (or you pasted it somewhere by mistake)

Console → Google Auth Platform → Clients → click your client → **Add secret** → copy the new one into `.env.local` **and into both Hostinger apps** → then **Disable** and **Delete** the old secret on that same page. Takes a few minutes.

---

## Part 8. Test it on your computer

### 8a. Check your settings (no Google login needed)

In Terminal (still inside the project folder):

```
pnpm google:check
```

You want every line to start with `PASS` (a few `WARN` lines are fine). The line **"Redirect URI to register in Google"** should show exactly `http://localhost:3000/api/oauth/google/callback`. Any line starting with `FAIL` tells you what is wrong in plain words.

### 8b. Ask Google if it recognises your client

```
pnpm google:check --probe --secret
```

This contacts Google but connects nothing. Expect `PASS` on "Google accepts the gsc authorization request", "...ga4...", and "Client secret". If it says `invalid_client`, the Client ID or secret was copied wrongly.

**If you see `FAIL ... redirect_uri_mismatch` ("You can't sign in to this app because it doesn't comply with Google's OAuth 2.0 policy")** while "Client secret" says PASS: your Client ID and secret are right, but Google does not have the callback address saved on that client. Fix it:

1. Open <https://console.cloud.google.com/auth/clients>. Check the project name in the top bar is `serp-connector`.
2. Click your client (the one whose Client ID matches the one in your `.env.local`).
3. Under **Authorized redirect URIs**, there must be a line that is exactly (copy and paste; no space before or after, no `/` at the end):
   ```
   http://localhost:3000/api/oauth/google/callback
   ```
   If it is missing, click **Add URI** and paste it. If it is in the "Authorized JavaScript origins" box, move it to the redirect box.
4. Scroll to the bottom and click **Save**. Wait for the "saved" message.
5. Wait 5 minutes (Google says changes can take a few minutes, occasionally longer), then run the command again.

### 8c. Start the app

```
pnpm install
pnpm dev:web
```

(`pnpm install` only matters the first time.) Wait until you see `Local: http://localhost:3000`. **Leave this Terminal window open.** To stop the app later, click in the window and press Ctrl+C.

### 8d. Make your account in the app and connect Google

1. Open <http://localhost:3000> in your browser.
2. Click **Create account**, enter an email and password, then open the confirmation email Supabase sends and click its link. (This login is for *your app*; it is separate from Google.)
3. Sign in. You land on the **Integrations** page.
4. In the "Google Search Console & GA4" box click **Connect Search Console**.
5. Google opens. Pick a Google account that is on your **Test users** list and has Search Console access.
6. Because the app is in Testing, Google shows **"Google hasn't verified this app"**. This is normal. Click **Continue** (if you only see "Back to safety", click **Advanced** first, then **Go to <your app name> (unsafe)**).
7. Read the permission screen. It should say your app wants to **view Search Console data**. Click **Continue** / **Allow**.
8. You return to the Integrations page with a green message "Search Console account connected" and a list of sites.
9. Click **Connect GA4** and do the same. You should see "GA4 properties available" and the list.

### 8e. Things worth trying (tick them off)

- [ ] Search Console sites appear, each with an "Enable for Claude / Disable for Claude" link.
- [ ] GA4 properties appear.
- [ ] Click **Refresh properties** and the list stays correct.
- [ ] Click **Disconnect**, then visit <https://myaccount.google.com/permissions> with that Google account: your app should no longer be listed.
- [ ] Connect with a Google account that has **no** Search Console sites. You should get a friendly "no properties" message, not an error.
- [ ] Try a Google account that is **not** on the Test users list. You *should* be blocked with `access_denied`. That proves Testing mode is protecting you.
- [ ] A week later, open the dashboard: the connection will show "needs attention" because Testing connections expire after 7 days. Click Disconnect, then Connect again. (This is expected until the app is public.)

Then repeat the connect test on the **live site** once it is online ([`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md)).

If something fails, see Part 10.

---

## Part 9. Going public: put the Google values on Hostinger, then publish and verify

Do 9a and 9b as soon as you have something working on your computer. Do 9c once the live site works. The review takes days, so do not leave it to the last minute.

### 9a. Things to prepare for Google's review

- [ ] **A live website on HTTPS** on a domain you own, hosted on your Hostinger Cloud plan (`https://connect.serpforge.io`). Follow [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md) first. Google visits your home page and privacy page.
- [ ] **Verify the domain** in Google Search Console (<https://search.google.com/search-console>) using the same Google account that owns the Cloud project, as an **Owner** of the domain property. Google requires this for the domain you listed in Part 3. (Add the domain as a "Domain" property and follow the DNS instructions; Hostinger's DNS editor is in hPanel → Domains → DNS.)
- [ ] **A public home page** that explains what the app does and links to the privacy policy. The app's home page already does this once deployed.
- [ ] **A privacy policy** at `https://connect.serpforge.io/privacy`. The app includes a **draft** page written from how the app really handles data. Read it, and have whoever advises you on legal matters review it. Add your contact email by setting `SUPPORT_EMAIL` in the website's Hostinger environment variables. It must clearly say how Google data is used, stored and shared.
- [ ] **A short screen recording** (upload to YouTube and set it to *Unlisted*) showing the whole connect flow in English: the browser address bar with the client ID visible, the Google permission screen with your app name, and what the app does with each permission (listing sites, showing reports).
- [ ] **A sentence per permission** explaining why you need it, and why a narrower one will not do (for example: "analytics.readonly lets the customer's own GA4 reports be fetched on their behalf; there is no narrower read-only report scope").
- [ ] **A working demo account** on the live site Google's reviewer could use if they ask (Google may request test access). Keep its email and password somewhere safe; share only through Google's review form if asked.

### 9b. Put the Google values into Hostinger

1. In hPanel, open the **website** app → **Environment variables** → add (or edit) `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and check `DATA_MODE=live` and `NEXT_PUBLIC_APP_URL=https://connect.serpforge.io` → **Save** (saving redeploys the app and takes a few minutes).
2. Open the **MCP server** app → **Environment variables** → add the **same** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` → **Save**.
3. Both apps must have both values, and the same `SECRET_KEYS`. Full list: [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md) Part 2.
4. In Google (Clients → your client), confirm the redirect URI `https://connect.serpforge.io/api/oauth/google/callback` is listed (Part 6).
5. Connect one test account on the live site, as in Part 8d.

### 9c. Publish and submit for verification

Do this only when the live site works and 9a is complete.

1. Console → Google Auth Platform → **Branding**: make sure the home page, privacy policy link and authorized domain from Part 3 are correct. (You cannot edit branding while a verification is in progress.)
2. **Audience** → click **Publish app** and confirm. The status changes from Testing to **In production**.
3. If your permissions are Sensitive or Restricted (Part 5), the console will tell you verification is needed. Follow its prompts to **submit for verification**: upload the video link, the permission reasons, and confirm the domain and privacy policy. Google may ask follow-up questions by email to your support/developer address. **Check that inbox daily** during the review, because slow replies delay approval.
4. While waiting, the app works for any Google account, but people see the "unverified app" warning and Google caps how many accounts can connect. Keep using test accounts only.
5. When Google approves, the warning disappears and the cap is lifted. Connect one fresh account on the live site to confirm, and tell your first customers.

Google also says that a passed brand check is only valid for 7 days before you publish; if you let it lapse you may need to re-verify. So publish soon after Google clears your branding.

### 9d. Good to know

- Google generally recommends a **separate project for the public app**, without any `localhost` address in it. A clean way: when you reach 9c, create a second project `serp-connector-prod`, repeat Parts 1 to 6 there (External; only the `https://connect.serpforge.io/...` redirect), publish and verify **that** project, and put its Client ID/secret in both Hostinger apps. Keep the first project for testing on your computer. This also means test users and weekly expiries never touch your live customers.
- Anyone who connected through the old project must click Connect again after you switch the Hostinger values, because their saved permission belongs to the old client.
- Changing the app name, logo or website addresses after approval can send the app back for another review. Decide them before submitting.

---

## Part 10. If something goes wrong

| What you see | In plain words | What to do |
|---|---|---|
| Google page or `pnpm google:check --probe`: **redirect_uri_mismatch** ("doesn't comply with Google's OAuth 2.0 policy") | The address the app used is not saved under **Authorized redirect URIs** on that client (not saved, wrong box, typo, or not applied yet) | In Clients → your client → make the Authorized redirect URI exactly `http://localhost:3000/api/oauth/google/callback` (on your computer) or `https://connect.serpforge.io/api/oauth/google/callback` (live). No space, no `/` at the end. Save and retry (it can take a few minutes to apply) |
| Google page: **invalid_client** or "OAuth client was not found" | Client ID is wrong, or you copied it from another project | Re-copy the Client ID from Clients, check the project name in the top bar, update `.env.local` (and Hostinger), restart the app |
| Google page: **access_denied** ("has not completed verification" / "only developer-approved testers") | In Testing mode this account is not on the Test users list | Audience → Test users → Add users, then try again |
| "Google hasn't verified this app" | Normal in Testing, and until verification is approved | Click Advanced → Go to the app (unsafe) for your own testing. Customers should not be asked to do this: finish Part 9c first |
| Connection shows "needs attention" about a week after connecting | Testing-mode connections expire after 7 days | Click Disconnect then Connect again. This stops after the app is published |
| App says "not configured" / Connect button is greyed out | The app did not read your Google values | Check `.env.local` lines (no quotes/spaces), make sure `DATA_MODE=live`, stop the app (Ctrl+C) and run `pnpm dev:web` again. On the live site, check the variables in hPanel and wait for the redeploy |
| After connecting: "Google API access is not configured on this server yet" | One of the three APIs in Part 2 is not enabled, or enabled in a different project | Check you are in the right project, then enable all three |
| After connecting, no sites listed | That Google account has no Search Console/GA4 access | Connect an account that can see those properties |
| Google's review email asks for changes | Normal | Reply to the email, fix the item (usually the privacy policy wording, the domain verification or the video), and resubmit |
| `pnpm: command not found` | pnpm is not installed | Ask your developer, or follow <https://pnpm.io/installation> |
| `pnpm google:check` shows FAIL on `DB_MODE` | Live mode needs the database | Make sure `.env.local` has `DB_MODE=postgres` and the `SUPABASE_DB_URL` line |

When asking for help, copy the **error message text**, but never the Client secret or anything starting with `GOCSPX-`.

---

## Part 11. What is done after this guide, and what is next

After Part 8 you have proven that Google sign-in, property listing and (via the dashboard report endpoint) reporting work with **your** Google project. Still ahead, in this order:

1. Put the website and MCP server online on Hostinger ([`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md)); overview in [`DEPLOYMENT.md`](DEPLOYMENT.md). Do this early: Google's review needs it.
2. Publish and submit for verification (Part 9c), then keep testing with your test users while you wait.
3. Connect Claude to the MCP server ([`MCP.md`](MCP.md)): this needs Supabase's OAuth server switched on, which is currently off in your project. You can do this while Google reviews.

---

## Glossary

- **Google Cloud project**: a folder in Google Cloud that holds your app's Google settings.
- **API**: a door into a Google product (Search Console, Analytics). You switch each door on.
- **OAuth client**: your app's ID badge with Google (Client ID = badge number, Client secret = its password).
- **Consent screen**: the "this app wants to view your data. Allow?" page customers see.
- **Scope**: one specific permission (for example "view Search Console data").
- **Redirect URI**: where Google sends the person back after they approve. Must match exactly.
- **External**: anyone with a Google account can eventually connect (as opposed to "Internal", only people in your own company's Google Workspace).
- **Testing / In production**: Testing limits an External app to a short list of test users with weekly expiry; In production opens it to everyone.
- **Test user**: a Google account you listed on the Audience page so it can connect while the app is in Testing.
- **Verification**: Google's review before a public app that asks for sensitive permissions is trusted. Typically 3 to 5 business days.
- **`.env.local`**: the private settings file on your computer. Never share or upload it.
