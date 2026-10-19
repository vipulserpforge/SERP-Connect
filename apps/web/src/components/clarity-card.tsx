import Link from "next/link";
import type { PropertyRecord, ProviderConnection } from "@serp/contracts";
import { CLARITY_DAILY_REQUEST_LIMIT, type QuotaStatus } from "@serp/provider-clarity";
import { disconnectConnectionAction, togglePropertyAction } from "@/app/actions";
import { reconnectClarityAction, renameClarityAction, saveClarityConnectionAction, verifyClarityAction } from "@/app/clarity-actions";

const NOTICES: Record<string, string> = {
  saved: "Token saved and encrypted. It is awaiting verification: Clarity has not been contacted yet.",
  reconnected: "New token saved. It is awaiting verification.",
  renamed: "Connection renamed.",
  verified: "Verified: Clarity accepted the token. One request was used from today's allowance.",
  verified_mock: "Demo mode: no request was sent to Clarity, so the token has not been verified.",
  verified_cached: "A saved result for this check already existed, so Clarity was not contacted and no request was used.",
  removed: "Connection removed. The stored token was deleted and no further requests will be made with it.",
};

const ERRORS: Record<string, string> = {
  AUTH_EXPIRED: "Clarity no longer accepts this token. It may be invalid, expired or replaced. Generate a new one in Clarity and use Replace token.",
  FORBIDDEN: "Clarity says this token is not allowed to export data. Ask a project admin to generate it, then use Replace token.",
  CLARITY_DAILY_BUDGET_EXHAUSTED: "Today's Clarity request allowance for this project is used up. Saved results still work; try again after the next UTC day starts.",
  RATE_LIMITED: "Too many requests in a short time. Wait a moment and try again.",
  PROVIDER_UNAVAILABLE: "Clarity could not be reached. The attempt was counted against today's allowance, so wait a little before trying again.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Clarity connections are not fully set up on this server yet. The site owner needs to finish the configuration (see docs/CLARITY.md).",
  PROPERTY_NOT_CONNECTED: "That Clarity connection could not be found.",
  INTERNAL_ERROR: "Something went wrong. The error was logged. Please try again.",
};

const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : null);

/** What each state means. Only states the app has evidence for are shown. */
function stateOf(c: ProviderConnection): { label: string; tone: string; detail: string } {
  if (c.status === "needs_attention") {
    if (c.lastErrorCode === "FORBIDDEN") return { label: "Permission denied", tone: "bg-amber-100 text-amber-800", detail: "Clarity rejected this token for the export. Replace the token." };
    if (c.lastErrorCode === "AUTH_EXPIRED") return { label: "Invalid credentials", tone: "bg-red-100 text-red-800", detail: "Clarity no longer accepts this token. Replace the token." };
    return { label: "Needs attention", tone: "bg-amber-100 text-amber-800", detail: "The stored token could not be used. Replace the token." };
  }
  if (c.status === "pending") return { label: "Awaiting verification", tone: "bg-stone-200 text-stone-800", detail: "Saved but never used. Verifying makes one request to Clarity." };
  return { label: "Connected", tone: "bg-emerald-100 text-emerald-800", detail: c.lastValidatedAt ? `Verified ${fmt(c.lastValidatedAt)}.` : "Verified." };
}

interface Props {
  connections: ProviderConnection[];
  properties: PropertyRecord[];
  quotas: Record<string, QuotaStatus | null>;
  notice: string | undefined;
  error: string | undefined;
  errorMessage: string | undefined;
  /** False when the operator has not finished server configuration; saving would fail. */
  enabled: boolean;
}

export function ClarityCard({ connections, properties, quotas, notice, error, errorMessage, enabled }: Props) {
  const message = error ? (error === "INVALID_QUERY" ? (errorMessage ?? "Check the name and token, then try again.") : (ERRORS[error] ?? ERRORS.INTERNAL_ERROR)) : null;
  return (
    <section id="clarity" className="card !p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <h2 className="text-xl font-medium">Microsoft Clarity</h2>
          <p className="muted mt-1 text-sm">
            {connections.length === 0
              ? "Visitor behaviour: engagement, clicks, scrolling and errors for the last 1 to 3 days."
              : `${connections.length} ${connections.length === 1 ? "project" : "projects"} connected`}
          </p>
        </div>
      </div>

      {notice && NOTICES[notice] && (
        <p role="status" className="mx-6 mb-4 rounded-xl bg-emerald-100 px-3.5 py-2.5 text-sm text-emerald-900">
          {NOTICES[notice]}
        </p>
      )}
      {message && (
        <p role="alert" className="mx-6 mb-4 rounded-xl bg-red-100 px-3.5 py-2.5 text-sm text-red-900">
          {message}
        </p>
      )}

      {enabled ? (
        <details className="border-t px-6 py-4" style={{ borderColor: "var(--line)" }} open={connections.length === 0 || !!error}>
          <summary className="btn-primary inline-flex cursor-pointer list-none !px-4 !py-2">Connect a Clarity project</summary>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <ol className="muted list-decimal space-y-1.5 pl-5 text-sm leading-relaxed">
              <li>Sign in at clarity.microsoft.com and open the project you want to connect.</li>
              <li>
                Go to <strong>Settings → Data Export → Generate new API token</strong>. Only a project <em>admin</em> can do this.
              </li>
              <li>Give the token a name (4–32 letters, numbers, - _ .), then copy it.</li>
              <li>Paste it here. Never send a token in chat or email.</li>
              <li>
                Saving does <strong>not</strong> contact Clarity. Clarity allows only {CLARITY_DAILY_REQUEST_LIMIT} requests per project per day, and even a test call uses
                one, so the first real report is what verifies the token.
              </li>
            </ol>
            <form action={saveClarityConnectionAction} className="space-y-3">
              <label className="block text-sm">
                Connection name
                <input name="name" required minLength={2} maxLength={60} placeholder="e.g. Main website" className="field" />
              </label>
              <label className="block text-sm">
                Clarity API token
                <input name="token" type="password" required maxLength={4096} autoComplete="off" spellCheck={false} placeholder="Paste the token here" className="field" />
              </label>
              <button className="btn-primary">Save token securely</button>
              <p className="muted text-xs">Sent over HTTPS straight to our server and stored encrypted. It is never shown again.</p>
            </form>
          </div>
        </details>
      ) : (
        <p className="muted border-t px-6 py-4 text-sm" style={{ borderColor: "var(--line)" }}>
          Clarity is turned off on this server.
        </p>
      )}

      {connections.map((c) => {
        const prop = properties.find((p) => p.connectionId === c.id);
        const q = prop ? quotas[prop.id] : null;
        const st = stateOf(c);
        return (
          <div key={c.id} className="border-t" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4" style={{ background: "rgba(255,255,255,0.03)" }}>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${st.tone}`}>{st.label}</span>
                <span className="font-medium">{c.accountLabel}</span>
                {c.lastErrorCode === "PROVIDER_RATE_LIMITED" && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Rate-limited by Clarity</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {prop && (
                  <Link href={`/dashboard/clarity?property=${prop.id}`} className="btn-ghost !px-3.5 !py-1.5 !text-xs">
                    View reports
                  </Link>
                )}
                {prop && (
                  <form action={verifyClarityAction}>
                    <input type="hidden" name="propertyId" value={prop.id} />
                    <button className="btn-ghost !px-3.5 !py-1.5 !text-xs" title="Makes one request to Clarity (uses 1 of the project's daily requests)">
                      Verify token (uses 1 request)
                    </button>
                  </form>
                )}
              </div>
            </div>
            <p className="muted px-6 pb-3 pt-3 text-xs">{st.detail}</p>

            {q && (
              <dl className="grid gap-x-8 gap-y-1 px-6 pb-4 text-xs sm:grid-cols-2">
                <div>
                  <dt className="muted inline">Requests tracked by this app today: </dt>
                  <dd className="inline">
                    {q.localBudget >= 1000 ? `${q.appTrackedUsed} today (no app-side limit; Clarity's own limit is ${q.providerDailyLimit}/day)` : `${q.appTrackedUsed} of ${q.localBudget} (Clarity's own limit is ${q.providerDailyLimit}/day; this app keeps a few spare)`}
                  </dd>
                </div>
                <div>
                  <dt className="muted inline">Left in this app's budget: </dt>
                  <dd className="inline">{q.localRemaining}</dd>
                </div>
                <div>
                  <dt className="muted inline">Counting window: </dt>
                  <dd className="inline">
                    {fmt(q.window.start)} to {fmt(q.window.end)} (assumed; Clarity does not publish its reset time)
                  </dd>
                </div>
                <div>
                  <dt className="muted inline">Last successful request: </dt>
                  <dd className="inline">{fmt(q.lastSuccessAt) ?? "none yet"}</dd>
                </div>
                {q.providerLimitReported && <p className="text-amber-300 sm:col-span-2">Clarity reported its daily limit today, so no more requests will be made until the next window.</p>}
                <p className="muted sm:col-span-2">This is a count kept by this app, not a counter from Clarity. Other uses of the same token are not included, and failed calls are counted as used.</p>
              </dl>
            )}

            {prop && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3.5" style={{ borderColor: "var(--line)" }}>
                <span className="text-sm">Project: {prop.displayName}</span>
                <form action={togglePropertyAction} className="flex items-center gap-3">
                  <input type="hidden" name="propertyId" value={prop.id} />
                  <input type="hidden" name="enabled" value={String(!prop.enabledForMcp)} />
                  <span className={`text-xs ${prop.enabledForMcp ? "text-emerald-300" : "muted"}`}>{prop.enabledForMcp ? "Visible to Claude" : "Hidden from Claude"}</span>
                  <button className="btn-ghost !px-3.5 !py-1.5 !text-xs">{prop.enabledForMcp ? "Disable for Claude" : "Enable for Claude"}</button>
                </form>
              </div>
            )}

            <div className="flex flex-wrap gap-x-8 gap-y-3 border-t px-6 py-4" style={{ borderColor: "var(--line)" }}>
              <details>
                <summary className="cursor-pointer text-sm underline" style={{ color: "var(--teal)" }}>
                  Rename
                </summary>
                <form action={renameClarityAction} className="mt-3 flex items-end gap-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <label className="text-xs">
                    New name
                    <input name="name" required minLength={2} maxLength={60} defaultValue={c.accountLabel ?? ""} className="field !mt-1" />
                  </label>
                  <button className="btn-ghost !py-2.5">Save</button>
                </form>
              </details>
              <details>
                <summary className="cursor-pointer text-sm underline" style={{ color: "var(--teal)" }}>
                  Replace token
                </summary>
                <form action={reconnectClarityAction} className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <label className="text-xs">
                    New API token
                    <input name="token" type="password" required maxLength={4096} autoComplete="off" spellCheck={false} className="field !mt-1" />
                  </label>
                  <button className="btn-ghost !py-2.5">Save new token</button>
                </form>
                <p className="muted mt-2 text-xs">The old token is overwritten. Revoke it in Clarity (Settings → Data Export) too.</p>
              </details>
              <details>
                <summary className="cursor-pointer text-sm text-red-300 underline">Remove…</summary>
                <form action={disconnectConnectionAction} className="mt-3 space-y-2">
                  <input type="hidden" name="connectionId" value={c.id} />
                  <p className="text-xs">
                    This deletes the stored token and saved reports and stops all requests for “{c.accountLabel}”. Claude will lose access to this project. It cannot be undone, and you
                    would need to paste a token again.
                  </p>
                  <button className="rounded-xl px-3.5 py-2 text-xs text-red-200 transition hover:bg-red-500/10" style={{ border: "1px solid rgba(248,113,113,0.5)" }}>
                    Yes, remove this connection
                  </button>
                </form>
              </details>
            </div>
          </div>
        );
      })}
    </section>
  );
}
