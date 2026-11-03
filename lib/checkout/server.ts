import "server-only";
import { withDbRetry, type DbResult } from "@/lib/db/retry";
import { getSupabase } from "@/lib/supabase/server";
import type { Customer, OrderLine } from "./input";
import type { CustomerOrderView, Quote } from "./types";

/*
 * Calls to the guest checkout functions in the database. They run with the
 * publishable key (as anon) and the gateway secret; the database does every
 * check that matters. Never cached; each call is retried a few times when
 * that is safe (lib/db/retry.ts). Errors are reported by code only.
 */

export type OrderBody = {
  lines: OrderLine[];
  delivery_paisa: number;
  total_paisa: number;
  customer: Customer;
};

export type PlaceResult =
  | { result: "placed" | "existing"; order: CustomerOrderView }
  | { result: "mismatch" | "abandoned" | "closed" | "phone_limit" }
  | { result: "limits"; max_lines: number; max_units: number; max_units_per_line: number }
  | { result: "quote_changed"; quote: Quote };

export type ResolveResult =
  | { state: "placed"; matches: boolean | null; order: CustomerOrderView }
  | { state: "none" | "abandoned" };

export type AttemptResult = { allowed: boolean; reason: "ok" | "rate_limited" | "not_configured" };

function rpc<T>(name: string, params: Record<string, unknown>): Promise<DbResult<T> & { attempts: number }> {
  return withDbRetry<T>(async () => {
    const { data, error } = await getSupabase().rpc(name, params);
    return { data: (data ?? null) as T | null, error };
  });
}

export function logDbError(where: string, error: { code?: string } | null) {
  console.error(`[checkout] ${where} failed: ${error?.code || "no code"}`);
}

export const quoteOrder = (secret: string, lines: OrderLine[], city: string | null) =>
  rpc<Quote>("quote_order", { p_gateway_key: secret, p_lines: lines, p_city: city });

export const registerAttempt = (secret: string, client: string | null, kind: "place" | "lookup" | "quote") =>
  rpc<AttemptResult>("checkout_register_attempt", { p_gateway_key: secret, p_client: client, p_kind: kind });

export const resolveCheckout = (secret: string, key: string, order: OrderBody | null, abandon: boolean) =>
  rpc<ResolveResult>("checkout_resolve", { p_gateway_key: secret, p_request_key: key, p_order: order, p_abandon: abandon });

export const placeCodOrder = (secret: string, key: string, order: OrderBody) =>
  rpc<PlaceResult>("place_cod_order", { p_gateway_key: secret, p_request_key: key, p_order: order });

export const customerOrder = (secret: string, key: string) =>
  rpc<CustomerOrderView | null>("get_customer_order", { p_gateway_key: secret, p_request_key: key });
