import { toConnectorError } from "@serp/contracts";
import { knownFormMessage } from "@serp/auth";
import type { QuotaStatus } from "@serp/provider-clarity";
import { BingCard } from "@/components/bing-card";
import { ClarityCard } from "@/components/clarity-card";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import Link from "next/link";
import { disconnectConnectionAction, revokeClientGrantAction, startGoogleConnectAction, syncPropertiesAction, togglePropertyAction } from "@/app/actions";
import { getEnv } from "@/lib/env";
import { MCP_URL } from "@/lib/mcp-url";
import { CopyButton } from "@/components/copy-button";
import { getRepository, getServices, requireUser } from "@/lib/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
// Vercel: allow up to 60 s (the free plan's ceiling). Provider calls and property sync can take longer than the 10 s default.
export const maxDuration = 60;

const GROUPS = [
  { key: "gsc", connection: "google", name: "Google Search Console", note: "Search performance: clicks, impressions, queries and pages." },
  { key: "ga4", connection: "google", name: "Google Analytics 4", note: "Traffic and conversions for your GA4 properties." },
  { key: "clarity", connection: "clarity", name: "Microsoft Clarity", note: "Visitor behaviour: engagement, clicks, scrolling and errors." },
  { key: "bing", connection: "bing", name: "Bing Webmaster Tools", note: "Bing search traffic, queries and crawl statistics." },
] as const;

const STATUS_STYLE: Record<string, string> = {
  connected: "tone-ok",
  needs_attention: "tone-warn",
  revoked: "tone-err",
};

const OAUTH_ERRORS: Record<string, string> = {
  attempt_invalid: "That connection attempt was invalid, expired or not approved. Please start again.",
  provider_unavailable: "Google is temporarily unavailable. Please try again shortly.",
  not_configured: "Google connections are not configured yet.",
  failed: "The connection could not be completed.",
};

const SYNC_ERRORS: Record<string, string> = {
  AUTH_EXPIRED: "Google no longer accepts this connection. Disconnect and connect it again.",
  AUTH_REVOKED: "Google access was revoked. Disconnect and connect it again.",
  FORBIDDEN: "This connection was not granted access to that Google product. Connect it from the dashboard and approve the permission.",
  PROVIDER_RATE_LIMITED: "Google is rate limiting requests. Try again in a minute.",
  PROVIDER_UNAVAILABLE: "Google is temporarily unavailable. Try again shortly.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Google API access is not configured on this server yet.",
  PROPERTY_NOT_CONNECTED: "That connection could not be found.",
};

const NOTICES: Record<string, string> = {
  grant_revoked: "Access was removed. That app can no longer read your data once its current session ends.",
  connect_failed: "That request could not be completed. Start the connection again from Claude.",
  revoke_manual:
    "The connection was removed here, but we could not confirm Google revoked it. You can also remove access at myaccount.google.com/permissions.",
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const { connected, oauth_error: oauthError, notice, synced, unverified, synced_ga4: syncedGa4, sync_error: syncError, clarity, clarity_error: clarityError, clarity_msg: clarityMsg, bing, bing_error: bingError, bing_msg: bingMsg, bing_sites: bingSites, bing_unverified: bingUnverified, bing_sync_error: bingSyncError } = await searchParams;
  const ga4Count = syncedGa4 !== undefined && /^\d{1,4}$/.test(syncedGa4) ? Number(syncedGa4) : null;
  const syncedCount = synced !== undefined && /^\d{1,4}$/.test(synced) ? Number(synced) : null;
  const unverifiedCount = unverified !== undefined && /^\d{1,4}$/.test(unverified) ? Number(unverified) : 0;
  let connections;
  let properties;
  let googleReady = false;
  try {
    googleReady = getServices().googleConfigured;
    const repo = getRepository();
    [connections, properties] = await Promise.all([repo.listConnections(user.userId), repo.listProperties(user.userId)]);
  } catch (err) {
    return (
      <main className="container-x py-16">
        <h1 className="text-3xl font-medium">Dashboard unavailable</h1>
        <p className="muted mt-2">{toConnectorError(err, "dashboard").message}</p>
      </main>
    );
  }

  // Application-tracked Clarity quota per project: local reads only, never a call to Clarity.
  const quotas: Record<string, QuotaStatus | null> = {};
  for (const p of properties.filter((x) => x.provider === "clarity")) {
    quotas[p.id] = await getServices().clarityQuota.status(p.externalPropertyId).catch(() => null);
  }

  // Apps (Claude) the user approved through the OAuth consent screen. Only meaningful with real sign-in.
  let grants: Array<{ clientId: string; name: string; grantedAt: string }> | null = null;
  if (getEnv().AUTH_MODE === "supabase") {
    try {
      const { data, error } = await (await createSupabaseServerClient()).auth.oauth.listGrants();
      if (!error && data) grants = data.map((g) => ({ clientId: g.client.id, name: g.client.name, grantedAt: g.granted_at }));
    } catch {
      grants = null; // OAuth server not enabled or Auth unreachable: the section simply does not render
    }
  }
  const mcpUrl = MCP_URL;

  // Overview numbers, all derived from what is already loaded above.
  const googleConnected = connections.some((c) => c.provider === "google" && c.status === "connected");
  const enabledCount = properties.filter((p) => p.enabledForMcp).length;
  const attention = connections.filter((c) => c.status !== "connected").length;
  const sourcesConnected = GROUPS.filter((g) => properties.some((p) => p.provider === g.key) || connections.some((c) => c.provider === g.connection && c.status === "connected" && (g.connection !== "google" || c.grantedScopes.includes(GOOGLE_SCOPES[g.key as "gsc" | "ga4"])))).length;
  const claudeLinked = grants ? grants.length > 0 : false;
  const SETUP = [
    { label: "Connect Google", done: googleConnected, href: "#gsc" },
    { label: "Choose properties for Claude", done: enabledCount > 0, href: "#gsc" },
    { label: "Add the connector in Claude", done: claudeLinked, href: "/mcp-guide" },
  ];
  const doneCount = SETUP.filter((x) => x.done).length;
  const NAV = [
    { id: "overview", label: "Overview", dot: null },
    ...GROUPS.map((g) => ({ id: g.key, label: { gsc: "Search Console", ga4: "GA4", clarity: "Clarity", bing: "Bing" }[g.key], dot: properties.some((p) => p.provider === g.key) })),
    { id: "claude", label: "Use with Claude", dot: null },
  ];

  return (
    <main className="container-x py-8 sm:py-10 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
      <aside className="lg:sticky lg:top-28 lg:self-start">
        <nav aria-label="Dashboard sections" className="flex flex-wrap gap-2 pb-3 lg:flex-col lg:flex-nowrap lg:gap-1 lg:pb-0">
          {NAV.map((n) => (
            <a key={n.id} href={`#${n.id}`} className="flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 text-sm transition hover:bg-white/10" style={{ border: "1px solid var(--line)" }}>
              {n.dot !== null && <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: n.dot ? "#34d399" : "rgba(255,255,255,0.25)" }} />}
              {n.label}
              {n.dot !== null && <span className="sr-only">{n.dot ? "(connected)" : "(not connected)"}</span>}
            </a>
          ))}
        </nav>
        <p className="muted mt-6 hidden break-all px-1 text-xs lg:block">
          Signed in as
          <br />
          <span className="text-white">{user.email ?? "unknown"}</span>
        </p>
      </aside>

      <div className="min-w-0">
      <header id="overview">
        <h1 className="text-3xl font-medium tracking-tight sm:text-5xl">
          Your <span className="accent">integrations</span>
        </h1>
        <p className="muted mt-3 max-w-2xl text-sm sm:text-base">
          <span className="lg:hidden">Signed in as {user.email ?? "unknown"}. </span>Provider accounts you connect are separate from this login.
        </p>

        <dl className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { k: "Sources connected", v: `${sourcesConnected} of ${GROUPS.length}`, tone: "" },
            { k: "Visible to Claude", v: `${enabledCount} of ${properties.length}`, tone: "" },
            { k: "Needs attention", v: attention === 0 ? "All healthy" : String(attention), tone: attention === 0 ? "tone-ok" : "tone-warn" },
            { k: "Claude connector", v: grants ? `${grants.length} ${grants.length === 1 ? "app" : "apps"} linked` : mcpUrl ? "Address ready" : "Not deployed", tone: "" },
          ].map((t) => (
            <div key={t.k} className="rounded-2xl p-4 sm:p-5" style={{ border: "1px solid var(--line)", background: "var(--surface)" }}>
              <dt className="muted text-xs sm:text-sm">{t.k}</dt>
              <dd className="mt-2">
                <span className={`inline-block rounded-lg text-xl font-medium tabular-nums sm:text-2xl ${t.tone ? `${t.tone} px-2 py-0.5` : ""}`}>{t.v}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 rounded-2xl p-5 sm:p-6" style={{ border: "1px solid var(--line)", background: "var(--surface)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-medium">{doneCount === SETUP.length ? "You're all set" : "Finish setting up"}</h2>
            <p className="muted text-sm">
              {doneCount} of {SETUP.length} done
            </p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.1)" }} role="progressbar" aria-valuemin={0} aria-valuemax={SETUP.length} aria-valuenow={doneCount} aria-label="Setup progress">
            <div className="bar-in h-full rounded-full" style={{ width: `${(doneCount / SETUP.length) * 100}%`, background: "var(--teal-strong)" }} />
          </div>
          <ol className="mt-4 grid gap-2 sm:grid-cols-3">
            {SETUP.map((st) => (
              <li key={st.label}>
                <Link href={st.href} className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm transition hover:bg-white/10">
                  <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${st.done ? "tone-ok" : ""}`} style={st.done ? undefined : { border: "1px solid rgba(255,255,255,0.3)" }}>
                    {st.done ? "✓" : ""}
                  </span>
                  <span className={st.done ? "muted line-through" : ""}>{st.label}</span>
                  <span className="sr-only">{st.done ? "(done)" : "(to do)"}</span>
                </Link>
              </li>
            ))}
          </ol>
          {doneCount === SETUP.length && (
            <p className="muted mt-3 text-sm">
              Try asking Claude: “Which pages lost the most clicks last month?”
            </p>
          )}
        </div>
      </header>

      {user.mock && (
        <p className="mt-4 alert tone-warn">
          Mock mode: showing demo connections for a fixed demo user. No real sign-in is happening.
        </p>
      )}

      {(connected === "gsc" || connected === "ga4") && (
        <p role="status" className="mt-4 alert tone-ok">
          {connected === "gsc" ? "Search Console" : "GA4"} account connected.
        </p>
      )}
      {syncedCount !== null && (
        <p role="status" className="mt-4 alert tone-ok">
          {syncedCount === 0
            ? "This Google account has no Search Console properties it can read. Connect an account that has access."
            : `${syncedCount} Search Console ${syncedCount === 1 ? "property" : "properties"} available.`}
          {unverifiedCount > 0 && ` ${unverifiedCount} listed site${unverifiedCount === 1 ? " is" : "s are"} unverified for this account and were skipped.`}
        </p>
      )}
      {ga4Count !== null && (
        <p role="status" className="mt-4 alert tone-ok">
          {ga4Count === 0
            ? "This Google account has no Google Analytics 4 properties it can read. Connect an account that has access."
            : `${ga4Count} GA4 ${ga4Count === 1 ? "property" : "properties"} available.`}
        </p>
      )}
      {syncError && (
        <p role="alert" className="mt-4 alert tone-warn">
          {SYNC_ERRORS[syncError] ?? "Properties could not be refreshed. Try again."}
        </p>
      )}
      {oauthError && (
        <p role="alert" className="mt-4 alert tone-err">
          {OAUTH_ERRORS[oauthError] ?? OAUTH_ERRORS.failed}
        </p>
      )}
      {notice && NOTICES[notice] && <p className="mt-4 alert tone-warn">{NOTICES[notice]}</p>}

      <div className="mt-8 space-y-6">
        {GROUPS.map((g) => {
          if (g.key === "clarity") {
            return (
              <ClarityCard
                key="clarity"
                connections={connections.filter((c) => c.provider === "clarity")}
                properties={properties}
                quotas={quotas}
                notice={clarity}
                error={clarityError}
                errorMessage={knownFormMessage(clarityMsg)}
                enabled={getEnv().PROVIDER_CLARITY_ENABLED}
              />
            );
          }
          if (g.key === "bing") {
            return (
              <BingCard
                key="bing"
                connections={connections.filter((c) => c.provider === "bing")}
                properties={properties}
                notice={bing}
                error={bingError}
                errorMessage={knownFormMessage(bingMsg)}
                sites={bingSites}
                unverified={bingUnverified}
                syncError={bingSyncError}
                oauthAvailable={getServices().bing.oauthConfigured}
                enabled={getEnv().PROVIDER_BING_ENABLED}
                demo={getEnv().DATA_MODE === "mock"}
              />
            );
          }
          const live = g.connection === "google" && googleReady;
          const rows = connections.filter(
            (c) => c.provider === g.connection && (g.connection !== "google" || c.grantedScopes.includes(GOOGLE_SCOPES[g.key as "gsc" | "ga4"])),
          );
          const total = properties.filter((x) => x.provider === g.key).length;
          return (
            <section key={g.key} id={g.key} className="card !p-0 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-4 p-6">
                <div>
                  <h2 className="flex items-center gap-3 text-xl font-medium">
                    <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl text-xs font-semibold" style={{ background: "rgba(15,163,163,0.2)", color: "var(--teal)" }}>
                      {g.key === "gsc" ? "GSC" : "GA4"}
                    </span>
                    {g.name}
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${rows.length > 0 ? "tone-ok" : "tone-neutral"}`}>{rows.length > 0 ? "Connected" : "Not connected"}</span>
                  </h2>
                  <p className="muted mt-1 text-sm">
                    {rows.length === 0 ? (g.connection === "google" && !googleReady ? "Available after Google Cloud setup (final phase)." : g.note) : `${rows.length} ${rows.length === 1 ? "account" : "accounts"} · ${total} ${total === 1 ? "property" : "properties"}`}
                  </p>
                </div>
                {live ? (
                  <form action={startGoogleConnectAction}>
                    <input type="hidden" name="product" value={g.key} />
                    <button className="btn-primary !px-4 !py-2">{rows.length === 0 ? "Connect" : "Connect another account"}</button>
                  </form>
                ) : (
                  <button disabled title={g.note} className="btn-ghost cursor-not-allowed !py-2 opacity-50">
                    Connect
                  </button>
                )}
              </div>

              {rows.length === 0 && (
                <p className="muted border-t px-6 py-4 text-sm" style={{ borderColor: "var(--line)" }}>
                  Not connected
                </p>
              )}
              {rows.map((c) => {
                const props = properties.filter((x) => x.connectionId === c.id && x.provider === g.key);
                const sharedWithOther =
                  g.connection === "google" && c.grantedScopes.includes(GOOGLE_SCOPES.gsc) && c.grantedScopes.includes(GOOGLE_SCOPES.ga4);
                return (
                  <div key={c.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4" style={{ background: "rgba(255,255,255,0.03)" }}>
                      <div className="flex items-center gap-3 text-sm">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[c.status] ?? "tone-neutral"}`}>
                          {c.status.replace("_", " ")}
                        </span>
                        <span className="font-medium">{c.accountLabel}</span>
                        <span className="muted">
                          {props.length} {props.length === 1 ? "property" : "properties"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {g.connection === "google" && c.status === "connected" && (
                          <form action={syncPropertiesAction}>
                            <input type="hidden" name="connectionId" value={c.id} />
                            <button className="btn-ghost !px-3.5 !py-1.5 !text-xs">Refresh properties</button>
                          </form>
                        )}
                        <form action={disconnectConnectionAction}>
                          <input type="hidden" name="connectionId" value={c.id} />
                          <button
                            title={sharedWithOther ? "This Google account is used for both Search Console and GA4; disconnecting removes both." : undefined}
                            className="rounded-xl px-3.5 py-1.5 text-xs text-red-300 transition hover:bg-red-500/10"
                            style={{ border: "1px solid rgba(248,113,113,0.35)" }}
                          >
                            Disconnect
                          </button>
                        </form>
                      </div>
                    </div>
                    {sharedWithOther && (
                      <p className="muted px-6 pb-3 text-xs" style={{ background: "rgba(255,255,255,0.03)" }}>
                        This Google account is shared with {g.key === "gsc" ? "GA4" : "Search Console"}. Disconnecting removes both.
                      </p>
                    )}
                    <ul>
                      {props.map((prop) => (
                        <li key={prop.id} className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3.5" style={{ borderColor: "var(--line)" }}>
                          <span className={`min-w-0 truncate text-sm ${prop.enabledForMcp ? "" : "muted"}`}>{prop.displayName}</span>
                          <form action={togglePropertyAction} className="flex items-center gap-3">
                            <input type="hidden" name="propertyId" value={prop.id} />
                            <input type="hidden" name="enabled" value={String(!prop.enabledForMcp)} />
                            <span className={`text-xs ${prop.enabledForMcp ? "text-emerald-300" : "muted"}`}>{prop.enabledForMcp ? "Visible to Claude" : "Hidden from Claude"}</span>
                            <button className="btn-ghost !px-3.5 !py-1.5 !text-xs">{prop.enabledForMcp ? "Disable for Claude" : "Enable for Claude"}</button>
                          </form>
                        </li>
                      ))}
                      {props.length === 0 && (
                        <li className="muted border-t px-6 py-4 text-sm" style={{ borderColor: "var(--line)" }}>
                          No properties yet. Use Refresh properties.
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <section id="claude" className="card mt-8">
        <h2 className="text-lg font-medium">Use with Claude</h2>
        {mcpUrl ? (
          <p className="mt-2 text-sm">
            In Claude, add a custom connector with this address, then sign in when asked:
            <code className="mt-2 block break-all rounded-xl px-3 py-2" style={{ background: "rgba(0,0,0,0.35)", color: "var(--teal)" }}>{mcpUrl}</code>
            <span className="mt-3 flex flex-wrap gap-2">
              <CopyButton text={mcpUrl} label="Copy address" />
              <Link href="/mcp-guide" className="btn-ghost !px-4 !py-2 text-sm">Step-by-step guide</Link>
            </span>
          </p>
        ) : (
          <p className="mt-2 text-sm opacity-70">The connector address appears here once the MCP server is deployed.</p>
        )}
        {grants && (
          <div className="mt-4">
            <h3 className="text-sm font-medium">Apps with access</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {grants.length === 0 && <li className="muted">No apps have access.</li>}
              {grants.map((g) => (
                <li key={g.clientId} className="flex items-center justify-between gap-2">
                  <span>
                    {g.name} <span className="opacity-60">since {g.grantedAt.slice(0, 10)}</span>
                  </span>
                  <form action={revokeClientGrantAction}>
                    <input type="hidden" name="clientId" value={g.clientId} />
                    <button className="min-h-9 text-xs text-red-300 underline">Remove access</button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      </div>
    </main>
  );
}
