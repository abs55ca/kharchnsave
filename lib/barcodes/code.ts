/*
 * In-store barcodes: "KNS" + a 7-digit serial number + a Damm check digit
 * (over the 7 digits), e.g. KNS00000013. Each size (product_variants row) gets
 * one, issued by the database (supabase/migrations/20261029200000_variant_barcodes.sql
 * and 20261030120000_kns_barcodes.sql), which uses the same check-digit table.
 * This copy lets the scan page spot a typed mistake before looking anything
 * up, and the tests check both agree.
 *
 * The first test barcodes were "U" + 8 digits (e.g. U00000084). They are all
 * retired: they still scan, and the lookup names the size's current barcode.
 * No U barcode is issued any more.
 *
 * A barcode only identifies a size: price, stock and details always come
 * from the database.
 */

export const BARCODE_PATTERN = /^KNS[0-9]{8}$/;

/** The first format, now only on retired test labels. */
export const LEGACY_BARCODE_PATTERN = /^U[0-9]{8}$/;

// "KN5…" typed by hand for "KNS…". Only this exact shape is corrected.
const KN5_TYPO = /^KN5([0-9]{8})$/;

/** Longest text the scan box accepts (item codes are at most 40 characters). */
export const SCAN_MAX_LENGTH = 40;

// Damm's table: row = interim digit, column = next digit.
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

/** Damm check digit of a string of digits (appending it makes the check 0). */
export function dammCheckDigit(digits: string) {
  if (!/^[0-9]+$/.test(digits)) throw new Error("Only digits have a check digit.");
  return [...digits].reduce((interim, digit) => DAMM[interim][Number(digit)], 0);
}

/** The barcode for a serial number, as the database issues it. */
export function formatBarcode(serial: number) {
  if (!Number.isInteger(serial) || serial < 1 || serial > 9_999_999) throw new Error("Serial out of range.");
  const digits = String(serial).padStart(7, "0");
  return `KNS${digits}${dammCheckDigit(digits)}`;
}

/** A current (KNS) barcode with a correct check digit. */
export function isValidBarcode(value: string) {
  return BARCODE_PATTERN.test(value) && dammCheckDigit(value.slice(-8)) === 0;
}

/** A retired U barcode with a correct check digit. */
export function isLegacyBarcode(value: string) {
  return LEGACY_BARCODE_PATTERN.test(value) && dammCheckDigit(value.slice(-8)) === 0;
}

/**
 * Text shaped like a barcode, current or retired, including "KN5" for "KNS".
 * Item codes can't look like this (products_item_code_not_barcode and
 * products_item_code_not_kns_barcode in the database).
 */
export function looksLikeBarcode(value: string) {
  return /^KN[S5][0-9]{8}$/.test(value) || LEGACY_BARCODE_PATTERN.test(value);
}

/** What a scanner or keyboard typed, tidied: no spaces, capital letters, "KN5…" read as "KNS…". */
export function normalizeScan(raw: unknown) {
  if (typeof raw !== "string") return "";
  const code = raw.normalize("NFKC").replace(/\s+/g, "").toUpperCase().slice(0, SCAN_MAX_LENGTH);
  return code.replace(KN5_TYPO, "KNS$1");
}

// Item codes (PL-M-1001) and SKUs (PL-M-1001-42.5).
const CODE_OR_SKU = /^[A-Z0-9]+([.-][A-Z0-9]+)*$/;

export type ScanInput =
  | { kind: "empty"; code: "" }
  /** One of our barcodes (current or retired), check digit correct. */
  | { kind: "barcode"; code: string }
  /** Shaped like one of our barcodes, but the check digit is wrong (a typo). */
  | { kind: "mistyped"; code: string }
  /** Possibly an item code or SKU. */
  | { kind: "text"; code: string }
  /** Characters no barcode, item code or SKU contains. */
  | { kind: "invalid"; code: string };

export function classifyScan(raw: unknown): ScanInput {
  const code = normalizeScan(raw);
  if (!code) return { kind: "empty", code: "" };
  if (BARCODE_PATTERN.test(code) || LEGACY_BARCODE_PATTERN.test(code)) {
    return isValidBarcode(code) || isLegacyBarcode(code) ? { kind: "barcode", code } : { kind: "mistyped", code };
  }
  return CODE_OR_SKU.test(code) ? { kind: "text", code } : { kind: "invalid", code };
}
