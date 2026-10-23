import type { Example } from "@/components/examples";

/** A Claude-style answer built in HTML (not a screenshot), so it stays sharp and readable at every size. */
export function AnswerCard({ example, compact = false }: { example: Example; compact?: boolean }) {
  return (
    <div
      data-ui
      className="w-full rounded-2xl text-left backdrop-blur-md"
      style={{ border: "1px solid rgba(255,255,255,0.16)", background: "rgba(9,26,24,0.88)", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5" style={{ borderBottom: "1px solid var(--line)" }}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--brand)" }} aria-hidden="true" />
          Claude
        </span>
        <span className="tone-neutral rounded-full px-2.5 py-1 text-xs">Sample data</span>
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
        <p className="ml-auto max-w-[88%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed" style={{ background: "rgba(255,255,255,0.1)" }}>
          {example.question}
        </p>
        <div>
          <p className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1 text-xs" style={{ background: "rgba(15,163,163,0.16)", color: "var(--teal)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12l4 4L19 7" />
            </svg>
            Used SERP Connect · {example.tool}
          </p>
          <p className="mt-3 text-sm leading-relaxed sm:text-base">{example.summary}</p>
          <div className="mt-3 overflow-hidden rounded-xl" style={{ background: "rgba(0,0,0,0.3)" }}>
            <table className="w-full table-fixed text-left text-sm">
              <thead>
                <tr className="muted text-xs">
                  {example.columns.map((c, i) => (
                    <th key={c} scope="col" className={`px-3.5 py-2.5 font-medium ${i === 0 ? "" : "text-right"}`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(compact ? example.rows.slice(0, 3) : example.rows).map((r) => (
                  <tr key={r[0]} style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                    {r.map((cell, i) => (
                      <td
                        key={i}
                        className={`px-3.5 py-2.5 ${i === 0 ? "w-[46%] break-words font-medium" : "text-right tabular-nums"} ${cell.startsWith("+") ? "text-emerald-300" : ""}`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
