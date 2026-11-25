import { describe, expect, it } from "vitest";
import { groupProfit, groupTotals, type GroupTotalsInput } from "./group-totals";

const item = (o: Partial<GroupTotalsInput>): GroupTotalsInput => ({
  stock: 1, price_paisa: 400000, sale_price_paisa: null, cost_paisa: null, publication_status: "published", ...o,
});

describe("groupTotals", () => {
  it("totals what customers pay now, per pair in stock, with the average and the regular-price total", () => {
    const t = groupTotals([
      item({ price_paisa: 400000, sale_price_paisa: 260000 }),
      item({ price_paisa: 300000, stock: 2 }),
      item({ price_paisa: 500000, stock: 0 }),
    ]);
    expect(t).toMatchObject({ listings: 3, pairs: 3, soldOut: 1, totalPaisa: 860000, regularTotalPaisa: 1000000, averagePaisa: 286667 });
    // Lowest and highest at the price paid now; the sold-out pair doesn't count.
    expect(t).toMatchObject({ lowestPaisa: 260000, highestPaisa: 300000 });
  });

  it("subtracts cost only for pairs with a known cost, and says how many that is", () => {
    const t = groupTotals([
      item({ price_paisa: 400000, sale_price_paisa: 260000, cost_paisa: 150000 }),
      item({ price_paisa: 300000, cost_paisa: 100000, stock: 2 }),
      item({ price_paisa: 350000 }),
    ]);
    expect(t).toMatchObject({ pairs: 4, costedPairs: 3, costPaisa: 350000, costedTotalPaisa: 860000, afterCostPaisa: 510000 });
    expect(t).toMatchObject({ lowestCostPaisa: 100000, highestCostPaisa: 150000 });
  });

  it("has no average or after-cost figure without pairs or costs, and counts drafts", () => {
    const t = groupTotals([item({ stock: 0, publication_status: "draft" }), item({ publication_status: "draft" })]);
    expect(t).toMatchObject({ drafts: 2, pairs: 1, afterCostPaisa: null });
    expect(groupTotals([]).averagePaisa).toBeNull();
  });
});

describe("groupProfit", () => {
  const inputs = { packagingPaisa: 5000, shippingPaisa: 20000, discountBp: 1000, commissionBp: 500 };

  it("takes cost, packaging, shipping, the agent's discount and commission off what every pair sells for", () => {
    const p = groupProfit(
      [
        item({ price_paisa: 400000, sale_price_paisa: 300000, cost_paisa: 100000 }), // sells at Rs. 3,000
        item({ price_paisa: 200000, cost_paisa: 100000, stock: 2 }),
        item({ price_paisa: 900000, stock: 0, cost_paisa: 100000 }), // sold out: nothing
      ],
      inputs,
    );
    // Sales 3,000 + 2 × 2,000 = 7,000. Discount 10%: 300 + 2 × 200 = 700.
    // Commission 5% of what's paid after it: 135 + 2 × 90 = 315.
    // Cost 3 × 1,000 + packaging 3 × 50 + shipping 3 × 200 = 3,750. Profit 7,000 − 3,750 − 700 − 315 = 2,235.
    expect(p).toEqual({
      pairs: 3, salesPaisa: 700000, shoeCostPaisa: 300000, packagingPaisa: 15000, shippingPaisa: 60000,
      totalCostPaisa: 375000, discountPaisa: 70000, commissionPaisa: 31500, profitPaisa: 223500, uncostedPairs: 0,
    });
  });

  it("counts pairs without a cost, whose shoe cost is left out", () => {
    const p = groupProfit([item({ price_paisa: 300000 }), item({ price_paisa: 300000, cost_paisa: 100000 })], {
      packagingPaisa: 0, shippingPaisa: 0, discountBp: 0, commissionBp: 0,
    });
    expect(p).toMatchObject({ pairs: 2, shoeCostPaisa: 100000, profitPaisa: 500000, uncostedPairs: 1 });
  });
});
