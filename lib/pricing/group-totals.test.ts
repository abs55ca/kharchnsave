import { describe, expect, it } from "vitest";
import { groupTotals, type GroupTotalsInput } from "./group-totals";

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
  });

  it("subtracts cost only for pairs with a known cost, and says how many that is", () => {
    const t = groupTotals([
      item({ price_paisa: 400000, sale_price_paisa: 260000, cost_paisa: 150000 }),
      item({ price_paisa: 300000, cost_paisa: 100000, stock: 2 }),
      item({ price_paisa: 350000 }),
    ]);
    expect(t).toMatchObject({ pairs: 4, costedPairs: 3, costPaisa: 350000, costedTotalPaisa: 860000, afterCostPaisa: 510000 });
  });

  it("has no average or after-cost figure without pairs or costs, and counts drafts", () => {
    const t = groupTotals([item({ stock: 0, publication_status: "draft" }), item({ publication_status: "draft" })]);
    expect(t).toMatchObject({ drafts: 2, pairs: 1, afterCostPaisa: null });
    expect(groupTotals([]).averagePaisa).toBeNull();
  });
});
