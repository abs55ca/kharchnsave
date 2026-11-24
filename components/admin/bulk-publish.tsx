"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { listDraftIds, publishProducts, type BulkPublishResult } from "@/app/admin/products/actions";
import { BULK_PUBLISH_BATCH } from "@/lib/admin/bulk-publish";

/*
 * Publishing several drafts from the product list: tick drafts (or select all
 * drafts on this page, or in the whole list), then "Publish selected". Sent in
 * batches of BULK_PUBLISH_BATCH with progress; each product is published with
 * the same checks as its own Publish button, and every one gets a result.
 */

type Selection = { selected: Set<string>; toggle: (id: string, on: boolean) => void; busy: boolean };
const SelectionContext = createContext<Selection | null>(null);

export function BulkPublish({ draftIdsOnPage, q, children }: { draftIdsOnPage: string[]; q: string; children: React.ReactNode }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<BulkPublishResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startRefresh] = useTransition();

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const allOnPage = draftIdsOnPage.length > 0 && draftIdsOnPage.every((id) => selected.has(id));

  const selectWholeList = async () => {
    setError(null);
    setBusy(true);
    const answer = await listDraftIds(q);
    setBusy(false);
    if (!answer.ok) return setError(answer.error);
    setSelected(new Set(answer.ids));
  };

  const publish = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Publish ${ids.length} product${ids.length === 1 ? "" : "s"}? They appear in the shop at their current prices.`)) return;
    setBusy(true);
    setError(null);
    setResults(null);
    const done: BulkPublishResult[] = [];
    for (let i = 0; i < ids.length; i += BULK_PUBLISH_BATCH) {
      setProgress(`Publishing ${Math.min(i + BULK_PUBLISH_BATCH, ids.length)} of ${ids.length}…`);
      let answer: Awaited<ReturnType<typeof publishProducts>>;
      try {
        answer = await publishProducts(ids.slice(i, i + BULK_PUBLISH_BATCH));
      } catch {
        answer = { ok: false, error: "No answer from the server." };
      }
      if (!answer.ok) {
        setError(`${answer.error} ${done.length ? `The first ${done.length} were handled (below); ` : ""}Publish the rest again: products already published are recognised.`);
        break;
      }
      done.push(...answer.results);
    }
    setResults(done);
    setProgress(null);
    setBusy(false);
    // Keep only what still needs publishing selected (failed or skipped ones), and update the list.
    setSelected(new Set(done.filter((r) => r.outcome === "skipped" || r.outcome === "failed").map((r) => r.id)));
    startRefresh(() => router.refresh());
  };

  const published = results?.filter((r) => r.outcome === "published") ?? [];
  const already = results?.filter((r) => r.outcome === "already") ?? [];
  const problems = results?.filter((r) => r.outcome === "skipped" || r.outcome === "failed") ?? [];

  return (
    <SelectionContext.Provider value={{ selected, toggle, busy }}>
      <div className="sticky top-0 z-20 mt-6 flex flex-wrap items-center gap-3 rounded-md border border-line bg-white/95 p-3 text-sm backdrop-blur">
        <label className="flex min-h-10 items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-forest"
            checked={allOnPage}
            disabled={busy || draftIdsOnPage.length === 0}
            onChange={(e) => setSelected((s) => {
              const next = new Set(s);
              for (const id of draftIdsOnPage) {
                if (e.target.checked) next.add(id);
                else next.delete(id);
              }
              return next;
            })}
          />
          Select all drafts on this page
        </label>
        <button type="button" className="font-semibold text-forest underline disabled:opacity-50" disabled={busy} onClick={selectWholeList}>
          Select all drafts in this list
        </button>
        {selected.size > 0 ? (
          <button type="button" className="text-muted underline disabled:opacity-50" disabled={busy} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        ) : null}
        <span className="ml-auto text-muted" aria-live="polite">{progress ?? `${selected.size} selected`}</span>
        <button type="button" className="btn btn-forest h-10" disabled={busy || selected.size === 0} onClick={publish}>
          {busy && progress ? "Publishing…" : `Publish selected (${selected.size})`}
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm font-medium text-danger">{error}</p> : null}
      {results ? (
        <div role="status" className="mt-3 rounded-md border border-line p-3 text-sm">
          <p className="font-semibold text-forest">
            Published {published.length}.{already.length ? ` ${already.length} were already published.` : ""}
            {problems.length ? ` ${problems.length} not published (still selected):` : ""}
          </p>
          {problems.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {problems.map((r) => (
                <li key={r.id}>
                  <span className="font-mono text-xs">{r.itemCode ?? r.id}</span> {r.name ? `${r.name}: ` : ""}{r.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {children}
    </SelectionContext.Provider>
  );
}

/** A row's tick box (drafts only); sits above the row's whole-row link. */
export function SelectDraft({ id, label }: { id: string; label: string }) {
  const ctx = useContext(SelectionContext);
  if (!ctx) return null;
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      className="relative z-10 size-5 shrink-0 accent-forest"
      checked={ctx.selected.has(id)}
      disabled={ctx.busy}
      onChange={(e) => ctx.toggle(id, e.target.checked)}
    />
  );
}
