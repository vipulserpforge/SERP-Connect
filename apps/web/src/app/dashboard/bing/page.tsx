import Link from "next/link";
import { BING_REPORTS, toConnectorError, type NormalizedReportResult, type ReportRow } from "@serp/contracts";
import { newRequestId } from "@serp/observability";
import { getServices, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";
// Vercel: allow up to 60 s (the free plan's ceiling). Provider calls and property sync can take longer than the 10 s default.
export const maxDuration = 60;
export const metadata = { title: "Bing reports" };

const MAX_ROWS_SHOWN = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REPORTS = [
  { key: "traffic", label: "Traffic", blurb: "Daily clicks and impressions from Bing search." },
  { key: "queries", label: "Search queries", blurb: "Queries with clicks, impressions and average positions." },
  { key: "crawl", label: "Crawl & index", blurb: "How Bingbot crawls and indexes the site." },
] as const;

const WINDOWS = [
  { key: "7", label: "Last 7 days", lastDays: 7 },
  { key: "28", label: "Last 28 days", lastDays: 28 },
  { key: "90", label: "Last 90 days", lastDays: 90 },
  { key: "all", label: "Everything Bing returned", lastDays: undefined },
] as const;

const ERRORS: Record<string, string> = {
  AUTH_EXPIRED: "Bing no longer accepts this connection. Reconnect it on the dashboard.",
  AUTH_REVOKED: "Bing access was revoked or has expired. Reconnect it on the dashboard.",
  FORBIDDEN: "Bing does not allow this account to use the Webmaster API. Check Settings → API Access in Bing Webmaster Tools.",
  PROPERTY_NOT_ACCESSIBLE: "Bing says this account cannot read that site. Refresh the site list on the dashboard.",
  PROPERTY_NOT_CONNECTED: "That Bing site could not be found.",
  PROVIDER_RATE_LIMITED: "Bing is rate limiting requests for this account. Wait a while and try again.",
  RATE_LIMITED: "Too many requests in a short time. Wait a moment and try again.",
  PROVIDER_UNAVAILABLE: "Bing could not be reached or answered in an unexpected way. Try again shortly.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Bing reports are not available on this server yet.",
  INTERNAL_ERROR: "Something went wrong. The error was logged.",
};

const COLUMN_LABELS: Record<string, string> = {
  date: "Date",
  query: "Query",
  clicks: "Clicks",
  impressions: "Impressions",
  avgClickPosition: "Avg. click position",
  avgImpressionPosition: "Avg. impression position",
  crawledPages: "Crawled pages",
  crawlErrors: "Crawl errors",
  inIndex: "In index",
  inLinks: "Inbound links",
  code2xx: "HTTP 2xx",
  code301: "HTTP 301",
  code302: "HTTP 302",
  code4xx: "HTTP 4xx",
  code5xx: "HTTP 5xx",
  allOtherCodes: "Other codes",
  blockedByRobotsTxt: "Blocked by robots.txt",
  containsMalware: "Malware flagged",
};

const cell = (v: string | number | null | undefined) => (v === undefined || v === null ? "no value" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v);

function age(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function Table({ result }: { result: NormalizedReportResult }) {
  const columns = [...result.report.dimensions, ...result.report.metrics].filter((k) => result.rows.some((r: ReportRow) => k in r) || result.rows.length === 0);
  const shown = result.rows.slice(0, MAX_ROWS_SHOWN);
  return (
    <section className="card !p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <caption className="sr-only">Bing {result.report.dimensions.join(", ")} report</caption>
          <thead className="muted text-xs">
            <tr>
              {columns.map((k) => (
                <th key={k} scope="col" className="px-6 py-3 font-medium">
                  {COLUMN_LABELS[k] ?? k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((k) => (
                  <td key={k} className={`border-t px-6 py-2 ${typeof r[k] === "number" ? "tabular-nums" : ""} ${r[k] === null || r[k] === undefined ? "muted" : ""}`} style={{ borderColor: "var(--line)" }}>
                    {cell(r[k])}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, columns.length)} className="muted border-t px-6 py-6 text-sm" style={{ borderColor: "var(--line)" }}>
                  No rows to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {result.rows.length > shown.length && (
        <p className="muted border-t px-6 py-3 text-xs" style={{ borderColor: "var(--line)" }}>
          Showing the first {shown.length} of {result.rows.length} rows.
        </p>
      )}
    </section>
  );
}

export default async function BingReportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser("/dashboard/bing");
  const sp = await searchParams;
  const { reports, repo } = getServices();

  // Resolve the caller's own Bing site by row id: a foreign or malformed id resolves to nothing.
  const wanted = sp.property ?? "";
  const prop = UUID.test(wanted) ? (await repo.listProperties(user.userId, { provider: "bing" })).find((p) => p.id === wanted) : undefined;
  if (!prop) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-12">
        <h1 className="text-3xl font-medium">Bing site not found</h1>
        <p className="muted mt-2 text-sm">That site is not connected to your account.</p>
        <Link href="/dashboard#bing" className="btn-ghost mt-6 inline-block">
          Back to the dashboard
        </Link>
      </main>
    );
  }

  const report = (BING_REPORTS as readonly string[]).includes(sp.report ?? "") ? (sp.report as (typeof BING_REPORTS)[number]) : "traffic";
  const window = WINDOWS.find((w) => w.key === sp.days) ?? WINDOWS[1];
  const meta = REPORTS.find((r) => r.key === report)!;
  const link = (over: { report?: string; days?: string }) => `/dashboard/bing?${new URLSearchParams({ property: prop.id, report: over.report ?? report, days: over.days ?? window.key })}`;

  const requestId = newRequestId();
  let result: NormalizedReportResult | null = null;
  let error: string | null = null;
  try {
    result = await reports.queryBing({ userId: user.userId, scopes: [] }, { propertyId: prop.externalPropertyId, report, ...(window.lastDays && { lastDays: window.lastDays }), limit: 1000 }, requestId);
  } catch (err) {
    const e = toConnectorError(err, requestId);
    error = e.code === "INVALID_QUERY" ? e.message.slice(0, 200) : (ERRORS[e.code] ?? "Something went wrong. The error was logged.");
  }

  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <Link href="/dashboard#bing" className="muted text-sm underline">
        ← Dashboard
      </Link>
      <h1 className="mt-3 text-3xl font-medium sm:text-4xl">
        Bing <span className="accent">{meta.label.toLowerCase()}</span>
      </h1>
      <p className="muted mt-2 break-all text-sm">
        {prop.displayName} · Source: Bing Webmaster Tools (not Google)
      </p>

      <nav aria-label="Report" className="mt-6 flex flex-wrap gap-2">
        {REPORTS.map((r) => (
          <Link key={r.key} href={link({ report: r.key })} aria-current={r.key === report ? "page" : undefined} className={r.key === report ? "btn-primary !px-4 !py-2" : "btn-ghost !px-4 !py-2"}>
            {r.label}
          </Link>
        ))}
      </nav>
      <nav aria-label="Time window" className="mt-3 flex flex-wrap gap-2 text-sm">
        {WINDOWS.map((w) => (
          <Link key={w.key} href={link({ days: w.key })} aria-current={w.key === window.key ? "page" : undefined} className={w.key === window.key ? "rounded-full tone-ok px-3 py-1" : "muted rounded-full px-3 py-1 underline"}>
            {w.label}
          </Link>
        ))}
      </nav>
      <p className="muted mt-2 text-xs">{meta.blurb} Bing's reports have no date range of their own: the window above filters the rows Bing returns.</p>

      {error && (
        <p role="alert" className="mt-6 rounded-xl tone-err px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-6 space-y-4">
          <div className="card text-sm">
            <dl className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <div>
                <dt className="muted inline">Provider: </dt>
                <dd className="inline">Bing Webmaster Tools</dd>
              </div>
              <div>
                <dt className="muted inline">Rows shown: </dt>
                <dd className="inline">
                  {result.rowCountReturned.toLocaleString("en-US")}
                  {result.rowCountReportedByProvider !== null && ` (Bing returned ${result.rowCountReportedByProvider.toLocaleString("en-US")} before the window filter)`}
                </dd>
              </div>
              <div>
                <dt className="muted inline">Window: </dt>
                <dd className="inline">{result.report.startDate ? `${result.report.startDate} to ${result.report.endDate}` : "everything Bing returned"}</dd>
              </div>
              <div>
                <dt className="muted inline">Fetched: </dt>
                <dd className="inline">
                  {age(Math.max(0, Math.round((Date.now() - new Date(result.fetchedAt).getTime()) / 1000)))}
                  {result.cache.hit && !result.cache.stale && " (saved copy, under 6 hours old)"}
                  {result.cache.stale && " (expired saved copy)"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="muted inline">Freshness: </dt>
                <dd className="inline">{String(result.providerMetadata?.freshness ?? "Not stated by Bing.")}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="muted inline">Dates: </dt>
                <dd className="inline">{result.report.dateSemantics}</dd>
              </div>
            </dl>
            <p className="muted mt-3 text-xs">
              Bing counts clicks, impressions and positions differently from Google Search Console. Do not add the two together or compare them one-to-one.
              {result.completeness !== "complete" && " Bing does not say whether this report is complete."}
            </p>
          </div>
          {result.mock && <p className="rounded-xl tone-warn px-4 py-2 text-sm">Demo data: this is not from Bing.</p>}
          {result.warnings
            .filter((w) => w.code !== "MOCK_DATA")
            .map((w) => (
              <p key={w.code} role="status" className="rounded-xl tone-warn px-4 py-2 text-sm">
                {w.message}
              </p>
            ))}
          <Table result={result} />
          <p className="muted text-xs">"no value" means Bing did not send that number. It is not zero.</p>
        </div>
      )}
    </main>
  );
}
