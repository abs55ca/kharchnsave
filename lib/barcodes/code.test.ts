import { describe, expect, it } from "vitest";
import {
  classifyScan,
  dammCheckDigit,
  formatBarcode,
  isLegacyBarcode,
  isValidBarcode,
  looksLikeBarcode,
  normalizeScan,
} from "./code";

// The same vectors as supabase/tests/barcodes_test.sql, so the database and
// the app agree on every check digit.
const VECTORS: [number, string][] = [
  [1, "KNS00000013"],
  [2, "KNS00000021"],
  [14, "KNS00000149"],
  [1234567, "KNS12345671"],
  [9999999, "KNS99999992"],
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
      for (let i = 3; i < barcode.length; i++) {
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
      for (let i = 3; i < barcode.length - 1; i++) {
        if (barcode[i] === barcode[i + 1]) continue;
        const swapped = `${barcode.slice(0, i)}${barcode[i + 1]}${barcode[i]}${barcode.slice(i + 2)}`;
        expect(isValidBarcode(swapped), swapped).toBe(false);
      }
    }
  });

  it("rejects other shapes", () => {
    for (const value of [
      "",
      "KNS0000013",
      "KNS000000130",
      "KN500000013",
      "KNX00000013",
      "kns00000013",
      "KNS0000001A",
      "U00000013",
    ]) {
      expect(isValidBarcode(value), value).toBe(false);
    }
  });

  it("only issues serials 1 to 9,999,999", () => {
    expect(() => formatBarcode(0)).toThrow();
    expect(() => formatBarcode(10_000_000)).toThrow();
    expect(() => formatBarcode(1.5)).toThrow();
  });
});

describe("retired U barcodes", () => {
  it("use the same digits and check digit, after U", () => {
    for (const [, barcode] of VECTORS) expect(isLegacyBarcode(`U${barcode.slice(3)}`), barcode).toBe(true);
    expect(isLegacyBarcode("U00000084")).toBe(true);
  });

  it("are recognised only with a correct check digit, and never as current barcodes", () => {
    for (const value of ["U00000014", "U0000013", "u00000013", "KNS00000013"]) {
      expect(isLegacyBarcode(value), value).toBe(false);
    }
  });
});

describe("item codes that look like barcodes", () => {
  it("covers KNS, KN5 and U followed by 8 digits", () => {
    for (const value of ["KNS00000084", "KN500000084", "KNS00000085", "U00000084", "U12345678"]) {
      expect(looksLikeBarcode(value), value).toBe(true);
    }
  });

  it("leaves other item codes alone", () => {
    for (const value of ["PL-M-1001", "KNS-0001", "KNS0000008", "KNS000000840", "KN50000008", "KNA00000084", "UU0000008"]) {
      expect(looksLikeBarcode(value), value).toBe(false);
    }
  });
});

describe("scan input", () => {
  it("removes spaces and line breaks and capitalises", () => {
    expect(normalizeScan(" kns0000 0013\r\n")).toBe("KNS00000013");
    expect(normalizeScan(" u0000 0013\r\n")).toBe("U00000013");
    expect(normalizeScan("p1133706-01mul")).toBe("P1133706-01MUL");
    expect(normalizeScan(undefined)).toBe("");
    expect(normalizeScan(["KNS00000013"])).toBe("");
  });

  it("reads KN5 typed by hand as KNS", () => {
    expect(normalizeScan("KN500000084")).toBe("KNS00000084");
    expect(normalizeScan("kn5 0000 0084")).toBe("KNS00000084");
    expect(normalizeScan("Kn5 00000084\t")).toBe("KNS00000084");
  });

  it("only corrects KN5 in exactly the barcode's shape", () => {
    for (const value of ["KN5-0001", "KN50000008", "KN5000000840", "XKN500000084", "KN500000084A"]) {
      expect(normalizeScan(value), value).toBe(value);
    }
  });

  it("caps the length", () => {
    expect(normalizeScan("A".repeat(100))).toHaveLength(40);
  });

  it("sorts what was scanned", () => {
    expect(classifyScan("")).toEqual({ kind: "empty", code: "" });
    expect(classifyScan("kns00000013")).toEqual({ kind: "barcode", code: "KNS00000013" });
    expect(classifyScan("kn5 0000 0013")).toEqual({ kind: "barcode", code: "KNS00000013" });
    expect(classifyScan("KNS00000014")).toEqual({ kind: "mistyped", code: "KNS00000014" });
    expect(classifyScan("KN500000014")).toEqual({ kind: "mistyped", code: "KNS00000014" });
    expect(classifyScan("pl-m-1001")).toEqual({ kind: "text", code: "PL-M-1001" });
    expect(classifyScan("PL-M-1001-42.5")).toEqual({ kind: "text", code: "PL-M-1001-42.5" });
    expect(classifyScan("P1133706-01MUL")).toEqual({ kind: "text", code: "P1133706-01MUL" });
    expect(classifyScan("4006381333931")).toEqual({ kind: "text", code: "4006381333931" });
    expect(classifyScan("PL_M'1001")).toEqual({ kind: "invalid", code: "PL_M'1001" });
  });

  it("still recognises retired U labels, so the lookup can say what replaced them", () => {
    expect(classifyScan("u00000084")).toEqual({ kind: "barcode", code: "U00000084" });
    expect(classifyScan("U00000085")).toEqual({ kind: "mistyped", code: "U00000085" });
  });
});
