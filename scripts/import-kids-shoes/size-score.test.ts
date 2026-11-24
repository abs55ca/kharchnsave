import { describe, expect, it } from "vitest";
import { scorePrice } from "@/lib/pricing/rules";
import { GROUP_MAX_PAISA, MIN_SCORE, sizeScore } from "./size-score";

describe("sizeScore", () => {
  it("runs from 45 at EU 22 to 100 at EU 36, rising with size", () => {
    expect(sizeScore(22)).toBe(45);
    expect(sizeScore(36)).toBe(100);
    const sizes = [22, 24, 25, 26, 27, 28, 29, 29.5, 30, 31, 32, 33, 34, 35, 36];
    const scores = sizes.map(sizeScore);
    expect(scores).toEqual([45, 53, 57, 61, 65, 69, 73, 74, 76, 80, 84, 88, 92, 96, 100]);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
  });

  it("never goes below 45 or above 100, even outside the batch's sizes", () => {
    expect(sizeScore(18)).toBe(MIN_SCORE);
    expect(sizeScore(40)).toBe(100);
  });

  it("gives these prices with the Rs. 95 ending (what the database works out too)", () => {
    const price = (size: number) => {
      const r = scorePrice(GROUP_MAX_PAISA, sizeScore(size), 95);
      return r.status === "ok" ? r.pricePaisa / 100 : null;
    };
    expect([22, 24, 29, 30, 33, 36].map(price)).toEqual([1795, 2095, 2895, 2995, 3495, 3995]);
  });
});
