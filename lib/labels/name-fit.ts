/*
 * Whether a name fits on a shelf label (lib/labels/zpl.ts). The name prints
 * on one line in the printer's font 0 (CG Triumvirate Bold Condensed) at
 * 26 dots, in a 228-dot box (x 28–256) that ends before the size's box. The
 * box is one line (^FB…,1): a name that doesn't fit would wrap and print
 * over itself, so it is refused, never cut short. One check for every place
 * that shows or prints a label: the product form, the label page, Copy ZPL
 * and the .zpl download.
 *
 * Width model: Zebra doesn't publish font 0's character widths, so each
 * character's width is taken from Arial Narrow Bold, a condensed
 * Helvetica-style font of similar proportions, in thousandths of the font
 * height (kerning ignored; it only narrows text). Checked against the
 * printer: "New Balance 574 Wh" measures 212 dots here and prints on one
 * line. The calibration labels print the widest and narrowest characters at
 * the limit, to confirm the model on the ZD888; NAME_SPARE_DOTS is the
 * margin to adjust if they show it is off.
 */

export const NAME_FONT_DOTS = 26;
export const NAME_BOX_DOTS = 228;
/** Left free in the box for rounding in the printer's font scaler (0.5 mm). */
export const NAME_SPARE_DOTS = 4;
export const NAME_MAX_DOTS = NAME_BOX_DOTS - NAME_SPARE_DOTS;
/** Longest label name accepted at all; the width almost always limits it first. */
export const LABEL_NAME_MAX_CHARS = 40;

// Widths in 1/1000 of the font height: U+0020–U+007E, then U+00C0–U+00FF.
const ASCII_WIDTHS = [
  228, 273, 389, 456, 456, 729, 592, 195, 273, 273, 319, 479, 228, 273, 228, 228, // space ! " # $ % & ' ( ) * + , - . /
  456, 456, 456, 456, 456, 456, 456, 456, 456, 456, 273, 273, 479, 479, 479, 501, // 0–9 : ; < = > ?
  800, 592, 592, 592, 592, 547, 501, 638, 592, 228, 456, 592, 501, 683, 592, 638, // @ A–O
  547, 638, 592, 547, 501, 592, 547, 774, 547, 547, 501, 273, 228, 273, 479, 456, // P–Z [ \ ] ^ _
  273, 456, 501, 456, 501, 456, 273, 501, 501, 228, 228, 456, 228, 729, 501, 501, // ` a–o
  501, 501, 319, 456, 273, 501, 456, 638, 456, 456, 410, 319, 230, 319, 479, //      p–z { | } ~
];
const LATIN_WIDTHS = [
  592, 592, 592, 592, 592, 592, 820, 592, 547, 547, 547, 547, 228, 228, 228, 228, // À–Ï
  592, 592, 638, 638, 638, 638, 638, 0, 638, 592, 592, 592, 592, 547, 547, 501,   // Ð–ß (× not printed)
  456, 456, 456, 456, 456, 456, 729, 456, 456, 456, 456, 456, 228, 228, 228, 228, // à–ï
  501, 501, 501, 501, 501, 501, 501, 0, 501, 501, 501, 501, 501, 456, 501, 456,   // ð–ÿ (÷ not printed)
];

/** Width of one character, or null if the label can't print it. */
function charWidth(char: string): number | null {
  const code = char.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return ASCII_WIDTHS[code - 0x20];
  if (code >= 0xc0 && code <= 0xff) return LATIN_WIDTHS[code - 0xc0] || null;
  return null;
}

// Typographic punctuation, printed as the plain character (the preview says so).
const PLAIN: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "‐": "-", "‑": "-", "–": "-", "—": "-", "−": "-",
};

/** Runs of spaces (and tabs or line breaks) made one space, trimmed: how a typed label name is stored. */
export function tidyLabelName(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** The text as it prints: compatibility forms unified (e.g. "…" → "..."), typographic punctuation made plain, spaces tidied. */
export function printedText(value: string) {
  return tidyLabelName(value.normalize("NFKC").replace(/[‘’‚′“”„″‐‑–—−]/g, (char) => PLAIN[char]));
}

/** How a character the label can't print is named in a message: itself, or its code if it's invisible. */
function describeChar(char: string) {
  return /[\p{C}\p{Z}\p{M}]/u.test(char)
    ? `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    : `“${char}”`;
}

export type NameFit = {
  /** What prints. */
  text: string;
  /** Estimated printed width in dots, rounded up (characters the label can't print aren't counted). */
  widthDots: number;
  /** Characters the label can't print, as they're named in messages. */
  unsupported: string[];
  fits: boolean;
};

export function measureLabelName(value: string): NameFit {
  const text = printedText(value);
  let units = 0;
  const unsupported = new Set<string>();
  for (const char of text) {
    const width = charWidth(char);
    if (width === null) unsupported.add(char);
    else units += width;
  }
  const widthDots = Math.ceil((units * NAME_FONT_DOTS) / 1000);
  return {
    text,
    widthDots,
    unsupported: [...unsupported].map(describeChar),
    fits: text !== "" && unsupported.size === 0 && widthDots <= NAME_MAX_DOTS,
  };
}

export type LabelNameSource = "label-name" | "product-name";

export type LabelName = NameFit & {
  /** The product's own label name, or its full name when that's blank. */
  source: LabelNameSource;
  /** Why it can't be printed, or null if it can. */
  problem: string | null;
};

const list = (items: string[]) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The name printed on a product's labels: its label name, or its full
 * product name when that's blank. Never shortened: if it can't be printed,
 * `problem` says why and what to do.
 */
export function labelNameFor(product: { labelName?: string | null; name: string }): LabelName {
  const own = tidyLabelName(product.labelName ?? "");
  const source: LabelNameSource = own ? "label-name" : "product-name";
  const fit = measureLabelName(own || product.name);
  let problem: string | null = null;
  if (fit.text === "") {
    problem = "There is no name to print. Add a label name.";
  } else if (fit.unsupported.length > 0) {
    const them = fit.unsupported.length === 1 ? "it" : "them";
    problem =
      source === "label-name"
        ? `The label printer can’t print ${list(fit.unsupported)}. Remove ${them} from the label name.`
        : `The label printer can’t print ${list(fit.unsupported)} in the product name. Add a label name without ${them}.`;
  } else if (!fit.fits) {
    problem =
      source === "label-name"
        ? `Too wide for the label: about ${fit.widthDots} dots, and there’s room for ${NAME_MAX_DOTS}. Shorten the label name.`
        : `The product name is too wide for the label (about ${fit.widthDots} dots; there’s room for ${NAME_MAX_DOTS}). Add a shorter label name before printing.`;
  }
  return { ...fit, source, problem };
}
