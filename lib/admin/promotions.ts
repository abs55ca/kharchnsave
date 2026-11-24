import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { actualDiscount, OPTIONS_BP, planAssignments, proposedRegular, type Basis, type DiscountBp } from "@/lib/promotions/plan";
import { readTimeout } from "@/lib/supabase/config";

/*
 * The promotion planner's data (public.admin_promotion_overview) and its
 * preview: saved assignments as stored, plus what the planner would assign to
 * products without one (marked "not saved yet"). Proposals only: nothing here
 * changes a price.
 */

type Verification = { supported: boolean; reason?: string; offered_since?: string } | null;

export type OverviewItem = {
  product_id: string;
  item_code: string;
  name: string;
  brand: string;
  publication_status: "draft" | "published";
  listed_at: string | null;
  group_key: string;
  mode: "auto" | "manual";
  score: number | null;
  regular_price_paisa: number;
  sale_price_paisa: number | null;
  selling_price_paisa: number;
  public_reference_paisa: number | null;
  sizes: number[];
  units_sold: number;
  assignment: null | {
    discount_bp: DiscountBp;
    basis: Basis | "model_group";
    proposed_regular_paisa: number;
    based_on_selling_paisa: number;
    assigned_at: string;
    outdated: boolean;
  };
  verification: Verification;
};

export type PromotionOverview = { reference_min_days: number | null; items: OverviewItem[] };

export async function getPromotionOverview(supabase: AdminSessionClient): Promise<PromotionOverview> {
  const { data, error } = await supabase.rpc("admin_promotion_overview").abortSignal(readTimeout());
  if (error) throw new Error(`admin_promotion_overview failed (${error.code || "no code"}).`);
  return data as PromotionOverview;
}

export type PreviewRow = {
  productId: string;
  itemCode: string;
  name: string;
  sizes: number[];
  status: "draft" | "published";
  score: number | null;
  sellingPaisa: number;
  discountBp: DiscountBp;
  saved: boolean;
  outdated: boolean;
  proposedPaisa: number;
  savingPaisa: number;
  /** The true discount from the proposed price, in hundredths of a percent (rounded half up from full precision). */
  actualHundredths: number;
  verified: boolean;
  verificationText: string;
  /** The "was" price the shop shows right now, if any (always verified). */
  publicReferencePaisa: number | null;
};

const REASONS: Record<string, string> = {
  not_published: "never offered at this price (not published)",
  not_offered_at_price: "never offered at this price",
  offered_too_briefly: "offered at this price too briefly",
};

function verificationText(v: Verification, minDays: number | null): { verified: boolean; text: string } {
  if (!v) return { verified: false, text: "Proposal only: not saved yet" };
  if (v.supported) return { verified: true, text: `Verified previous price${v.offered_since ? ` (offered since ${v.offered_since.slice(0, 10)})` : ""}` };
  const reason = REASONS[v.reason ?? ""] ?? "no verified price history";
  return { verified: false, text: `Proposal only: ${reason}${v.reason === "offered_too_briefly" && minDays ? ` (needs ${minDays} days)` : ""}` };
}

export function buildPreview(overview: PromotionOverview, today: string) {
  const { planned, basis, reason } = planAssignments(
    overview.items.map((i) => ({
      productId: i.product_id,
      groupKey: i.group_key,
      listedAt: i.listed_at,
      unitsSold: Number(i.units_sold),
      assignedBp: i.assignment?.discount_bp ?? null,
    })),
    today,
  );
  const plannedBy = new Map(planned.map((p) => [p.productId, p]));
  const rows: PreviewRow[] = overview.items.map((i) => {
    const plan = plannedBy.get(i.product_id);
    const discountBp = (i.assignment?.discount_bp ?? plan?.discountBp) as DiscountBp;
    const proposed = i.assignment && !i.assignment.outdated ? i.assignment.proposed_regular_paisa : proposedRegular(i.selling_price_paisa, discountBp);
    const actual = actualDiscount(proposed, i.selling_price_paisa);
    const v = verificationText(i.assignment ? i.verification : null, overview.reference_min_days);
    return {
      productId: i.product_id,
      itemCode: i.item_code,
      name: i.name,
      sizes: i.sizes.map(Number),
      status: i.publication_status,
      score: i.score,
      sellingPaisa: i.selling_price_paisa,
      discountBp,
      saved: !!i.assignment,
      outdated: !!i.assignment?.outdated,
      proposedPaisa: proposed,
      savingPaisa: actual.savingPaisa,
      actualHundredths: actual.percentHundredths,
      verified: v.verified,
      verificationText: v.text,
      publicReferencePaisa: i.public_reference_paisa,
    };
  });
  const distribution = Object.fromEntries(OPTIONS_BP.map((bp) => [bp, rows.filter((r) => r.discountBp === bp).length])) as Record<DiscountBp, number>;
  return {
    rows,
    basis,
    reason,
    distribution,
    unsaved: rows.filter((r) => !r.saved).length,
    outdated: rows.filter((r) => r.outdated).length,
    /** What "Save" sends: new assignments, and saved ones whose proposal is out of date (the database keeps their percentage). */
    toSave: [
      ...planned.map((p) => ({ product_id: p.productId, discount_bp: p.discountBp, basis: p.basis })),
      ...overview.items.filter((i) => i.assignment?.outdated).map((i) => ({ product_id: i.product_id, discount_bp: i.assignment!.discount_bp, basis }) ),
    ],
  };
}
