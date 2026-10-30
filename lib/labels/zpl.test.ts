import { describe, expect, it } from "vitest";
import { formatBarcode } from "@/lib/barcodes/code";
import {
  buildLabel,
  buildLabels,
  calibrationLabels,
  chooseLabelName,
  defaultQuantity,
  LABEL,
  LABEL_NAME_MAX,
  labelSize,
  labelText,
  MAX_BARCODE_CHARS,
  MAX_SYMBOL_DOTS,
  parseQuantity,
  planCode128,
  shortLabelName,
  worstCaseCode128Dots,
} from "./zpl";

const SPEC = { name: "Nike Air Max", size: 42.5, barcode: "U00000013", quantity: 1 };

/** The ^FO x position of the barcode field. */
const barcodeX = (zpl: string) => Number(/\^FO(\d+),\d+\^BC/.exec(zpl)?.[1]);

describe("barcode width", () => {
  it("encodes our barcodes as Code B + Code C pairs: 101 modules, 202 dots", () => {
    expect(planCode128("U00000013")).toEqual({ field: ">:U>500000013", modules: 101, dots: 202 });
  });

  it("fits inside the label with quiet zones and position tolerance", () => {
    const quiet = LABEL.quietZoneModules * LABEL.moduleDots;
    expect(MAX_SYMBOL_DOTS).toBe(406 - 2 * (20 + 8));
    for (const barcode of ["U00000013", formatBarcode(9_999_999)]) {
      const zpl = buildLabel({ ...SPEC, barcode });
      const x = barcodeX(zpl);
      const width = planCode128(barcode).dots;
      expect(x, "left white").toBeGreaterThanOrEqual(quiet + LABEL.edgeToleranceDots);
      expect(LABEL.widthDots - x - width, "right white").toBeGreaterThanOrEqual(quiet + LABEL.edgeToleranceDots);
      expect(x).toBe(102);
    }
  });

  it("still fits if the printer used Code B for every character", () => {
    expect(worstCaseCode128Dots("U00000013".length)).toBe(268);
    expect(worstCaseCode128Dots("U00000013".length)).toBeLessThanOrEqual(MAX_SYMBOL_DOTS);
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
    for (const data of ["U0^XZ", "U0~JA", "U0>5", "u00000013", "U 0"]) expect(() => planCode128(data), data).toThrow();
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
    expect(zpl).toContain("^BY2\n^FO102,46^BCN,88,N,N,N,N^FD>:U>500000013^FS");
    expect(zpl).toContain("^FO0,145^A0N,30,30^FB406,1,0,C^FDU00000013^FS");
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
    expect(() => buildLabel({ ...SPEC, barcode: "U00000014" })).toThrow();
  });

  it("puts several sizes in one file, one format each", () => {
    const file = buildLabels([
      { ...SPEC, size: 30, barcode: "U00000021", quantity: 5 },
      { ...SPEC, size: 31, barcode: "U00000149", quantity: 2 },
    ]);
    expect(file.match(/\^XA/g)).toHaveLength(2);
    expect(file.match(/\^XZ/g)).toHaveLength(2);
    expect(file).toContain("^FDEU 30^FS");
    expect(file).toContain("^PQ5,0,1,N");
    expect(file).toContain("^PQ2,0,1,N");
    expect(() => buildLabels([])).toThrow();
  });

  it("cannot be broken by a product name", () => {
    const evil = buildLabel({ ...SPEC, name: "Shoe^XZ^XA~JA\\&^FDx" });
    expect(evil.match(/\^XA/g)).toHaveLength(1);
    expect(evil.match(/\^XZ/g)).toHaveLength(1);
    expect(evil).not.toContain("~");
    expect(evil).not.toContain("\\");
  });
});

describe("short names", () => {
  it("keeps names that fit", () => {
    expect(shortLabelName("Nike", "Air Max 90")).toBe("Nike Air Max 90");
    expect(shortLabelName("Unbranded", "Canvas sneakers")).toBe("Canvas sneakers");
  });

  it(`cuts at a whole word to at most ${LABEL_NAME_MAX} characters`, () => {
    expect(shortLabelName("New Balance", "Fresh Foam X 1080v12")).toBe("New Balance Fresh");
    const exact = "Abcdefghi Klmnopqr"; // 18
    expect(shortLabelName("Unbranded", exact)).toBe(exact);
    expect(shortLabelName("Unbranded", `${exact} x`)).toBe(exact);
  });

  it("cuts a single long word", () => {
    expect(shortLabelName("Superlongbrandnamewithoutspaces", "X")).toBe("Superlongbrandname");
  });

  it("tidies whitespace and keeps accented letters the font has", () => {
    expect(shortLabelName("  Clarks ", " Désert   Boot ")).toBe("Clarks Désert Boot");
    expect(labelText("Shoe 👟 one")).toBe("Shoe one");
  });

  it("lets an admin choose a name for one print, within the limit", () => {
    expect(chooseLabelName("  Kids canvas  ", "Default")).toBe("Kids canvas");
    expect(chooseLabelName("", "Default")).toBe("Default");
    expect(chooseLabelName(null, "Default")).toBe("Default");
    expect(chooseLabelName("A".repeat(30), "Default")).toHaveLength(LABEL_NAME_MAX);
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

  it("has three labels, each printed once, with a comment saying what it tests", () => {
    expect(file.match(/\^XA/g)).toHaveLength(3);
    expect(file.match(/\^PQ1,0,1,N/g)).toHaveLength(3);
    expect(file.match(/\^FX Calibration [123]/g)).toHaveLength(3);
  });

  it("tests the widest name, the verified 18-character name and the text block command", () => {
    expect(file).toContain(`^FD${"W".repeat(LABEL_NAME_MAX)}^FS`);
    expect("New Balance 574 Wh").toHaveLength(LABEL_NAME_MAX);
    expect(file).toContain("^FO28,14^A0N,26,26^FB228,1,0,L^FDNew Balance 574 Wh^FS");
    expect(file).toContain("^FO28,14^A0N,26,26^TBN,228,30^FD");
  });

  it("uses the same layout as real labels", () => {
    expect(file.match(/\^FO266,14\^A0N,26,26\^FB112,1,0,R\^FDEU 42\.5\^FS/g)).toHaveLength(3);
    expect(file.match(/\^FO102,46\^BCN,88,N,N,N,N/g)).toHaveLength(3);
  });
});
