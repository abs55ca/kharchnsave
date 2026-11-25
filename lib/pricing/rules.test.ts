import { describe, expect, it } from "vitest";
import {
  coverageTarget,
  displayedDiscount,
  formatBp,
  marginStatus,
  percentOf,
  percentToBp,
  priceWithEnding,
  referralScenario,
  salePrice,
  scorePrice,
  spreadOffsetBp,
} from "./rules";

const rs = (rupees: number) => rupees * 100;

describe("price endings (default 95)", () => {
  it("gives the owner's examples", () => {
    expect(priceWithEnding(rs(1500), 95)).toBe(rs(1495));
    expect(priceWithEnding(rs(2000), 95)).toBe(rs(1995));
    expect(priceWithEnding(rs(2500), 95)).toBe(rs(2495));
    expect(priceWithEnding(rs(5000), 95)).toBe(rs(4995));
  });

  it("keeps a price that already ends in 95, and never goes above the calculated amount", () => {
    expect(priceWithEnding(rs(1495), 95)).toBe(rs(1495));
    expect(priceWithEnding(rs(1495) + 99, 95)).toBe(rs(1495)); // Rs. 1,495.99: whole rupees only
    expect(priceWithEnding(rs(1495) - 1, 95)).toBe(rs(1395)); // Rs. 1,494.99 is below 1,495
    expect(priceWithEnding(rs(1594), 95)).toBe(rs(1495));
    expect(priceWithEnding(rs(1595), 95)).toBe(rs(1595));
    for (let amount = 0; amount <= rs(3000); amount += 137) {
      const p = priceWithEnding(amount, 95);
      if (p !== null) {
        expect(p).toBeLessThanOrEqual(amount);
        expect((p / 100) % 100).toBe(95);
        // The highest such price: the next one up would exceed the amount.
        expect(p + rs(100)).toBeGreaterThan(amount);
      }
    }
  });

  it("flags amounts too small for the ending instead of making a zero or negative price", () => {
    expect(priceWithEnding(rs(94), 95)).toBeNull();
    expect(priceWithEnding(rs(95), 95)).toBe(rs(95));
    expect(priceWithEnding(0, 95)).toBeNull();
    expect(priceWithEnding(-500, 95)).toBeNull();
    expect(priceWithEnding(rs(99), 0)).toBeNull(); // ending 00 needs at least Rs. 100
    expect(priceWithEnding(rs(100), 0)).toBe(rs(100));
  });

  it("is configurable (99 for a later test)", () => {
    expect(priceWithEnding(rs(2000), 99)).toBe(rs(1999));
    expect(priceWithEnding(rs(1999), 99)).toBe(rs(1999));
    expect(priceWithEnding(rs(1998), 99)).toBe(rs(1899));
    expect(() => priceWithEnding(rs(2000), 100)).toThrow();
    expect(() => priceWithEnding(1.5, 95)).toThrow();
  });
});

describe("score pricing", () => {
  it("maximum × score / 100, then the ending", () => {
    expect(scorePrice(rs(5000), 50, 95)).toEqual({ status: "ok", calculatedPaisa: rs(2500), pricePaisa: rs(2495) });
    expect(scorePrice(rs(5000), 100, 95)).toEqual({ status: "ok", calculatedPaisa: rs(5000), pricePaisa: rs(4995) });
    expect(scorePrice(rs(5000), 30, 95)).toEqual({ status: "ok", calculatedPaisa: rs(1500), pricePaisa: rs(1495) });
    // Never above the maximum, even at 100.
    expect(scorePrice(rs(4995), 100, 95).pricePaisa).toBe(rs(4995));
  });

  it("rounds the calculated amount down to the paisa", () => {
    // Rs. 3,333 × 33 / 100 = Rs. 1,099.89
    expect(scorePrice(rs(3333), 33, 95)).toEqual({ status: "ok", calculatedPaisa: 109989, pricePaisa: rs(1095) });
  });

  it("score 0 needs pricing unless it's an explicit giveaway", () => {
    expect(scorePrice(rs(5000), 0, 95)).toEqual({ status: "needs_pricing", calculatedPaisa: 0, pricePaisa: null });
    expect(scorePrice(rs(5000), 0, 95, true)).toEqual({ status: "giveaway", calculatedPaisa: 0, pricePaisa: 0 });
  });

  it("tiny prices are flagged, not zeroed", () => {
    expect(scorePrice(rs(500), 5, 95)).toEqual({ status: "too_small", calculatedPaisa: rs(25), pricePaisa: null });
    expect(scorePrice(rs(1900), 5, 95)).toEqual({ status: "ok", calculatedPaisa: rs(95), pricePaisa: rs(95) });
  });

  it("refuses bad input", () => {
    expect(() => scorePrice(rs(5000), 101, 95)).toThrow();
    expect(() => scorePrice(rs(5000), 2.5, 95)).toThrow();
    expect(() => scorePrice(0, 50, 95)).toThrow();
  });
});

describe("sale prices", () => {
  it("applies the ending after the discount and reports the extra discount it adds", () => {
    // Rs. 2,495 at 10%: Rs. 2,245.50 → Rs. 2,195 (Rs. 50.50 more off); actual 12%.
    expect(salePrice(rs(2495), 1000, 95)).toEqual({ rawPaisa: 224550, pricePaisa: rs(2195), roundingPaisa: 5050, actualPercent: 12 });
    // Rs. 4,995 at 20%: Rs. 3,996 → Rs. 3,995.
    expect(salePrice(rs(4995), 2000, 95)).toEqual({ rawPaisa: rs(3996), pricePaisa: rs(3995), roundingPaisa: 100, actualPercent: 20 });
  });

  it("is always below the regular price and flags a sale price that would be too small", () => {
    expect(salePrice(rs(150), 3000, 95)).toEqual({ rawPaisa: rs(105), pricePaisa: rs(95), roundingPaisa: rs(10), actualPercent: 36 });
    expect(salePrice(rs(120), 3000, 95).pricePaisa).toBeNull();
    for (const regular of [rs(95), rs(195), rs(1495), rs(99995)]) {
      for (const bp of [1, 1000, 2500, 9000]) {
        const s = salePrice(regular, bp, 95);
        if (s.pricePaisa !== null) expect(s.pricePaisa).toBeLessThan(regular);
      }
    }
  });
});

describe("honest discount badges", () => {
  it("savings = reference − sale; percent rounded down", () => {
    expect(displayedDiscount(rs(2495), rs(2195))).toEqual({ savingsPaisa: rs(300), percent: 12 });
    expect(displayedDiscount(rs(2000), 159900)).toEqual({ savingsPaisa: 40100, percent: 20 });
  });

  it("shows nothing without a supported reference, or when it isn't above the sale price", () => {
    expect(displayedDiscount(null, rs(2195))).toBeNull();
    expect(displayedDiscount(rs(2195), rs(2195))).toBeNull();
    expect(displayedDiscount(rs(2000), rs(2195))).toBeNull();
  });
});

describe("coverage targets", () => {
  it("ceil(85% × eligible listings)", () => {
    expect(coverageTarget(0, 8500)).toBe(0);
    expect(coverageTarget(1, 8500)).toBe(1);
    expect(coverageTarget(7, 8500)).toBe(6); // 5.95 → 6
    expect(coverageTarget(20, 8500)).toBe(17);
    expect(coverageTarget(21, 8500)).toBe(18); // 17.85 → 18
    expect(coverageTarget(100, 8500)).toBe(85);
    expect(coverageTarget(13, 10000)).toBe(13);
  });
});

describe("referral scenarios on sale items", () => {
  it("a 20% sale then a 10% referral discount is 28% off, not 30%", () => {
    const sale = salePrice(rs(10000), 2000, 0).pricePaisa!; // Rs. 8,000
    const s = referralScenario(sale, 1000, 500, null);
    expect(s.paidPaisa).toBe(rs(7200));
    expect((rs(10000) - s.paidPaisa) / rs(10000)).toBe(0.28);
    // Commission on what the customer pays for the goods, after the discount.
    expect(s.commissionPaisa).toBe(rs(360));
  });

  it("missing costs stay unknown", () => {
    expect(referralScenario(rs(2195), 1000, 500, null).retainedPaisa).toBeNull();
    expect(referralScenario(rs(2195), 1000, 500, rs(1000))).toMatchObject({ discountPaisa: 21950, paidPaisa: 197550, commissionPaisa: 9878, retainedPaisa: 87672 });
  });

  it("percent_of rounds half up", () => {
    expect(percentOf(105, 5000)).toBe(53);
    expect(percentOf(197550, 500)).toBe(9878); // 9877.5 → 9878
  });

  it("margin rule: unknown cost can't be called profitable", () => {
    const rule = { minProfitPaisa: rs(300), minMarginBp: null };
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: null }, rule)).toBe("cost_unknown");
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: rs(299) }, rule)).toBe("violation");
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: rs(300) }, rule)).toBe("ok");
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: rs(399) }, { minProfitPaisa: null, minMarginBp: 2000 })).toBe("violation");
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: rs(400) }, { minProfitPaisa: null, minMarginBp: 2000 })).toBe("ok");
    expect(marginStatus({ paidPaisa: rs(2000), retainedPaisa: null }, { minProfitPaisa: null, minMarginBp: null })).toBe("not_configured");
  });
});

describe("percent input", () => {
  it("parses whole and decimal percentages into basis points", () => {
    expect(percentToBp("15")).toBe(1500);
    expect(percentToBp("12.5")).toBe(1250);
    expect(percentToBp(" 7.25 % ")).toBe(725);
    expect(percentToBp("0")).toBeNull();
    expect(percentToBp("91")).toBeNull();
    expect(percentToBp("1.234")).toBeNull();
    expect(percentToBp("abc")).toBeNull();
    expect(formatBp(1250)).toBe("12.5%");
    expect(formatBp(1500)).toBe("15%");
  });
});

describe("price spread", () => {
  it("gives each product a fixed offset from 0 to the spread, from the end of its id", () => {
    expect(spreadOffsetBp("a7a7a7a7-0000-4000-8000-000000000000", 500)).toBe(0);
    expect(spreadOffsetBp("a7a7a7a7-0000-4000-8000-0000000001f4", 500)).toBe(500); // 0x1f4 = 500
    expect(spreadOffsetBp("a7a7a7a7-0000-4000-8000-0000000001f5", 500)).toBe(0);
    expect(spreadOffsetBp("a7a7a7a7-0000-4000-8000-ffffffffffff", 500)).toBe(0xffffffff % 501);
    expect(spreadOffsetBp("a7a7a7a7-0000-4000-8000-0000000001f4", 0)).toBe(0);
  });

  it("takes the offset off after the price ending, in whole rupees, never above the score price", () => {
    expect(scorePrice(rs(6000), 50, 95, false, 0)).toEqual(scorePrice(rs(6000), 50, 95));
    // Rs. 3,000 → Rs. 2,995 (the ending), less 5% = Rs. 2,845.25 → Rs. 2,845.
    expect(scorePrice(rs(6000), 50, 95, false, 500)).toEqual({ status: "ok", calculatedPaisa: rs(3000), pricePaisa: rs(2845) });
    // 2.37%: Rs. 4,495 → Rs. 4,388.47 → Rs. 4,388.
    expect(scorePrice(rs(4500), 100, 95, false, 237).pricePaisa).toBe(rs(4388));
    expect(scorePrice(rs(6000), 100, 95, false, 1).pricePaisa).toBe(rs(5994));
    expect(() => scorePrice(rs(6000), 50, 95, false, 501)).toThrow(RangeError);
  });
});
