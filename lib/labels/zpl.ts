import { isValidBarcode } from "@/lib/barcodes/code";
import { labelNameFor, NAME_BOX_DOTS, NAME_FONT_DOTS } from "./name-fit";

/*
 * Shelf labels for the shop's Zebra printer: 2 × 1 inch labels at 203 dpi
 * (406 × 203 dots), ZPL. Each label has the product's label name (or its
 * full name), the EU size, a Code 128 barcode and the barcode's readable ID
 * underneath. No shop branding, and no price (prices change; the barcode
 * looks them up). A name that doesn't fit is refused, never cut short
 * (./name-fit.ts).
 *
 * The positions are the ones that printed correctly on the shop's ZD888 with
 * ^LT20 (label top). Pure functions: used by the label page in the browser
 * and by the download route on the server.
 */

export const LABEL = {
  widthDots: 406,
  heightDots: 203,
  /** ^LT: label top, already saved on the printer; repeated in every label. */
  topDots: 20,
  /** ^PR: print speed. */
  printSpeed: 4,
  /** ^BY2: narrowest bar = 2 dots (0.25 mm). */
  moduleDots: 2,
  barcodeHeightDots: 88,
  /** Code 128 needs at least 10 modules of white on each side. */
  quietZoneModules: 10,
  /** Extra white on each side for the label's position varying by about 1 mm. */
  edgeToleranceDots: 8,
} as const;

// Printed and checked on the ZD888: "New Balance 574 Wh" and "EU 42.5" each
// fit on one line. Both text boxes keep at least 28 dots (3.5 mm) from the
// label's edges.
const LAYOUT = {
  topY: 14,
  topFont: NAME_FONT_DOTS,
  // The name's field ends before the size's field starts, so even a name
  // wider than expected stays inside its own box and never reaches the size.
  nameX: 28,
  nameWidth: NAME_BOX_DOTS, // x 28–256
  sizeX: 266,
  sizeWidth: 112, // x 266–378
  barcodeY: 46,
  idY: 145,
  idFont: 30,
} as const;

export const LABEL_QUANTITY_MAX = 100;
/** Longest barcode data that fits with quiet zones, even if every character is encoded in Code B. */
export const MAX_BARCODE_CHARS = 12;

/* ---------- Code 128 ---------- */

// Start (11) + check character (11) + stop (13) modules; 11 per symbol.
const code128Modules = (symbols: number) => 35 + 11 * symbols;

export type Code128Plan = {
  /** ^FD data for ^BC in mode N, with explicit code set switches. */
  field: string;
  modules: number;
  dots: number;
};

/**
 * Encodes data as Code B, switching to Code C (two digits per symbol) for a
 * trailing run of an even number of digits, e.g. KNS00000013 → ">:KNS>500000013":
 * 8 symbols, 123 modules, 246 dots. Explicit switches make the width exact.
 */
export function planCode128(data: string): Code128Plan {
  if (!/^[A-Z0-9.-]+$/.test(data)) throw new Error("Barcode data must be capital letters, digits, hyphens or full stops.");
  if (data.length > MAX_BARCODE_CHARS) throw new Error(`Barcode data can be at most ${MAX_BARCODE_CHARS} characters.`);

  const split = /^(.*?)((?:[0-9]{2}){2,})$/.exec(data);
  let field: string;
  let symbols: number;
  if (split && split[1] === "") {
    field = `>;${split[2]}`;
    symbols = split[2].length / 2;
  } else if (split) {
    field = `>:${split[1]}>5${split[2]}`;
    symbols = split[1].length + 1 + split[2].length / 2;
  } else {
    field = `>:${data}`;
    symbols = data.length;
  }
  const modules = code128Modules(symbols);
  return { field, modules, dots: modules * LABEL.moduleDots };
}

/** Width a symbol may use: the label minus quiet zones and position tolerance on both sides. */
export const MAX_SYMBOL_DOTS = LABEL.widthDots - 2 * (LABEL.quietZoneModules * LABEL.moduleDots + LABEL.edgeToleranceDots);

/** Worst case (every character in Code B) for `length` characters. */
export function worstCaseCode128Dots(length: number) {
  return code128Modules(length) * LABEL.moduleDots;
}

/* ---------- Text ---------- */

/**
 * A ^FD field for printable text (already checked by ./name-fit.ts, so
 * printable ASCII and Latin-1 letters only, no control characters). ^ and ~
 * start ZPL commands even inside data, so if the text has either (or \, or
 * _, the escape character), the field gets ^FH and they're sent as hex
 * escapes (_5E, _7E, _5C, _5F) and print as themselves. Other text is sent
 * as it is (^CI28: UTF-8).
 */
export function fieldData(text: string) {
  if (!/[\^~\\_]/.test(text)) return `^FD${text}`;
  return `^FH_^FD${text.replace(/[\^~\\_]/g, (char) => `_${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** A ^FX comment: printable ASCII only, no command characters. */
function commentText(value: string) {
  return value.replace(/[^ -~]|[\^~\\]/g, " ").replace(/\s+/g, " ").trim();
}

export function labelSize(size: number) {
  return `EU ${Number(size)}`;
}

/* ---------- Quantity ---------- */

/** Pre-loved pairs are one of a kind; new shoes default to one label per pair in stock. */
export function defaultQuantity(itemStatus: "new" | "preloved", stock: number) {
  if (itemStatus === "preloved") return 1;
  return Math.min(Math.max(stock, 1), LABEL_QUANTITY_MAX);
}

/** A whole number from 0 (or 1) to LABEL_QUANTITY_MAX, or null. */
export function parseQuantity(value: unknown, { allowZero = false } = {}) {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value.trim())) return null;
  const quantity = Number(value.trim());
  return quantity >= (allowZero ? 0 : 1) && quantity <= LABEL_QUANTITY_MAX ? quantity : null;
}

/* ---------- Labels ---------- */

export type LabelSpec = {
  /** The name to print: labelNameFor(product).text. Refused if it doesn't fit. */
  name: string;
  size: number;
  barcode: string;
  quantity: number;
};

/** One label format, printed `quantity` times. */
export function buildLabel(spec: LabelSpec, { comment }: { comment?: string } = {}) {
  if (!isValidBarcode(spec.barcode)) throw new Error("Not a valid barcode.");
  if (!Number.isInteger(spec.quantity) || spec.quantity < 1 || spec.quantity > LABEL_QUANTITY_MAX) {
    throw new Error(`Print 1 to ${LABEL_QUANTITY_MAX} labels.`);
  }
  const name = labelNameFor({ labelName: spec.name, name: "" });
  if (name.problem) throw new Error(name.problem);
  const plan = planCode128(spec.barcode);
  if (plan.dots > MAX_SYMBOL_DOTS) throw new Error("The barcode is too wide for the label.");
  const barcodeX = Math.floor((LABEL.widthDots - plan.dots) / 2);

  return [
    "^XA",
    ...(comment ? [`^FX ${commentText(comment)}`] : []),
    "^CI28",
    `^PW${LABEL.widthDots}`,
    `^LL${LABEL.heightDots}`,
    `^LT${LABEL.topDots}`,
    `^PR${LABEL.printSpeed}`,
    "^LH0,0",
    `^FO${LAYOUT.nameX},${LAYOUT.topY}^A0N,${LAYOUT.topFont},${LAYOUT.topFont}^FB${LAYOUT.nameWidth},1,0,L${fieldData(name.text)}^FS`,
    `^FO${LAYOUT.sizeX},${LAYOUT.topY}^A0N,${LAYOUT.topFont},${LAYOUT.topFont}^FB${LAYOUT.sizeWidth},1,0,R^FD${labelSize(spec.size)}^FS`,
    `^BY${LABEL.moduleDots}`,
    `^FO${barcodeX},${LAYOUT.barcodeY}^BCN,${LABEL.barcodeHeightDots},N,N,N,N^FD${plan.field}^FS`,
    `^FO0,${LAYOUT.idY}^A0N,${LAYOUT.idFont},${LAYOUT.idFont}^FB${LABEL.widthDots},1,0,C^FD${spec.barcode}^FS`,
    `^PQ${spec.quantity},0,1,N`,
    "^XZ",
  ].join("\n");
}

/** Several label formats in one file (e.g. every size of a new style). */
export function buildLabels(specs: LabelSpec[]) {
  if (specs.length === 0) throw new Error("Choose at least one label.");
  return `${specs.map((spec) => buildLabel(spec)).join("\n")}\n`;
}

/**
 * Names for the calibration labels, each as wide as the width check
 * (./name-fit.ts) allows, or close to it. On the printer, every one must
 * print on a single line, clear of "EU 42.5". If one wraps or prints over
 * itself, the width model is too generous: increase NAME_SPARE_DOTS.
 */
export const CALIBRATION_NAMES = [
  // 1. The widest character: 11 × W, about 222 dots.
  "WWWWWWWWWWW",
  // 2. The reference that printed correctly before (about 213 dots).
  "New Balance 574 Wh",
  // 3. The narrowest characters: 37 × l, about 220 dots.
  "l".repeat(37),
  // 4. A typical name with accents and digits, exactly at the limit (224 dots).
  "Écru Navy Trainers 31",
] as const;

/** Four test labels for checking the name's width on the printer (CALIBRATION_NAMES), each next to EU 42.5. */
export function calibrationLabels() {
  const barcodes = ["KNS99999992", "KNS00000013", "KNS12345671", "KNS00000021"];
  const comments = [
    "Calibration 1: widest characters at the width limit",
    "Calibration 2: verified reference name",
    "Calibration 3: narrowest characters at the width limit",
    "Calibration 4: accents and digits at the width limit",
  ];
  const labels = CALIBRATION_NAMES.map((name, index) =>
    buildLabel({ name, size: 42.5, barcode: barcodes[index], quantity: 1 }, { comment: comments[index] }),
  );
  return `${labels.join("\n")}\n`;
}
