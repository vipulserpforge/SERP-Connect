"use client";

import { useState } from "react";
import { AnswerCard } from "@/components/answer-card";
import { EXAMPLES } from "@/components/examples";

/** Three example questions to switch between. Without JavaScript the first answer is simply shown. */
export function PromptDemo() {
  const [active, setActive] = useState(0);
  const current = EXAMPLES[active]!;
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-12">
      <div role="tablist" aria-label="Example questions" className="grid gap-3">
        {EXAMPLES.map((e, i) => {
          const on = i === active;
          return (
            <button
              key={e.id}
              role="tab"
              id={`tab-${e.id}`}
              aria-selected={on}
              aria-controls="demo-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={(ev) => {
                if (ev.key === "ArrowDown" || ev.key === "ArrowRight") setActive((i + 1) % EXAMPLES.length);
                if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") setActive((i + EXAMPLES.length - 1) % EXAMPLES.length);
              }}
              className="min-h-14 rounded-2xl p-4 text-left transition duration-200 sm:p-5"
              style={{
                border: `1px solid ${on ? "rgba(255,122,0,0.6)" : "var(--line)"}`,
                background: on ? "rgba(255,122,0,0.08)" : "var(--surface)",
              }}
            >
              <span className="block text-xs font-medium" style={{ color: on ? "var(--brand-hover)" : "var(--teal)" }}>
                {e.label}
              </span>
              <span className="mt-1.5 block text-base leading-snug sm:text-lg">“{e.question}”</span>
            </button>
          );
        })}
      </div>
      <div id="demo-panel" role="tabpanel" aria-labelledby={`tab-${current.id}`} aria-live="polite">
        <AnswerCard example={current} />
      </div>
    </div>
  );
}
