/*
 * Sales by size (Pricing page): discount rules by EU size within a pricing
 * group. The database (supabase/migrations/20261124120000_size_sales.sql,
 * private.size_rules_validate / size_rule_match / size_sale_price) is the
 * authority; this copy gives the form instant checks and is tested to agree.
 * Browser-safe.
 *
 *   - A rule is one size (from = to) or an inclusive range (from < to).
 *     Sizes are whole or half EU sizes, 15 to 50, never rounded.
 *   - A single-size rule overrides a range containing that size.
 *   - Ranges may not overlap each other (boundaries included); a size may not
 *     have two single-size rules.
 *   - Unmatched sizes get the default discount, if one is set; otherwise no sale.
 *   - Sale price = regular × (1 − discount), in whole paisa, rounded half up.
 *     Always from the regular price (never compounded onto a sale price).
 */

export type SizeRule = { from: number; to: number; discountBp: number };

export const SIZE_MIN = 15;
export const SIZE_MAX = 50;
export const BP_MIN = 100; // 1%
export const BP_MAX = 9000; // 90%
export const MAX_RULES = 50;

export const isEuSize = (n: number) => Number.isFinite(n) && Number.isInteger(n * 2) && n >= SIZE_MIN && n <= SIZE_MAX;
const isBp = (n: number | null) => n !== null && Number.isInteger(n) && n >= BP_MIN && n <= BP_MAX;

/** "EU 36" or "EU 25–30". */
export const ruleLabel = (r: Pick<SizeRule, "from" | "to">) => (r.from === r.to ? `EU ${r.from}` : `EU ${r.from}–${r.to}`);

/** Problems with a rule set, each a sentence naming the row(s); empty when valid. */
export function validateSizeRules(rules: SizeRule[], defaultBp: number | null): string[] {
  const errors: string[] = [];
  if (rules.length > MAX_RULES) errors.push(`Use at most ${MAX_RULES} rules.`);
  rules.forEach((r, i) => {
    const row = `Row ${i + 1}`;
    if (!isEuSize(r.from) || !isEuSize(r.to)) errors.push(`${row}: sizes are whole or half EU sizes from ${SIZE_MIN} to ${SIZE_MAX} (e.g. 29.5).`);
    else if (r.from > r.to) errors.push(`${row}: "from" (EU ${r.from}) is above "to" (EU ${r.to}).`);
    if (!isBp(r.discountBp)) errors.push(`${row}: the discount is 1% to 90% (up to two decimals).`);
  });
  if (defaultBp !== null && !isBp(defaultBp)) errors.push("Default discount: 1% to 90% (up to two decimals), or leave it empty for no sale.");
  if (errors.length) return errors;

  rules.forEach((a, i) => {
    rules.forEach((b, j) => {
      if (j <= i) return;
      if (a.from === a.to && b.from === b.to && a.from === b.from) {
        errors.push(`Rows ${i + 1} and ${j + 1} are both single-size rules for EU ${a.from}. Keep one.`);
      } else if (a.from < a.to && b.from < b.to && a.from <= b.to && b.from <= a.to) {
        errors.push(`Rows ${i + 1} and ${j + 1} overlap (${ruleLabel(a)} and ${ruleLabel(b)}). Ranges can't share sizes; use a single-size rule to override part of a range.`);
      }
    });
  });
  return errors;
}

export type SizeMatch = { discountBp: number; label: string };

/** The discount for one EU size: a single-size rule, else a range, else the default, else none. */
export function matchSize(rules: SizeRule[], defaultBp: number | null, size: number): SizeMatch | null {
  const single = rules.find((r) => r.from === r.to && r.from === size);
  if (single) return { discountBp: single.discountBp, label: ruleLabel(single) };
  const range = rules.find((r) => r.from < r.to && r.from <= size && size <= r.to);
  if (range) return { discountBp: range.discountBp, label: ruleLabel(range) };
  return defaultBp !== null ? { discountBp: defaultBp, label: "Default" } : null;
}

/** regular × (1 − bp/10000), in whole paisa, half up (same as private.size_sale_price). */
export function sizeSalePrice(regularPaisa: number, discountBp: number): number {
  if (!Number.isSafeInteger(regularPaisa) || regularPaisa < 0) throw new RangeError("Whole paisa.");
  if (!isBp(discountBp)) throw new RangeError("Discount 1% to 90%.");
  return Math.floor((regularPaisa * (10000 - discountBp) * 2 + 10000) / 20000);
}
