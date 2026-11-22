import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { readTimeout } from "@/lib/supabase/config";

/*
 * Sales agents for the admin area, read through the admin_* database
 * functions with the verified admin's own session (the database checks
 * membership + aal2 again). The tables themselves aren't readable through the
 * API. Changes: app/admin/agents/actions.ts.
 */

export type AgentTotals = {
  referred_orders: number;
  cancelled_orders: number;
  returned_orders: number;
  awaiting_delivery_paisa: number;
  held_paisa: number;
  awaiting_payment_paisa: number;
  available_paisa: number;
  on_hold_paisa: number;
  reversed_paisa: number;
  paid_paisa: number;
  outstanding_adjustments_paisa: number;
  payable_paisa: number;
  next_release_at: string | null;
};

export type AdminAgent = {
  id: string;
  user_id: string | null;
  username: string;
  display_name: string;
  email: string;
  code: string;
  access_status: "pending" | "active" | "suspended";
  code_enabled: boolean;
  discount_bp: number;
  commission_bp: number | null;
  applies_to_sale_items: boolean | null;
  terms_version: number;
  version: number;
  created_at: string;
  updated_at: string;
  totals: AgentTotals;
};

export type AgentDetail = AdminAgent & {
  available: { order_id: string; order_number: string; commission_paisa: number; release_at: string }[];
  outstanding_adjustments: { id: string; kind: "manual" | "return_after_payout"; amount_paisa: number; reason: string; created_at: string }[];
  events: { kind: string; details: Record<string, unknown> | null; actor_user_id: string | null; created_at: string }[];
};

export type CommissionState =
  | "awaiting_delivery"
  | "held"
  | "awaiting_payment"
  | "available"
  | "paid"
  | "cancelled"
  | "reversed"
  | "no_commission"
  | "on_hold";

export type CommissionRow = {
  order_id: string;
  agent_id: string;
  order_number: string;
  placed_at: string;
  order_status: string;
  payment_status: string;
  delivered_at: string | null;
  release_at: string | null;
  code: string;
  terms_version: number;
  discount_bp: number;
  commission_bp: number;
  applies_to_sale_items: boolean;
  eligible_subtotal_paisa: number;
  discount_paisa: number;
  commission_basis_paisa: number;
  commission_paisa: number;
  reversed_paisa: number;
  earned_paisa: number;
  state: CommissionState;
  payout_id: string | null;
  paid_paisa: number | null;
  /** An admin's hold (pending return); the reason is for admins only. */
  on_hold: boolean;
  hold_reason: string | null;
};

export type Page<T> = { total: number; page: number; page_size: number; rows: T[] };

export type AdminPayouts = {
  total: number;
  page: number;
  page_size: number;
  payouts: {
    id: string;
    amount_paisa: number;
    paid_on: string;
    method: string;
    reference: string | null;
    note: string | null;
    created_by: string | null;
    created_at: string;
    lines: { order_number: string | null; adjustment_id: string | null; amount_paisa: number }[] | null;
  }[];
  adjustments: {
    id: string;
    kind: "manual" | "return_after_payout";
    amount_paisa: number;
    reason: string;
    order_number: string | null;
    created_by: string | null;
    created_at: string;
    payout_id: string | null;
  }[];
};

export type OrderReferral = CommissionRow & {
  agent_username_now: string;
  agent_display_name: string;
  agent_username_then: string;
  hold_hours: number;
  rounding_rule: string;
  hold_history: { id: number; action: "hold" | "release"; reason: string; actor_user_id: string | null; created_at: string }[] | null;
  /** The version a hold/release form must name (null: no hold events yet). */
  latest_hold_event_id: number | null;
  lines: { line_no: number; eligible: boolean; line_total_paisa: number; discount_paisa: number; commission_paisa: number }[];
};

export const PAGE_SIZE = 20;

export class AgentDataError extends Error {}

async function read<T>(supabase: AdminSessionClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args).abortSignal(readTimeout());
  if (error) throw new AgentDataError(`${fn} failed (${error.code || "no code"}).`);
  return data as T;
}

export const listAgents = (supabase: AdminSessionClient) => read<AdminAgent[]>(supabase, "admin_list_agents", {});
export const getAgent = (supabase: AdminSessionClient, id: string) => read<AgentDetail | null>(supabase, "admin_get_agent", { p_agent_id: id });
export const getAgentCommissions = (supabase: AdminSessionClient, id: string, page: number) =>
  read<Page<CommissionRow>>(supabase, "admin_agent_commissions", { p_agent_id: id, p_page: page, p_page_size: PAGE_SIZE });
export const getAgentPayouts = (supabase: AdminSessionClient, id: string, page: number) =>
  read<AdminPayouts>(supabase, "admin_agent_payouts", { p_agent_id: id, p_page: page, p_page_size: PAGE_SIZE });
export const getOrderReferral = (supabase: AdminSessionClient, orderId: string) =>
  read<OrderReferral | null>(supabase, "admin_order_referral", { p_order_id: orderId });

export const STATE_LABELS: Record<CommissionState, string> = {
  awaiting_delivery: "Awaiting delivery (estimate)",
  held: "Held (30-day hold)",
  awaiting_payment: "Waiting for courier payment",
  available: "Available",
  paid: "Paid",
  cancelled: "Cancelled: no commission",
  reversed: "Returned: reversed",
  no_commission: "No commission (0 earned)",
  on_hold: "On hold (admin)",
};

export const ACCESS_LABELS: Record<AdminAgent["access_status"], string> = {
  pending: "Login not set up",
  active: "Active",
  suspended: "Suspended",
};

export const PAYOUT_METHODS = {
  bank_transfer: "Bank transfer",
  easypaisa: "Easypaisa",
  jazzcash: "JazzCash",
  cash: "Cash",
  other: "Other",
} as const;

const HINTS: Record<string, string> = {
  version_conflict: "This agent changed since you opened the page (perhaps in another tab). Reload and try again.",
  invalid_username: "Usernames are 3-30 lower-case letters, digits, dots, hyphens or underscores.",
  invalid_display_name: "Enter a display name (2-80 characters).",
  invalid_email: "Enter a valid email address.",
  invalid_code: "Codes are 3-16 letters and digits.",
  invalid_terms: "Discount and commission are percentages from 0 to 50.",
  terms_required: "Set the commission and choose whether sale items qualify before enabling the code.",
  not_linked: "This agent hasn't got a login yet. Create a password link first.",
  not_available: "Something selected isn't available to pay any more. Reload to see the current list.",
  already_paid: "Something selected was already paid. Reload to see the current list.",
  adjustments_required: "Every outstanding deduction must be included in the payout.",
  invalid_amount: "The amount must equal the selected earnings and adjustments, and be more than zero.",
  invalid_date: "The payment date can't be in the future.",
  invalid_method: "Choose how the agent was paid.",
  invalid_payout: "Check the payout details.",
  reason_required: "Give a reason (5-300 characters).",
  ambiguous_user: "More than one login has this email. Ask the owner to check Supabase Auth.",
  request_mismatch: "This form was already used for a different change. Reload the page and try again.",
  on_hold: "A selected commission is on hold. Release the hold first (on the order’s page).",
  nothing_to_pay: "A selected order earns no commission, so there’s nothing to pay for it.",
  already_on_hold: "This commission is already on hold.",
  not_on_hold: "This commission isn’t on hold.",
  not_holdable: "There’s no commission to hold on this order (cancelled, returned or zero).",
  hold_conflict: "This commission’s hold changed since you opened the page (perhaps in another tab). Reload to see the current hold, then try again.",
};

/** A message an admin can act on (never raw SQL). */
export function describeAgentError(error: { code?: string; hint?: string | null; message?: string } | null): string {
  if (!error) return "That didn't work. Reload the page and try again.";
  if (error.code === "42501") return "Your session no longer has admin access. Sign in again in a new tab, then retry.";
  if (error.code === "PT404") return "This agent no longer exists.";
  if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") return "Someone else is changing this right now. Try again in a moment.";
  if (error.hint && HINTS[error.hint]) {
    // The database's own message for payouts names the orders or the right amount.
    return ["not_available", "already_paid", "invalid_amount", "on_hold", "nothing_to_pay"].includes(error.hint)
      ? `${HINTS[error.hint]} (${error.message ?? ""})`
      : HINTS[error.hint];
  }
  return "That didn't work. Reload the page and try again.";
}
