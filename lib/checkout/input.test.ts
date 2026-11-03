import { describe, expect, it } from "vitest";
import { cartDigest, normalizePakistanMobile, orderLinesFromCart, parseOrderLines, validateCustomer } from "./input";

describe("normalizePakistanMobile", () => {
  it("accepts the common ways of writing a mobile number", () => {
    for (const input of ["03001234567", "0300 1234567", "0300-1234567", "+92 300 1234567", "+923001234567", "0092 300 1234567", "92 300 1234567", "300 1234567", "(0300) 123-4567"]) {
      expect(normalizePakistanMobile(input), input).toBe("+923001234567");
    }
  });

  it("rejects landlines, short or long numbers and other countries", () => {
    for (const input of ["042 35761234", "0300123456", "030012345678", "+44 7700 900123", "0300 123456a", "", "+92 400 1234567"]) {
      expect(normalizePakistanMobile(input), input).toBeNull();
    }
  });
});

describe("validateCustomer", () => {
  const good = { name: "  Ayesha   Khan ", phone: "0300 1234567", city: "Lahore", address: "House 12, Street 4,\nModel Town", landmark: "", note: "" };

  it("cleans and normalises valid details", () => {
    expect(validateCustomer(good)).toEqual({
      ok: true,
      customer: { name: "Ayesha Khan", phone: "+923001234567", city: "Lahore", address: "House 12, Street 4, Model Town", landmark: null, note: null },
    });
  });

  it("explains each problem", () => {
    const result = validateCustomer({ name: "A", phone: "12345", city: "", address: "Short", landmark: "x".repeat(101), note: "ok" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["address", "city", "landmark", "name", "phone"]);
  });

  it("rejects control characters", () => {
    const result = validateCustomer({ ...good, name: "Ayesha\u0000Khan" });
    expect(result.ok).toBe(false);
  });
});

describe("order lines", () => {
  it("converts rupees to exact paisa and sorts by SKU", () => {
    expect(orderLinesFromCart([
      { sku: "B-1", quantity: 2, price: 2450 },
      { sku: "A-1", quantity: 1, price: 999.99 },
    ])).toEqual([
      { sku: "A-1", quantity: 1, unit_price_paisa: 99999 },
      { sku: "B-1", quantity: 2, unit_price_paisa: 245000 },
    ]);
  });

  it("describes a cart the same way whatever the order of its lines", () => {
    const a = [{ sku: "A", quantity: 1, unit_price_paisa: 1 }, { sku: "B", quantity: 2, unit_price_paisa: 2 }];
    expect(cartDigest(a)).toBe(cartDigest([...a].reverse()));
    expect(cartDigest(a)).not.toBe(cartDigest([{ ...a[0], quantity: 2 }, a[1]]));
  });

  it("parses untrusted lines strictly", () => {
    expect(parseOrderLines([{ sku: "A", quantity: 1, unit_price_paisa: 100 }])).toEqual([{ sku: "A", quantity: 1, unit_price_paisa: 100 }]);
    for (const bad of [null, [], [{ sku: "A", quantity: 0, unit_price_paisa: 1 }], [{ sku: "A", quantity: 1.5, unit_price_paisa: 1 }],
      [{ sku: "A", quantity: 1, unit_price_paisa: -1 }], [{ sku: "", quantity: 1, unit_price_paisa: 1 }],
      [{ sku: "A", quantity: 1, unit_price_paisa: 1 }, { sku: "A", quantity: 1, unit_price_paisa: 1 }],
      Array.from({ length: 51 }, (_, i) => ({ sku: `S${i}`, quantity: 1, unit_price_paisa: 1 }))]) {
      expect(parseOrderLines(bad)).toBeNull();
    }
  });
});
