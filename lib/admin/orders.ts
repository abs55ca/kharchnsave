import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import type { OrderStatus, PaymentStatus } from "@/lib/checkout/types";
import { readTimeout } from "@/lib/supabase/config";

/*
 * Orders for the admin area, read with the verified admin's own session
 * (RLS: member + aal2). Changes go through the admin_* database functions
 * (app/admin/orders/actions.ts); nothing here writes.
 */

export const ORDER_TABS = {
  confirm: { label: "To confirm", statuses: ["awaiting_confirmation"] },
  dispatch: { label: "To dispatch", statuses: ["confirmed"] },
  courier: { label: "With courier", statuses: ["dispatched"] },
  problems: { label: "Failed delivery", statuses: ["delivery_failed"] },
  done: { label: "Done", statuses: ["delivered", "returned", "cancelled", "completed"] },
} as const satisfies Record<string, { label: string; statuses: OrderStatus[] }>;

export type OrderTab = keyof typeof ORDER_TABS;

export type OrderListItem = {
  id: string;
  order_number: string;
  channel: "online" | "in_store";
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_name: string | null;
  city: string | null;
  total_paisa: number;
  created_at: string;
  hold_expires_at: string | null;
};

export type AdminOrder = OrderListItem & {
  version: number;
  customer_phone: string | null;
  address: string | null;
  landmark: string | null;
  delivery_note: string | null;
  subtotal_paisa: number;
  delivery_paisa: number;
  courier: string | null;
  tracking_number: string | null;
  cancel_reason: string | null;
  collected_paisa: number | null;
  refunded_paisa: number | null;
  order_items: {
    id: string;
    line_no: number;
    sku: string;
    item_code: string;
    product_name: string;
    brand: string;
    colour: string;
    item_status: string;
    condition: string;
    size_eu: number;
    unit_price_paisa: number;
    quantity: number;
    line_total_paisa: number;
  }[];
  order_events: {
    id: number;
    kind: string;
    from_status: string | null;
    to_status: string | null;
    to_payment: string | null;
    actor: string;
    note: string | null;
    details: Record<string, unknown> | null;
    created_at: string;
  }[];
};

export type OrderHealth = {
  scheduled: "scheduled" | "duplicate" | "not_scheduled" | "no_scheduler" | "unknown";
  last_succeeded_at: string | null;
  last_failed_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  overdue_holds: number;
  oldest_overdue_minutes: number | null;
  now: string;
};

export class OrderDataError extends Error {}

export function isOrderTab(value: unknown): value is OrderTab {
  return typeof value === "string" && value in ORDER_TABS;
}

export async function listOrders(supabase: AdminSessionClient, tab: OrderTab): Promise<OrderListItem[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, channel, status, payment_status, customer_name, city, total_paisa, created_at, hold_expires_at")
    .in("status", [...ORDER_TABS[tab].statuses])
    .order("created_at", { ascending: tab !== "done" })
    .limit(200);
  if (error) throw new OrderDataError(`Couldn't load orders (${error.code || "no code"}).`);
  return data as OrderListItem[];
}

export async function countOpenOrders(supabase: AdminSessionClient) {
  const { data, error } = await supabase.from("orders").select("status").in("status", ["awaiting_confirmation", "confirmed", "delivery_failed"]);
  if (error) throw new OrderDataError(`Couldn't count orders (${error.code || "no code"}).`);
  const rows = data as { status: OrderStatus }[];
  return {
    confirm: rows.filter((r) => r.status === "awaiting_confirmation").length,
    dispatch: rows.filter((r) => r.status === "confirmed").length,
    problems: rows.filter((r) => r.status === "delivery_failed").length,
  };
}

export async function getOrder(supabase: AdminSessionClient, id: string): Promise<AdminOrder | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(`*,
      order_items (id, line_no, sku, item_code, product_name, brand, colour, item_status, condition, size_eu, unit_price_paisa, quantity, line_total_paisa),
      order_events (id, kind, from_status, to_status, to_payment, actor, note, details, created_at)`)
    .eq("id", id)
    .order("line_no", { referencedTable: "order_items" })
    .order("id", { referencedTable: "order_events" })
    .maybeSingle();
  if (error) throw new OrderDataError(`Couldn't load the order (${error.code || "no code"}).`);
  return data as AdminOrder | null;
}

export async function getOrderHealth(supabase: AdminSessionClient): Promise<OrderHealth | null> {
  const { data, error } = await supabase.rpc("admin_order_health").abortSignal(readTimeout());
  if (error) {
    console.error(`[admin] order health failed: ${error.code || "no code"}`);
    return null;
  }
  return data as OrderHealth;
}

/** Warnings for the admin banner: the hold-expiry job and checkout configuration. */
export function healthWarnings(health: OrderHealth | null, configProblems: string[], testingKeys = false): string[] {
  const warnings: string[] = [];
  if (testingKeys) {
    warnings.push("CHECKOUT_TURNSTILE_TESTING_KEYS is set: bot checks accept Cloudflare’s testing keys. For local tests only; remove it on any host.");
  }
  if (!health) return ["The order health check couldn’t be loaded."];
  const now = new Date(health.now).getTime();
  const lastOk = health.last_succeeded_at ? new Date(health.last_succeeded_at).getTime() : null;
  if (health.scheduled === "duplicate") {
    warnings.push("More than one scheduled job releases expired holds. Run supabase/setup/schedule_order_expiry.sql again to keep exactly one.");
  } else if (health.scheduled !== "scheduled") {
    warnings.push("Expired holds aren’t released automatically: the scheduled job isn’t set up (README, “Order hold expiry”).");
  } else if (lastOk === null || now - lastOk > 10 * 60_000) {
    warnings.push("The hold-expiry job hasn’t succeeded in the last 10 minutes.");
  }
  if (health.consecutive_failures > 0) {
    warnings.push(`The hold-expiry job failed ${health.consecutive_failures} time(s) in a row (${health.last_error ?? "no detail"}).`);
  }
  if (health.overdue_holds > 0 && (health.oldest_overdue_minutes ?? 0) >= 5) {
    warnings.push(`${health.overdue_holds} expired hold(s) haven’t been released yet (oldest ${health.oldest_overdue_minutes} min).`);
  }
  if (configProblems.length > 0) {
    warnings.push(`Checkout is off on this website: not set: ${configProblems.join(", ")}.`);
  }
  return warnings;
}

const HINTS: Record<string, string> = {
  version_conflict: "This order changed since you opened it (perhaps in another tab). Reload and try again.",
  bad_transition: "That step doesn’t fit the order’s current status. Reload to see where it is.",
  bad_payment_transition: "That payment record doesn’t fit the order’s current state.",
  invalid_return: "Account for every pair in the parcel: restocked plus written off must equal the quantity sold.",
  invalid_amount: "Check the amount.",
  invalid_reason: "Choose a reason.",
  invalid_order: "Check the details you entered.",
  invalid_settings: "A setting has an invalid value.",
  in_store_unpublished: "Unpublished products can’t be sold in the shop until that is decided in Settings.",
};

/** A message an admin can act on (never raw SQL). */
export function describeOrderError(error: { code?: string; hint?: string | null; message?: string }): string {
  if (error.code === "42501") return "Your session no longer has admin access. Sign in again in a new tab, then retry.";
  if (error.code === "PT404") return "This order no longer exists.";
  if (error.code === "55P03" || error.code === "40P01" || error.code === "40001") {
    return "Someone else is working on this order right now. Try again in a moment.";
  }
  if (error.hint && HINTS[error.hint]) return HINTS[error.hint];
  if (error.code === "23514") {
    if (error.message?.includes("shop_settings_ready_to_open")) {
      return "Ordering can’t be switched on until every required setting has a value.";
    }
    return "That change breaks one of the shop’s rules (for example, stock can’t go below zero).";
  }
  return "That didn’t work. Reload the page and try again.";
}
