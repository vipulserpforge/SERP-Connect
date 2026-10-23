"use client";

import { useState } from "react";

/** Copies text to the clipboard and says so. Falls back to a selectable field if the browser blocks clipboard access. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2200);
  }
  return (
    <button type="button" onClick={copy} className="btn-ghost shrink-0 !px-4">
      <span aria-live="polite">{state === "copied" ? "Copied ✓" : state === "failed" ? "Select and copy" : label}</span>
    </button>
  );
}
