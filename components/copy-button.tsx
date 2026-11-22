"use client";

import { useState } from "react";

/** Copies `value` to the clipboard; says so (or that it couldn't). */
export function CopyButton({ value, label = "Copy", className = "btn btn-outline h-9 px-3 text-sm" }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 2500);
      }}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select and copy it" : label}</span>
    </button>
  );
}
