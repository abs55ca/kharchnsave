import { describe, expect, it } from "vitest";
import { offeredSince, raisedRegular, shopPercent, type Pricing } from "./promotion";

const KIDS_PRICES = [179500, 209500, 219500, 239500, 259500, 269500, 289500, 299500, 319500, 329500, 349500, 359500, 379500, 399500];

describe("raisedRegular", () => {
  it("rounds selling ÷ (1 − discount) up to the whole rupee", () => {
    expect(raisedRegular(379500, 3500)).toBe(583900); // 5,838.46 → 5,839
    expect(raisedRegular(179500, 2000)).toBe(224400); // 2,243.75 → 2,244
    expect(raisedRegular(299500, 3000)).toBe(427900); // 4,278.57 → 4,279
    expect(raisedRegular(240000, 2000)).toBe(300000); // exact: stays 3,000
  });

  it("for every kids' price and percentage, the shop's 'Save X%' is exactly the assigned percentage", () => {
    for (const selling of KIDS_PRICES) {
      for (const bp of [2000, 2500, 3000, 3500]) {
        const regular = raisedRegular(selling, bp);
        expect(regular % 100).toBe(0);
        expect(regular).toBeGreaterThan(selling);
        // At or just above the assigned discount (never below it), by less than a rupee's worth.
        expect((regular - selling) * 10000).toBeGreaterThanOrEqual(bp * regular);
        expect(shopPercent(regular, selling)).toBe(bp / 100);
      }
    }
  });
});

describe("offeredSince", () => {
  const row = (price: number, sale: number | null, status: string, at: string) => ({ regular_price_paisa: price, sale_price_paisa: sale, publication_status: status, created_at: at });
  const pricing = (history: Pricing["history"]) => ({ history }) as Pricing;

  it("is the start of the current run of being published at that price with no sale", () => {
    const h = [
      row(299500, null, "draft", "2026-11-23T10:00:00Z"),
      row(427900, null, "draft", "2026-11-24T10:00:00Z"),
      row(427900, null, "published", "2026-11-24T10:01:00Z"),
    ];
    expect(offeredSince(pricing(h), 427900)?.toISOString()).toBe("2026-11-24T10:01:00.000Z");
  });

  it("restarts after any interruption (unpublished, a sale or another price), and is null if not offered now", () => {
    const h = [
      row(427900, null, "published", "2026-11-01T00:00:00Z"),
      row(427900, 299500, "published", "2026-11-10T00:00:00Z"),
      row(427900, null, "published", "2026-11-12T00:00:00Z"),
    ];
    expect(offeredSince(pricing(h), 427900)?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(offeredSince(pricing([...h, row(427900, null, "draft", "2026-11-20T00:00:00Z")]), 427900)).toBeNull();
    expect(offeredSince(pricing(h), 500000)).toBeNull();
  });
});
