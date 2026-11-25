"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";
import { groupProfit, groupTotals, type GroupTotalsInput } from "@/lib/pricing/group-totals";

/*
 * Group totals (Pricing page, admin only): what each group's pairs in stock
 * sell for, what they cost (shoes, packaging, shipping), what an agent's code
 * and commission take, and the profit left. Packaging, shipping and the
 * agent's rates are planning figures: kept in this browser only, never saved
 * to the shop or used for prices.
 */

export type GroupTotalsRow = { id: string; name: string; items: GroupTotalsInput[] | null };

type Saved = { discount: string; commission: string; groups: Record<string, { packaging: string; shipping: string }> };

const STORAGE_KEY = "kns-admin-group-totals";
const money = (paisa: number) => formatPrice(paisa / 100);
const INPUT = "h-9 w-full rounded-md border border-line bg-white px-2 text-sm font-normal focus:border-forest focus:outline-none aria-[invalid=true]:border-danger";

/** Rupees typed in a box, as paisa; null when it isn't a number of rupees 0 or more. Empty counts as 0. */
function rupeesToPaisa(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** A percentage typed in a box, as basis points; null unless 0–100. Empty counts as 0. */
function percentToBp(text: string): number | null {
  const t = text.trim().replace(/%$/, "");
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
}

const bpToText = (bp: number) => (bp ? String(bp / 100) : "");

export function GroupTotalsTable({
  rows,
  defaultDiscountBp,
  defaultCommissionBp,
}: {
  rows: GroupTotalsRow[];
  defaultDiscountBp: number;
  defaultCommissionBp: number;
}) {
  const [saved, setSaved] = useState<Saved>({ discount: bpToText(defaultDiscountBp), commission: bpToText(defaultCommissionBp), groups: {} });
  const [loaded, setLoaded] = useState(false);

  // What was entered last time, on this browser (read after the first render, so it matches the server's).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only storage, read once after hydration
      if (raw) setSaved((s) => ({ ...s, ...(JSON.parse(raw) as Partial<Saved>) }));
    } catch {
      // Storage blocked or unreadable: start from the defaults.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Not saved; the numbers still work for this visit.
    }
  }, [saved, loaded]);

  if (rows.length === 0) return <p className="text-sm text-muted">No groups yet.</p>;

  const discountBp = percentToBp(saved.discount);
  const commissionBp = percentToBp(saved.commission);
  const groupText = (id: string) => saved.groups[id] ?? { packaging: "", shipping: "" };
  const setGroup = (id: string, change: Partial<{ packaging: string; shipping: string }>) =>
    setSaved((s) => ({ ...s, groups: { ...s.groups, [id]: { ...(s.groups[id] ?? { packaging: "", shipping: "" }), ...change } } }));

  const th = "px-3 py-2 text-left align-bottom font-semibold";
  const td = "whitespace-nowrap px-3 py-2 align-top tabular-nums";
  const sticky = "sticky left-0 z-10 bg-white";

  return (
    <div className="space-y-3">
      <div className="grid max-w-md gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold">
          Agent discount (%)
          <input
            inputMode="decimal"
            value={saved.discount}
            onChange={(e) => setSaved((s) => ({ ...s, discount: e.target.value }))}
            aria-invalid={discountBp === null}
            placeholder="0"
            className={`${INPUT} mt-1 h-10`}
          />
          <span className="mt-1 block font-normal text-muted">Off the price, with the agent&apos;s code</span>
        </label>
        <label className="text-xs font-semibold">
          Agent commission (%)
          <input
            inputMode="decimal"
            value={saved.commission}
            onChange={(e) => setSaved((s) => ({ ...s, commission: e.target.value }))}
            aria-invalid={commissionBp === null}
            placeholder="0"
            className={`${INPUT} mt-1 h-10`}
          />
          <span className="mt-1 block font-normal text-muted">Of what the customer pays</span>
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="bg-cream">
            <tr>
              <th scope="col" className={`${th} ${sticky} bg-cream`}>Group</th>
              <th scope="col" className={th}>Pairs</th>
              <th scope="col" className={th}>Cost / pair</th>
              <th scope="col" className={th}>Lowest price</th>
              <th scope="col" className={th}>Avg. price</th>
              <th scope="col" className={th}>Highest price</th>
              <th scope="col" className={th}>Sales</th>
              <th scope="col" className={`${th} w-28`}>Packaging / pair (Rs.)</th>
              <th scope="col" className={`${th} w-28`}>Shipping / pair (Rs.)</th>
              <th scope="col" className={th}>Total cost</th>
              <th scope="col" className={th}>Agent discount</th>
              <th scope="col" className={th}>Agent commission</th>
              <th scope="col" className={th}>Profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => {
              if (!row.items) {
                return (
                  <tr key={row.id}>
                    <th scope="row" className={`${th} ${sticky}`}>{row.name}</th>
                    <td colSpan={12} className={`${td} text-danger`}>Couldn&apos;t be loaded right now.</td>
                  </tr>
                );
              }
              const t = groupTotals(row.items);
              const text = groupText(row.id);
              const packaging = rupeesToPaisa(text.packaging);
              const shipping = rupeesToPaisa(text.shipping);
              const valid = packaging !== null && shipping !== null && discountBp !== null && commissionBp !== null;
              const p = valid
                ? groupProfit(row.items, { packagingPaisa: packaging, shippingPaisa: shipping, discountBp, commissionBp })
                : null;
              const dash = <span className="text-muted">—</span>;
              return (
                <tr key={row.id}>
                  <th scope="row" className={`${th} ${sticky} align-top`}>{row.name}</th>
                  <td className={td}>
                    {t.pairs}
                    <span className="block whitespace-normal text-xs text-muted">
                      {t.listings} shoe(s){t.drafts ? `, ${t.drafts} draft` : ""}{t.soldOut ? `, ${t.soldOut} sold out` : ""}
                    </span>
                  </td>
                  <td className={td}>
                    {t.lowestCostPaisa === null ? (
                      <span className="text-muted">Not set</span>
                    ) : t.lowestCostPaisa === t.highestCostPaisa ? (
                      money(t.lowestCostPaisa)
                    ) : (
                      `${money(t.lowestCostPaisa)} – ${money(t.highestCostPaisa!)}`
                    )}
                    {t.costedPairs > 0 && t.costedPairs < t.pairs ? (
                      <span className="block whitespace-normal text-xs text-danger">{t.pairs - t.costedPairs} pair(s) not set</span>
                    ) : null}
                  </td>
                  <td className={td}>{t.lowestPaisa === null ? dash : money(t.lowestPaisa)}</td>
                  <td className={td}>{t.averagePaisa === null ? dash : money(t.averagePaisa)}</td>
                  <td className={td}>{t.highestPaisa === null ? dash : money(t.highestPaisa)}</td>
                  <td className={td}>
                    {money(t.totalPaisa)}
                    {t.regularTotalPaisa !== t.totalPaisa ? (
                      <span className="block whitespace-normal text-xs text-muted">{money(t.regularTotalPaisa)} without sales</span>
                    ) : null}
                  </td>
                  <td className={td}>
                    <input
                      inputMode="decimal"
                      aria-label={`Packaging per pair for ${row.name} (Rs.)`}
                      value={text.packaging}
                      onChange={(e) => setGroup(row.id, { packaging: e.target.value })}
                      aria-invalid={packaging === null}
                      placeholder="0"
                      className={INPUT}
                    />
                  </td>
                  <td className={td}>
                    <input
                      inputMode="decimal"
                      aria-label={`Shipping per pair for ${row.name} (Rs.)`}
                      value={text.shipping}
                      onChange={(e) => setGroup(row.id, { shipping: e.target.value })}
                      aria-invalid={shipping === null}
                      placeholder="0"
                      className={INPUT}
                    />
                  </td>
                  <td className={td}>{p ? money(p.totalCostPaisa) : dash}</td>
                  <td className={td}>{p ? money(p.discountPaisa) : dash}</td>
                  <td className={td}>{p ? money(p.commissionPaisa) : dash}</td>
                  <td className={td}>
                    {p ? (
                      <strong className={p.profitPaisa < 0 ? "text-danger" : "text-forest"}>{money(p.profitPaisa)}</strong>
                    ) : (
                      <span className="text-xs text-danger">Check the numbers entered</span>
                    )}
                    {p && p.uncostedPairs > 0 ? (
                      <span className="block max-w-40 whitespace-normal text-xs text-danger">
                        Too high: {p.uncostedPairs} pair(s) have no cost yet
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="space-y-0.5 text-xs text-muted">
        <li><strong className="text-ink">Prices</strong> are what customers pay now (the sale price when a pair is on sale).</li>
        <li><strong className="text-ink">Sales</strong>: every pair in stock sold at its price.</li>
        <li><strong className="text-ink">Total cost</strong>: (cost + packaging + shipping) × pairs.</li>
        <li><strong className="text-ink">Agent discount</strong>: the code&apos;s % off each pair&apos;s price. <strong className="text-ink">Agent commission</strong>: the agent&apos;s % of what the customer pays after that discount.</li>
        <li><strong className="text-ink">Profit</strong>: sales − total cost − agent discount − agent commission, as if every pair sold with an agent&apos;s code.</li>
        <li>Packaging, shipping and the agent&apos;s % are kept on this browser only, for working things out. They don&apos;t change any prices.</li>
      </ul>
    </div>
  );
}
