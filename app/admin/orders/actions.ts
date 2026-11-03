"use server";

import { refresh, updateTag } from "next/cache";
import { describeOrderError } from "@/lib/admin/orders";
import { getAdminClient } from "@/lib/auth/admin";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { rupeesToPaisa } from "@/lib/admin/product-input";

/*
 * Admin order actions. Each is a public endpoint, so each checks for a
 * verified admin (identity, current membership, aal2) and calls a database
 * function through the admin's own session; the database checks the same
 * again, along with the order's version and the allowed status changes.
 * Every form carries a request id made when the page was rendered, so a
 * double click or a retry is recognised and applied once.
 */

export type OrderActionState = { ok: boolean; message: string | null };

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

// Stock changes: the shop's cached catalogue must show them at once.
const STOCK_ACTIONS = new Set(["cancel", "dispatch", "return", "expire"]);

export async function orderAction(_previous: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) {
    return { ok: false, message: access.status === "signed-out" ? "You’ve been signed out. Sign in again in a new tab." : "Admin access required." };
  }

  const action = text(formData, "action");
  const orderId = text(formData, "orderId");
  const requestId = text(formData, "requestId");
  const version = Number(text(formData, "version"));
  if (action !== "expire" && (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(requestId) || !Number.isInteger(version))) {
    return { ok: false, message: "This form is out of date. Reload the page." };
  }
  const note = text(formData, "note") || null;
  const base = { p_order_id: orderId, p_expected_version: version, p_request_id: requestId };

  let call: PromiseLike<{ data: unknown; error: { code?: string; hint?: string | null; message?: string } | null }>;
  switch (action) {
    case "confirm":
      call = supabase.rpc("admin_confirm_order", { ...base, p_note: note });
      break;
    case "cancel":
      call = supabase.rpc("admin_cancel_order", { ...base, p_reason: text(formData, "reason"), p_note: note });
      break;
    case "dispatch":
      call = supabase.rpc("admin_dispatch_order", {
        ...base,
        p_courier: text(formData, "courier"),
        p_tracking_number: text(formData, "tracking") || null,
        p_note: note,
      });
      break;
    case "delivered":
      call = supabase.rpc("admin_mark_delivered", { ...base, p_cash_collected: formData.get("cashCollected") === "on", p_note: note });
      break;
    case "failed":
      call = supabase.rpc("admin_mark_delivery_failed", { ...base, p_note: note });
      break;
    case "return": {
      const lines = formData.getAll("itemId").map((id) => ({
        order_item_id: String(id),
        restock: Number(text(formData, `restock-${id}`) || 0),
        write_off: Number(text(formData, `writeOff-${id}`) || 0),
      }));
      call = supabase.rpc("admin_receive_return", { ...base, p_lines: lines, p_note: note });
      break;
    }
    case "payment": {
      const amount = text(formData, "amount");
      const paisa = amount ? rupeesToPaisa(amount) : null;
      if (amount && paisa === null) return { ok: false, message: "Enter the amount in rupees, e.g. 2450 or 2450.50." };
      call = supabase.rpc("admin_record_payment", {
        ...base,
        p_action: text(formData, "paymentAction"),
        p_amount_paisa: paisa,
        p_reference: text(formData, "reference") || null,
        p_note: note,
      });
      break;
    }
    case "note":
      call = supabase.rpc("admin_add_order_note", { p_order_id: orderId, p_request_id: requestId, p_note: note });
      break;
    case "expire":
      call = supabase.rpc("admin_expire_holds_now");
      break;
    default:
      return { ok: false, message: "Unknown action." };
  }

  const { data, error } = await call;
  if (error) {
    console.error(`[admin] order ${action} failed: ${error.code || "no code"}${error.hint ? ` (${error.hint})` : ""}`);
    return { ok: false, message: describeOrderError(error) };
  }

  if (STOCK_ACTIONS.has(action)) updateTag(CATALOGUE_TAG);
  else refresh();

  const result = (data as { result?: string; released?: number } | null) ?? {};
  if (action === "expire") return { ok: true, message: `Released ${result.released ?? 0} expired hold(s).` };
  if (result.result === "expired") return { ok: false, message: "Too late: this order’s hold had expired, so it was cancelled and its items released." };
  if (result.result === "replayed") return { ok: true, message: "Already done." };
  return { ok: true, message: "Saved." };
}
