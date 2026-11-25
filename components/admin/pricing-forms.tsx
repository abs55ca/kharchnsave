"use client";

import Link from "@/components/admin/admin-link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  applyCampaignAction,
  applyProductPricingAction,
  applyRepriceAction,
  campaignSelectionAction,
  createCampaignAction,
  createGroupAction,
  endCampaignAction,
  previewProductPricing,
  previewReprice,
  runScheduleAction,
  saveSettingsAction,
  updateCampaignAction,
  type PricingFormState,
} from "@/app/admin/pricing/actions";
import { SubmitButton, useRequestAction } from "@/components/admin/agent-forms";
import type { Campaign, CampaignLine, CampaignPlan, Candidate, Economics, Plan, PlanLine, PricingGroup, PricingProduct, PricingSettings } from "@/lib/admin/pricing";
import { formatPrice } from "@/lib/format";
import { displayedDiscount, formatBp, scorePrice, spreadOffsetBp } from "@/lib/pricing/rules";

/*
 * Score pricing and sale campaign forms (phones first). Estimates while
 * typing come from lib/pricing/rules.ts; what is saved is worked out again by
 * the database, after a preview the admin confirms. Every write goes through
 * useRequestAction (components/admin/agent-forms.tsx): one request id per
 * change, "Retry unconfirmed save" after a lost answer, and nothing applied twice.
 */

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const LABEL = "mb-1 block text-sm font-semibold";
const HINT = "mt-1 text-xs text-muted";
const rupees = (paisa: number | null | undefined) => (paisa === null || paisa === undefined ? "—" : formatPrice(paisa / 100));
const asState = (s: unknown) => s as PricingFormState;

// Reason texts (kept here as well as in lib/admin/pricing.ts, which is server-only).
const REASONS: Record<string, string> = {
  not_found: "Product not found",
  unknown_group: "That pricing group no longer exists",
  incomplete: "Automatic pricing needs a group and a score",
  giveaway_needs_score_0: "A giveaway needs automatic pricing with score 0",
  needs_pricing: "Score 0: needs pricing (or mark it as an explicit giveaway)",
  too_small: "Too small for the price ending: needs review",
  sale_too_small: "The sale price would be too small: needs review",
  manual_sale_conflict: "Its manual sale price would be at or above the new regular price",
  size_sale_running: "It's in a running size sale (Sales by size): end that sale first",
  giveaway_on_sale: "A giveaway can't be on sale",
  margin_violation: "Below the minimum profit/margin in the worst referral case",
  cost_unknown: "Cost unknown, so the minimum margin can't be checked",
  not_published: "Not published",
  free_item: "Free item",
  other_sale: "Already on another sale (manual or another campaign)",
  no_reference: "No supported reference price (this sale requires one)",
  changed_since_review: "Changed since the sale was reviewed",
};
const REFERENCE_REASONS: Record<string, string> = {
  not_published: "it wasn't published at that price before the sale",
  not_offered_at_price: "it was never offered at this regular price",
  offered_too_briefly: "it was offered at this price for less than your minimum days",
  not_above_sale_price: "the supported reference isn't above the sale price",
  new_listing: "new listing, no price history",
  no_history_before_tracking: "on sale since before price history was kept",
};
const reason = (r: string | null | undefined) => (r ? (REASONS[r] ?? r) : "");
const STALE_NOTICE = "Prices, products or agent terms changed since your preview, so nothing was applied. This is the new preview: check it and confirm again.";
function Notice({ text }: { text: string | null }) {
  return text ? <p role="status" className="rounded-md border border-danger p-2 text-sm font-medium text-danger">{text}</p> : null;
}

function Message({ state }: { state: PricingFormState }) {
  return state.message ? (
    <p aria-live="polite" className={`text-sm ${state.ok ? "text-forest" : "font-medium text-danger"}`}>{state.message}</p>
  ) : null;
}

// ---------------------------------------------------------------------------
// Score entry and estimates
// ---------------------------------------------------------------------------

/** A score: a slider in steps of 5, and a box for any whole number 0-100. */
export function ScoreInput({ value, onChange, id, name }: { value: number | null; onChange: (v: number | null) => void; id: string; name?: string }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range" min={0} max={100} step={5} value={value ?? 0} aria-label="Score (steps of 5)"
        onChange={(e) => onChange(Number(e.target.value))} className="h-10 flex-1 accent-forest"
      />
      <input
        id={id} name={name} type="number" inputMode="numeric" min={0} max={100} step={1} value={value ?? ""}
        onChange={(e) => {
          const n = e.target.value === "" ? null : Number(e.target.value);
          onChange(n === null || (Number.isInteger(n) && n >= 0 && n <= 100) ? n : value);
        }}
        className={`${INPUT} h-10 w-20 text-center`} aria-describedby={`${id}-hint`}
      />
    </div>
  );
}

/**
 * What a score gives under a maximum, with the price spread and the price ending (an estimate; the database decides).
 * With a product (`productId`) its own spread is applied; without one (several shoes), the range is described.
 */
export function PriceEstimate({ maxPaisa, score, ending, giveaway = false, spreadBp = 0, productId }: {
  maxPaisa: number | null; score: number | null; ending: number; giveaway?: boolean; spreadBp?: number; productId?: string;
}) {
  if (maxPaisa === null || score === null) return <p className="text-sm text-muted">Choose a group and a score to see the price.</p>;
  const offset = productId ? spreadOffsetBp(productId, spreadBp) : 0;
  const r = scorePrice(maxPaisa, score, ending, giveaway, offset);
  if (r.status === "needs_pricing") return <p className="text-sm font-medium text-danger">Score 0 means “needs pricing”: nothing is saved unless you make it an explicit giveaway.</p>;
  if (r.status === "giveaway") return <p className="text-sm font-medium text-danger">Giveaway: Rs. 0.</p>;
  if (r.status === "too_small") return <p className="text-sm font-medium text-danger">{rupees(r.calculatedPaisa)} is too small for a price ending in {ending}: flagged for review, not saved.</p>;
  return (
    <p className="text-sm">
      Estimated price <span className="text-lg font-bold">{rupees(r.pricePaisa)}</span>{" "}
      <span className="text-muted">
        ({rupees(maxPaisa)} × {score}%{offset ? ` − this shoe’s ${formatBp(offset)} spread` : ""} = {rupees(r.calculatedPaisa)}, ending {ending})
      </span>
      {spreadBp > 0 && !productId ? (
        <span className="block text-xs text-muted">
          With the {formatBp(spreadBp)} price spread, each shoe then gets its own price up to {formatBp(spreadBp)} below this, so they don’t all look the same.
        </span>
      ) : null}
    </p>
  );
}

function Margin({ e }: { e: Economics | null | undefined }) {
  if (!e) return null;
  const w = e.worst;
  const scenario = w.kind === "no_code" ? "no code" : `code ${formatBp(w.discount_bp)} off, ${formatBp(w.commission_bp)} commission`;
  return (
    <div className="text-xs">
      <p>
        Lowest amount kept ({scenario}): customer pays {rupees(w.paid_paisa)}, commission {rupees(w.commission_paisa)},{" "}
        {w.retained_paisa === null ? <span className="font-semibold text-danger">kept: unknown (no cost recorded)</span> : <span>kept after cost: <strong>{rupees(w.retained_paisa)}</strong></span>}
      </p>
      {e.margin === "violation" ? <p className="font-semibold text-danger">At least one scenario is below your minimum profit or margin.</p> : null}
      {e.margin === "cost_unknown" ? <p className="font-semibold text-danger">Cost unknown: the minimum can’t be checked.</p> : null}
      {e.agents_excluded > 0 ? (
        <p className="text-muted">{e.agents_excluded} of {e.agents_enabled} enabled agent code(s) don’t apply here {e.referral_allowed ? "(their terms exclude sale items)" : "(no referral discounts on this sale)"}.</p>
      ) : null}
      {e.scenarios.length > 1 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted">All {e.scenarios.length} scenarios</summary>
          <ul className="mt-1 space-y-0.5">
            {e.scenarios.map((s, i) => (
              <li key={i}>
                {s.kind === "no_code" ? "No code" : `${s.agents} agent(s): ${formatBp(s.discount_bp)} off, ${formatBp(s.commission_bp)} commission`}: pays {rupees(s.paid_paisa)}, commission {rupees(s.commission_paisa)}, kept {s.retained_paisa === null ? "unknown" : rupees(s.retained_paisa)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Previews and confirmations
// ---------------------------------------------------------------------------

function PlanLines({ lines }: { lines: PlanLine[] }) {
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {lines.map((l) => {
        const priceMoves = l.from && l.to && (l.from.price_paisa !== l.to.price_paisa || l.from.sale_price_paisa !== l.to.sale_price_paisa);
        return (
          <li key={l.product_id} className={`space-y-1 p-3 text-sm ${l.action === "skip" ? "bg-danger/5" : ""}`}>
            <p className="font-semibold">
              <span className="font-mono text-xs">{l.item_code}</span> {l.name}
              <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${l.action === "apply" ? "bg-forest text-white" : l.action === "skip" ? "bg-danger text-white" : "bg-cream"}`}>
                {l.action === "apply" ? (priceMoves ? "Price changes" : "Saves") : l.action === "skip" ? "Not changed" : "No change"}
              </span>
            </p>
            {l.action === "skip" ? <p className="text-danger">{reason(l.reason)}</p> : null}
            {l.from && l.to ? (
              <p>
                Regular {rupees(l.from.price_paisa)}{l.from.price_paisa !== l.to.price_paisa ? <> → <strong>{rupees(l.to.price_paisa)}</strong></> : null}
                {l.from.sale_price_paisa !== null || l.to.sale_price_paisa !== null ? (
                  <> · sale {rupees(l.from.sale_price_paisa)}{l.from.sale_price_paisa !== l.to.sale_price_paisa ? <> → <strong>{rupees(l.to.sale_price_paisa)}</strong></> : null}</>
                ) : null}
                {l.calculation && l.to.mode === "manual" && l.calculation.price_paisa !== null ? <span className="text-muted"> (score would give {rupees(l.calculation.price_paisa)}; manual price kept)</span> : null}
              </p>
            ) : null}
            {l.campaign ? (
              <p className="text-xs">
                In the running sale “{l.campaign.name}” ({formatBp(l.campaign.discount_bp)}): badge {l.badge_from ?? "none"}{l.badge_from !== l.badge_to ? ` → ${l.badge_to ?? "none (no supported reference)"}` : ""}
                {l.proposed?.sale?.rounding_paisa ? `; the price ending adds ${rupees(l.proposed.sale.rounding_paisa)} off` : ""}
              </p>
            ) : null}
            <Margin e={l.economics} />
          </li>
        );
      })}
    </ul>
  );
}

function PlanSummary({ plan }: { plan: Plan }) {
  const s = plan.summary;
  return (
    <p className="text-sm">
      <strong>{s.apply}</strong> to apply ({s.price_changes} price change{s.price_changes === 1 ? "" : "s"}), {s.unchanged} unchanged,{" "}
      <span className={s.skip ? "font-semibold text-danger" : ""}>{s.skip} not changed (see why)</span>.
    </p>
  );
}

/** A confirmation form for a previewed plan: sends exactly what was previewed, with its token. */
function ConfirmPlan({ plan, payloadName, payload, action, label, storageKey, onStale }: {
  plan: Plan; payloadName: string; payload: unknown; action: typeof applyProductPricingAction; label: string; storageKey: string; onStale: (plan: Plan) => void;
}) {
  const r = useRequestAction(action, {
    label, storageKey,
    onDone: (result) => {
      const s = asState(result);
      if (!s.ok && s.data) onStale(s.data as Plan);
    },
  });
  return (
    <form onSubmit={r.onSubmit} className="space-y-2">
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name={payloadName} value={JSON.stringify(payload)} />
      <input type="hidden" name="token" value={plan.token} />
      <SubmitButton r={r} label={label} busy="Applying…" className="btn btn-forest h-11 w-full sm:w-auto" disabled={plan.summary.apply === 0 || (r.state.ok && r.state.done === true)} />
      <Message state={asState(r.state)} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Settings and groups
// ---------------------------------------------------------------------------

export function SettingsForm({ settings }: { settings: PricingSettings }) {
  const r = useRequestAction(saveSettingsAction, { label: "Save pricing settings", storageKey: "pricing-settings" });
  const pct = (bp: number | null) => (bp === null ? "" : String(bp / 100));
  return (
    <form onSubmit={r.onSubmit} className="space-y-4">
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name="version" value={settings.version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          Price ending (rupees)
          <input name="ending" inputMode="numeric" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={settings.price_ending_rupees} required />
          <span className={HINT}>95 turns Rs. 2,000 into Rs. 1,995. Never rounds up.</span>
        </label>
        <label className={LABEL}>
          Minimum profit per item (Rs., optional)
          <input name="minProfit" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={settings.min_profit_paisa === null ? "" : settings.min_profit_paisa / 100} />
          <span className={HINT}>After the worst referral discount and commission, and the recorded cost.</span>
        </label>
        <label className={LABEL}>
          Minimum margin (%, optional)
          <input name="minMargin" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={pct(settings.min_margin_bp)} />
          <span className={HINT}>Kept after costs ÷ what the customer pays.</span>
        </label>
        <label className={LABEL}>
          Minimum days at a price before it can be a “was” price (optional)
          <input name="minDays" inputMode="numeric" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={settings.reference_min_days ?? ""} />
          <span className={HINT}>Your own policy; no legal minimum is assumed. Empty: any recorded offer counts.</span>
        </label>
        {settings.price_spread_bp !== undefined ? (
          <label className={LABEL}>
            Price spread (%, 0 to 5)
            <input name="spread" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={pct(settings.price_spread_bp)} placeholder="0" />
            <span className={HINT}>
              So shoes in a group don’t all cost the same: each one’s automatic price is its own fixed amount, up to this much, below
              its score price (then the price ending). It never goes above the group maximum. 0 turns it off.
            </span>
          </label>
        ) : (
          <p className={`${HINT} sm:col-span-2`}>
            Price spread needs the database update <code className="font-mono">supabase/migrations/20261125120000_price_spread.sql</code>.
          </p>
        )}
        <label className={LABEL}>
          New shoes on sale: target (%)
          <input name="newTarget" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={pct(settings.new_sale_target_bp)} required />
        </label>
        <label className={LABEL}>
          Pre-loved on sale: target (%)
          <input name="prelovedTarget" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={pct(settings.preloved_sale_target_bp)} required />
        </label>
      </div>
      <SubmitButton r={r} label="Save settings" busy="Saving…" className="btn btn-forest h-11" />
      <Message state={asState(r.state)} />
    </form>
  );
}

export function CreateGroupForm() {
  const r = useRequestAction(createGroupAction, { label: "Create group", storageKey: "pricing-create-group", resetOnDone: true });
  return (
    <form onSubmit={r.onSubmit} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
      <input type="hidden" name="requestId" value={r.requestId} />
      <label className={LABEL}>
        New group name
        <input name="name" className={`${INPUT} mt-1 h-11 font-normal`} required minLength={2} maxLength={60} placeholder="e.g. Men’s sneakers" />
      </label>
      <label className={LABEL}>
        Maximum (Rs.)
        <input name="max" inputMode="numeric" className={`${INPUT} mt-1 h-11 font-normal`} required placeholder="5000" />
      </label>
      <SubmitButton r={r} label="Create" busy="Creating…" className="btn btn-outline h-11" />
      <div className="sm:col-span-3"><Message state={asState(r.state)} /></div>
    </form>
  );
}

/** Change one or more groups' maximums together (or by a percentage), preview, then confirm. */
export function GroupMaxEditor({ groups, outOfDate }: { groups: PricingGroup[]; outOfDate: number }) {
  const [maxes, setMaxes] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((g) => [g.id, String(g.max_price_paisa / 100)])));
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [percent, setPercent] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ group_id: string; max_price_paisa: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const adjust = () => {
    const p = Number(percent);
    if (!Number.isFinite(p) || p <= -90 || p > 500) return setError("Enter a percentage such as 10 or -5.");
    setError(null);
    setMaxes((m) => {
      const next = { ...m };
      for (const g of groups) if (chosen.has(g.id)) next[g.id] = String(Math.floor((g.max_price_paisa * (100 + p)) / 100 / 100));
      return next;
    });
  };
  const runPreview = (all: boolean) => {
    const list = all ? [] : groups
      .map((g) => ({ group_id: g.id, max_price_paisa: Math.round(Number(maxes[g.id]) * 100) }))
      .filter((c, i) => c.max_price_paisa !== groups[i].max_price_paisa);
    if (!all && list.length === 0) return setError("Change at least one maximum first.");
    if (list.some((c) => !Number.isInteger(c.max_price_paisa / 100) || c.max_price_paisa < 10000)) return setError("Maximums are whole rupees, at least Rs. 100.");
    setError(null);
    start(async () => {
      const answer = await previewReprice(list);
      if (answer.ok) {
        setPlan(answer.plan);
        setNotice(null);
        setChanges(list);
      } else setError(answer.message);
    });
  };

  return (
    <div className="space-y-4">
      {groups.length === 0 ? <p className="text-sm text-muted">No groups yet.</p> : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {groups.map((g) => (
            <li key={g.id} className="grid gap-2 p-3 sm:grid-cols-[auto_1fr_10rem] sm:items-center">
              <input type="checkbox" aria-label={`Select ${g.name}`} checked={chosen.has(g.id)} className="h-5 w-5"
                onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(g.id); else n.delete(g.id); return n; })} />
              <div>
                <p className="font-semibold">{g.name}</p>
                <p className="text-xs text-muted">Now {rupees(g.max_price_paisa)} · {g.auto} automatic, {g.manual} manual</p>
              </div>
              <label className="text-xs font-semibold">
                New maximum (Rs.)
                <input inputMode="numeric" className={`${INPUT} mt-1 h-10 font-normal`} value={maxes[g.id] ?? ""}
                  onChange={(e) => setMaxes((m) => ({ ...m, [g.id]: e.target.value }))} />
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-semibold">
          Adjust selected by (%)
          <input inputMode="decimal" className={`${INPUT} mt-1 h-10 w-28 font-normal`} value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10 or -5" />
        </label>
        <button type="button" className="btn btn-outline h-10" onClick={adjust} disabled={chosen.size === 0}>Apply to selected</button>
        <button type="button" className="btn btn-forest h-10" onClick={() => runPreview(false)} disabled={pending}>{pending ? "Working…" : "Preview new maximums"}</button>
        <button type="button" className="btn btn-outline h-10" onClick={() => runPreview(true)} disabled={pending}>
          Review out-of-date automatic prices{outOfDate ? ` (${outOfDate})` : ""}
        </button>
      </div>
      {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
      {plan ? (
        <section aria-label="Repricing preview" className="space-y-3 rounded-md border-2 border-forest/40 p-3">
          <h3 className="font-bold">Preview</h3>
          {plan.groups?.length ? <p className="text-sm">{plan.groups.map((g) => `${g.name}: ${rupees(g.max_from)} → ${rupees(g.max_to)}`).join(" · ")}</p> : null}
          <Notice text={notice} />
          <PlanSummary plan={plan} />
          <p className="text-xs text-muted">Manual prices are never changed. Running sales follow the new regular prices; their “was” prices can only go down.</p>
          <PlanLines lines={plan.lines.filter((l) => l.action !== "unchanged")} />
          <ConfirmPlan key={plan.token} plan={plan} payloadName="changes" payload={changes} action={applyRepriceAction} label="Confirm and reprice" storageKey="pricing-reprice" onStale={(p) => { setPlan(p); setNotice(STALE_NOTICE); }} />
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk set-up
// ---------------------------------------------------------------------------

export function BulkPricingTable({ products, groups, settings }: { products: PricingProduct[]; groups: PricingGroup[]; settings: PricingSettings }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? "");
  const [score, setScore] = useState<number | null>(50);
  const [cost, setCost] = useState("");
  const [setCostToo, setSetCostToo] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const group = groups.find((g) => g.id === groupId) ?? null;

  const toggle = (id: string, on: boolean) => setChosen((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const runPreview = () => {
    const costPaisa = setCostToo ? (cost.trim() === "" ? null : Math.round(Number(cost.replace(/,/g, "")) * 100)) : undefined;
    if (costPaisa !== undefined && costPaisa !== null && (!Number.isInteger(costPaisa) || costPaisa < 0)) return setError("Enter the cost in rupees, or leave it empty for “unknown”.");
    if (chosen.size === 0) return setError("Select products first.");
    if (mode === "auto" && (!group || score === null)) return setError("Choose a group and a score.");
    setError(null);
    const list = products.filter((p) => chosen.has(p.product_id)).map((p) => ({
      product_id: p.product_id, mode, group_id: groupId || null, score,
      cost_paisa: costPaisa === undefined ? p.cost_paisa : costPaisa, giveaway: false,
    }));
    start(async () => {
      const answer = await previewProductPricing(list);
      if (answer.ok) {
        setPlan(answer.plan);
        setNotice(null);
        setItems(list);
      } else setError(answer.message);
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-md border border-line bg-cream/50 p-3">
        <p className="text-sm font-semibold">For the {chosen.size} selected product(s):</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} /> Automatic price from score</label>
          <label className="flex items-center gap-2"><input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} /> Manual price (kept as it is)</label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL}>
            Pricing group
            <select className={`${INPUT} mt-1 h-11 font-normal`} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">No group</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name} (max {rupees(g.max_price_paisa)})</option>)}
            </select>
          </label>
          <div>
            <label htmlFor="bulk-score" className={LABEL}>Score (0-100)</label>
            <ScoreInput id="bulk-score" value={score} onChange={setScore} />
            <p id="bulk-score-hint" className={HINT}>The shoe’s relative value. Discounts are set separately in Sales.</p>
          </div>
        </div>
        {mode === "auto" ? <PriceEstimate maxPaisa={group?.max_price_paisa ?? null} score={score} ending={settings.price_ending_rupees} spreadBp={settings.price_spread_bp ?? 0} /> : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={setCostToo} onChange={(e) => setSetCostToo(e.target.checked)} /> Also set the cost</label>
          {setCostToo ? (
            <label className="text-xs font-semibold">
              Cost per item (Rs.; empty = unknown)
              <input inputMode="decimal" className={`${INPUT} mt-1 h-10 w-36 font-normal`} value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
          ) : null}
        </div>
        <button type="button" className="btn btn-forest h-11 w-full sm:w-auto" onClick={runPreview} disabled={pending}>{pending ? "Working…" : "Preview"}</button>
        {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
      </div>

      {plan ? (
        <section aria-label="Pricing preview" className="space-y-3 rounded-md border-2 border-forest/40 p-3">
          <h3 className="font-bold">Preview</h3>
          <Notice text={notice} />
          <PlanSummary plan={plan} />
          <PlanLines lines={plan.lines} />
          <ConfirmPlan key={plan.token} plan={plan} payloadName="items" payload={items} action={applyProductPricingAction} label="Confirm and apply" storageKey="pricing-bulk" onStale={(p) => { setPlan(p); setNotice(STALE_NOTICE); }} />
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2 text-sm">
        <button type="button" className="btn btn-outline h-9" onClick={() => setChosen(new Set(products.map((p) => p.product_id)))}>Select all shown</button>
        <button type="button" className="btn btn-outline h-9" onClick={() => setChosen(new Set(products.filter((p) => p.mode === "manual" && p.score === null).map((p) => p.product_id)))}>Select not yet scored</button>
        <button type="button" className="btn btn-outline h-9" onClick={() => setChosen(new Set())}>Clear</button>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {products.map((p) => (
          <li key={p.product_id}>
            <label className="flex items-start gap-3 p-3">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={chosen.has(p.product_id)} onChange={(e) => toggle(p.product_id, e.target.checked)} />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-semibold"><span className="font-mono text-xs">{p.item_code}</span> {p.name}</span>
                <span className="block text-xs text-muted">
                  {p.brand} · {p.item_status === "new" ? "New" : "Pre-loved"} · {p.publication_status} · stock {p.stock}
                  {p.campaign ? ` · in sale “${p.campaign.name}”` : ""}
                </span>
                <span className="block">
                  {rupees(p.price_paisa)}{p.sale_price_paisa !== null ? ` (sale ${rupees(p.sale_price_paisa)})` : ""} ·{" "}
                  {p.mode === "auto" ? `automatic: ${p.group_name}, score ${p.score}` : p.score !== null ? `manual (score ${p.score})` : "manual, not scored"}
                  {" · "}cost {p.cost_paisa === null ? <span className="text-danger">unknown</span> : rupees(p.cost_paisa)}
                </span>
                {p.mode === "auto" && p.calculation?.price_paisa !== undefined && p.calculation?.price_paisa !== p.price_paisa ? (
                  <span className="block text-xs font-semibold text-danger">Out of date: the score gives {rupees(p.calculation?.price_paisa)}. Review out-of-date prices above.</span>
                ) : null}
              </span>
              <Link href={`/admin/products/${p.product_id}`} className="shrink-0 text-xs font-semibold text-forest link-underline">Open</Link>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One product (on its edit page)
// ---------------------------------------------------------------------------

export function ProductPricingPanel({ pricing }: { pricing: import("@/lib/admin/pricing").ProductPricing }) {
  const [mode, setMode] = useState(pricing.mode);
  const [groupId, setGroupId] = useState(pricing.group_id ?? "");
  const [score, setScore] = useState<number | null>(pricing.score);
  const [cost, setCost] = useState(pricing.cost_paisa === null ? "" : String(pricing.cost_paisa / 100));
  const [giveaway, setGiveaway] = useState(pricing.giveaway);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const group = pricing.groups.find((g) => g.id === groupId) ?? null;

  const runPreview = () => {
    const costPaisa = cost.trim() === "" ? null : Math.round(Number(cost.replace(/,/g, "")) * 100);
    if (costPaisa !== null && (!Number.isInteger(costPaisa) || costPaisa < 0)) return setError("Enter the cost in rupees, or leave it empty for “unknown”.");
    setError(null);
    const list = [{ product_id: pricing.product_id, mode, group_id: groupId || null, score, cost_paisa: costPaisa, giveaway: giveaway && mode === "auto" && score === 0 }];
    start(async () => {
      const answer = await previewProductPricing(list);
      if (answer.ok) {
        setPlan(answer.plan);
        setNotice(null);
        setItems(list);
      } else setError(answer.message);
    });
  };

  return (
    <section aria-labelledby="pricing-heading" className="space-y-4 rounded-lg border border-line p-4">
      <h2 id="pricing-heading" className="text-lg font-bold">Pricing</h2>
      <p className="text-sm">
        Now {rupees(pricing.price_paisa)}{pricing.sale_price_paisa !== null ? `, on sale at ${rupees(pricing.sale_price_paisa)}` : ""}.{" "}
        {pricing.campaign ? <>In the running sale “{pricing.campaign.name}”: change its prices there or here (a new regular price recalculates the sale price).</> : null}
      </p>
      {pricing.sale_price_paisa !== null ? (
        <p className="text-xs text-muted">
          {pricing.reference?.reference_price_paisa
            ? `Shoppers see “was ${rupees(pricing.reference.reference_price_paisa)}” (offered at that price since ${new Date(pricing.reference.offered_since!).toLocaleDateString("en-PK")}).`
            : `No “was” price or badge: ${REFERENCE_REASONS[pricing.reference?.unsupported_reason ?? "not_offered_at_price"] ?? "no supported reference"}.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} /> Automatic from score</label>
        <label className="flex items-center gap-2"><input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} /> Manual price</label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Pricing group
          <select className={`${INPUT} mt-1 h-11 font-normal`} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">No group</option>
            {pricing.groups.map((g) => <option key={g.id} value={g.id}>{g.name} (max {rupees(g.max_price_paisa)})</option>)}
          </select>
        </label>
        <div>
          <label htmlFor="product-score" className={LABEL}>Score (0-100)</label>
          <ScoreInput id="product-score" value={score} onChange={setScore} />
          <p id="product-score-hint" className={HINT}>Relative value; a sale’s discount doesn’t change it.</p>
        </div>
        <label className={LABEL}>
          Cost per item (Rs., optional)
          <input inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Unknown" />
        </label>
      </div>
      <PriceEstimate maxPaisa={group?.max_price_paisa ?? null} score={score} ending={pricing.settings.price_ending_rupees} giveaway={giveaway && score === 0}
        spreadBp={pricing.settings.price_spread_bp ?? 0} productId={pricing.product_id} />
      {mode === "auto" && score === 0 ? (
        <label className="flex items-start gap-2 rounded-md border border-danger/40 p-2 text-sm">
          <input type="checkbox" checked={giveaway} className="mt-0.5"
            onChange={(e) => {
              if (e.target.checked && !window.confirm("Make this a giveaway at Rs. 0? It can then be published free of charge. This is recorded.")) return;
              setGiveaway(e.target.checked);
            }} />
          Explicit giveaway: Rs. 0 (recorded). Without this, score 0 means “needs pricing”.
        </label>
      ) : null}
      <Margin e={pricing.economics} />
      <button type="button" className="btn btn-forest h-11 w-full sm:w-auto" onClick={runPreview} disabled={pending}>{pending ? "Working…" : "Preview"}</button>
      {error ? <p className="text-sm font-medium text-danger">{error}</p> : null}
      {plan ? (
        <div className="space-y-3">
          <Notice text={notice} />
          <PlanLines lines={plan.lines} />
          <ConfirmPlan key={plan.token} plan={plan} payloadName="items" payload={items} action={applyProductPricingAction} label="Confirm" storageKey={`pricing-product:${pricing.product_id}`} onStale={(p) => { setPlan(p); setNotice(STALE_NOTICE); }} />
        </div>
      ) : null}
      {pricing.history.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">Price history</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {pricing.history.map((h, i) => (
              <li key={i}>
                {new Date(h.created_at).toLocaleString("en-PK", { timeZone: "Asia/Karachi" })}: {rupees(h.regular_price_paisa)}
                {h.sale_price_paisa !== null ? `, sale ${rupees(h.sale_price_paisa)}` : ""}{h.reference_price_paisa !== null ? `, was-price ${rupees(h.reference_price_paisa)}` : ""} · {h.publication_status} · {h.reason.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const PRESETS = [
  { key: "new", label: "New shoes (10–15%)", bp: 1000 },
  { key: "preloved_recent", label: "Recently listed pre-loved (10%)", bp: 1000 },
  { key: "preloved_slow", label: "Slower-selling pre-loved (15–20%)", bp: 1500 },
  { key: "clearance", label: "Clearance (25–30%)", bp: 2500 },
  { key: "custom", label: "Custom", bp: 1000 },
] as const;

const KARACHI = "Asia/Karachi";
/** An ISO time as the value of a datetime-local field, in Pakistan time. */
function localValue(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: KARACHI, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function CampaignFields({ campaign }: { campaign?: Campaign }) {
  const [preset, setPreset] = useState<string>(campaign?.preset ?? "new");
  const [discount, setDiscount] = useState(campaign ? String(campaign.discount_bp / 100) : "10");
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className={LABEL}>
        Preset (editable; not researched optimums)
        <select name="preset" className={`${INPUT} mt-1 h-11 font-normal`} value={preset}
          onChange={(e) => { setPreset(e.target.value); setDiscount(String((PRESETS.find((p) => p.key === e.target.value)?.bp ?? 1000) / 100)); }}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </label>
      <label className={LABEL}>
        Name
        <input name="name" className={`${INPUT} mt-1 h-11 font-normal`} required minLength={2} maxLength={80} defaultValue={campaign?.name ?? ""} placeholder="e.g. Eid new arrivals" />
      </label>
      <label className={LABEL}>
        Discount (%)
        <input name="discount" inputMode="decimal" className={`${INPUT} mt-1 h-11 font-normal`} required value={discount} onChange={(e) => setDiscount(e.target.value)} />
        <span className={HINT}>Prices then end in your price ending, which can add a little extra off (shown in the preview).</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Starts (Pakistan time)
          <input name="startsAt" type="datetime-local" className={`${INPUT} mt-1 h-11 font-normal`} required defaultValue={localValue(campaign?.starts_at ?? new Date().toISOString())} />
        </label>
        <label className={LABEL}>
          Ends (optional)
          <input name="endsAt" type="datetime-local" className={`${INPUT} mt-1 h-11 font-normal`} defaultValue={localValue(campaign?.ends_at ?? null)} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="noReferral" defaultChecked={campaign ? !campaign.referral_allowed : false} className="mt-0.5" />
        No referral-code discounts on this sale’s items (shoppers are told; agents earn nothing on them).
      </label>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="requireReference" defaultChecked={campaign?.require_reference ?? false} className="mt-0.5" />
        Only put products on sale that have a supported “was” price (otherwise they go on sale without a badge).
      </label>
    </div>
  );
}

export function CreateCampaignForm() {
  const router = useRouter();
  const r = useRequestAction(createCampaignAction, {
    label: "Create sale", storageKey: "sale-create",
    onDone: (result) => { const s = asState(result); if (s.campaignId) router.push(`/admin/sales/${s.campaignId}`); },
  });
  return (
    <form onSubmit={r.onSubmit} className="space-y-4">
      <input type="hidden" name="requestId" value={r.requestId} />
      <CampaignFields />
      <SubmitButton r={r} label="Create draft sale" busy="Creating…" className="btn btn-forest h-11" />
      <Message state={asState(r.state)} />
    </form>
  );
}

export function CampaignDetailsForm({ campaign }: { campaign: Campaign }) {
  const r = useRequestAction(updateCampaignAction, { label: "Save sale details", storageKey: `sale-details:${campaign.id}` });
  return (
    <form onSubmit={r.onSubmit} className="space-y-4">
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name="campaignId" value={campaign.id} />
      <input type="hidden" name="version" value={campaign.version} />
      <CampaignFields campaign={campaign} />
      <SubmitButton r={r} label="Save details" busy="Saving…" className="btn btn-outline h-11" />
      <Message state={asState(r.state)} />
    </form>
  );
}

type Choice = "included" | "excluded" | "none";

/** The products of a sale: on sale, kept at the regular price, or not chosen. Stable: nothing rotates. */
export function CampaignSelection({ campaign, candidates, editable }: { campaign: Campaign; candidates: Candidate[]; editable: boolean }) {
  const initial = useMemo(() => Object.fromEntries(candidates.map((c) => [c.product_id, (c.selection ?? "none") as Choice])), [candidates]);
  const [choice, setChoice] = useState<Record<string, Choice>>(initial);
  const [notes, setNotes] = useState<Record<string, string>>(() => Object.fromEntries(candidates.map((c) => [c.product_id, c.note ?? ""])));
  const [overrides, setOverrides] = useState<Record<string, string>>(() => Object.fromEntries(candidates.map((c) => [c.product_id, c.override_reason ?? ""])));
  const [filter, setFilter] = useState<"all" | "new" | "preloved" | "eligible">("eligible");
  const r = useRequestAction(campaignSelectionAction, { label: "Save selection", storageKey: `sale-selection:${campaign.id}` });

  const changes = candidates
    .filter((c) => choice[c.product_id] !== initial[c.product_id] || (notes[c.product_id] ?? "") !== (c.note ?? "") || (overrides[c.product_id] ?? "") !== (c.override_reason ?? ""))
    .map((c) => ({
      product_id: c.product_id, state: choice[c.product_id], note: notes[c.product_id] || null,
      ...((overrides[c.product_id] ?? "") !== (c.override_reason ?? "") ? { override_reason: overrides[c.product_id] || null } : {}),
    }));
  const shown = candidates.filter((c) => filter === "all" || (filter === "eligible" ? c.eligible : c.item_status === filter));
  const setMany = (pred: (c: Candidate) => boolean, to: Choice) => setChoice((s) => { const n = { ...s }; for (const c of candidates) if (pred(c)) n[c.product_id] = to; return n; });
  const groups = [...new Map(candidates.filter((c) => c.group_id).map((c) => [c.group_id!, c.group_name!])).entries()];
  const count = (status: string) => {
    const eligible = candidates.filter((c) => c.eligible && c.item_status === status);
    return `${eligible.filter((c) => choice[c.product_id] === "included").length} of ${eligible.length}`;
  };

  return (
    <form onSubmit={r.onSubmit} className="space-y-3">
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name="campaignId" value={campaign.id} />
      <input type="hidden" name="version" value={campaign.version} />
      <input type="hidden" name="changes" value={JSON.stringify(changes)} />
      <p className="text-sm">Selected (published, in stock): new {count("new")} · pre-loved {count("preloved")}.</p>
      {editable ? (
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" className="btn btn-outline h-9" onClick={() => setMany((c) => c.eligible && c.item_status === "preloved" && choice[c.product_id] === "none", "included")}>All eligible pre-loved</button>
          <button type="button" className="btn btn-outline h-9" onClick={() => setMany((c) => c.eligible && c.item_status === "new" && choice[c.product_id] === "none", "included")}>All eligible new</button>
          {groups.map(([id, name]) => (
            <button key={id} type="button" className="btn btn-outline h-9" onClick={() => setMany((c) => c.group_id === id && c.eligible && choice[c.product_id] === "none", "included")}>Group: {name}</button>
          ))}
          <button type="button" className="btn btn-outline h-9" onClick={() => setChoice(initial)}>Undo changes</button>
        </div>
      ) : <p className="text-sm text-muted">Selection is fixed while the sale is scheduled or over. Unschedule it to change it.</p>}
      <div className="flex flex-wrap gap-3 text-sm">
        {(["eligible", "new", "preloved", "all"] as const).map((f) => (
          <label key={f} className="flex items-center gap-1"><input type="radio" checked={filter === f} onChange={() => setFilter(f)} /> {f === "eligible" ? "Eligible" : f === "new" ? "New" : f === "preloved" ? "Pre-loved" : "All"}</label>
        ))}
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {shown.map((c) => (
          <li key={c.product_id} className="space-y-2 p-3 text-sm">
            <p className="font-semibold"><span className="font-mono text-xs">{c.item_code}</span> {c.name}</p>
            <p className="text-xs text-muted">
              {c.item_status === "new" ? "New" : "Pre-loved"} · {c.publication_status}{c.eligible ? "" : " (not eligible: unpublished or out of stock)"} · stock {c.stock} · {rupees(c.price_paisa)}
              {c.listed_at ? ` · listed ${c.listed_at}` : ""}{c.group_name ? ` · ${c.group_name}` : ""} · cost {c.cost_paisa === null ? "unknown" : rupees(c.cost_paisa)}
              {c.other_campaign ? ` · in sale “${c.other_campaign}”` : c.sale_price_paisa !== null && c.selection === null ? " · has a manual sale price" : ""}
            </p>
            {editable ? (
              <div className="flex flex-wrap gap-3">
                {(["included", "excluded", "none"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1">
                    <input type="radio" name={`choice-${c.product_id}`} checked={choice[c.product_id] === v} onChange={() => setChoice((s) => ({ ...s, [c.product_id]: v }))} />
                    {v === "included" ? "On sale" : v === "excluded" ? "Keep regular price" : "Not chosen"}
                  </label>
                ))}
              </div>
            ) : <p>{choice[c.product_id] === "included" ? "On sale" : choice[c.product_id] === "excluded" ? "Kept at regular price" : "Not chosen"}</p>}
            {editable && choice[c.product_id] !== "none" ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted">Note / margin exception</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-semibold">
                    Note (optional)
                    <input className={`${INPUT} mt-1 h-9 font-normal`} maxLength={200} value={notes[c.product_id] ?? ""} onChange={(e) => setNotes((s) => ({ ...s, [c.product_id]: e.target.value }))} />
                  </label>
                  <label className="text-xs font-semibold">
                    Margin exception: reason (recorded)
                    <input className={`${INPUT} mt-1 h-9 font-normal`} maxLength={300} value={overrides[c.product_id] ?? ""} onChange={(e) => setOverrides((s) => ({ ...s, [c.product_id]: e.target.value }))} placeholder="Only if you accept a margin below the minimum" />
                  </label>
                </div>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <div className="sticky bottom-0 space-y-2 border-t border-line bg-white py-3">
          <SubmitButton r={r} label={`Save selection (${changes.length} change${changes.length === 1 ? "" : "s"})`} busy="Saving…" className="btn btn-forest h-11 w-full sm:w-auto" disabled={changes.length === 0} />
          <Message state={asState(r.state)} />
        </div>
      ) : null}
    </form>
  );
}

function CampaignLines({ lines }: { lines: CampaignLine[] }) {
  const ACTION: Record<CampaignLine["action"], string> = {
    apply: "Goes on sale", skip: "Left out", keep: "On sale", remove: "Comes off sale", kept_regular: "Kept at regular price", planned: "Goes on sale at the start", closed: "—",
  };
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {lines.map((l) => {
        const honest = l.sale_paisa !== null ? displayedDiscount(l.reference_paisa, l.sale_paisa) : null;
        return (
          <li key={l.product_id} className={`space-y-1 p-3 text-sm ${l.action === "skip" ? "bg-danger/5" : ""}`}>
            <p className="font-semibold"><span className="font-mono text-xs">{l.item_code}</span> {l.name} <span className="ml-1 rounded bg-cream px-1.5 py-0.5 text-xs">{ACTION[l.action]}</span></p>
            {l.action === "skip" ? <p className="text-danger">{reason(l.reason)}</p> : null}
            {l.note ? <p className="text-xs text-muted">Note: {l.note}</p> : null}
            {l.override_reason ? <p className="text-xs">Margin exception: {l.override_reason}</p> : null}
            {l.sale_paisa !== null && l.action !== "kept_regular" ? (
              <>
                <p>
                  Regular {rupees(l.regular_paisa)} → sale <strong>{rupees(l.sale_paisa)}</strong>
                  {l.sale?.actual_percent !== null && l.sale?.actual_percent !== undefined ? ` (${l.sale.actual_percent}% off the regular price` : ""}
                  {l.sale?.rounding_paisa ? `, incl. ${rupees(l.sale.rounding_paisa)} extra from the price ending)` : l.sale ? ")" : ""}
                </p>
                <p className="text-xs">
                  {honest
                    ? <>Shoppers see: was {rupees(l.reference_paisa)}, save {rupees(honest.savingsPaisa)} ({honest.percent}% off).</>
                    : <span className="text-danger">No “was” price or badge: {REFERENCE_REASONS[l.reference?.reason ?? "not_offered_at_price"] ?? "no supported reference"}. Shoppers see the selling price only.</span>}
                </p>
              </>
            ) : null}
            <Margin e={l.economics} />
          </li>
        );
      })}
    </ul>
  );
}

/** The sale's preview and its confirmation (activate, schedule, or apply changes). */
export function CampaignApply({ plan }: { plan: CampaignPlan }) {
  const [stale, setStale] = useState<{ basedOn: string; plan: CampaignPlan } | null>(null);
  const current = stale && stale.basedOn === plan.token ? stale.plan : plan;
  const c = current.campaign;
  const r = useRequestAction(applyCampaignAction, {
    label: "Apply sale", storageKey: `sale-apply:${c.id}`,
    onDone: (result) => { const s = asState(result); if (!s.ok && s.data) setStale({ basedOn: plan.token, plan: s.data as CampaignPlan }); },
  });
  const s = current.summary;
  const startsLater = c.starts_in_future;
  const label = c.status === "draft" ? (startsLater ? "Confirm and schedule" : "Confirm and start the sale now") : "Confirm changes";
  const changes = c.status === "draft" ? s.apply : s.apply + s.remove;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {c.status === "draft" ? <><strong>{s.apply}</strong> go on sale</> : <><strong>{s.keep}</strong> on sale, <strong>{s.apply}</strong> to add, <strong>{s.remove}</strong> to take off</>}
        , <span className={s.skip ? "font-semibold text-danger" : ""}>{s.skip} left out (see why)</span>, {s.kept_regular} kept at the regular price.
        {s.no_badge ? ` ${s.no_badge} will show no “was” price.` : ""}
        {s.rounding_paisa ? ` The price ending adds ${rupees(s.rounding_paisa)} of extra discount in total.` : ""}
      </p>
      {current.overlaps.length > 0 ? (
        <p className="rounded-md border border-danger p-2 text-sm text-danger">
          Overlaps with {current.overlaps.map((o) => `“${o.name}” (${o.status})`).join(", ")}. Only one sale runs at a time: end, cancel or reschedule one first.
        </p>
      ) : null}
      <CampaignLines lines={current.lines} />
      {c.status === "draft" || c.status === "active" ? (
        <form onSubmit={(e) => { if (!window.confirm(`${label}? ${changes} product price(s) will change.`)) { e.preventDefault(); return; } r.onSubmit(e); }} className="space-y-2">
          <input type="hidden" name="requestId" value={r.requestId} />
          <input type="hidden" name="campaignId" value={c.id} />
          <input type="hidden" name="version" value={c.version} />
          <input type="hidden" name="token" value={current.token} />
          <SubmitButton r={r} label={label} busy="Applying…" className="btn btn-forest h-11 w-full sm:w-auto" disabled={changes === 0} />
          <Message state={asState(r.state)} />
        </form>
      ) : null}
    </div>
  );
}

/**
 * End, cancel or unschedule. Stays mounted when the sale's status no longer
 * allows it (`available` false), so its result stays on screen after the
 * page refreshes; an unconfirmed request is still offered for retry.
 */
export function CampaignEndForm({ campaign, action, label, confirmText, tone = "outline", available }: { campaign: Campaign; action: "end" | "cancel" | "unschedule"; label: string; confirmText: string; tone?: "outline" | "danger"; available: boolean }) {
  const r = useRequestAction(endCampaignAction, { label, storageKey: `sale-${action}:${campaign.id}` });
  if (!available && !r.unconfirmed) return <Message state={asState(r.state)} />;
  return (
    <form onSubmit={(e) => { if (!window.confirm(confirmText)) { e.preventDefault(); return; } r.onSubmit(e); }} className="space-y-2">
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name="campaignId" value={campaign.id} />
      <input type="hidden" name="version" value={campaign.version} />
      <input type="hidden" name="action" value={action} />
      <SubmitButton r={r} label={label} busy="Working…" className={`btn ${tone === "danger" ? "btn-outline text-danger" : "btn-outline"} h-11`} />
      <Message state={asState(r.state)} />
    </form>
  );
}

export function RunScheduleForm() {
  const r = useRequestAction(runScheduleAction, { label: "Run due changes now", storageKey: "sale-run-schedule" });
  return (
    <form onSubmit={r.onSubmit} className="space-y-2">
      <input type="hidden" name="requestId" value={r.requestId} />
      <SubmitButton r={r} label="Run due starts and ends now" busy="Running…" className="btn btn-outline h-10" />
      <Message state={asState(r.state)} />
    </form>
  );
}
