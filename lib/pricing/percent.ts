/*
 * Discount percentages for display, in whole hundredths of a percent, from
 * whole-paisa prices. Exact integer arithmetic (no floating point), rounded
 * half up. Safe to import in the browser.
 */

/**
 * The saving and its true percentage, from the stored prices (never a nominal percentage).
 * saving ÷ regular at full precision, then rounded half up to hundredths of a percent
 * (204,346 ÷ 583,846 = 34.99998…% → 35.00%).
 */
export function actualDiscount(regularPaisa: number, sellingPaisa: number): { savingPaisa: number; percentHundredths: number } {
  if (!Number.isSafeInteger(regularPaisa) || !Number.isSafeInteger(sellingPaisa) || regularPaisa <= 0) {
    throw new RangeError("Prices must be whole paisa, the regular price above zero.");
  }
  const saving = regularPaisa - sellingPaisa;
  // round(saving × 10000 ÷ regular), half up: floor((2 × saving × 10000 + regular) ÷ (2 × regular)).
  return { savingPaisa: saving, percentHundredths: Math.floor((saving * 20000 + regularPaisa) / (2 * regularPaisa)) };
}

/** Hundredths of a percent for display, always two decimals: 3500 → "35.00%". */
export function formatPercentHundredths(hundredths: number): string {
  if (!Number.isSafeInteger(hundredths)) throw new RangeError("Whole hundredths of a percent.");
  const sign = hundredths < 0 ? "-" : "";
  const abs = Math.abs(hundredths);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}
