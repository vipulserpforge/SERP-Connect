import Link from "next/link";
import type { PropertyRecord, ProviderConnection } from "@serp/contracts";
import { disconnectConnectionAction, togglePropertyAction } from "@/app/actions";
import { renameBingAction, saveBingApiKeyAction, startBingOAuthAction, syncBingSitesAction } from "@/app/bing-actions";
import { SubmitButton } from "@/components/submit-button";

const NOTICES: Record<string, string> = {
  connected: "Bing account connected.",
  saved: "API key saved and encrypted.",
  key_replaced: "API key replaced.",
  synced: "Site list refreshed.",
  renamed: "Connection renamed.",
  removed: "Connection removed. The stored credentials were deleted and no further requests will be made. Bing has no way for us to revoke them from here, so also remove the app in your Bing Webmaster Tools settings (or delete the API key there).",
};

const ERRORS: Record<string, string> = {
  AUTH_REQUIRED: "That Bing sign-in was cancelled, expired or invalid. Start again.",
  AUTH_EXPIRED: "Bing no longer accepts this connection (the key may be wrong or replaced, or the login expired). Reconnect it below.",
  AUTH_REVOKED: "Access was revoked at Bing or has expired. Reconnect it below.",
  FORBIDDEN: "Bing does not allow this account to use the Webmaster API. In Bing Webmaster Tools open Settings → API Access, accept the terms, and make sure the account has a verified site.",
  PROPERTY_NOT_CONNECTED: "That Bing connection could not be found.",
  PROPERTY_NOT_ACCESSIBLE: "Bing says this account cannot read that site.",
  PROVIDER_RATE_LIMITED: "Bing is rate limiting requests for this account. Wait a while and try again.",
  PROVIDER_UNAVAILABLE: "Bing could not be reached or answered in an unexpected way. Try again shortly.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "This option is not set up on this server yet (see docs/BING.md).",
  RATE_LIMITED: "Too many requests in a short time. Wait a moment and try again.",
  INTERNAL_ERROR: "Something went wrong. The error was logged. Please try again.",
};

const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : null);

/** Only states the app has evidence for are shown. */
function stateOf(c: ProviderConnection): { label: string; tone: string; detail: string } {
  if (c.status === "needs_attention" || c.status === "revoked") {
    if (c.lastErrorCode === "AUTH_REVOKED" || c.status === "revoked") return { label: "Reconnect needed", tone: "tone-err", detail: "Bing access was revoked or expired. Reconnect below." };
    if (c.lastErrorCode === "AUTH_EXPIRED") return { label: "Invalid credentials", tone: "tone-err", detail: "Bing rejected the stored credentials. Reconnect below." };
    return { label: "Needs attention", tone: "tone-warn", detail: "The stored credentials could not be used. Reconnect below." };
  }
  if (c.status === "pending") {
    return { label: "Not verified yet", tone: "tone-neutral", detail: "Saved, but Bing has not confirmed it yet. Use Refresh sites: if Bing answers, the connection is verified." };
  }
  return { label: "Connected", tone: "tone-ok", detail: c.lastValidatedAt ? `Bing last answered ${fmt(c.lastValidatedAt)}.` : "Bing answered." };
}

interface Props {
  connections: ProviderConnection[];
  properties: PropertyRecord[];
  notice: string | undefined;
  error: string | undefined;
  errorMessage: string | undefined;
  /** Number of verified sites found by the latest refresh, and how many Bing lists as unverified. */
  sites: string | undefined;
  unverified: string | undefined;
  syncError: string | undefined;
  /** False when the operator has not registered a Bing OAuth client. The API-key option still works. */
  oauthAvailable: boolean;
  /** False when Bing is switched off on this server. */
  enabled: boolean;
  demo: boolean;
}

const count = (v: string | undefined) => (v !== undefined && /^\d{1,4}$/.test(v) ? Number(v) : null);

export function BingCard({ connections, properties, notice, error, errorMessage, sites, unverified, syncError, oauthAvailable, enabled, demo }: Props) {
  const message = error ? (error === "INVALID_QUERY" ? (errorMessage ?? "Check what you entered and try again.") : (ERRORS[error] ?? ERRORS.INTERNAL_ERROR)) : null;
  const n = count(sites);
  const skipped = count(unverified) ?? 0;
  const siteTotal = properties.filter((p) => p.provider === "bing").length;
  return (
    <section id="bing" className="card !p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="flex items-center gap-3 text-xl font-medium"><span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl text-xs font-semibold" style={{ background: "rgba(15,163,163,0.2)", color: "var(--teal)" }}>BI</span>Bing Webmaster Tools</h2>
          <p className="muted mt-1 text-sm">
            {connections.length === 0
              ? "Bing search traffic, queries and crawl statistics for your verified sites. Read-only."
              : `${connections.length} ${connections.length === 1 ? "account" : "accounts"} · ${siteTotal} ${siteTotal === 1 ? "site" : "sites"}`}
          </p>
        </div>
      </div>

      {notice && NOTICES[notice] && (
        <p role="status" className="mx-6 mb-4 alert tone-ok">
          {NOTICES[notice]}
          {n !== null && notice !== "removed" && (n === 0 ? " No verified sites were found yet." : ` ${n} verified ${n === 1 ? "site" : "sites"} found.`)}
          {skipped > 0 && ` ${skipped} listed ${skipped === 1 ? "site is" : "sites are"} not verified in Bing and was skipped.`}
        </p>
      )}
      {syncError && (
        <p role="alert" className="mx-6 mb-4 alert tone-warn">
          The account was saved, but the site list could not be read: {ERRORS[syncError] ?? ERRORS.INTERNAL_ERROR}
        </p>
      )}
      {message && (
        <p role="alert" className="mx-6 mb-4 alert tone-err">
          {message}
        </p>
      )}
      {demo && (
        <p className="mx-6 mb-4 rounded-xl tone-warn px-3.5 py-2.5 text-xs">Demo mode: Bing is not contacted and the data is made up.</p>
      )}

      {enabled ? (
        <div className="border-t px-6 py-5" style={{ borderColor: "var(--line)" }}>
          <p className="muted max-w-3xl text-sm leading-relaxed">
            We ask for <strong>read-only</strong> access (<code>webmaster.read</code>) so Claude can read your Bing traffic, queries and crawl statistics. We never submit URLs, change settings or
            edit your sites. You can disconnect at any time.
          </p>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">
                Connect with your Bing login <span className="rounded-full tone-ok px-2 py-0.5 text-xs">Recommended</span>
              </h3>
              <p className="muted mt-1 text-xs">You sign in at Bing and approve access. Your password never reaches us.</p>
              <form action={startBingOAuthAction} className="mt-3">
                <SubmitButton className="btn-primary !px-4 !py-2" disabled={!oauthAvailable} title={oauthAvailable ? undefined : "Not set up on this server yet"}>
                  {connections.length === 0 ? "Connect with Bing" : "Connect another Bing account"}
                </SubmitButton>
              </form>
              {!oauthAvailable && <p className="mt-2 text-xs text-amber-300">Sign-in with Bing is not set up on this server yet. Use an API key instead, or see docs/BING.md.</p>}
            </div>
            <details open={connections.length === 0 && !oauthAvailable}>
              <summary className="cursor-pointer text-sm font-medium">Or use a Bing API key</summary>
              <ol className="muted mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed">
                <li>Sign in at bing.com/webmasters and open <strong>Settings → API Access</strong>.</li>
                <li>Accept the terms if asked, choose <strong>API Key</strong>, then <strong>Generate API Key</strong> (you get one per account).</li>
                <li>Copy it and paste it below. Never send it in chat or email.</li>
                <li>One key works for all your verified sites. If it leaks, delete it in Bing and generate a new one, then use Replace key here.</li>
              </ol>
              <form action={saveBingApiKeyAction} className="mt-3 space-y-3">
                <label className="block text-sm">
                  Connection name
                  <input name="name" minLength={2} maxLength={60} placeholder="e.g. My Bing account" className="field" />
                </label>
                <label className="block text-sm">
                  Bing API key
                  <input name="apiKey" type="password" required maxLength={64} autoComplete="off" spellCheck={false} placeholder="Paste the key here" className="field" />
                </label>
                <SubmitButton className="btn-ghost !py-2.5">Save key securely</SubmitButton>
                <p className="muted text-xs">Sent over HTTPS to our server and stored encrypted. It is never shown again. Bing requires API keys to travel in the request address, so the key is only ever sent from our server to Bing.</p>
              </form>
            </details>
          </div>
        </div>
      ) : (
        <p className="muted border-t px-6 py-4 text-sm" style={{ borderColor: "var(--line)" }}>
          Bing Webmaster is turned off on this server until the live check has passed (see docs/BING.md).
        </p>
      )}

      {connections.map((c) => {
        const st = stateOf(c);
        const props = properties.filter((p) => p.connectionId === c.id && p.provider === "bing");
        const method = c.authMethod === "oauth" ? "Bing login (OAuth)" : c.authMethod === "api_key" ? "API key" : "Unknown method";
        return (
          <div key={c.id} className="border-t" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4" style={{ background: "rgba(255,255,255,0.03)" }}>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${st.tone}`}>{st.label}</span>
                <span className="font-medium">{c.accountLabel}</span>
                <span className="muted text-xs">{method}</span>
                <span className="muted text-xs">
                  {props.length} {props.length === 1 ? "site" : "sites"}
                </span>
              </div>
              <form action={syncBingSitesAction}>
                <input type="hidden" name="connectionId" value={c.id} />
                <SubmitButton className="btn-ghost !px-3.5 !py-1.5 !text-xs" title="Asks Bing which verified sites this account can see">
                  Refresh sites
                </SubmitButton>
              </form>
            </div>
            <p className="muted px-6 pb-3 pt-3 text-xs">{st.detail}</p>

            <ul>
              {props.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3.5" style={{ borderColor: "var(--line)" }}>
                  <span className={`min-w-0 truncate text-sm ${p.enabledForMcp ? "" : "muted"}`}>{p.displayName}</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <Link href={`/dashboard/bing?property=${p.id}`} className="btn-ghost !px-3.5 !py-1.5 !text-xs">
                      View reports
                    </Link>
                    <form action={togglePropertyAction} className="flex items-center gap-3">
                      <input type="hidden" name="propertyId" value={p.id} />
                      <input type="hidden" name="enabled" value={String(!p.enabledForMcp)} />
                      <span className={`text-xs ${p.enabledForMcp ? "text-emerald-300" : "muted"}`}>{p.enabledForMcp ? "Visible to Claude" : "Hidden from Claude"}</span>
                      <SubmitButton className="btn-ghost !px-3.5 !py-1.5 !text-xs">{p.enabledForMcp ? "Disable for Claude" : "Enable for Claude"}</SubmitButton>
                    </form>
                  </div>
                </li>
              ))}
              {props.length === 0 && (
                <li className="muted border-t px-6 py-4 text-sm" style={{ borderColor: "var(--line)" }}>
                  No verified sites yet. Verify a site in Bing Webmaster Tools, then use Refresh sites.
                </li>
              )}
            </ul>

            <div className="flex flex-wrap gap-x-8 gap-y-3 border-t px-6 py-4" style={{ borderColor: "var(--line)" }}>
              <details>
                <summary className="cursor-pointer text-sm underline" style={{ color: "var(--teal)" }}>
                  Rename
                </summary>
                <form action={renameBingAction} className="mt-3 flex items-end gap-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <label className="text-xs">
                    New name
                    <input name="name" required minLength={2} maxLength={60} defaultValue={c.accountLabel ?? ""} className="field !mt-1" />
                  </label>
                  <SubmitButton className="btn-ghost !py-2.5">Save</SubmitButton>
                </form>
              </details>
              <details>
                <summary className="cursor-pointer text-sm underline" style={{ color: "var(--teal)" }}>
                  {c.authMethod === "oauth" ? "Reconnect with Bing" : "Switch to Bing login"}
                </summary>
                <form action={startBingOAuthAction} className="mt-3 space-y-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <p className="muted text-xs">You will sign in at Bing again. {c.authMethod === "api_key" ? "The saved API key is replaced by the login." : "The old login is replaced."}</p>
                  <SubmitButton className="btn-ghost !py-2.5" disabled={!oauthAvailable}>
                    {c.authMethod === "oauth" ? "Reconnect" : "Switch to Bing login"}
                  </SubmitButton>
                </form>
              </details>
              <details>
                <summary className="cursor-pointer text-sm underline" style={{ color: "var(--teal)" }}>
                  {c.authMethod === "api_key" ? "Replace key" : "Switch to API key"}
                </summary>
                <form action={saveBingApiKeyAction} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <label className="text-xs">
                    Bing API key
                    <input name="apiKey" type="password" required maxLength={64} autoComplete="off" spellCheck={false} className="field !mt-1" />
                  </label>
                  <SubmitButton className="btn-ghost !py-2.5">Save key</SubmitButton>
                </form>
                <p className="muted mt-2 text-xs">The current credential is overwritten. Compromised key? Delete it in Bing (Settings → API Access), generate a new one, and paste it here.</p>
              </details>
              <details>
                <summary className="cursor-pointer text-sm text-red-300 underline">Remove…</summary>
                <form action={disconnectConnectionAction} className="mt-3 space-y-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <p className="text-xs">
                    This deletes the stored credentials and saved reports for “{c.accountLabel}” and stops all requests. Claude will lose access to its sites. Bing offers no way for us to revoke
                    access from here, so also remove it in Bing Webmaster Tools.
                  </p>
                  <SubmitButton className="rounded-xl px-3.5 py-2 text-xs text-red-200 transition hover:bg-red-500/10" style={{ border: "1px solid rgba(248,113,113,0.5)" }}>
                    Yes, remove this connection
                  </SubmitButton>
                </form>
              </details>
            </div>
          </div>
        );
      })}
    </section>
  );
}
