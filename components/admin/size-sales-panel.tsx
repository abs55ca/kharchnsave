"use client";

import { useMemo, useState, useTransition } from "react";
import { applySizeSaleAction, endSizeSaleAction, previewSizeSale, type PricingFormState } from "@/app/admin/pricing/actions";
import { SubmitButton, useRequestAction } from "@/components/admin/agent-forms";
import { formatPrice } from "@/lib/format";
import { formatPercentHundredths } from "@/lib/pricing/percent";
import { formatBp, percentToBp } from "@/lib/pricing/rules";
import { matchSize, ruleLabel, validateSizeRules, type SizeRule } from "@/lib/pricing/size-rules";
import { SIZE_SALE_REASONS, WAS_REASONS, type DbSizeRule, type SizeSaleLine, type SizeSaleOverview, type SizeSalePlan } from "@/lib/pricing/size-sale-types";

/*
 * "Sales by size" on the Pricing page: discount rules by EU size for one
 * pricing group, a preview of every product in it, then apply or end. The
 * database works everything out again when applying (same preview token).
 */

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const rupees = (paisa: number) => formatPrice(paisa / 100);

type Row = { key: number; from: string; to: string; percent: string };
type Group = { id: string; name: string; max_price_paisa: number };

let nextKey = 1;
const toRows = (rules: DbSizeRule[]): Row[] =>
  rules.map((r) => ({ key: nextKey++, from: String(r.from), to: String(r.to), percent: formatBp(r.discount_bp).replace("%", "") }));
const startingRules = (o: SizeSaleOverview | undefined) => o?.active ?? o?.saved ?? null;

/** The form's rows as rules, or the problems with them (row by row). */
function readRules(rows: Row[], defaultText: string): { rules: SizeRule[]; defaultBp: number | null; errors: string[] } {
  const errors: string[] = [];
  const rules = rows.map((row, i) => {
    const from = row.from.trim() === "" ? NaN : Number(row.from);
    const to = row.to.trim() === "" ? from : Number(row.to);
    const bp = percentToBp(row.percent, { min: 100, max: 9000 });
    if (bp === null) errors.push(`Row ${i + 1}: enter the discount as a percentage from 1 to 90, e.g. 30 or 12.5.`);
    return { from, to, discountBp: bp ?? 0 };
  });
  const defaultBp = defaultText.trim() === "" ? null : percentToBp(defaultText, { min: 100, max: 9000 });
  if (defaultText.trim() !== "" && defaultBp === null) errors.push("Default discount: a percentage from 1 to 90, or empty for no sale.");
  if (errors.length === 0) errors.push(...validateSizeRules(rules, defaultBp));
  return { rules, defaultBp, errors };
}

export function SizeSalesPanel({ groups, overviews, sizes = {} }: {
  groups: Group[];
  overviews: Record<string, SizeSaleOverview>;
  /** Every EU size in each group, with how many products have it. */
  sizes?: Record<string, { size: number; products: number }[]>;
}) {
  const initialGroup = groups.find((g) => g.name.trim().toLowerCase() === "kids sneakers")?.id ?? groups[0]?.id ?? "";
  const [groupId, setGroupId] = useState(initialGroup);
  const [rows, setRows] = useState<Row[]>(() => toRows(startingRules(overviews[initialGroup])?.rules ?? []));
  const [defaultText, setDefaultText] = useState(() => {
    const bp = startingRules(overviews[initialGroup])?.default_discount_bp;
    return bp ? formatBp(bp).replace("%", "") : "";
  });
  const [plan, setPlan] = useState<SizeSalePlan | null>(null);
  const [planInputs, setPlanInputs] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [filter, setFilter] = useState<"affected" | "all" | "eligible" | "blocked" | "unchanged">("affected");
  const [pending, start] = useTransition();

  const overview = overviews[groupId];
  const active = plan?.group.id === groupId && plan.active ? plan.active : overview?.active ?? null;
  const parsed = readRules(rows, defaultText);
  const inputs = JSON.stringify({ groupId, rules: parsed.rules, defaultBp: parsed.defaultBp });
  const upToDate = plan !== null && planInputs === inputs;

  const chooseGroup = (id: string) => {
    setGroupId(id);
    const saved = startingRules(overviews[id]);
    setRows(toRows(saved?.rules ?? []));
    setDefaultText(saved?.default_discount_bp ? formatBp(saved.default_discount_bp).replace("%", "") : "");
    setPlan(null);
    setProblems([]);
  };
  const update = (key: number, change: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const runPreview = () => {
    if (parsed.errors.length) return setProblems(parsed.errors);
    setProblems([]);
    const dbRules = parsed.rules.map((r) => ({ from: r.from, to: r.to, discount_bp: r.discountBp }));
    start(async () => {
      const answer = await previewSizeSale(groupId, dbRules, parsed.defaultBp);
      if (answer.ok) {
        setPlan(answer.plan);
        setPlanInputs(inputs);
      } else setProblems([answer.message]);
    });
  };

  const applyR = useRequestAction(applySizeSaleAction, {
    label: "Apply size sale",
    storageKey: `size-sale-apply:${groupId}`,
    onDone: (state) => {
      const data = (state as PricingFormState).data as SizeSalePlan | undefined;
      if (data && Array.isArray(data.lines)) {
        setPlan(data); // stale: the new preview
        setPlanInputs(inputs);
      } else setPlan(null);
    },
  });
  const endR = useRequestAction(endSizeSaleAction, { label: "End size sale", storageKey: `size-sale-end:${groupId}`, onDone: () => setPlan(null) });

  if (groups.length === 0) return <p className="text-sm text-muted">Create a pricing group first.</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Different discounts for different EU sizes in one group. A single size overrides a range; ranges can&apos;t overlap. Sale price =
        regular price × (1 − discount), to the paisa (half up), always from the regular price. Regular prices, scores and maximums
        don&apos;t change. The shop shows a crossed-out &ldquo;was&rdquo; price only where the price history supports it.
      </p>

      <label className="block max-w-sm text-sm font-semibold">
        Pricing group
        <select className={`${INPUT} mt-1 h-10 font-normal`} value={groupId} onChange={(e) => chooseGroup(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name} (max {rupees(g.max_price_paisa)})</option>
          ))}
        </select>
      </label>

      {active ? (
        <p role="status" className="rounded-md border border-forest p-3 text-sm">
          A size sale is running in this group since {new Date(active.started_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} on{" "}
          {active.live} product(s): {active.rules.map((r) => `${ruleLabel(r)} ${formatBp(r.discount_bp)}`).join(", ") || "no rules"}
          {active.default_discount_bp ? `, others ${formatBp(active.default_discount_bp)}` : ""}. Applying the same rules adds newly eligible
          products; to change the rules, end it first.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)]">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Rules</legend>
        {rows.length === 0 ? <p className="text-sm text-muted">No rules yet.</p> : null}
        {rows.map((row, i) => (
          <div key={row.key} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2 sm:max-w-xl">
            <label className="text-xs font-semibold">
              EU from
              <input inputMode="decimal" aria-label={`Row ${i + 1}: EU size from`} className={`${INPUT} mt-1 h-10 font-normal`} value={row.from}
                onChange={(e) => update(row.key, { from: e.target.value })} placeholder="25" />
            </label>
            <label className="text-xs font-semibold">
              EU to
              <input inputMode="decimal" aria-label={`Row ${i + 1}: EU size to`} className={`${INPUT} mt-1 h-10 font-normal`} value={row.to}
                onChange={(e) => update(row.key, { to: e.target.value })} placeholder="same size" />
            </label>
            <label className="text-xs font-semibold">
              % off
              <input inputMode="decimal" aria-label={`Row ${i + 1}: discount percent`} className={`${INPUT} mt-1 h-10 font-normal`} value={row.percent}
                onChange={(e) => update(row.key, { percent: e.target.value })} placeholder="30" />
            </label>
            <button type="button" className="h-10 px-2 text-xs font-semibold text-danger underline" aria-label={`Remove row ${i + 1}`}
              onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-outline h-10" onClick={() => setRows((rs) => [...rs, { key: nextKey++, from: "", to: "", percent: "" }])}>
          Add a rule
        </button>
        <p className="text-xs text-muted">Sizes are EU 15 to 50, whole or half (e.g. 29.5). Leave &ldquo;EU to&rdquo; empty for one size.</p>
      </fieldset>
      <GroupSizes sizes={sizes[groupId] ?? null} rules={parsed.errors.length ? null : parsed.rules} defaultBp={parsed.defaultBp} />
      </div>

      <label className="block max-w-xs text-sm font-semibold">
        Default % off for other sizes (optional)
        <input inputMode="decimal" className={`${INPUT} mt-1 h-10 font-normal`} value={defaultText} onChange={(e) => setDefaultText(e.target.value)}
          placeholder="empty: no sale" />
      </label>

      {problems.length ? (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm font-medium text-danger">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        <button type="button" className="btn btn-forest h-11" onClick={runPreview} disabled={pending}>
          {pending ? "Previewing…" : "Preview size sale"}
        </button>
        <form onSubmit={(e) => { if (!applyR.unconfirmed && !window.confirm(`Put ${plan?.counts.eligible ?? 0} product(s) on sale at the previewed prices?`)) { e.preventDefault(); return; } applyR.onSubmit(e); }}>
          <input type="hidden" name="requestId" value={applyR.requestId} />
          <input type="hidden" name="groupId" value={groupId} />
          <input type="hidden" name="rules" value={JSON.stringify(parsed.rules.map((r) => ({ from: r.from, to: r.to, discount_bp: r.discountBp })))} />
          <input type="hidden" name="defaultBp" value={parsed.defaultBp ?? ""} />
          <input type="hidden" name="token" value={plan?.token ?? ""} />
          <SubmitButton r={applyR} label={`Apply eligible sales${upToDate ? ` (${plan!.counts.eligible})` : ""}`} busy="Applying…" className="btn btn-outline h-11"
            disabled={!upToDate || plan!.counts.eligible === 0} />
        </form>
        {active || endR.unconfirmed ? (
          <form onSubmit={(e) => { if (!endR.unconfirmed && !window.confirm("End this group's size sale? Its products go back to their regular prices.")) { e.preventDefault(); return; } endR.onSubmit(e); }}>
            <input type="hidden" name="requestId" value={endR.requestId} />
            <input type="hidden" name="groupId" value={groupId} />
            <SubmitButton r={endR} label="End size-based sales" busy="Ending…" className="btn btn-outline h-11 text-danger" />
          </form>
        ) : null}
      </div>
      {plan && !upToDate ? <p className="text-sm font-medium text-danger">The rules changed since this preview. Preview again before applying.</p> : null}
      {applyR.state.message ? <p aria-live="polite" className={`text-sm ${applyR.state.ok ? "text-forest" : "font-medium text-danger"}`}>{applyR.state.message}</p> : null}
      {endR.state.message ? <p aria-live="polite" className={`text-sm ${endR.state.ok ? "text-forest" : "font-medium text-danger"}`}>{endR.state.message}</p> : null}

      {plan ? <SizeSalePreview plan={plan} filter={filter} setFilter={setFilter} /> : null}
    </div>
  );
}

function SizeSalePreview({ plan, filter, setFilter }: { plan: SizeSalePlan; filter: string; setFilter: (f: "affected" | "all" | "eligible" | "blocked" | "unchanged") => void }) {
  const { counts } = plan;
  const lines = useMemo(() => plan.lines.filter((l) => {
    if (filter === "all") return true;
    if (filter === "affected") return l.reason !== "no_rule";
    return l.status === filter;
  }), [plan, filter]);
  const blockedWhy = useMemo(() => {
    const by = new Map<string, number>();
    for (const l of plan.lines) if (l.status === "blocked") by.set(l.reason ?? "", (by.get(l.reason ?? "") ?? 0) + 1);
    return [...by.entries()].sort((a, b) => b[1] - a[1]);
  }, [plan]);

  return (
    <section aria-label="Size sale preview" className="space-y-3 rounded-md border border-line p-3">
      <h3 className="font-bold">Preview: {plan.group.name}</h3>
      <p className="text-sm">
        <strong>{counts.eligible}</strong> eligible · <strong>{counts.blocked}</strong> blocked · <strong>{counts.unchanged}</strong> unchanged
        (of {plan.lines.length} products in the group).
      </p>
      {counts.eligible === 0 ? (
        <div role="status" className="rounded-md bg-cream p-3 text-sm">
          <p className="font-semibold">Nothing qualifies, so applying would change nothing.</p>
          {blockedWhy.length ? (
            <ul className="mt-1 list-disc pl-5">
              {blockedWhy.map(([reason, n]) => <li key={reason}>{n} product(s): {SIZE_SALE_REASONS[reason] ?? reason}</li>)}
            </ul>
          ) : <p className="mt-1">No product in this group matches a rule.</p>}
        </div>
      ) : null}
      <label className="text-xs font-semibold">
        Show{" "}
        <select className="ml-1 h-8 rounded-md border border-line px-2 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as never)}>
          <option value="affected">Matching a rule</option>
          <option value="eligible">Eligible</option>
          <option value="blocked">Blocked</option>
          <option value="unchanged">Unchanged</option>
          <option value="all">All</option>
        </select>
      </label>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[60rem] text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="py-2 pr-3">Product</th>
              <th scope="col" className="py-2 pr-3">Rule</th>
              <th scope="col" className="py-2 pr-3">Regular</th>
              <th scope="col" className="py-2 pr-3">Customer pays now</th>
              <th scope="col" className="py-2 pr-3">Sale price</th>
              <th scope="col" className="py-2 pr-3">Saving</th>
              <th scope="col" className="py-2 pr-3">Margin</th>
              <th scope="col" className="py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((l) => <PreviewRow key={l.product_id} line={l} />)}
          </tbody>
        </table>
      </div>
      {lines.length === 0 ? <p className="text-sm text-muted">No products in this view.</p> : null}
    </section>
  );
}

function PreviewRow({ line: l }: { line: SizeSaleLine }) {
  const tone = l.status === "eligible" ? "text-forest" : l.status === "blocked" ? "text-danger" : "text-muted";
  return (
    <tr data-product={l.item_code}>
      <td className="py-2 pr-3">
        <span className="font-semibold">{l.name}</span>
        <span className="block text-xs text-muted"><span className="font-mono">{l.item_code}</span> · EU {l.sizes.join(", ")}</span>
      </td>
      <td className="py-2 pr-3">{l.rule ? `${l.rule} · ${formatBp(l.discount_bp!)}` : <span className="text-muted">none</span>}</td>
      <td className="py-2 pr-3">{rupees(l.regular_paisa)}</td>
      <td className="py-2 pr-3">{rupees(l.current_paisa)}</td>
      <td className="py-2 pr-3 font-semibold">{l.proposed_paisa !== null ? rupees(l.proposed_paisa) : "—"}</td>
      <td className="py-2 pr-3">
        {l.proposed_paisa !== null && l.actual_hundredths !== null
          ? <>{rupees(l.regular_paisa - l.proposed_paisa)} <span className="text-muted">({formatPercentHundredths(l.actual_hundredths)})</span></>
          : "—"}
      </td>
      <td className="py-2 pr-3">
        {l.proposed_paisa === null ? "—" : l.cost_paisa === null ? "Cost unknown"
          : <>Kept {rupees(Number(l.retained_paisa ?? 0))}{l.margin === "violation" ? <span className="block text-xs text-danger">below your minimum</span> : null}</>}
      </td>
      <td className={`py-2 ${tone}`}>
        {l.status === "eligible" ? "Will go on sale" : l.status === "blocked" ? "Blocked" : "Unchanged"}
        {l.reason ? <span className="block text-xs">{SIZE_SALE_REASONS[l.reason] ?? l.reason}{l.detail ? `: ${l.detail}` : ""}</span> : null}
        {l.was ? (
          <span className="block text-xs text-ink">
            {l.was.shown ? `Shop shows "Was ${rupees(Number(l.was.price_paisa))}"` : `No "was" price (${WAS_REASONS[l.was.reason ?? ""] ?? "no verified history"})`}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** The sizes the group's products come in, and what the rules (as typed) do to each. */
function GroupSizes({ sizes, rules, defaultBp }: { sizes: { size: number; products: number }[] | null; rules: SizeRule[] | null; defaultBp: number | null }) {
  if (sizes === null) return <p className="text-sm text-muted">This group&apos;s sizes couldn&apos;t be listed.</p>;
  const total = sizes.reduce((n, s) => n + s.products, 0);
  return (
    <section aria-label="Sizes in this group" className="space-y-2">
      <h3 className="text-sm font-semibold">Sizes in this group</h3>
      {sizes.length === 0 ? (
        <p className="text-sm text-muted">No products in this group yet.</p>
      ) : (
        <>
          <p className="text-xs text-muted">
            {sizes.length} size(s) across {total} listing(s).{rules ? " What your rules do to each:" : " Fix the rules to see what they do to each size."}
          </p>
          <ul className="flex flex-wrap gap-2">
            {sizes.map((s) => {
              const match = rules ? matchSize(rules, defaultBp, s.size) : null;
              return (
                <li key={s.size} data-size={s.size}
                  className={`rounded border px-2 py-1 text-xs ${match ? "border-forest bg-cream" : "border-line"}`}>
                  <span className="font-semibold">EU {s.size}</span>
                  <span className="text-muted"> · {s.products} {s.products === 1 ? "listing" : "listings"}</span>
                  {rules ? <span className={match ? "block text-forest" : "block text-muted"}>{match ? `${formatBp(match.discountBp)} off · ${match.label}` : "no sale"}</span> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
