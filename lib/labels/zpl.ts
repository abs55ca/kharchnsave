import { isValidBarcode } from "@/lib/barcodes/code";
import { fullName } from "@/lib/catalog/product-utils";

/*
 * Shelf labels for the shop's Zebra printer: 2 × 1 inch labels at 203 dpi
 * (406 × 203 dots), ZPL. Each label has a short shoe name, the EU size, a
 * Code 128 barcode and the barcode's readable ID underneath. No shop
 * branding, and no price (prices change; the barcode looks them up).
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

// Printed and checked on the ZD888: an 18-character name ("New Balance 574 Wh")
// and "EU 42.5" each fit on one line. Both text boxes keep at least 28 dots
// (3.5 mm) from the label's edges.
const LAYOUT = {
  topY: 14,
  topFont: 26,
  // The name's field ends before the size's field starts, so even a name
  // wider than expected wraps inside its own box and never reaches the size.
  nameX: 28,
  nameWidth: 228, // x 28–256
  sizeX: 266,
  sizeWidth: 112, // x 266–378
  barcodeY: 46,
  idY: 145,
  idFont: 30,
} as const;

/** Longest short name; checked with the calibration labels below. */
export const LABEL_NAME_MAX = 18;
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
 * trailing run of an even number of digits, e.g. U00000013 → ">:U>500000013":
 * 6 symbols, 101 modules, 202 dots. Explicit switches make the width exact.
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
 * Text safe inside a ZPL field: no ^ or ~ (command prefixes) or \ (escape),
 * no control characters, and only characters the printer's font has.
 */
export function labelText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\^~\\]/g, " ")
    .replace(/[^ -~ -ÿ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Brand and name, shortened to whole words that fit LABEL_NAME_MAX, e.g.
 * "New Balance Fresh Foam X 1080" → "New Balance Fresh". A first word that
 * is too long on its own is cut.
 */
export function shortLabelName(brand: string, name: string, max = LABEL_NAME_MAX) {
  const text = labelText(fullName({ brand, name }));
  if (text.length <= max) return text;
  let short = "";
  for (const word of text.split(" ")) {
    const next = short ? `${short} ${word}` : word;
    if (next.length > max) break;
    short = next;
  }
  return short || text.slice(0, max);
}

/** An admin's own short name for this print, or the default. */
export function chooseLabelName(custom: unknown, fallback: string) {
  const text = typeof custom === "string" ? labelText(custom).slice(0, LABEL_NAME_MAX).trim() : "";
  return text || fallback;
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
  /** Already shortened (shortLabelName / chooseLabelName). */
  name: string;
  size: number;
  barcode: string;
  quantity: number;
};

/** One label format, printed `quantity` times. */
export function buildLabel(
  spec: LabelSpec,
  { nameBlock = "FB", comment }: { nameBlock?: "FB" | "TB"; comment?: string } = {},
) {
  if (!isValidBarcode(spec.barcode)) throw new Error("Not a valid barcode.");
  if (!Number.isInteger(spec.quantity) || spec.quantity < 1 || spec.quantity > LABEL_QUANTITY_MAX) {
    throw new Error(`Print 1 to ${LABEL_QUANTITY_MAX} labels.`);
  }
  const plan = planCode128(spec.barcode);
  if (plan.dots > MAX_SYMBOL_DOTS) throw new Error("The barcode is too wide for the label.");
  const barcodeX = Math.floor((LABEL.widthDots - plan.dots) / 2);
  const name = labelText(spec.name);
  const nameField =
    nameBlock === "TB"
      ? `^TBN,${LAYOUT.nameWidth},${LAYOUT.topFont + 4}`
      : `^FB${LAYOUT.nameWidth},1,0,L`;

  return [
    "^XA",
    ...(comment ? [`^FX ${labelText(comment)}`] : []),
    "^CI28",
    `^PW${LABEL.widthDots}`,
    `^LL${LABEL.heightDots}`,
    `^LT${LABEL.topDots}`,
    `^PR${LABEL.printSpeed}`,
    "^LH0,0",
    `^FO${LAYOUT.nameX},${LAYOUT.topY}^A0N,${LAYOUT.topFont},${LAYOUT.topFont}${nameField}^FD${name}^FS`,
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
 * Three test labels for checking the layout on the printer:
 * 1. the worst case: 18 × "W" (wider than the name's box, so it overprints
 *    inside that box) next to the widest size; it must never reach the size;
 * 2. the verified reference: an 18-character name, "New Balance 574 Wh",
 *    with "EU 42.5", both on one line;
 * 3. the same as 1, but with ^TB (text block). If the firmware supports ^TB,
 *    the name is cut off inside its box; if it doesn't, the name prints
 *    across the label.
 */
export function calibrationLabels() {
  const widest = "W".repeat(LABEL_NAME_MAX);
  const labels = [
    buildLabel(
      { name: widest, size: 42.5, barcode: "U99999992", quantity: 1 },
      { comment: "Calibration 1: widest name next to the widest size" },
    ),
    buildLabel(
      { name: shortLabelName("New Balance", "574 Wh"), size: 42.5, barcode: "U00000013", quantity: 1 },
      { comment: "Calibration 2: verified 18-character name with EU 42.5" },
    ),
    buildLabel(
      { name: `${widest}WWWWWW`, size: 42.5, barcode: "U12345671", quantity: 1 },
      { nameBlock: "TB", comment: "Calibration 3: text block (TB) test" },
    ),
  ];
  return `${labels.join("\n")}\n`;
}
