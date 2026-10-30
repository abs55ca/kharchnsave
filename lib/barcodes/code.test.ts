import { describe, expect, it } from "vitest";
import { classifyScan, dammCheckDigit, formatBarcode, isValidBarcode, normalizeScan } from "./code";

// The same vectors as supabase/tests/barcodes_test.sql, so the database and
// the app agree on every check digit.
const VECTORS: [number, string][] = [
  [1, "U00000013"],
  [2, "U00000021"],
  [14, "U00000149"],
  [1234567, "U12345671"],
  [9999999, "U99999992"],
];

describe("check digit", () => {
  it("matches the published Damm example (572 → 4)", () => {
    expect(dammCheckDigit("572")).toBe(4);
  });

  it.each(VECTORS)("serial %i is %s", (serial, barcode) => {
    expect(formatBarcode(serial)).toBe(barcode);
    expect(isValidBarcode(barcode)).toBe(true);
  });

  it("catches every single-digit typo", () => {
    for (const [, barcode] of VECTORS) {
      for (let i = 1; i < barcode.length; i++) {
        for (let d = 0; d <= 9; d++) {
          if (String(d) === barcode[i]) continue;
          const typo = `${barcode.slice(0, i)}${d}${barcode.slice(i + 1)}`;
          expect(isValidBarcode(typo), typo).toBe(false);
        }
      }
    }
  });

  it("catches every swap of two neighbouring different digits", () => {
    for (const [, barcode] of VECTORS) {
      for (let i = 1; i < barcode.length - 1; i++) {
        if (barcode[i] === barcode[i + 1]) continue;
        const swapped = `${barcode.slice(0, i)}${barcode[i + 1]}${barcode[i]}${barcode.slice(i + 2)}`;
        expect(isValidBarcode(swapped), swapped).toBe(false);
      }
    }
  });

  it("rejects other shapes", () => {
    for (const value of ["", "U0000013", "U000000130", "X00000013", "u00000013", "U0000001A"]) {
      expect(isValidBarcode(value), value).toBe(false);
    }
  });

  it("only issues serials 1 to 9,999,999", () => {
    expect(() => formatBarcode(0)).toThrow();
    expect(() => formatBarcode(10_000_000)).toThrow();
    expect(() => formatBarcode(1.5)).toThrow();
  });
});

describe("scan input", () => {
  it("removes spaces and line breaks and capitalises", () => {
    expect(normalizeScan(" u0000 0013\r\n")).toBe("U00000013");
    expect(normalizeScan("p1133706-01mul")).toBe("P1133706-01MUL");
    expect(normalizeScan(undefined)).toBe("");
    expect(normalizeScan(["U00000013"])).toBe("");
  });

  it("caps the length", () => {
    expect(normalizeScan("A".repeat(100))).toHaveLength(40);
  });

  it("sorts what was scanned", () => {
    expect(classifyScan("")).toEqual({ kind: "empty", code: "" });
    expect(classifyScan("u00000013")).toEqual({ kind: "barcode", code: "U00000013" });
    expect(classifyScan("U00000014")).toEqual({ kind: "mistyped", code: "U00000014" });
    expect(classifyScan("pl-m-1001")).toEqual({ kind: "text", code: "PL-M-1001" });
    expect(classifyScan("PL-M-1001-42.5")).toEqual({ kind: "text", code: "PL-M-1001-42.5" });
    expect(classifyScan("P1133706-01MUL")).toEqual({ kind: "text", code: "P1133706-01MUL" });
    expect(classifyScan("4006381333931")).toEqual({ kind: "text", code: "4006381333931" });
    expect(classifyScan("PL_M'1001")).toEqual({ kind: "invalid", code: "PL_M'1001" });
  });
});
