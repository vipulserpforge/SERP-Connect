# Provider credential management

How Google Search Console / GA4 credentials are stored, refreshed, revoked and deleted, and which secrets production will need. Everything here runs on the server; nothing sensitive reaches browser code.

## Identity layers (kept separate)

1. **App user**: Supabase `auth.users.id`. Owns everything.
2. **Provider connection**: a Google account the user links, keyed by Google's stable `sub` (never by email). One user may link several; one Google account may be linked by several users, each separately.
3. **MCP token**: what Claude presents to the MCP server (later phase).

## Storage

| Item | Where | Form |
|---|---|---|
| Connection details (label, scopes, status, `credential_version`) | `provider_connections` | plaintext, non-secret; browser can read via RLS |
| Access token + refresh token + expiry | `provider_secrets` | **AES-256-GCM ciphertext only**; no browser access |
| OAuth `state` | `oauth_states` | SHA-256 hash only; PKCE verifier encrypted |
| Audit trail | `audit_events` | allow-listed metadata only |

**Envelope encryption.** Each secret gets a random 256-bit data key (DEK). The token JSON is encrypted with the DEK; the DEK is wrapped by a key-encryption key (KEK) held outside the database. The ciphertext is bound (AAD) to `userId` + `connectionId`, so a row copied to another user or connection fails to decrypt. The wrapped DEK is bound to the KEK version. A database leak alone reveals nothing usable.

**KEK sources** (`@serp/secrets`): a versioned key ring from `SECRET_KEYS` (works anywhere, including Vercel/Railway env), or a `KmsKeyProvider` that delegates wrap/unwrap to a managed KMS so the KEK never enters the process (needs a small `KmsClient` for the chosen cloud; not written yet). Development without `SECRET_KEYS` uses a throwaway in-memory key; production without keys refuses to start.

## Lifecycle

- **Connect**: server action creates a PKCE challenge and single-use `state` (stored hashed, bound to the user, 10 min TTL) → Google consent → callback validates state for the signed-in user, exchanges the code, checks the granted read-only scope and the `id_token` (audience, issuer, expiry), upserts the connection by `sub`, stores encrypted tokens. Incremental consent (`include_granted_scopes`) lets one account serve both GSC and GA4.
- **Use**: `CredentialService.getAccessToken(userId, connectionId)` decrypts, returns a valid token, refreshing within 5 minutes of expiry. Refresh is single-flight in-process and optimistic across processes (`credential_version` compare-and-swap); a lost race re-reads the winner's token.
- **Failure**: `invalid_grant` (user revoked or token expired) → status `needs_attention`, no retry loop, user asked to reconnect. Transient Google errors surface as `PROVIDER_UNAVAILABLE` without changing state. Decrypt failure returns a single opaque message.
- **Revoke / disconnect**: best-effort revoke at Google, then the secret and connection are deleted locally regardless. If Google could not be reached the user is told to remove access at myaccount.google.com/permissions.
- **Delete account**: `ON DELETE CASCADE` removes connections, secrets, states and audit rows.
- **Rotation**: add a new `<version>:<key>` to `SECRET_KEYS`, set `SECRET_CURRENT_KEY_VERSION`, run `CredentialService.rewrapBatch()` (re-wraps DEKs only; tokens are not re-encrypted), then remove the old key.

## Logging and audit

The logger redacts by key name (token, secret, authorization, verifier, state, ciphertext, email, …) and by value shape (Bearer, `ya29.`, `1//`, JWTs, DB URL passwords). Audit events (`connection.created`, `.refreshed`, `.needs_attention`, `.disconnected`, `oauth.failed`, key rewrap) carry only allow-listed fields (product, reason, keyVersion, errorKind, count). Tests assert tokens never appear in logs, audit rows, errors or the browser bundle.

## Production secrets you will eventually need

All **server-only** unless noted. None are needed today; mock Google and an ephemeral dev key are used until then.

| Variable | What | When |
|---|---|---|
| `BING_CLIENT_SECRET` | Bing OAuth client secret from Bing Webmaster Tools → Settings → API Access → OAuth Client. Server-side only, both apps. Rotate by creating a new client secret at Bing and updating the host. Customers' own Bing API keys are stored encrypted per connection, not here. See `BING.md`. | Only for "Connect with Bing" |
| `CREDENTIAL_FINGERPRINT_KEY` | 32-byte base64 key for keyed fingerprints of Clarity tokens (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Same value in both apps. Losing it only resets quota history; no reconnect needed. See `CLARITY.md`. | Before saving Clarity tokens in production |
| `SECRET_KEYS` | Versioned 32-byte base64 KEKs, e.g. `v1:<base64>`. Generate with `node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"`. Back it up in a password manager/secret manager: **losing it makes stored tokens unrecoverable** (users just reconnect). | Before any real connection |
| `SECRET_CURRENT_KEY_VERSION` | Version that encrypts new data (optional; defaults to last) | Only when rotating |
| `SUPABASE_DB_URL` | Postgres pooler connection string including the DB password | When `DB_MODE=postgres` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public values, safe in browsers | When `AUTH_MODE=supabase` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The operator's single OAuth web client ([`GOOGLE-SETUP.md`](GOOGLE-SETUP.md)). Needed by **both** the web app and the MCP server. The secret is shown once at creation; rotate with *Add secret* on the client page | `DATA_MODE=live` |
| `GOOGLE_REDIRECT_URI` | Optional override. Default `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`; must match a redirect URI registered on the Google client exactly | `DATA_MODE=live` |
| `NEXT_PUBLIC_APP_URL`, `MCP_PUBLIC_URL` | Public URLs (not secret) | Deploy |
| MCP OAuth issuer settings (`MCP_OAUTH_ISSUER_URL`, `MCP_RESOURCE_AUDIENCE`) | For verifying Claude's tokens | MCP auth phase |
| `BING_CLIENT_ID`, `BING_CLIENT_SECRET` | Only if Bing is enabled later | Optional |
| `SUPABASE_SERVICE_ROLE_KEY` | Not used by current code; add only if a server feature needs it. Never `NEXT_PUBLIC_`. | Probably never |
| Alternative to `SECRET_KEYS` | A KMS key id plus a concrete `KmsClient` | If you prefer managed KMS |

Never commit these. `.env*` is git-ignored except `.env.example`; a test scans committable files for secret shapes. Set production values in Hostinger hPanel → the app → **Environment variables** (stored encrypted by Hostinger), for both the web app and the MCP server; see [`HOSTINGER-DEPLOY.md`](HOSTINGER-DEPLOY.md).
