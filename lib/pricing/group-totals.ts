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
  /** Cheapest and dearest pair in stock, at the price customers pay now. */
  lowestPaisa: number | null;
  highestPaisa: number | null;
  /** Pairs with a known cost, and their cost and value. */
  costedPairs: number;
  costPaisa: number;
  costedTotalPaisa: number;
  /** Cheapest and dearest cost among pairs with one (the same when the group shares one cost). */
  lowestCostPaisa: number | null;
  highestCostPaisa: number | null;
  /** Value of the costed pairs minus their cost; null when no pair has a cost. */
  afterCostPaisa: number | null;
};

export function groupTotals(items: GroupTotalsInput[]): GroupTotals {
  const t: GroupTotals = {
    listings: items.length, pairs: 0, drafts: 0, soldOut: 0, totalPaisa: 0, regularTotalPaisa: 0,
    averagePaisa: null, lowestPaisa: null, highestPaisa: null, costedPairs: 0, costPaisa: 0, costedTotalPaisa: 0,
    lowestCostPaisa: null, highestCostPaisa: null, afterCostPaisa: null,
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
    t.lowestPaisa = t.lowestPaisa === null ? pays : Math.min(t.lowestPaisa, pays);
    t.highestPaisa = t.highestPaisa === null ? pays : Math.max(t.highestPaisa, pays);
    if (item.cost_paisa !== null) {
      t.costedPairs += pairs;
      t.costPaisa += item.cost_paisa * pairs;
      t.costedTotalPaisa += pays * pairs;
      t.lowestCostPaisa = t.lowestCostPaisa === null ? item.cost_paisa : Math.min(t.lowestCostPaisa, item.cost_paisa);
      t.highestCostPaisa = t.highestCostPaisa === null ? item.cost_paisa : Math.max(t.highestCostPaisa, item.cost_paisa);
    }
  }
  if (t.pairs > 0) t.averagePaisa = Math.round(t.totalPaisa / t.pairs);
  if (t.costedPairs > 0) t.afterCostPaisa = t.costedTotalPaisa - t.costPaisa;
  return t;
}

/** What the owner enters for a group: per-pair extras and the agent's rates (basis points: 1000 = 10%). */
export type ProfitInputs = {
  packagingPaisa: number;
  shippingPaisa: number;
  discountBp: number;
  commissionBp: number;
};

export type GroupProfit = {
  pairs: number;
  /** What customers pay now for every pair in stock, before any agent code. */
  salesPaisa: number;
  /** The shoes' own cost (pairs with a cost only). */
  shoeCostPaisa: number;
  packagingPaisa: number;
  shippingPaisa: number;
  /** Shoes + packaging + shipping. */
  totalCostPaisa: number;
  /** The agent code's discount off each pair's price. */
  discountPaisa: number;
  /** The agent's commission on what's paid after the discount. */
  commissionPaisa: number;
  /** Sales − total cost − discount − commission. */
  profitPaisa: number;
  /** Pairs whose own cost isn't known: left out of the shoe cost, so the profit is too high by their cost. */
  uncostedPairs: number;
};

/**
 * If every pair in stock sold through an agent's code: the price each pair
 * sells at now (sale price where there is one), less the code's discount; the
 * agent earns the commission on what the customer then pays. Rounded per pair.
 */
export function groupProfit(items: GroupTotalsInput[], inputs: ProfitInputs): GroupProfit {
  const p: GroupProfit = {
    pairs: 0, salesPaisa: 0, shoeCostPaisa: 0, packagingPaisa: 0, shippingPaisa: 0, totalCostPaisa: 0,
    discountPaisa: 0, commissionPaisa: 0, profitPaisa: 0, uncostedPairs: 0,
  };
  for (const item of items) {
    const pairs = Math.max(0, item.stock);
    if (pairs === 0) continue;
    const pays = item.sale_price_paisa ?? item.price_paisa;
    const discount = Math.round((pays * inputs.discountBp) / 10000);
    const commission = Math.round(((pays - discount) * inputs.commissionBp) / 10000);
    p.pairs += pairs;
    p.salesPaisa += pays * pairs;
    p.discountPaisa += discount * pairs;
    p.commissionPaisa += commission * pairs;
    if (item.cost_paisa === null) p.uncostedPairs += pairs;
    else p.shoeCostPaisa += item.cost_paisa * pairs;
  }
  p.packagingPaisa = inputs.packagingPaisa * p.pairs;
  p.shippingPaisa = inputs.shippingPaisa * p.pairs;
  p.totalCostPaisa = p.shoeCostPaisa + p.packagingPaisa + p.shippingPaisa;
  p.profitPaisa = p.salesPaisa - p.totalCostPaisa - p.discountPaisa - p.commissionPaisa;
  return p;
}
