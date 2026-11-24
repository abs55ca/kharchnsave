"use server";

import { refresh } from "next/cache";
import { buildPreview, getPromotionOverview } from "@/lib/admin/promotions";
import { getAdminClient } from "@/lib/auth/admin";

/*
 * Saves the promotion planner's assignments (proposals only: no price, sale,
 * history, checkout or order changes; the database works out every proposed
 * price itself). Safe to repeat: saved percentages never change.
 */

export type PromotionSaveState = { ok: boolean; message: string | null };

/** Today in Pakistan time (dates in listed_at are calendar dates). */
const karachiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

export async function savePromotionPlanAction(): Promise<PromotionSaveState> {
  const { supabase } = await getAdminClient();
  if (!supabase) return { ok: false, message: "Admin access required. Sign in again (with two-step verification), then try again." };
  try {
    // Planned again from the current data, not from what the page showed earlier.
    const preview = buildPreview(await getPromotionOverview(supabase), karachiToday());
    if (preview.toSave.length === 0) return { ok: true, message: "Nothing to save: every product already has its percentage and an up-to-date proposal." };
    const { data, error } = await supabase.rpc("admin_save_promotion_assignments", { p_items: preview.toSave });
    if (error) {
      console.error("[admin] Saving the promotion plan failed:", error.code);
      return { ok: false, message: "The plan couldn’t be saved right now. Nothing changed; please try again." };
    }
    const r = data as { assigned: number; refreshed: number };
    refresh();
    return { ok: true, message: `Saved: ${r.assigned} new assignment(s), ${r.refreshed} proposal(s) refreshed. Selling prices are unchanged.` };
  } catch (error) {
    console.error("[admin] Saving the promotion plan failed:", (error as Error).message);
    return { ok: false, message: "The plan couldn’t be saved right now. Nothing changed; please try again." };
  }
}
