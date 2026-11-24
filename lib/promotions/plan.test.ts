import { describe, expect, it } from "vitest";
import { actualDiscount, dataReliability, formatPercentHundredths, planAssignments, proposedRegular, type Candidate, type DiscountBp } from "./plan";

const TODAY = "2026-11-23";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const products = (n: number, extra: Partial<Candidate> = {}): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ productId: id(i + 1), groupKey: `model ${i + 1}`, listedAt: null, unitsSold: 0, assignedBp: null, ...extra }));
const share = (planned: { discountBp: DiscountBp }[]) => {
  const out: Record<number, number> = { 2000: 0, 2500: 0, 3000: 0, 3500: 0 };
  for (const p of planned) out[p.discountBp]++;
  return out;
};

describe("proposedRegular", () => {
  it("works backwards from the selling price, to the paisa", () => {
    // The example: Rs. 3,795 at 35% → Rs. 5,838.46.
    expect(proposedRegular(379500, 3500)).toBe(583846);
    expect(proposedRegular(179500, 2000)).toBe(224375); // 1795 / 0.8 = 2243.75 exactly
    expect(proposedRegular(299500, 3000)).toBe(427857); // 4278.571… → 4278.57
    expect(proposedRegular(100, 2500)).toBe(133); // 1.333… → 1.33
  });

  it("refuses other percentages and non-paisa amounts", () => {
    expect(() => proposedRegular(379500, 4000)).toThrow();
    expect(() => proposedRegular(3795.5, 3500)).toThrow();
    expect(() => proposedRegular(0, 3500)).toThrow();
  });
});

describe("actualDiscount and formatPercentHundredths", () => {
  const shown = (regular: number, selling: number) => formatPercentHundredths(actualDiscount(regular, selling).percentHundredths);

  it("shows the required examples: full precision, then two decimals (not truncated)", () => {
    // Reference Rs. 5,838.46, selling Rs. 3,795: 2,043.46 ÷ 5,838.46 = 34.99998…%.
    expect(actualDiscount(583846, 379500)).toEqual({ savingPaisa: 204346, percentHundredths: 3500 });
    expect(shown(583846, 379500)).toBe("35.00%");
    // Reference Rs. 4,278.57, selling Rs. 2,995: 1,283.57 ÷ 4,278.57 = 29.99997…%.
    expect(actualDiscount(427857, 299500)).toEqual({ savingPaisa: 128357, percentHundredths: 3000 });
    expect(shown(427857, 299500)).toBe("30.00%");
    // And from the planner's own proposals.
    expect(shown(proposedRegular(379500, 3500), 379500)).toBe("35.00%");
    expect(shown(proposedRegular(299500, 3000), 299500)).toBe("30.00%");
    expect(shown(proposedRegular(179500, 2000), 179500)).toBe("20.00%");
  });

  it("rounds half up at the second decimal, both ways", () => {
    // 1 / 8 = 12.5% exactly; 1 / 3 = 33.333…% → 33.33; 2 / 3 = 66.666…% → 66.67; 0.12345 → 12.35 (half up).
    expect(shown(800, 700)).toBe("12.50%");
    expect(shown(300, 200)).toBe("33.33%");
    expect(shown(300, 100)).toBe("66.67%");
    expect(actualDiscount(100000, 87655).percentHundredths).toBe(1235); // 12.345% → 12.35
    expect(actualDiscount(100000, 87656).percentHundredths).toBe(1234); // 12.344% → 12.34
  });

  it("every Kids Sneakers selling price at every percentage shows exactly the assigned percentage", () => {
    for (const selling of [179500, 209500, 219500, 239500, 259500, 269500, 289500, 299500, 319500, 329500, 349500, 359500, 379500, 399500]) {
      for (const bp of [2000, 2500, 3000, 3500]) {
        const regular = proposedRegular(selling, bp);
        expect(regular - actualDiscount(regular, selling).savingPaisa).toBe(selling); // the selling price is untouched
        expect(shown(regular, selling)).toBe(`${bp / 100}.00%`);
      }
    }
  });

  it("formats whole hundredths with two decimals", () => {
    expect(formatPercentHundredths(3500)).toBe("35.00%");
    expect(formatPercentHundredths(2999)).toBe("29.99%");
    expect(formatPercentHundredths(5)).toBe("0.05%");
    expect(formatPercentHundredths(0)).toBe("0.00%");
    expect(() => formatPercentHundredths(12.5)).toThrow();
  });
});

describe("planAssignments", () => {
  it("follows the default distribution (20/35/30/15%) without reliable age or sales data", () => {
    const { planned, basis } = planAssignments(products(100), TODAY);
    expect(basis).toBe("default_distribution");
    expect(planned).toHaveLength(100);
    expect(share(planned)).toEqual({ 2000: 20, 2500: 35, 3000: 30, 3500: 15 });
  });

  it("is the same on every run, and seeded (another seed shuffles who gets what)", () => {
    const a = planAssignments(products(40), TODAY).planned;
    const b = planAssignments(products(40), TODAY).planned;
    expect(b).toEqual(a);
    const other = planAssignments(products(40), TODAY, "another-seed").planned;
    expect(share(other)).toEqual(share(a));
    expect(other.map((p) => p.discountBp)).not.toEqual(a.map((p) => p.discountBp));
  });

  it("gives every size of a model the same percentage", () => {
    const list = products(30).map((c, i) => ({ ...c, groupKey: `model ${Math.floor(i / 3)}` }));
    const { planned } = planAssignments(list, TODAY);
    for (let g = 0; g < 10; g++) {
      const bps = new Set(planned.filter((_, i) => Math.floor(i / 3) === g).map((p) => p.discountBp));
      expect(bps.size).toBe(1);
    }
  });

  it("keeps saved percentages; new products only fill in (and a new size joins its model's percentage)", () => {
    const first = planAssignments(products(20), TODAY).planned;
    const saved = products(20).map((c, i) => ({ ...c, assignedBp: first[i].discountBp }));
    expect(planAssignments(saved, TODAY).planned).toEqual([]);
    const withNewSize = [...saved, { productId: id(99), groupKey: "model 1", listedAt: null, unitsSold: 0, assignedBp: null }];
    expect(planAssignments(withNewSize, TODAY).planned).toEqual([{ productId: id(99), discountBp: first[0].discountBp, basis: "default_distribution" }]);
  });

  it("ignores size, price and score entirely (they aren't inputs)", () => {
    const a = planAssignments(products(12), TODAY).planned;
    // Same ids and models, listed in reverse order: same answer per product.
    const b = planAssignments(products(12).reverse(), TODAY).planned;
    const byId = (list: typeof a) => Object.fromEntries(list.map((p) => [p.productId, p.discountBp]));
    expect(byId(b)).toEqual(byId(a));
  });

  it("with reliable age and sales data, slower stock gets the larger discounts", () => {
    const list = products(20, { listedAt: "2026-06-01" }).map((c, i) => ({ ...c, unitsSold: i * 3 })); // product 1 sold 0, product 20 sold 57
    expect(dataReliability(list, TODAY).reliable).toBe(true);
    const { planned, basis } = planAssignments(list, TODAY);
    expect(basis).toBe("age_and_sales");
    expect(share(planned)).toEqual({ 2000: 4, 2500: 7, 3000: 6, 3500: 3 });
    const bp = Object.fromEntries(planned.map((p) => [p.productId, p.discountBp]));
    expect([bp[id(1)], bp[id(2)], bp[id(3)]]).toEqual([3500, 3500, 3500]);
    expect(bp[id(20)]).toBe(2000);
  });

  it("treats new listings or too few sales as unreliable", () => {
    expect(dataReliability(products(10, { listedAt: "2026-11-20", unitsSold: 10 }), TODAY).reliable).toBe(false);
    expect(dataReliability(products(10, { listedAt: "2026-01-01", unitsSold: 1 }), TODAY).reliable).toBe(false);
  });
});
