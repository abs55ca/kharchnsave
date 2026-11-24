/*
 * Shapes of the Sales by size database answers
 * (supabase/migrations/20261124120000_size_sales.sql) and the reasons shown to
 * admins. Browser-safe (used by the Pricing page's client panel).
 */

export type DbSizeRule = { from: number; to: number; discount_bp: number };

export type SizeSaleLine = {
  product_id: string;
  item_code: string;
  name: string;
  brand: string;
  publication_status: string;
  sizes: number[];
  rule: string | null;
  discount_bp: number | null;
  regular_paisa: number;
  current_paisa: number;
  proposed_paisa: number | null;
  actual_hundredths: number | null;
  cost_paisa: number | null;
  /** Lowest amount kept after referral discounts and commission, when the cost is known. */
  retained_paisa: number | null;
  margin: "not_configured" | "cost_unknown" | "ok" | "violation" | null;
  status: "eligible" | "blocked" | "unchanged";
  reason: string | null;
  detail: string | null;
  was: null | { shown: boolean; price_paisa?: number | null; reason?: string; offered_since?: string };
};

export type SizeSalePlan = {
  group: { id: string; name: string; max_price_paisa: number };
  rules: DbSizeRule[];
  default_discount_bp: number | null;
  active: null | { id: string; rules: DbSizeRule[]; default_discount_bp: number | null; started_at: string; same_rules: boolean; live: number };
  lines: SizeSaleLine[];
  counts: { eligible: number; blocked: number; unchanged: number };
  token: string;
};

export type SizeSaleOverview = {
  group_id: string;
  saved: null | { rules: DbSizeRule[]; default_discount_bp: number | null; version: number; updated_at: string };
  active: null | { id: string; rules: DbSizeRule[]; default_discount_bp: number | null; started_at: string; live: number };
};

/** Why a product won't (or needn't) go on sale, in plain words. */
export const SIZE_SALE_REASONS: Record<string, string> = {
  no_rule: "No rule matches its size (and no default discount)",
  no_sizes: "It has no sizes",
  sizes_differ: "Its sizes fall under different rules; one product has one price, so it can't be split",
  already_on_this_sale: "Already on this size sale at this price",
  size_sale_running_other_rules: "In the running size sale under different rules: end that sale first",
  not_published: "Not published (a draft or archived): publish it to put it on sale",
  free_item: "It's free (price Rs. 0 or a giveaway)",
  in_campaign: "In another running sale",
  manual_sale: "It already has a sale price (set on its product page); remove that first",
  sale_too_small: "The discount leaves no valid sale price",
  margin_violation: "The sale price would break your minimum profit or margin",
  cost_unknown_with_margin_rule: "Cost unknown, and a minimum profit or margin is set",
};

export const WAS_REASONS: Record<string, string> = {
  not_published: "not published",
  not_offered_at_price: "not offered at this regular price long enough",
  offered_too_briefly: "not yet offered at this price for the minimum days",
  not_above_sale_price: "not above the sale price",
};
