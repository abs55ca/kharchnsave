import "server-only";
import type { AgentTotals, CommissionState } from "@/lib/admin/agents";
import { readTimeout } from "@/lib/supabase/config";
import type { createSessionClient } from "@/lib/supabase/session";

/*
 * The signed-in agent's own figures, from the agent_* database functions
 * (supabase/migrations/20261118120200_commission_accounting.sql). They return
 * only this agent's data and nothing about customers.
 */

type SessionClient = Awaited<ReturnType<typeof createSessionClient>>;

export type AgentDashboard = {
  display_name: string;
  username: string;
  code: string;
  code_enabled: boolean;
  discount_bp: number;
  commission_bp: number | null;
  applies_to_sale_items: boolean | null;
  totals: AgentTotals;
  upcoming_releases: { order_number: string; commission_paisa: number; release_at: string }[];
  now: string;
};

export type AgentReferral = {
  order_number: string;
  placed_at: string;
  delivered_at: string | null;
  release_at: string | null;
  eligible_subtotal_paisa: number;
  discount_paisa: number;
  commission_bp: number;
  commission_paisa: number;
  earned_paisa: number;
  reversed_paisa: number;
  state: CommissionState;
};

export type AgentPayouts = {
  total: number;
  payouts: { amount_paisa: number; paid_on: string; method: string; reference: string | null; orders: number }[];
  adjustments: { amount_paisa: number; reason: string; kind: string; order_number: string | null; created_at: string; settled: boolean }[];
};

export const AGENT_PAGE_SIZE = 20;

async function read<T>(supabase: SessionClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args).abortSignal(readTimeout());
  if (error) throw new Error(`${fn} failed (${error.code || "no code"}).`);
  return data as T;
}

export const getDashboard = (supabase: SessionClient) => read<AgentDashboard>(supabase, "agent_dashboard");
export const getReferrals = (supabase: SessionClient, page: number) =>
  read<{ total: number; rows: AgentReferral[] }>(supabase, "agent_referrals", { p_page: page, p_page_size: AGENT_PAGE_SIZE });
export const getPayouts = (supabase: SessionClient, page: number) =>
  read<AgentPayouts>(supabase, "agent_payouts", { p_page: page, p_page_size: AGENT_PAGE_SIZE });

/** What each state means, in the agent's terms. */
export const AGENT_STATE_LABELS: Record<CommissionState, string> = {
  awaiting_delivery: "Estimated: not delivered yet",
  held: "Held for 30 days after delivery",
  awaiting_payment: "Waiting for the courier to pay the shop",
  available: "Available: will be paid",
  paid: "Paid",
  cancelled: "Cancelled: no commission",
  reversed: "Returned: no commission",
  no_commission: "No commission on this order",
  on_hold: "On hold: the shop is checking a return",
};
