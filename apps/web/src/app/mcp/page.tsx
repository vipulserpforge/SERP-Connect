import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { getEnv } from "@/lib/env";

export const metadata = { title: "MCP connector" };
export const dynamic = "force-dynamic";

const STEPS = [
  { title: "Create an account and sign in", body: "Sign up with Google or email. This login is only for this app." },
  { title: "Connect your data on the dashboard", body: "Connect Search Console, GA4, Clarity or Bing, then choose which properties Claude may use." },
  { title: "Add the connector in Claude", body: "In Claude open Settings → Connectors → Add custom connector and paste the address above." },
  { title: "Sign in and allow", body: "Claude opens a sign-in window on this site. Sign in and click Allow." },
  { title: "Ask a question", body: "For example: “Which pages lost the most clicks last month?”" },
];

const GROUPS = [
  {
    name: "Search Console",
    note: "Search performance from Google.",
    tools: [
      { name: "list_gsc_properties", body: "The Search Console properties you enabled for Claude." },
      { name: "query_gsc_performance", body: "Clicks, impressions, CTR and position by query, page, country, device or date. Page through results, compare with an earlier period, and get totals and a plain-language summary." },
    ],
  },
  {
    name: "Google Analytics 4",
    note: "Traffic and conversions.",
    tools: [
      { name: "list_ga4_properties", body: "Your GA4 properties and their reporting time zones." },
      { name: "query_ga4_report", body: "Sessions, users, key events and more by any dimension, in each property's own time zone. Filter to organic traffic." },
    ],
  },
  {
    name: "Microsoft Clarity",
    note: "On-site behaviour, last 24 to 72 hours.",
    tools: [
      { name: "list_clarity_projects", body: "The Clarity projects you connected. Uses no Clarity requests." },
      { name: "get_clarity_insights", body: "Engagement, clicks, scrolling and errors. Results are saved because Clarity allows only 10 requests per project per day." },
      { name: "get_clarity_quota_status", body: "How much of today's Clarity allowance this app has tracked as used." },
    ],
  },
  {
    name: "Bing Webmaster",
    note: "Bing's own numbers, never mixed with Google's.",
    tools: [
      { name: "list_bing_sites", body: "Your Bing Webmaster sites that Claude may read." },
      { name: "query_bing_report", body: "Bing traffic, search queries and crawl statistics for one site." },
    ],
  },
  {
    name: "General",
    note: "Helpers that work across sources.",
    tools: [
      { name: "get_connection_status", body: "Which accounts and properties are connected and healthy." },
      { name: "get_supported_metrics", body: "The metrics and dimensions each provider can answer." },
    ],
  },
];

const PROMPTS = [
  "Which pages lost the most clicks last month?",
  "Compare this month's clicks with the previous month, by page.",
  "Which queries have high impressions but a low click-through rate?",
  "How many organic users landed on each page last week?",
  "Show clicks by country and device for the last 28 days.",
  "How are visitors behaving on mobile over the last 3 days?",
];

export default function McpPage() {
  const url = getEnv().NEXT_PUBLIC_MCP_URL;
  return (
    <main className="container-x pb-6 pt-12 sm:pt-20">
      <section className="grid items-end gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="pill enter" style={{ color: "var(--teal)", ["--i" as string]: 0 }}>
            MCP connector
          </p>
          <h1 className="enter mt-5 text-[2.5rem] font-medium leading-[1.05] tracking-tight sm:text-6xl" style={{ ["--i" as string]: 1 }}>
            Use your data <span className="accent">inside Claude.</span>
          </h1>
          <p className="muted enter mt-5 max-w-xl text-lg leading-relaxed" style={{ ["--i" as string]: 2 }}>
            The connector lets Claude read your Search Console, GA4, Clarity and Bing data on your behalf. It is read-only, and Claude can only reach the properties you enabled.
          </p>
        </div>

        <div className="enter rounded-2xl p-5 sm:p-6" style={{ border: "1px solid var(--line)", background: "rgba(9,26,24,0.85)", ["--i" as string]: 3 }}>
          <h2 className="text-sm font-medium">Connector address</h2>
          {url ? (
            <>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(0,0,0,0.4)", color: "var(--teal)" }}>
                  {url}
                </code>
                <CopyButton text={url} label="Copy address" />
              </div>
              <p className="muted mt-3 text-sm">Paste this into Claude when it asks for the connector's address.</p>
            </>
          ) : (
            <p className="muted mt-3 text-sm leading-relaxed">The address appears here once the MCP server is deployed and NEXT_PUBLIC_MCP_URL is set.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="steps-h" className="pt-16 sm:pt-24">
        <h2 id="steps-h" className="reveal text-3xl font-medium tracking-tight sm:text-4xl">
          How to connect
        </h2>
        <ol className="mt-8 grid gap-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="reveal flex gap-4 rounded-2xl p-4 sm:gap-5 sm:p-5" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ background: "var(--brand)", color: "#1a0e00" }}>
                {i + 1}
              </span>
              <div>
                <h3 className="text-lg font-medium">{s.title}</h3>
                <p className="muted mt-1 leading-relaxed">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="tools-h" className="pt-16 sm:pt-24">
        <h2 id="tools-h" className="reveal text-3xl font-medium tracking-tight sm:text-4xl">
          What Claude <span className="accent">can do</span>
        </h2>
        <div className="mt-8 grid gap-4">
          {GROUPS.map((g) => (
            <div key={g.name} className="reveal grid gap-5 rounded-2xl p-5 sm:p-6 lg:grid-cols-[0.7fr_1.3fr] lg:gap-10" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
              <div>
                <h3 className="text-xl font-medium">{g.name}</h3>
                <p className="muted mt-1 text-sm">{g.note}</p>
              </div>
              <ul className="grid gap-4">
                {g.tools.map((t) => (
                  <li key={t.name}>
                    <code className="rounded-md px-2 py-0.5 text-sm" style={{ background: "rgba(15,163,163,0.16)", color: "var(--teal)" }}>
                      {t.name}
                    </code>
                    <p className="muted mt-2 leading-relaxed">{t.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="try-h" className="pt-16 sm:pt-24">
        <h2 id="try-h" className="reveal text-3xl font-medium tracking-tight sm:text-4xl">
          Questions to <span className="accent">try</span>
        </h2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {PROMPTS.map((p) => (
            <li key={p} className="reveal rounded-2xl px-5 py-4 text-base sm:text-lg" style={{ background: "rgba(255,255,255,0.08)" }}>
              “{p}”
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3 pt-16 sm:flex-row sm:pt-24">
        <Link href="/signup" className="btn-primary !min-h-12 !px-7 text-base">
          Create account
        </Link>
        <Link href="/dashboard" className="btn-ghost !min-h-12 !px-7 text-base">
          Go to dashboard
        </Link>
      </section>
    </main>
  );
}
