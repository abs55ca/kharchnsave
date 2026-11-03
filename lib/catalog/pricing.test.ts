import { describe, expect, it } from "vitest";
import { discountPercent, isOnSale, pricesFromColumns, saleBadgeText } from "./pricing";

describe("discount badge", () => {
  it("shows whole percentages", () => {
    expect(saleBadgeText(2000, 1600)).toBe("20% OFF");
    expect(saleBadgeText(8500, 4250)).toBe("50% OFF");
  });

  it("rounds down, so it never claims more than the real saving", () => {
    // 20.05% and 24.99%: still 20% and 24%.
    expect(discountPercent(2000, 1599)).toBe(20);
    expect(discountPercent(4000, 3000.4)).toBe(24);
    expect(saleBadgeText(3, 2)).toBe("33% OFF");
    expect(saleBadgeText(1000, 1)).toBe("99% OFF");
  });

  it("says “Sale” rather than “0% OFF” for a discount under 1%", () => {
    expect(discountPercent(10000, 9950)).toBe(0);
    expect(saleBadgeText(10000, 9950)).toBe("Sale");
    expect(saleBadgeText(10000, 9900)).toBe("1% OFF");
  });

  it("works on exact paisa, not floating-point rupees", () => {
    expect(discountPercent(8500.5, 6800.5)).toBe(19); // 19.9988%
    expect(discountPercent(8500.5, 6800.4)).toBe(20); // 20.0001%
    expect(discountPercent(0.3, 0.2)).toBe(33);
  });

  it("is 0 when there's no real discount", () => {
    expect(discountPercent(2000, 2000)).toBe(0);
    expect(discountPercent(2000, 2500)).toBe(0);
    expect(discountPercent(0, 0)).toBe(0);
  });
});

describe("prices from the database", () => {
  it("charges the sale price while there is one, and keeps the regular price for display", () => {
    expect(pricesFromColumns({ price_paisa: 200000, sale_price_paisa: 160000 })).toEqual({ price: 1600, regularPrice: 2000 });
  });

  it("leaves products without a sale exactly as before", () => {
    expect(pricesFromColumns({ price_paisa: 850050, sale_price_paisa: null })).toEqual({ price: 8500.5, regularPrice: null });
    expect(pricesFromColumns({ price_paisa: 850000 })).toEqual({ price: 8500, regularPrice: null });
  });

  it("ignores a sale price that isn't below the regular price (the database refuses those anyway)", () => {
    expect(pricesFromColumns({ price_paisa: 200000, sale_price_paisa: 200000 })).toEqual({ price: 2000, regularPrice: null });
    expect(pricesFromColumns({ price_paisa: 200000, sale_price_paisa: 0 })).toEqual({ price: 2000, regularPrice: null });
  });

  it("knows when a product is on sale", () => {
    expect(isOnSale({ price: 1600, regularPrice: 2000 })).toBe(true);
    expect(isOnSale({ price: 2000, regularPrice: null })).toBe(false);
  });
});
