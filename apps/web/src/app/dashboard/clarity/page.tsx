import Link from "next/link";
import type { NormalizedReportResult, ReportRow } from "@serp/contracts";
import { CLARITY_DAILY_REQUEST_LIMIT, CLARITY_DIMENSIONS, CLARITY_DOCS_URL, CLARITY_MAX_ROWS, CLARITY_TIME_SEMANTICS } from "@serp/provider-clarity";
import { newRequestId } from "@serp/observability";
import { fetchClarityReportAction } from "@/app/clarity-actions";
import { getServices, requireUser } from "@/lib/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clarity reports" };

const MAX_ROWS_SHOWN = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dimension presets for the views people ask for. Each is just a choice of up to three documented dimensions. */
const PRESETS = [
  { label: "Overview", dims: [] as string[] },
  { label: "Devices & browsers", dims: ["Device", "Browser"] },
  { label: "Operating systems", dims: ["OS"] },
  { label: "Traffic sources", dims: ["Source", "Medium", "Channel"] },
  { label: "Popular pages", dims: ["URL"] },
  { label: "Countries", dims: ["Country/Region"] },
];

/** Groups the metric blocks Clarity returned by name. Names come from the response; nothing is assumed to be present. */
const TABS = [
  { key: "all", label: "All metrics", test: () => true },
  { key: "traffic", label: "Traffic", test: (n: string) => /traffic/i.test(n) },
  { key: "engagement", label: "Engagement", test: (n: string) => /engagement|scroll depth/i.test(n) },
  { key: "interactions", label: "Interactions & errors", test: (n: string) => /click|excessive scroll|quickback|error/i.test(n) },
  { key: "pages", label: "Pages & referrers", test: (n: string) => /popular|page title|referrer/i.test(n) },
];

const ERRORS: Record<string, string> = {
  AUTH_EXPIRED: "Clarity no longer accepts this token. Replace the token on the dashboard.",
  FORBIDDEN: "Clarity says this token is not allowed to export data. Replace the token on the dashboard.",
  CLARITY_DAILY_BUDGET_EXHAUSTED: "Today's Clarity request allowance for this project is used up, and no saved result exists for these settings. Try a saved view, or come back after the next UTC day starts.",
  RATE_LIMITED: "Too many requests in a short time. Wait a moment and try again.",
  PROVIDER_UNAVAILABLE: "Clarity could not be reached or answered in an unexpected format. The attempt counted against today's allowance.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Clarity is not fully set up on this server yet.",
  PROPERTY_NOT_CONNECTED: "That Clarity project could not be found.",
  INTERNAL_ERROR: "Something went wrong. The error was logged.",
};

const cell = (v: string | number | null | undefined) => (v === undefined ? "—" : v === null ? "no value" : typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v);

function age(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function Block({ name, rows, dims, truncated }: { name: string; rows: ReportRow[]; dims: string[]; truncated: boolean }) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "metricName");
  const isDim = (k: string) => dims.some((d) => d.toLowerCase().replace(/[^a-z0-9]/g, "") === k.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const columns = [...keys.filter(isDim), ...keys.filter((k) => !isDim(k))];
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  return (
    <section className="card !p-0 overflow-hidden">
      <h3 className="px-6 pt-5 text-lg font-medium">{name}</h3>
      {truncated && <p className="mx-6 mt-2 rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900">Clarity's {CLARITY_MAX_ROWS}-row limit was reached for this metric, so rows are missing. Add or change a dimension to narrow it.</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <caption className="sr-only">{name}</caption>
          <thead className="muted text-xs">
            <tr>
              {columns.map((k) => (
                <th key={k} scope="col" className="border-t px-6 py-2 font-medium" style={{ borderColor: "var(--line)" }}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {columns.map((k) => (
                  <td key={k} className={`border-t px-6 py-2 ${typeof r[k] === "number" ? "tabular-nums" : ""}`} style={{ borderColor: "var(--line)" }}>
                    {cell(r[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && <p className="muted border-t px-6 py-3 text-xs" style={{ borderColor: "var(--line)" }}>Showing the first {shown.length} of {rows.length} rows.</p>}
    </section>
  );
}

export default async function ClarityReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser("/dashboard/clarity");
  const sp = await searchParams;
  const { repo, reports, clarityQuota } = getServices();
  const projects = await repo.listProperties(user.userId, { provider: "clarity" });

  if (projects.length === 0) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-12">
        <h1 className="text-3xl font-medium">Clarity reports</h1>
        <p className="muted mt-3">No Clarity project is connected yet.</p>
        <Link href="/dashboard#clarity" className="btn-primary mt-6">Connect a Clarity project</Link>
      </main>
    );
  }

  const project = projects.find((p) => p.id === sp.property && UUID.test(sp.property ?? "")) ?? projects[0]!;
  const numOfDays = ([1, 2, 3] as const).find((d) => String(d) === sp.days) ?? 1;
  const allowed = new Set<string>(CLARITY_DIMENSIONS);
  const dims = [...new Set((sp.dims ?? "").split(",").filter((d) => allowed.has(d)))].slice(0, 3);
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0]!;
  const link = (over: { days?: number; dims?: string[]; tab?: string }) => {
    const d = over.dims ?? dims;
    const q = new URLSearchParams({ property: project.id, days: String(over.days ?? numOfDays), ...(d.length > 0 && { dims: d.join(",") }), ...(over.tab && over.tab !== "all" && { tab: over.tab }) });
    return `/dashboard/clarity?${q}`;
  };

  // Page views read saved data only. Calling Clarity happens solely through the explicit Fetch button.
  let result: NormalizedReportResult | null = null;
  let loadError: string | null = null;
  try {
    result = await reports.peekClarityCache({ userId: user.userId, scopes: [] }, { propertyId: project.externalPropertyId, numOfDays, dimensions: dims }, newRequestId());
  } catch {
    loadError = "PROPERTY_NOT_CONNECTED";
  }
  const quota = await clarityQuota.status(project.externalPropertyId).catch(() => null);
  const errorCode = sp.error ?? loadError;

  const blocks = (result?.providerMetadata?.metricBlocks as Array<{ metricName: string; rows: number; truncated: boolean }> | undefined) ?? [];
  const visible = blocks.filter((b) => tab.test(b.metricName));
  const fetchFields = (
    <>
      <input type="hidden" name="propertyId" value={project.id} />
      <input type="hidden" name="days" value={numOfDays} />
      {dims.map((d, i) => (
        <input key={d} type="hidden" name={`dim${i + 1}`} value={d} />
      ))}
    </>
  );

  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <Link href="/dashboard#clarity" className="muted text-sm underline">← Back to integrations</Link>
      <h1 className="mt-3 text-3xl font-medium sm:text-4xl">
        Clarity <span className="accent">reports</span>
      </h1>
      <p className="muted mt-2 text-sm">{project.displayName}</p>

      {projects.length > 1 && (
        <nav aria-label="Clarity projects" className="mt-4 flex flex-wrap gap-2">
          {projects.map((p) => (
            <Link key={p.id} href={`/dashboard/clarity?property=${p.id}`} aria-current={p.id === project.id ? "page" : undefined} className={p.id === project.id ? "btn-primary !py-1.5 !text-xs" : "btn-ghost !py-1.5 !text-xs"}>
              {p.displayName}
            </Link>
          ))}
        </nav>
      )}

      <div className="card mt-6 text-sm">
        <h2 className="font-medium">What this shows</h2>
        <ul className="muted mt-2 list-disc space-y-1 pl-5">
          <li>Visitor <em>behaviour</em> from Microsoft Clarity. It is not search data: rankings, impressions and organic clicks come from Search Console.</li>
          <li>{CLARITY_TIME_SEMANTICS}</li>
          <li>Clarity allows only {CLARITY_DAILY_REQUEST_LIMIT} requests per project per day and no history beyond 3 days. Each metric returns at most {CLARITY_MAX_ROWS} rows with no paging.</li>
          <li>
            Field names and values are shown exactly as Clarity returns them; Clarity's <a className="underline" href={CLARITY_DOCS_URL}>API documentation</a> does not define each field. A dash (—) means the field was not in the response; “no value” means Clarity sent null; 0 is a real zero.
          </li>
        </ul>
      </div>

      <section className="mt-6" aria-label="Report settings">
        <p className="text-sm font-medium">Quick views</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const active = p.dims.join(",") === dims.join(",");
            return (
              <Link key={p.label} href={link({ dims: p.dims })} aria-current={active ? "true" : undefined} className={active ? "btn-primary !py-1.5 !text-xs" : "btn-ghost !py-1.5 !text-xs"}>
                {p.label}
              </Link>
            );
          })}
        </div>
        <p className="mt-4 text-sm font-medium">Time window</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {([1, 2, 3] as const).map((d) => (
            <Link key={d} href={link({ days: d })} aria-current={d === numOfDays ? "true" : undefined} className={d === numOfDays ? "btn-primary !py-1.5 !text-xs" : "btn-ghost !py-1.5 !text-xs"}>
              Last {d * 24} hours
            </Link>
          ))}
        </div>
        <p className="muted mt-3 text-xs">
          Selected: last {numOfDays * 24} hours{dims.length > 0 ? `, by ${dims.join(" › ")}` : ", no breakdown"}. Switching views only shows results already saved; it never contacts Clarity.
        </p>
      </section>

      {errorCode && (
        <p role="alert" className="mt-6 rounded-xl bg-red-100 px-3.5 py-2.5 text-sm text-red-900">
          {errorCode === "INVALID_QUERY" ? (sp.msg ?? "Those settings are not supported by Clarity.") : (ERRORS[errorCode] ?? ERRORS.INTERNAL_ERROR)}
        </p>
      )}

      <section className="card mt-6 text-sm" aria-label="Request allowance">
        <h2 className="font-medium">Request allowance (tracked by this app)</h2>
        {quota ? (
          <p className="muted mt-2">
            {quota.localBudget >= 1000 ? `${quota.appTrackedUsed} requests made today · no app-side limit` : `${quota.appTrackedUsed} of ${quota.localBudget} used today · ${quota.localRemaining} left in this app's budget`} · Clarity's own limit is {quota.providerDailyLimit}/day. Window {quota.window.start.slice(0, 16).replace("T", " ")} to {quota.window.end.slice(0, 16).replace("T", " ")} UTC (assumed).
            {quota.lastSuccessAt && ` Last successful request: ${quota.lastSuccessAt.slice(0, 16).replace("T", " ")} UTC.`}
            {quota.providerLimitReported && " Clarity reported its limit today: fetching is paused until the next window."}
          </p>
        ) : (
          <p className="muted mt-2">Allowance information is unavailable right now.</p>
        )}
      </section>

      {result ? (
        <>
          <section className="card mt-6 text-sm" aria-label="Result details">
            <div className="flex flex-wrap items-center gap-2">
              {result.mock && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">Demo data: not from Clarity</span>}
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${result.cache.stale ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                {result.cache.stale ? "Saved result (expired)" : "Saved result"}
              </span>
              <span className="muted">
                Fetched {result.fetchedAt.slice(0, 16).replace("T", " ")} UTC ({age(result.cache.ageSeconds)}) · {result.rowCountReturned.toLocaleString("en-US")} rows
              </span>
            </div>
            {result.warnings.length > 0 && (
              <ul className="mt-3 space-y-1.5" aria-label="Warnings">
                {result.warnings.map((w) => (
                  <li key={w.code + w.message} className="rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-900">
                    {w.message}
                  </li>
                ))}
              </ul>
            )}
            <form action={fetchClarityReportAction} className="mt-4">
              {fetchFields}
              <button className="btn-ghost !py-2 !text-xs">Refresh from Clarity (uses 1 request)</button>
            </form>
          </section>

          <nav aria-label="Metric groups" className="mt-6 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link key={t.key} href={link({ tab: t.key })} aria-current={t.key === tab.key ? "true" : undefined} className={t.key === tab.key ? "btn-primary !py-1.5 !text-xs" : "btn-ghost !py-1.5 !text-xs"}>
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="mt-4 space-y-5">
            {visible.length === 0 && (
              <p className="muted text-sm">
                {blocks.length === 0 ? "Clarity returned no rows for this window. That means no data was reported, not that every value is zero." : `This result has no "${tab.label}" metrics. Clarity only returns the metrics it has data for.`}
              </p>
            )}
            {visible.map((b) => (
              <Block key={b.metricName} name={b.metricName} rows={result.rows.filter((r) => r.metricName === b.metricName)} dims={result.report.dimensions} truncated={b.truncated} />
            ))}
          </div>
        </>
      ) : (
        <section className="card mt-6 text-sm" aria-label="No saved result">
          <h2 className="font-medium">No saved result for these settings</h2>
          <p className="muted mt-2">
            Fetching asks Clarity for the last {numOfDays * 24} hours{dims.length > 0 ? ` by ${dims.join(", ")}` : ""} and uses <strong>1</strong> of today's requests. The result is then saved for several hours, so reopening it is free.
          </p>
          <form action={fetchClarityReportAction} className="mt-4">
            {fetchFields}
            <button className="btn-primary" disabled={quota?.localRemaining === 0}>
              Fetch from Clarity (uses 1 request)
            </button>
            {quota?.localRemaining === 0 && <p className="mt-2 text-xs text-amber-300">This app's budget for today is used up.</p>}
          </form>
        </section>
      )}
    </main>
  );
}
