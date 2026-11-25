import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import type { SizeSaleOverview } from "@/lib/pricing/size-sale-types";
import { readTimeout } from "@/lib/supabase/config";

/*
 * Score pricing and sale campaigns for the admin pages. Every read and write
 * goes through the database functions in
 * supabase/migrations/20261121120000_score_pricing_and_sales.sql (verified
 * admins only); this file only types their answers and words their errors.
 * Costs, scores, margins and pricing history never leave the admin area.
 */

export type PricingSettings = {
  price_ending_rupees: number;
  min_profit_paisa: number | null;
  min_margin_bp: number | null;
  reference_min_days: number | null;
  new_sale_target_bp: number;
  preloved_sale_target_bp: number;
  /** 0-500: each automatic price is up to this much below the score price (20261125120000_price_spread.sql; missing before it). */
  price_spread_bp?: number;
  version: number;
};

export type PricingGroup = { id: string; name: string; max_price_paisa: number; version: number; auto: number; manual: number };

export type AgentTerms = { discount_bp: number; commission_bp: number; applies_to_sale_items: boolean | null; agents: number };

export type PricingOverview = {
  settings: PricingSettings;
  groups: PricingGroup[];
  agents: { enabled: number; excluding_sale_items: number; terms: AgentTerms[] };
  counts: { auto: number; manual: number; needs_pricing: number; out_of_date: number; unknown_cost: number };
};

export type Calculation = { status: "ok" | "giveaway" | "needs_pricing" | "too_small" | "not_set"; calculated_paisa: number | null; price_paisa: number | null; spread_bp?: number };

export type PricingProduct = {
  product_id: string;
  item_code: string;
  name: string;
  brand: string;
  item_status: "new" | "preloved";
  publication_status: "draft" | "published" | "archived";
  listed_at: string | null;
  stock: number;
  price_paisa: number;
  sale_price_paisa: number | null;
  reference_price_paisa: number | null;
  mode: "manual" | "auto";
  group_id: string | null;
  group_name: string | null;
  max_price_paisa: number | null;
  score: number | null;
  cost_paisa: number | null;
  giveaway: boolean;
  pricing_version: number;
  product_version: number;
  campaign: { id: string; name: string } | null;
  calculation: Calculation | null;
};

export type Scenario = {
  kind: "no_code" | "referral";
  agents: number;
  discount_bp: number;
  commission_bp: number;
  discount_paisa: number;
  paid_paisa: number;
  commission_paisa: number;
  retained_paisa: number | null;
};

export type Economics = {
  price_paisa: number;
  cost_paisa: number | null;
  on_sale: boolean;
  referral_allowed: boolean;
  scenarios: Scenario[];
  worst: Scenario;
  margin: "not_configured" | "cost_unknown" | "ok" | "violation";
  agents_enabled: number;
  agents_excluded: number;
};

type State = { mode: string; group_id: string | null; score: number | null; cost_paisa: number | null; giveaway: boolean; price_paisa: number; sale_price_paisa: number | null; reference_price_paisa: number | null };

export type PlanLine = {
  product_id: string;
  item_code?: string;
  name?: string;
  brand?: string;
  item_status?: "new" | "preloved";
  publication_status?: string;
  stock?: number;
  group_name?: string | null;
  max_price_paisa?: number | null;
  from?: State;
  to?: State;
  calculation?: Calculation | null;
  proposed?: { price_paisa: number; sale_price_paisa: number | null; sale: SaleCalc | null };
  campaign?: { id: string; name: string; discount_bp: number } | null;
  badge_from?: number | null;
  badge_to?: number | null;
  economics?: Economics;
  override_reason?: string | null;
  action: "apply" | "unchanged" | "skip";
  reason: string | null;
};

export type SaleCalc = { raw_paisa: number; price_paisa: number | null; rounding_paisa: number | null; actual_percent: number | null };

export type Plan = {
  kind: "product_pricing" | "reprice";
  lines: PlanLine[];
  summary: { apply: number; unchanged: number; skip: number; price_changes: number };
  groups?: { group_id: string; name: string; max_from: number; max_to: number }[];
  token: string;
};

export type ProductPricing = {
  product_id: string;
  item_code: string;
  name: string;
  item_status: "new" | "preloved";
  publication_status: string;
  price_paisa: number;
  sale_price_paisa: number | null;
  reference_price_paisa: number | null;
  mode: "manual" | "auto";
  group_id: string | null;
  score: number | null;
  cost_paisa: number | null;
  giveaway: boolean;
  pricing_version: number;
  campaign: { id: string; name: string; discount_bp: number } | null;
  reference: { reference_price_paisa: number | null; offered_price_paisa: number | null; offered_since: string | null; offered_until: string | null; unsupported_reason: string | null } | null;
  economics: Economics;
  history: { regular_price_paisa: number; sale_price_paisa: number | null; reference_price_paisa: number | null; publication_status: string; reason: string; created_at: string }[];
  settings: PricingSettings;
  groups: { id: string; name: string; max_price_paisa: number }[];
};

export type CampaignStatus = "draft" | "scheduled" | "active" | "ended" | "cancelled";

export type Campaign = {
  id: string;
  name: string;
  preset: "new" | "preloved_recent" | "preloved_slow" | "clearance" | "custom";
  discount_bp: number;
  starts_at: string;
  ends_at: string | null;
  referral_allowed: boolean;
  require_reference: boolean;
  status: CampaignStatus;
  version: number;
  started_at: string | null;
  ended_at: string | null;
  end_reason: "admin" | "schedule" | null;
  /** By the database's clock. */
  starts_in_future: boolean;
  due: "start" | "end" | null;
  included?: number;
  kept_regular?: number;
  live?: number;
};

export type CampaignLine = {
  product_id: string;
  item_code: string;
  name: string;
  brand: string;
  item_status: "new" | "preloved";
  publication_status: string;
  stock: number;
  listed_at: string | null;
  included: boolean;
  note: string | null;
  override_reason: string | null;
  action: "apply" | "skip" | "keep" | "remove" | "kept_regular" | "planned" | "closed";
  reason: string | null;
  regular_paisa: number;
  sale_paisa: number | null;
  sale: SaleCalc | null;
  reference_paisa: number | null;
  reference: { supported: boolean; reason?: string; offered_since?: string; price_paisa?: number } | null;
  badge_percent: number | null;
  economics: Economics | null;
  cost_paisa: number | null;
};

export type CampaignPlan = {
  campaign: Campaign;
  lines: CampaignLine[];
  overlaps: { id: string; name: string; status: string; starts_at: string; ends_at: string | null }[];
  summary: { apply: number; keep: number; remove: number; skip: number; planned: number; kept_regular: number; no_badge: number; rounding_paisa: number };
  token: string;
};

export type Candidate = {
  product_id: string;
  item_code: string;
  name: string;
  brand: string;
  item_status: "new" | "preloved";
  publication_status: string;
  listed_at: string | null;
  stock: number;
  price_paisa: number;
  sale_price_paisa: number | null;
  group_id: string | null;
  group_name: string | null;
  score: number | null;
  cost_paisa: number | null;
  eligible: boolean;
  selection: "included" | "excluded" | null;
  note: string | null;
  override_reason: string | null;
  other_campaign: string | null;
};

export type StatusCoverage = { eligible: number; on_sale: number; no_badge: number; target_bp: number; target: number; coverage_bp: number | null; gap: number };

export type Coverage = {
  settings: PricingSettings;
  current_campaign: Campaign | null;
  statuses: { new: StatusCoverage; preloved: StatusCoverage };
  needs_review: { product_id: string; item_code: string; name: string; item_status: string; listed_at: string | null }[];
  no_badge: { product_id: string; item_code: string; name: string; item_status: string; reason: string }[];
  kept_regular: { product_id: string; item_code: string; name: string; item_status: string; note: string | null }[];
  skipped: { product_id: string; item_code: string; name: string; item_status: string; reason: string }[];
  manual_sales: number;
  agents: { enabled: number; excluding_sale_items: number; preloved_on_sale: number; preloved_eligible: number };
};

export type ScheduleHealth = {
  heartbeat: { last_started_at: string | null; last_succeeded_at: string | null; last_failed_at: string | null; last_error: string | null; consecutive_failures: number } | null;
  overdue: Campaign[];
};

export class PricingDataError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
  }
}

/** PostgREST's "function not found": the migration that adds it isn't applied to this database. */
export const isMissingFunction = (error: unknown) => error instanceof PricingDataError && error.code === "PGRST202";

async function read<T>(supabase: AdminSessionClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args).abortSignal(readTimeout());
  if (error) throw new PricingDataError(`${fn} failed (${error.code || "no code"}).`, error.code || null);
  return data as T;
}

export const getPricingOverview = (s: AdminSessionClient) => read<PricingOverview>(s, "admin_pricing_overview");
export const getPricingProducts = (s: AdminSessionClient, filter: Record<string, unknown>) =>
  read<{ total: number; items: PricingProduct[] }>(s, "admin_pricing_products", { p_filter: filter });
export const getProductPricing = (s: AdminSessionClient, productId: string) => read<ProductPricing | null>(s, "admin_product_pricing", { p_product_id: productId });
export const listCampaigns = (s: AdminSessionClient) => read<Campaign[]>(s, "admin_list_campaigns");
export const getCampaign = (s: AdminSessionClient, id: string) => read<CampaignPlan | null>(s, "admin_get_campaign", { p_campaign_id: id });
export const getCampaignCandidates = (s: AdminSessionClient, id: string) => read<Candidate[]>(s, "admin_campaign_candidates", { p_campaign_id: id });
export const getCoverage = (s: AdminSessionClient) => read<Coverage>(s, "admin_sale_coverage");
export const getScheduleHealth = (s: AdminSessionClient) => read<ScheduleHealth>(s, "admin_sale_schedule_health");
export const getSizeSaleOverview = (s: AdminSessionClient, groupId: string) => read<SizeSaleOverview>(s, "admin_size_sale_overview", { p_group_id: groupId });

/** All of a group's non-archived products (every page). */
export async function getGroupProducts(supabase: AdminSessionClient, groupId: string): Promise<PricingProduct[]> {
  const items: PricingProduct[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await read<{ total: number; items: PricingProduct[] }>(supabase, "admin_pricing_products",
      { p_filter: { group_id: groupId, limit: 500, offset } });
    items.push(...page.items);
    if (page.items.length < 500) break;
  }
  return items;
}

/** Every EU size the given products (a group's) come in, with how many products have it (for Sales by size). */
export async function getGroupSizes(supabase: AdminSessionClient, products: Pick<PricingProduct, "product_id">[]): Promise<{ size: number; products: number }[]> {
  const ids = products.map((p) => p.product_id);
  const counts = new Map<number, Set<string>>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from("product_variants").select("product_id, size_eu").in("product_id", ids.slice(i, i + 100)).abortSignal(readTimeout());
    if (error) throw new PricingDataError(`Couldn't read the group's sizes (${error.code || "no code"}).`, error.code || null);
    for (const row of (data ?? []) as { product_id: string; size_eu: number | string }[]) {
      const size = Number(row.size_eu);
      counts.set(size, (counts.get(size) ?? new Set()).add(row.product_id));
    }
  }
  return [...counts.entries()].map(([size, products]) => ({ size, products: products.size })).sort((a, b) => a.size - b.size);
}

/** Why a line wasn't (or can't be) applied, for admins. */
export const REASONS: Record<string, string> = {
  not_found: "Product not found",
  unknown_group: "That pricing group no longer exists",
  incomplete: "Automatic pricing needs a group and a score",
  giveaway_needs_score_0: "A giveaway needs automatic pricing with score 0",
  needs_pricing: "Score 0: needs pricing (or mark it as an explicit giveaway)",
  too_small: "Too small for the price ending: needs review",
  sale_too_small: "The sale price would be too small: needs review",
  manual_sale_conflict: "Its manual sale price would be at or above the new regular price",
  size_sale_running: "It's in a running size sale (Sales by size): end that sale first",
  giveaway_on_sale: "A giveaway can't be on sale",
  margin_violation: "Below the minimum profit/margin in the worst referral case",
  cost_unknown: "Cost unknown, so the minimum margin can't be checked",
  not_published: "Not published",
  free_item: "Free item",
  other_sale: "Already on another sale (manual or another campaign)",
  no_reference: "No supported reference price (this sale requires one)",
  changed_since_review: "Changed since the sale was reviewed",
};

/** Why a sale has no "was" price / badge. */
export const REFERENCE_REASONS: Record<string, string> = {
  not_published: "wasn't published at that price before the sale",
  not_offered_at_price: "was never offered at this regular price (price history)",
  offered_too_briefly: "was offered at this price for less than your minimum days",
  not_above_sale_price: "the supported reference isn't above the sale price",
  new_listing: "new listing: no price history",
  no_history_before_tracking: "on sale since before price history was kept",
};

export const PRESETS = {
  new: { label: "New shoes", range: "10–15%", discountBp: 1000, referralAllowed: true },
  preloved_recent: { label: "Recently listed pre-loved", range: "10%", discountBp: 1000, referralAllowed: true },
  preloved_slow: { label: "Slower-selling pre-loved", range: "15–20%", discountBp: 1500, referralAllowed: true },
  clearance: { label: "Clearance", range: "25–30%", discountBp: 2500, referralAllowed: true },
  custom: { label: "Custom", range: "", discountBp: 1000, referralAllowed: true },
} as const;

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  active: "Running",
  ended: "Ended",
  cancelled: "Cancelled",
};

const HINTS: Record<string, string> = {
  request_mismatch: "This form was already used for a different change. Reload the page.",
  version_conflict: "This was changed somewhere else since you opened it. Reload the page to see the latest version.",
  preview_required: "Preview the change first.",
  preview_stale: "Something changed while this was being applied. Preview again.",
  invalid_items: "Choose 1 to 200 products.",
  invalid_item: "Check the scores (0-100) and costs.",
  invalid_maximum: "Maximum prices are whole rupees from Rs. 100 to Rs. 10,00,000.",
  invalid_settings: "Check the pricing settings.",
  invalid_name: "Check the name (2-60 characters for groups, 2-80 for sales).",
  invalid_discount: "The discount is 1% to 90%.",
  invalid_window: "The sale needs a start, and its end must come after it.",
  invalid_campaign: "Check the sale's details.",
  invalid_selection: "Check the selection (notes up to 200 characters; override reasons 5-300).",
  campaign_overlap: "Another sale runs at the same time. End, cancel or reschedule one of them first.",
  campaign_scheduled: "This sale is scheduled. Unschedule it to change it.",
  campaign_closed: "This sale is over.",
  campaign_not_draft: "Only a draft sale can be edited.",
  campaign_window_passed: "This sale's end time has passed. Change its dates first.",
  bad_transition: "That change isn't possible for this sale's status.",
  unknown_group: "That pricing group no longer exists. Reload the page.",
  unknown_product: "A selected product no longer exists. Reload the page.",
};

export function describePricingError(error: { code?: string; hint?: string | null; message?: string } | null): string {
  if (!error) return "That didn't work. Reload the page and try again.";
  if (error.code === "42501") return "Your session no longer has admin access. Sign in again in a new tab, then retry.";
  if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") return "Someone else is changing prices right now. Try again in a moment.";
  // Messages written for admins by the database itself (row-by-row rule problems, or why a size sale must end first).
  if ((error.hint === "campaign_overlap" || error.hint === "invalid_size_rules" || error.hint === "size_sale_running" || error.hint === "stale") && error.message) return error.message;
  if (error.hint && HINTS[error.hint]) return HINTS[error.hint];
  if (error.code === "PT404") return "Not found. Reload the page.";
  return "That didn't work. Reload the page and try again.";
}
