/*
 * Money totals for a pricing group (admin only: uses costs). Counts every
 * pair in stock (a listing with stock 2 counts twice) of the group's
 * non-archived products, drafts included. Sold-out listings add nothing.
 */

export type GroupTotalsInput = {
  stock: number;
  price_paisa: number;
  sale_price_paisa: number | null;
  cost_paisa: number | null;
  publication_status: string;
};

export type GroupTotals = {
  listings: number;
  /** Pairs in stock. */
  pairs: number;
  drafts: number;
  soldOut: number;
  /** At the prices customers pay now (sale price where there is one). */
  totalPaisa: number;
  /** At the regular prices (no sales). */
  regularTotalPaisa: number;
  averagePaisa: number | null;
  /** Pairs with a known cost, and their cost and value. */
  costedPairs: number;
  costPaisa: number;
  costedTotalPaisa: number;
  /** Value of the costed pairs minus their cost; null when no pair has a cost. */
  afterCostPaisa: number | null;
};

export function groupTotals(items: GroupTotalsInput[]): GroupTotals {
  const t: GroupTotals = {
    listings: items.length, pairs: 0, drafts: 0, soldOut: 0, totalPaisa: 0, regularTotalPaisa: 0,
    averagePaisa: null, costedPairs: 0, costPaisa: 0, costedTotalPaisa: 0, afterCostPaisa: null,
  };
  for (const item of items) {
    if (item.publication_status === "draft") t.drafts += 1;
    const pairs = Math.max(0, item.stock);
    if (pairs === 0) {
      t.soldOut += 1;
      continue;
    }
    const pays = item.sale_price_paisa ?? item.price_paisa;
    t.pairs += pairs;
    t.totalPaisa += pays * pairs;
    t.regularTotalPaisa += item.price_paisa * pairs;
    if (item.cost_paisa !== null) {
      t.costedPairs += pairs;
      t.costPaisa += item.cost_paisa * pairs;
      t.costedTotalPaisa += pays * pairs;
    }
  }
  if (t.pairs > 0) t.averagePaisa = Math.round(t.totalPaisa / t.pairs);
  if (t.costedPairs > 0) t.afterCostPaisa = t.costedTotalPaisa - t.costPaisa;
  return t;
}
