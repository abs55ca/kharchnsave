import { describe, expect, it } from "vitest";
import { formatBarcode } from "@/lib/barcodes/code";
import { labelNameFor, NAME_MAX_DOTS } from "./name-fit";
import {
  buildLabel,
  buildLabels,
  CALIBRATION_NAMES,
  calibrationLabels,
  defaultQuantity,
  fieldData,
  LABEL,
  labelSize,
  MAX_BARCODE_CHARS,
  MAX_SYMBOL_DOTS,
  parseQuantity,
  planCode128,
  worstCaseCode128Dots,
} from "./zpl";

const SPEC = { name: "Nike Air Max", size: 42.5, barcode: "KNS00000013", quantity: 1 };

/** The ^FO x position of the barcode field. */
const barcodeX = (zpl: string) => Number(/\^FO(\d+),\d+\^BC/.exec(zpl)?.[1]);

describe("barcode width", () => {
  it("encodes our barcodes as Code B + Code C pairs: 123 modules, 246 dots", () => {
    expect(planCode128("KNS00000013")).toEqual({ field: ">:KNS>500000013", modules: 123, dots: 246 });
  });

  it("uses the fewest symbols possible: 3 letters, 1 switch, 4 digit pairs", () => {
    expect(planCode128("KNS00000013").modules).toBe(35 + 11 * (3 + 1 + 4));
  });

  it("fits inside the label with quiet zones and position tolerance", () => {
    const quiet = LABEL.quietZoneModules * LABEL.moduleDots;
    expect(MAX_SYMBOL_DOTS).toBe(406 - 2 * (20 + 8));
    for (const barcode of ["KNS00000013", formatBarcode(9_999_999)]) {
      const zpl = buildLabel({ ...SPEC, barcode });
      const x = barcodeX(zpl);
      const width = planCode128(barcode).dots;
      expect(x, "left white").toBeGreaterThanOrEqual(quiet + LABEL.edgeToleranceDots);
      expect(LABEL.widthDots - x - width, "right white").toBeGreaterThanOrEqual(quiet + LABEL.edgeToleranceDots);
      expect(x).toBe(80);
    }
  });

  it("still fits if the printer used Code B for every character", () => {
    expect(worstCaseCode128Dots("KNS00000013".length)).toBe(312);
    expect(worstCaseCode128Dots("KNS00000013".length)).toBeLessThanOrEqual(MAX_SYMBOL_DOTS);
  });

  it("allows at most 12 characters (worst case), and refuses 13", () => {
    expect(MAX_BARCODE_CHARS).toBe(12);
    expect(worstCaseCode128Dots(12)).toBeLessThanOrEqual(MAX_SYMBOL_DOTS);
    expect(worstCaseCode128Dots(13)).toBeGreaterThan(MAX_SYMBOL_DOTS);
    expect(() => planCode128("ABCDEFGHIJKLM")).toThrow();
    expect(planCode128("ABCDEFGHIJKL").dots).toBeLessThanOrEqual(MAX_SYMBOL_DOTS);
  });

  it("uses Code C for all-digit data and Code B otherwise", () => {
    expect(planCode128("12345678")).toMatchObject({ field: ">;12345678", modules: 35 + 44 });
    expect(planCode128("AB-1")).toMatchObject({ field: ">:AB-1", modules: 35 + 44 });
  });

  it("refuses characters that could break the ZPL", () => {
    for (const data of ["KNS0^XZ", "KNS0~JA", "KNS0>5", "kns00000013", "KNS 0"]) expect(() => planCode128(data), data).toThrow();
  });
});

describe("label format", () => {
  const zpl = buildLabel(SPEC);

  it("has the printer settings: UTF-8, size, label top, speed", () => {
    expect(zpl.startsWith("^XA\n^CI28\n^PW406\n^LL203\n^LT20\n^PR4\n")).toBe(true);
    expect(zpl.endsWith("^PQ1,0,1,N\n^XZ")).toBe(true);
  });

  it("uses the positions that printed correctly on the ZD888", () => {
    expect(zpl).toContain("^FO28,14^A0N,26,26^FB228,1,0,L^FDNike Air Max^FS");
    expect(zpl).toContain("^FO266,14^A0N,26,26^FB112,1,0,R^FDEU 42.5^FS");
    expect(zpl).toContain("^BY2\n^FO80,46^BCN,88,N,N,N,N^FD>:KNS>500000013^FS");
    expect(zpl).toContain("^FO0,145^A0N,30,30^FB406,1,0,C^FDKNS00000013^FS");
  });

  // [x, width] of the name's (left-justified) and size's (right-justified) text boxes.
  const box = (label: string, justify: "L" | "R") => {
    const match = new RegExp(`\\^FO(\\d+),\\d+\\^A0N,26,26\\^FB(\\d+),1,0,${justify}`).exec(label);
    expect(match, `${justify} text box`).toBeTruthy();
    return [Number(match![1]), Number(match![2])] as const;
  };

  it("keeps the name's box (28–256) clear of the size's box (266–378)", () => {
    const [nameX, nameWidth] = box(zpl, "L");
    const [sizeX, sizeWidth] = box(zpl, "R");
    expect([nameX, nameX + nameWidth]).toEqual([28, 256]);
    expect([sizeX, sizeX + sizeWidth]).toEqual([266, 378]);
    expect(nameX + nameWidth).toBeLessThan(sizeX);
  });

  it("keeps both text boxes at least 28 dots (3.5 mm) from the label's edges", () => {
    const [nameX] = box(zpl, "L");
    const [sizeX, sizeWidth] = box(zpl, "R");
    expect(nameX).toBeGreaterThanOrEqual(28);
    expect(LABEL.widthDots - (sizeX + sizeWidth)).toBeGreaterThanOrEqual(28);
  });

  it("fits the barcode between the top text and the readable ID", () => {
    const barcode = /\^FO\d+,(\d+)\^BCN,(\d+),/.exec(zpl)!;
    const top = Number(barcode[1]);
    const bottom = top + Number(barcode[2]);
    expect(top).toBeGreaterThanOrEqual(14 + 26);
    expect(bottom).toBeLessThanOrEqual(145);
  });

  it("has no shop branding and no price", () => {
    expect(zpl).not.toMatch(/kharch|save|rs\.|price/i);
  });

  it("prints the quantity asked for", () => {
    expect(buildLabel({ ...SPEC, quantity: 12 })).toContain("^PQ12,0,1,N");
  });

  it("refuses bad quantities and barcodes", () => {
    for (const quantity of [0, -1, 101, 1.5]) expect(() => buildLabel({ ...SPEC, quantity })).toThrow();
    expect(() => buildLabel({ ...SPEC, barcode: "KNS00000014" })).toThrow();
    // Retired U barcodes are never printed again.
    expect(() => buildLabel({ ...SPEC, barcode: "U00000013" })).toThrow();
  });

  it("puts several sizes in one file, one format each", () => {
    const file = buildLabels([
      { ...SPEC, size: 30, barcode: "KNS00000021", quantity: 5 },
      { ...SPEC, size: 31, barcode: "KNS00000149", quantity: 2 },
    ]);
    expect(file.match(/\^XA/g)).toHaveLength(2);
    expect(file.match(/\^XZ/g)).toHaveLength(2);
    expect(file).toContain("^FDEU 30^FS");
    expect(file).toContain("^PQ5,0,1,N");
    expect(file).toContain("^PQ2,0,1,N");
    expect(() => buildLabels([])).toThrow();
  });

  it("cannot be broken by a label name: ZPL command characters are sent as hex escapes", () => {
    const evil = buildLabel({ ...SPEC, name: "S^XZ^XA~JA\\_^FD" });
    expect(evil.match(/\^XA/g)).toHaveLength(1);
    expect(evil.match(/\^XZ/g)).toHaveLength(1);
    expect(evil).not.toContain("~");
    expect(evil).not.toContain("\\");
    expect(evil).toContain("^FB228,1,0,L^FH_^FDS_5EXZ_5EXA_7EJA_5C_5F_5EFD^FS");
  });

  it("sends ordinary names exactly as before (no ^FH)", () => {
    expect(fieldData("Nike Air Max")).toBe("^FDNike Air Max");
    expect(fieldData("Kids' Navy/Grey")).toBe("^FDKids' Navy/Grey");
    expect(fieldData("Café Crème")).toBe("^FDCafé Crème");
    expect(fieldData("a_b")).toBe("^FH_^FDa_5Fb");
  });

  it("prints a name as the check says it prints: curly quotes and dashes made plain", () => {
    expect(buildLabel({ ...SPEC, name: "Kids’ Trainers – Navy" })).toContain("^FDKids' Trainers - Navy^FS");
  });

  it("refuses a name that doesn't fit, or that the printer can't print, instead of cutting it", () => {
    expect(() => buildLabel({ ...SPEC, name: "Navy/Grey Strap Trainers" })).toThrow(/Too wide/);
    expect(() => buildLabel({ ...SPEC, name: "W".repeat(12) })).toThrow(/Too wide/);
    expect(() => buildLabel({ ...SPEC, name: "Shoe 👟" })).toThrow(/can’t print “👟”/);
    expect(() => buildLabel({ ...SPEC, name: "Shoe\u0007" })).toThrow(/U\+0007/);
    expect(() => buildLabel({ ...SPEC, name: "   " })).toThrow(/no name/);
  });
});

describe("printing and reprinting", () => {
  const nameField = (zpl: string) => zpl.split("\n").filter((line) => line.startsWith("^FO28,14"));

  it("prints the same name on an all-sizes print and on a single-size reprint", () => {
    const name = labelNameFor({ labelName: null, name: "Kids’ Trainers" }).text;
    const all = buildLabels([
      { name, size: 30, barcode: "KNS00000021", quantity: 4 },
      { name, size: 31, barcode: "KNS00000149", quantity: 2 },
    ]);
    const reprint = buildLabels([{ name, size: 31, barcode: "KNS00000149", quantity: 1 }]);
    expect(nameField(reprint)).toEqual(["^FO28,14^A0N,26,26^FB228,1,0,L^FDKids' Trainers^FS"]);
    expect(nameField(all)).toEqual([nameField(reprint)[0], nameField(reprint)[0]]);
  });

  it("uses the label name once there is one", () => {
    const name = labelNameFor({ labelName: "Navy/Grey Trainers", name: "Kids’ Navy and Grey Double-Strap Sports Trainers" });
    expect(name).toMatchObject({ source: "label-name", text: "Navy/Grey Trainers", fits: true, problem: null });
    expect(nameField(buildLabel({ ...SPEC, name: name.text }))).toEqual(["^FO28,14^A0N,26,26^FB228,1,0,L^FDNavy/Grey Trainers^FS"]);
  });
});

describe("sizes and quantities", () => {
  it("formats EU sizes", () => {
    expect(labelSize(42)).toBe("EU 42");
    expect(labelSize(42.5)).toBe("EU 42.5");
    expect(labelSize(19.0)).toBe("EU 19");
  });

  it("defaults to 1 for pre-loved and to the stock for new shoes", () => {
    expect(defaultQuantity("preloved", 1)).toBe(1);
    expect(defaultQuantity("preloved", 0)).toBe(1);
    expect(defaultQuantity("new", 7)).toBe(7);
    expect(defaultQuantity("new", 0)).toBe(1);
    expect(defaultQuantity("new", 500)).toBe(100);
  });

  it("parses quantities from 1 (or 0) to 100", () => {
    expect(parseQuantity("3")).toBe(3);
    expect(parseQuantity(" 100 ")).toBe(100);
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("0", { allowZero: true })).toBe(0);
    for (const value of ["101", "-1", "1.5", "", "abc", null]) expect(parseQuantity(value), String(value)).toBeNull();
  });
});

describe("calibration labels", () => {
  const file = calibrationLabels();

  it("has four labels, each printed once, with a comment saying what it tests", () => {
    expect(file.match(/\^XA/g)).toHaveLength(4);
    expect(file.match(/\^PQ1,0,1,N/g)).toHaveLength(4);
    expect(file.match(/\^FX Calibration [1234]/g)).toHaveLength(4);
  });

  it("prints names at (or close to) the width limit, which the check accepts", () => {
    const names = CALIBRATION_NAMES.map((name) => labelNameFor({ labelName: name, name: "" }));
    for (const name of names) expect(name.fits, name.text).toBe(true);
    expect(names.map((name) => name.widthDots)).toEqual([222, 213, 220, NAME_MAX_DOTS]);
    // One more of the widest or the narrowest character no longer fits.
    expect(labelNameFor({ labelName: "W".repeat(12), name: "" }).fits).toBe(false);
    expect(labelNameFor({ labelName: "l".repeat(38), name: "" }).fits).toBe(false);
  });

  it("includes the reference name that printed on one line before", () => {
    expect(file).toContain("^FO28,14^A0N,26,26^FB228,1,0,L^FDNew Balance 574 Wh^FS");
    expect(file).toContain("^FDÉcru Navy Trainers 31^FS");
  });

  it("uses the same layout as real labels", () => {
    expect(file.match(/\^FO266,14\^A0N,26,26\^FB112,1,0,R\^FDEU 42\.5\^FS/g)).toHaveLength(4);
    expect(file.match(/\^FO80,46\^BCN,88,N,N,N,N/g)).toHaveLength(4);
    expect(file).not.toContain("^TB");
  });

  it("uses KNS barcodes with correct check digits", () => {
    for (const barcode of ["KNS99999992", "KNS00000013", "KNS12345671", "KNS00000021"]) expect(file).toContain(`^FD${barcode}^FS`);
    expect(file).not.toMatch(/\^FDU\d/);
  });
});
