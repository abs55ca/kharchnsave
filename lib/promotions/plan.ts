import { createHash } from "node:crypto";

/*
 * The promotion planner's rules (admin only; see
 * supabase/migrations/20261123120000_promotion_planner.sql). Whole paisa,
 * integers only.
 *
 * A discount percentage per product, from OPTIONS, aiming at DISTRIBUTION
 * (shares of products). Chosen once and saved; a saved percentage never
 * changes. Listings of the same model (same brand and name: its other sizes)
 * share one percentage.
 *
 * Which model gets which percentage:
 *   - Reliable age and sales data (most products listed long enough, and
 *     enough sales to compare): slower stock (more days listed per unit sold)
 *     gets the larger discounts, within the distribution.
 *   - Otherwise: seeded randomness. Models are ordered by a hash of the seed
 *     and their stable id (the smallest product id among their listings), and
 *     each takes the percentage furthest below its target share.
 *   Never from shoe size, price or pricing score.
 *
 * Proposed regular price = selling ÷ (1 − discount), rounded half up to the
 * paisa (the database works it out again and stores it; this copy is for
 * tests and display).
 */

export const OPTIONS_BP = [2000, 2500, 3000, 3500] as const;
export type DiscountBp = (typeof OPTIONS_BP)[number];

/** Target share of products per percentage (basis points of 100%). */
export const DISTRIBUTION: Record<DiscountBp, number> = { 2000: 2000, 2500: 3500, 3000: 3000, 3500: 1500 };

export const SEED = "kharchnsave-promotions-v1";

/** Age and sales count as reliable only with this much history. */
export const RELIABLE = { minListedDays: 60, shareListed: 0.8, minUnitsSold: 30 } as const;

export type Basis = "default_distribution" | "age_and_sales";

export type Candidate = {
  productId: string;
  groupKey: string;
  /** "YYYY-MM-DD" when first published; null for drafts never published. */
  listedAt: string | null;
  unitsSold: number;
  /** The saved percentage, if any. */
  assignedBp: DiscountBp | null;
};

/** selling ÷ (1 − bp/10000), half up, in paisa (same as private.promotion_proposed_regular). */
export function proposedRegular(sellingPaisa: number, discountBp: number): number {
  if (!Number.isSafeInteger(sellingPaisa) || sellingPaisa <= 0) throw new RangeError("Selling price must be a positive whole number of paisa.");
  if (!OPTIONS_BP.includes(discountBp as DiscountBp)) throw new RangeError("Discount must be 20, 25, 30 or 35%.");
  const d = 10000 - discountBp;
  return Math.floor((sellingPaisa * 20000 + d) / (2 * d));
}

/**
 * The saving and its true percentage, from the stored prices (never the nominal percentage).
 * The percentage is saving ÷ regular at full precision, then rounded half up to hundredths of a
 * percent (e.g. 204,346 ÷ 583,846 = 34.99998…% → 35.00%). Exact whole-number arithmetic: no
 * floating-point error, and no truncation.
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

export function hashOrder(seed: string, stableId: string): string {
  return createHash("sha256").update(`${seed}:${stableId}`).digest("hex");
}

export function dataReliability(candidates: Candidate[], today: string): { reliable: boolean; reason: string } {
  if (candidates.length === 0) return { reliable: false, reason: "no products" };
  const now = Date.parse(`${today}T00:00:00Z`);
  const listedLongEnough = candidates.filter((c) => c.listedAt && (now - Date.parse(`${c.listedAt}T00:00:00Z`)) / 86_400_000 >= RELIABLE.minListedDays).length;
  const units = candidates.reduce((n, c) => n + c.unitsSold, 0);
  if (listedLongEnough / candidates.length < RELIABLE.shareListed) {
    return { reliable: false, reason: `only ${listedLongEnough} of ${candidates.length} products have been listed for ${RELIABLE.minListedDays}+ days` };
  }
  if (units < RELIABLE.minUnitsSold) return { reliable: false, reason: `only ${units} pairs sold so far (needs ${RELIABLE.minUnitsSold}+)` };
  return { reliable: true, reason: `${listedLongEnough} of ${candidates.length} products listed ${RELIABLE.minListedDays}+ days; ${units} pairs sold` };
}

export type Planned = { productId: string; discountBp: DiscountBp; basis: Basis };

/**
 * Percentages for products that have none yet. Saved assignments are kept
 * (and count toward the distribution); a model that already has one passes it
 * to its new listings.
 */
export function planAssignments(candidates: Candidate[], today: string, seed = SEED): { planned: Planned[]; basis: Basis; reason: string } {
  const { reliable, reason } = dataReliability(candidates, today);
  const basis: Basis = reliable ? "age_and_sales" : "default_distribution";

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) groups.set(c.groupKey, [...(groups.get(c.groupKey) ?? []), c]);

  const counts = new Map<DiscountBp, number>(OPTIONS_BP.map((bp) => [bp, 0]));
  for (const c of candidates) if (c.assignedBp) counts.set(c.assignedBp, counts.get(c.assignedBp)! + 1);
  const total = candidates.length;
  const deficit = (bp: DiscountBp) => (DISTRIBUTION[bp] * total) / 10000 - counts.get(bp)!;

  const planned: Planned[] = [];
  const open: { key: string; members: Candidate[]; stableId: string; slowness: number }[] = [];
  for (const [key, members] of groups) {
    const saved = members.find((m) => m.assignedBp)?.assignedBp ?? null;
    const unassigned = members.filter((m) => !m.assignedBp);
    if (saved) {
      // New sizes of a model that already has a percentage.
      for (const m of unassigned) {
        planned.push({ productId: m.productId, discountBp: saved, basis });
        counts.set(saved, counts.get(saved)! + 1);
      }
      continue;
    }
    const days = members.map((m) => (m.listedAt ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${m.listedAt}T00:00:00Z`)) / 86_400_000 : 0));
    const slowness = Math.max(...days) / (members.reduce((n, m) => n + m.unitsSold, 0) + 1);
    open.push({ key, members, stableId: [...members.map((m) => m.productId)].sort()[0], slowness });
  }

  const byHash = (a: { stableId: string }, b: { stableId: string }) => hashOrder(seed, a.stableId).localeCompare(hashOrder(seed, b.stableId));
  if (reliable) {
    // Slowest first: they take the largest discount still below its share.
    open.sort((a, b) => b.slowness - a.slowness || byHash(a, b));
  } else {
    open.sort(byHash);
  }

  for (const g of open) {
    const size = g.members.length;
    const choices = [...OPTIONS_BP].filter((bp) => deficit(bp) > 0);
    let bp: DiscountBp;
    if (reliable) {
      bp = (choices.length ? choices : [...OPTIONS_BP]).sort((a, b) => b - a)[0];
    } else {
      // The percentage furthest below its share (ties: the hash decides, so it stays seeded).
      const h = parseInt(hashOrder(seed, `${g.stableId}:tie`).slice(0, 8), 16);
      const ranked = [...OPTIONS_BP].sort((a, b) => deficit(b) - deficit(a) || ((h + a) % 7) - ((h + b) % 7));
      bp = ranked[0];
    }
    for (const m of g.members) planned.push({ productId: m.productId, discountBp: bp, basis });
    counts.set(bp, counts.get(bp)! + size);
  }
  return { planned, basis, reason };
}
