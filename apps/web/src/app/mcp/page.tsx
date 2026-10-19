import Link from "next/link";
import { getEnv } from "@/lib/env";

export const metadata = { title: "MCP connector" };
export const dynamic = "force-dynamic";

const TOOLS = [
  { name: "get_connection_status", body: "See which accounts and properties are connected and healthy." },
  { name: "query_gsc_performance", body: "Search Console clicks, impressions, CTR and position by query, page, country, device or date." },
  { name: "query_ga4_report", body: "GA4 sessions, users, conversions and more, in each property's own time zone." },
  { name: "list_clarity_projects", body: "The Microsoft Clarity projects you connected. Uses no Clarity requests." },
  { name: "get_clarity_insights", body: "Visitor behaviour from Clarity for the last 24, 48 or 72 hours. Results are saved because Clarity allows only 10 requests per project per day." },
  { name: "list_bing_sites", body: "Your Bing Webmaster sites that Claude may read." },
  { name: "query_bing_report", body: "Bing traffic, search queries and crawl statistics for one site. Bing's own numbers, never mixed with Google's." },
  { name: "get_clarity_quota_status", body: "How much of today's Clarity request allowance this app has tracked as used." },
  { name: "get_supported_metrics", body: "The metrics and dimensions each provider can answer." },
];

const STEPS = [
  "Create an account and sign in.",
  "On the dashboard, connect Search Console and/or GA4, then choose which properties Claude may use.",
  "In Claude, open Settings → Connectors → Add custom connector and paste the address below.",
  "Claude opens a sign-in window on this site. Sign in and click Allow.",
  "Ask a question, for example: “Which pages lost the most clicks last month?”",
];

export default function McpPage() {
  const url = getEnv().NEXT_PUBLIC_MCP_URL;
  return (
    <main className="mx-auto max-w-4xl px-5 py-16">
      <h1 className="text-4xl font-medium sm:text-5xl">
        Use your data <span className="accent">inside Claude</span>
      </h1>
      <p className="muted mt-4 max-w-2xl text-lg">
        Our MCP connector lets Claude read your Search Console and GA4 data on your behalf. It is read-only, and Claude can only reach the
        properties you enabled.
      </p>

      <section className="card mt-10">
        <h2 className="text-lg font-medium">Connector address</h2>
        {url ? (
          <code className="mt-3 block break-all rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(0,0,0,0.35)", color: "var(--teal)" }}>
            {url}
          </code>
        ) : (
          <p className="muted mt-3 text-sm">The address appears here once the MCP server is deployed and NEXT_PUBLIC_MCP_URL is set.</p>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-medium">How to connect</h2>
        <ol className="mt-5 space-y-3">
          {STEPS.map((s, i) => (
            <li key={s} className="card flex items-start gap-4 !p-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ background: "var(--brand)" }}>
                {i + 1}
              </span>
              <span className="pt-1 text-sm leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-medium">What Claude can do</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <li key={t.name} className="card !p-4">
              <code className="text-sm" style={{ color: "var(--teal)" }}>{t.name}</code>
              <p className="muted mt-2 text-sm">{t.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12 flex flex-wrap gap-3">
        <Link href="/signup" className="btn-primary">Create account</Link>
        <Link href="/dashboard" className="btn-ghost">Go to dashboard</Link>
      </section>
    </main>
  );
}
