import { describe, expect, it } from "vitest";
import { actualDiscount, formatPercentHundredths } from "./percent";
import { matchSize, ruleLabel, sizeSalePrice, validateSizeRules, type SizeRule } from "./size-rules";

const KIDS: SizeRule[] = [
  { from: 25, to: 30, discountBp: 3000 },
  { from: 36, to: 36, discountBp: 3500 },
];

describe("matchSize", () => {
  it("matches inclusive range boundaries and fractional sizes, without rounding", () => {
    expect(matchSize(KIDS, null, 25)).toEqual({ discountBp: 3000, label: "EU 25–30" });
    expect(matchSize(KIDS, null, 30)).toEqual({ discountBp: 3000, label: "EU 25–30" });
    expect(matchSize(KIDS, null, 29.5)).toEqual({ discountBp: 3000, label: "EU 25–30" });
    expect(matchSize(KIDS, null, 24.5)).toBeNull();
    expect(matchSize(KIDS, null, 30.5)).toBeNull();
    expect(matchSize(KIDS, null, 36)).toEqual({ discountBp: 3500, label: "EU 36" });
  });

  it("lets a single-size rule override a range, wherever it is in the list", () => {
    const rules: SizeRule[] = [{ from: 28, to: 28, discountBp: 1000 }, ...KIDS];
    expect(matchSize(rules, null, 28)).toEqual({ discountBp: 1000, label: "EU 28" });
    expect(matchSize([...KIDS, { from: 28, to: 28, discountBp: 1000 }], null, 28)?.discountBp).toBe(1000);
    expect(matchSize(rules, null, 27.5)?.discountBp).toBe(3000);
  });

  it("gives unmatched sizes no sale, or the default discount when one is set", () => {
    expect(matchSize(KIDS, null, 33)).toBeNull();
    expect(matchSize(KIDS, 1500, 33)).toEqual({ discountBp: 1500, label: "Default" });
    expect(matchSize([], null, 30)).toBeNull();
  });
});

describe("validateSizeRules", () => {
  it("accepts the initial Kids Sneakers rules, and a single size inside a range", () => {
    expect(validateSizeRules(KIDS, null)).toEqual([]);
    expect(validateSizeRules([...KIDS, { from: 28, to: 28, discountBp: 1000 }], 500)).toEqual([]);
  });

  it("rejects overlapping ranges, boundaries included", () => {
    expect(validateSizeRules([...KIDS, { from: 30, to: 32, discountBp: 2000 }], null)).toEqual([
      "Rows 1 and 3 overlap (EU 25–30 and EU 30–32). Ranges can't share sizes; use a single-size rule to override part of a range.",
    ]);
    expect(validateSizeRules([...KIDS, { from: 30.5, to: 32, discountBp: 2000 }], null)).toEqual([]);
  });

  it("rejects duplicate single-size rules", () => {
    expect(validateSizeRules([...KIDS, { from: 36, to: 36, discountBp: 2000 }], null)).toEqual([
      "Rows 2 and 3 are both single-size rules for EU 36. Keep one.",
    ]);
  });

  it("rejects bad sizes, reversed ranges and percentages", () => {
    expect(validateSizeRules([{ from: 29.3, to: 30, discountBp: 3000 }], null)[0]).toMatch(/Row 1: sizes are whole or half/);
    expect(validateSizeRules([{ from: 31, to: 30, discountBp: 3000 }], null)).toEqual(['Row 1: "from" (EU 31) is above "to" (EU 30).']);
    expect(validateSizeRules([{ from: 30, to: 31, discountBp: 9500 }], null)[0]).toMatch(/Row 1: the discount is 1% to 90%/);
    expect(validateSizeRules([], 50)[0]).toMatch(/^Default discount/);
  });
});

describe("sizeSalePrice", () => {
  it("is regular × (1 − discount), half up to the paisa, from the regular price", () => {
    expect(sizeSalePrice(329500, 3000)).toBe(230650); // Rs. 2,306.50 exactly
    expect(sizeSalePrice(399500, 3500)).toBe(259675); // Rs. 2,596.75 exactly
    expect(sizeSalePrice(100001, 3000)).toBe(70001); // 70,000.7 → 70,001
    expect(sizeSalePrice(100003, 2500)).toBe(75002); // 75,002.25 → 75,002
    expect(sizeSalePrice(2, 2500)).toBe(2); // 1.5 → 2 (half up)
  });

  it("shows the saving accurately", () => {
    const sale = sizeSalePrice(299500, 3000);
    expect(sale).toBe(209650);
    expect(formatPercentHundredths(actualDiscount(299500, sale).percentHundredths)).toBe("30.00%");
    expect(ruleLabel({ from: 25, to: 30 })).toBe("EU 25–30");
  });
});
