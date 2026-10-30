"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

/**
 * The scan box. The barcode scanner types the code and presses Enter, which
 * submits the form. The box is emptied and focused again straight away, so
 * the next scan can start while the last one is still being looked up (the
 * latest scan wins). Without JavaScript it's an ordinary search form.
 */
export function ScanForm({ lastCode }: { lastCode: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  // Back in the box after each result, and whenever the window is used again,
  // unless the admin has moved focus somewhere else on purpose.
  useEffect(() => {
    const refocus = () => {
      const active = document.activeElement;
      if (!active || active === document.body) input.current?.focus();
    };
    refocus();
    window.addEventListener("focus", refocus);
    return () => window.removeEventListener("focus", refocus);
  }, [lastCode]);

  return (
    <form
      role="search"
      action="/admin/scan"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        const field = input.current;
        if (!field) return;
        const code = field.value;
        field.value = "";
        field.focus();
        if (!code.trim()) return;
        startTransition(() => router.replace(`/admin/scan?code=${encodeURIComponent(code)}`, { scroll: false }));
      }}
      className="max-w-xl"
    >
      <label htmlFor="scan-code" className="mb-1.5 block text-sm font-semibold">
        Barcode, item code or SKU
      </label>
      <div className="flex gap-2">
        <input
          ref={input}
          id="scan-code"
          name="code"
          // The page exists to receive scans: the box is ready immediately.
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={60}
          aria-describedby="scan-hint"
          className="h-12 min-w-0 flex-1 rounded-md border border-line px-3 font-mono text-lg tracking-wide focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest"
        />
        <button type="submit" className="btn btn-forest h-12">
          Look up
        </button>
      </div>
      <p id="scan-hint" className="mt-1 text-xs text-muted">
        Scan a label, or type the code and press Enter. Looking something up never changes stock.
      </p>
      <p aria-live="polite" className="mt-1 h-5 text-xs text-muted">
        {pending ? "Looking up…" : ""}
      </p>
    </form>
  );
}
