/*
 * Score pricing and sale arithmetic, in whole paisa (integers only; no
 * floating-point money). The database is the authority: these functions
 * mirror the private.* SQL functions in
 * supabase/migrations/20261121120000_score_pricing_and_sales.sql exactly, so the
 * admin pages can show an instant estimate while typing. Every price that is
 * saved or charged is worked out again by the database
 * (db-tests/pricing.test.ts checks both give the same answers).
 *
 * Rules (README, "Score pricing and sales"):
 *   calculated   = floor(maximum × score / 100)                      (paisa)
 *   spread       = with a price spread S (0-500 bp), each product's own
 *                  offset 0..S bp (spreadOffsetBp, from its id) comes off the
 *                  price AFTER the ending, rounded down to whole rupees:
 *                  floor(price × (10000 − offset) / 10000)
 *                  (20261126120000_price_spread_after_ending.sql).
 *   price ending = the highest positive whole-rupee amount ending in E
 *                  (default 95) that doesn't exceed the calculated amount;
 *                  an amount that already ends in E keeps it. None exists
 *                  (e.g. Rs. 90 with E = 95): "too small", flagged for review.
 *   score 0      = needs pricing, unless the admin explicitly made it a giveaway.
 *   sale price   = the ending rule applied to floor(regular × (10000 − bp) / 10000).
 *   badge        = floor(100 × (reference − sale) / reference), only with a
 *                  supported reference price (never derived from the discount).
 */

/** Rs. 10,00,000: the largest price the product form accepts (lib/admin/product-input.ts). */
export const MAX_PRICE_PAISA = 100_000_000;
export const DEFAULT_ENDING = 95;

const isInt = (n: number) => Number.isSafeInteger(n);

/** Highest positive whole-rupee price ending in `ending` (0-99) not above `amountPaisa`; null if there is none. */
export function priceWithEnding(amountPaisa: number, ending: number): number | null {
  if (!isInt(amountPaisa) || !isInt(ending) || ending < 0 || ending > 99) throw new RangeError("Whole paisa and an ending of 0-99.");
  const rupees = Math.floor(amountPaisa / 100);
  const candidate = ending + 100 * Math.floor((rupees - ending) / 100);
  return candidate > 0 ? candidate * 100 : null;
}

export type ScoreResult =
  | { status: "ok"; calculatedPaisa: number; pricePaisa: number }
  | { status: "giveaway"; calculatedPaisa: 0; pricePaisa: 0 }
  | { status: "needs_pricing"; calculatedPaisa: 0; pricePaisa: null }
  | { status: "too_small"; calculatedPaisa: number; pricePaisa: null };

export const MAX_SPREAD_BP = 500;

/**
 * A product's own offset below the score price: 0..spreadBp basis points, the
 * last 8 hex digits of its id (a number) mod (spreadBp + 1). The same every
 * time, so repricing never moves it. Mirrors private.spread_offset_bp.
 */
export function spreadOffsetBp(productId: string, spreadBp: number): number {
  if (!isInt(spreadBp) || spreadBp <= 0) return 0;
  const hex = productId.replace(/-/g, "").slice(-8);
  if (!/^[0-9a-f]{8}$/i.test(hex)) throw new RangeError("Not a product id.");
  return parseInt(hex, 16) % (spreadBp + 1);
}

/** The regular price for a score (0-100) under a group maximum (paisa), then `offsetBp` (spreadOffsetBp) below it, in whole rupees. */
export function scorePrice(maxPaisa: number, score: number, ending: number, giveaway = false, offsetBp = 0): ScoreResult {
  if (!isInt(maxPaisa) || maxPaisa <= 0 || maxPaisa > MAX_PRICE_PAISA) throw new RangeError("Maximum out of range.");
  if (!isInt(score) || score < 0 || score > 100) throw new RangeError("Scores are whole numbers from 0 to 100.");
  if (score === 0) {
    return giveaway ? { status: "giveaway", calculatedPaisa: 0, pricePaisa: 0 } : { status: "needs_pricing", calculatedPaisa: 0, pricePaisa: null };
  }
  if (!isInt(offsetBp) || offsetBp < 0 || offsetBp > MAX_SPREAD_BP) throw new RangeError("Spread offsets are 0 to 500 basis points.");
  const calculated = Math.floor((maxPaisa * score) / 100);
  const scored = priceWithEnding(calculated, ending);
  if (scored === null) return { status: "too_small", calculatedPaisa: calculated, pricePaisa: null };
  // Whole numbers below 2^53, so the division and floor are exact (as the SQL's numeric).
  const price = offsetBp ? Math.floor((scored * (10000 - offsetBp)) / 1_000_000) * 100 : scored;
  return { status: "ok", calculatedPaisa: calculated, pricePaisa: price };
}

export type SaleResult = {
  /** regular × (100% − discount), rounded down to the paisa, before the price ending. */
  rawPaisa: number;
  /** The sale price after the ending rule; null when no positive price is left ("too small"). */
  pricePaisa: number | null;
  /** Extra discount the price ending added (raw − price). */
  roundingPaisa: number | null;
  /** The actual discount from the regular price, rounded down to a whole percent. */
  actualPercent: number | null;
};

/** A campaign's sale price for a regular price and a discount in basis points (100 = 1%). */
export function salePrice(regularPaisa: number, discountBp: number, ending: number): SaleResult {
  if (!isInt(regularPaisa) || regularPaisa < 0) throw new RangeError("Whole paisa.");
  if (!isInt(discountBp) || discountBp < 1 || discountBp > 9000) throw new RangeError("Discounts are 0.01% to 90%.");
  const raw = Math.floor((regularPaisa * (10000 - discountBp)) / 10000);
  const price = priceWithEnding(raw, ending);
  if (price === null || regularPaisa === 0) return { rawPaisa: raw, pricePaisa: null, roundingPaisa: null, actualPercent: null };
  return { rawPaisa: raw, pricePaisa: price, roundingPaisa: raw - price, actualPercent: Math.floor(((regularPaisa - price) * 100) / regularPaisa) };
}

/** The honest discount display: savings and a rounded-down percentage, or null without a usable reference price. */
export function displayedDiscount(referencePaisa: number | null, salePaisa: number): { savingsPaisa: number; percent: number } | null {
  if (referencePaisa === null || !isInt(referencePaisa) || !isInt(salePaisa) || salePaisa <= 0 || referencePaisa <= salePaisa) return null;
  const savings = referencePaisa - salePaisa;
  return { savingsPaisa: savings, percent: Math.floor((savings * 100) / referencePaisa) };
}

/** ceil(eligible × target / 100%): how many listings a coverage target asks for (whole listings). */
export function coverageTarget(eligibleListings: number, targetBp: number): number {
  if (!isInt(eligibleListings) || eligibleListings < 0 || !isInt(targetBp) || targetBp < 0 || targetBp > 10000) throw new RangeError("Counts and 0-100%.");
  return Math.floor((eligibleListings * targetBp + 9999) / 10000);
}

/** bp basis points of an amount, rounded half up to the paisa (private.percent_of). */
export function percentOf(amountPaisa: number, bp: number): number {
  return Math.floor((amountPaisa * bp + 5000) / 10000);
}

export type Scenario = {
  discountBp: number;
  commissionBp: number;
  discountPaisa: number;
  paidPaisa: number;
  commissionPaisa: number;
  /** What's left after the referral discount, the commission and the recorded cost; null when the cost is unknown. */
  retainedPaisa: number | null;
};

/**
 * One unit under one referral scenario (an estimate per unit: an order's
 * discount and commission are worked out once per order and shared across its
 * lines, so a line's share can differ from this by a paisa or so).
 */
export function referralScenario(pricePaisa: number, discountBp: number, commissionBp: number, costPaisa: number | null): Scenario {
  const discount = percentOf(pricePaisa, discountBp);
  const paid = pricePaisa - discount;
  const commission = percentOf(paid, commissionBp);
  return {
    discountBp,
    commissionBp,
    discountPaisa: discount,
    paidPaisa: paid,
    commissionPaisa: commission,
    retainedPaisa: costPaisa === null ? null : paid - commission - costPaisa,
  };
}

export type MarginRule = { minProfitPaisa: number | null; minMarginBp: number | null };
export type MarginStatus = "not_configured" | "cost_unknown" | "ok" | "violation";

/**
 * Checks one scenario (margin = retained ÷ what the customer pays).
 * Check every eligible scenario: the lowest cash amount need not have the lowest margin.
 */
export function marginStatus(scenario: Pick<Scenario, "paidPaisa" | "retainedPaisa">, rule: MarginRule): MarginStatus {
  if (rule.minProfitPaisa === null && rule.minMarginBp === null) return "not_configured";
  if (scenario.retainedPaisa === null) return "cost_unknown";
  if (rule.minProfitPaisa !== null && scenario.retainedPaisa < rule.minProfitPaisa) return "violation";
  if (rule.minMarginBp !== null && scenario.retainedPaisa * 10000 < rule.minMarginBp * scenario.paidPaisa) return "violation";
  return "ok";
}

/** "12.5" → 1250 basis points; null unless 0.01-90 with at most two decimals. */
export function percentToBp(text: string, { min = 1, max = 9000 } = {}): number | null {
  const match = /^\s*(\d{1,2})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp >= min && bp <= max ? bp : null;
}

/** 1250 → "12.5%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
