"use server";

import { refresh, updateTag } from "next/cache";
import { answerForDbError, type BlockedReason } from "@/lib/admin/request-outcome";
import { describePricingError, type CampaignPlan, type Plan } from "@/lib/admin/pricing";
import { rupeesToPaisa } from "@/lib/admin/product-input";
import { getAdminClient, type AdminSessionClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";
import { percentToBp } from "@/lib/pricing/rules";

/*
 * Score pricing and sale campaign actions. Each is a public endpoint, so each
 * first checks for a verified admin, then calls the database through the
 * admin's own session, where the same is checked again. Writes carry the
 * form's request id (components/admin/agent-forms.tsx, useRequestAction): a
 * double click or a retry after a lost answer is applied once, and answered
 * with the original result. Price changes need the token of the preview the
 * admin confirmed; anything changed since makes it "stale" (nothing applied)
 * and the new preview comes back with the answer.
 */

export type PricingFormState = {
  ok: boolean;
  message: string | null;
  done?: boolean;
  version?: number;
  uncertain?: boolean;
  blocked?: BlockedReason;
  /** The database's answer (a result, or a new preview when stale). */
  data?: unknown;
  /** Set when a campaign was created: its page. */
  campaignId?: string;
};

export type PreviewAnswer<T> = { ok: true; plan: T } | { ok: false; message: string };

function failure(error: { code?: string; message?: string; hint?: string | null } | null): PricingFormState {
  const answer = answerForDbError(error);
  if (answer.uncertain) return { ok: false, uncertain: true, message: "No answer from the database." };
  if (answer.blocked) return { ok: false, blocked: answer.blocked, message: describePricingError(error) };
  return { ok: false, message: describePricingError(error) };
}

async function adminClient(): Promise<AdminSessionClient | PricingFormState> {
  const { access, supabase } = await getAdminClient();
  if (supabase) return supabase;
  const blocked: BlockedReason =
    access.status === "signed-out" ? "signed_out" : access.status === "unavailable" ? "unavailable" : "no_access";
  return { ok: false, blocked, message: blocked === "signed_out" ? "You’ve been signed out." : "Admin access required." };
}

const isState = (value: unknown): value is PricingFormState => typeof value === "object" && value !== null && "ok" in value;
const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const OUT_OF_DATE: PricingFormState = { ok: false, message: "This form is out of date. Reload the page." };
const STALE = "Prices, products or agent terms changed since your preview, so nothing was applied. Check the new preview below and confirm again.";

function json(formData: FormData, name: string): unknown {
  try {
    return JSON.parse(text(formData, name));
  } catch {
    return undefined;
  }
}

/** After a price change: the shop's cached catalogue is refreshed at once, and this page too. */
function pricesChanged() {
  updateTag(CATALOGUE_TAG);
  refresh();
}

// ---------------------------------------------------------------------------
// Previews (reads; safe to call any number of times)
// ---------------------------------------------------------------------------

async function preview<T>(fn: string, args: Record<string, unknown>): Promise<PreviewAnswer<T>> {
  const supabase = await adminClient();
  if (isState(supabase)) return { ok: false, message: supabase.message ?? "Admin access required." };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, message: describePricingError(error) };
  return { ok: true, plan: data as T };
}

export async function previewProductPricing(items: unknown): Promise<PreviewAnswer<Plan>> {
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) return { ok: false, message: "Choose 1 to 200 products." };
  return preview<Plan>("admin_preview_product_pricing", { p_items: items });
}

export async function previewReprice(changes: unknown): Promise<PreviewAnswer<Plan>> {
  if (!Array.isArray(changes) || changes.length > 50) return { ok: false, message: "Choose up to 50 groups." };
  return preview<Plan>("admin_preview_reprice", { p_changes: changes });
}

export async function previewCampaign(campaignId: string): Promise<PreviewAnswer<CampaignPlan>> {
  if (!UUID_PATTERN.test(campaignId)) return { ok: false, message: "Sale not found." };
  return preview<CampaignPlan>("admin_get_campaign", { p_campaign_id: campaignId });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type Answer = { result?: string; version?: number; id?: string; replayed?: boolean; preview?: unknown; applied?: number; skipped?: unknown[] | number; removed?: number };

async function write(fn: string, args: Record<string, unknown>, label: string): Promise<{ state?: PricingFormState; answer?: Answer }> {
  const supabase = await adminClient();
  if (isState(supabase)) return { state: supabase };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`[admin] ${label} failed: ${error.code || "no code"}${error.hint ? ` (${error.hint})` : ""}`);
    return { state: failure(error) };
  }
  return { answer: (data as Answer | null) ?? {} };
}

function staleOrDone(answer: Answer, doneMessage: string): PricingFormState {
  if (answer.result === "stale") return { ok: false, done: true, message: STALE, data: answer.preview };
  return { ok: true, done: true, version: answer.version, data: answer, message: answer.replayed ? `Already done earlier. ${doneMessage}` : doneMessage };
}

export async function saveSettingsAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const version = Number(text(formData, "version"));
  if (!UUID_PATTERN.test(requestId) || !Number.isInteger(version)) return OUT_OF_DATE;
  const ending = Number(text(formData, "ending"));
  const optionalRupees = (name: string) => (text(formData, name) ? rupeesToPaisa(text(formData, name)) : null);
  const optionalPercent = (name: string) => (text(formData, name) ? percentToBp(text(formData, name)) : null);
  const minProfit = optionalRupees("minProfit");
  const minMargin = optionalPercent("minMargin");
  const minDays = text(formData, "minDays") ? Number(text(formData, "minDays")) : null;
  const target = (name: string) => (text(formData, name) === "100" ? 10000 : percentToBp(text(formData, name), { min: 0, max: 10000 }));
  const newTarget = target("newTarget");
  const prelovedTarget = target("prelovedTarget");
  if (!Number.isInteger(ending) || ending < 0 || ending > 99) return { ok: false, message: "The price ending is a number from 0 to 99, e.g. 95." };
  if ((text(formData, "minProfit") && minProfit === null) || (text(formData, "minMargin") && minMargin === null)) {
    return { ok: false, message: "Enter the minimum profit in rupees and the minimum margin as a percentage, or leave them empty." };
  }
  if (minDays !== null && (!Number.isInteger(minDays) || minDays < 1 || minDays > 365)) return { ok: false, message: "Minimum days are 1 to 365, or empty for none." };
  if (newTarget === null || prelovedTarget === null) return { ok: false, message: "Coverage targets are percentages from 0 to 100." };
  const { state, answer } = await write("admin_save_pricing_settings", {
    p_expected_version: version, p_request_id: requestId,
    p_settings: { price_ending_rupees: ending, min_profit_paisa: minProfit, min_margin_bp: minMargin, reference_min_days: minDays,
      new_sale_target_bp: newTarget, preloved_sale_target_bp: prelovedTarget },
  }, "pricing settings");
  if (state) return state;
  refresh();
  return { ok: true, done: true, version: answer!.version, message: answer!.replayed ? "Already saved earlier." : "Saved. Automatic prices change only when you review and apply them below." };
}

export async function createGroupAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const max = rupeesToPaisa(text(formData, "max"));
  if (!UUID_PATTERN.test(requestId)) return OUT_OF_DATE;
  if (max === null || max % 100 !== 0) return { ok: false, message: "Enter the maximum price in whole rupees, e.g. 5000." };
  const { state, answer } = await write("admin_create_pricing_group", { p_request_id: requestId, p_name: text(formData, "name"), p_max_price_paisa: max }, "create group");
  if (state) return state;
  if (answer!.result === "name_taken") return { ok: false, done: true, message: "A group with that name already exists." };
  refresh();
  return { ok: true, done: true, message: answer!.replayed ? "Already created earlier." : "Group created." };
}

export async function applyProductPricingAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const items = json(formData, "items");
  const token = text(formData, "token");
  if (!UUID_PATTERN.test(requestId) || !Array.isArray(items) || !/^[0-9a-f]{64}$/.test(token)) return OUT_OF_DATE;
  const { state, answer } = await write("admin_apply_product_pricing", { p_request_id: requestId, p_items: items, p_token: token }, "apply pricing");
  if (state) return state;
  if (answer!.result !== "stale") pricesChanged();
  return staleOrDone(answer!, `Applied to ${answer!.applied ?? 0} product(s).`);
}

export async function applyRepriceAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const changes = json(formData, "changes");
  const token = text(formData, "token");
  if (!UUID_PATTERN.test(requestId) || !Array.isArray(changes) || !/^[0-9a-f]{64}$/.test(token)) return OUT_OF_DATE;
  const { state, answer } = await write("admin_apply_reprice", { p_request_id: requestId, p_changes: changes, p_token: token }, "reprice");
  if (state) return state;
  if (answer!.result !== "stale") pricesChanged();
  return staleOrDone(answer!, `Repriced ${answer!.applied ?? 0} product(s).`);
}

/** "2026-11-21T10:00" typed on the form, in Pakistan time (UTC+5, no daylight saving). */
function karachiTime(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+05:00` : null;
}

function campaignInput(formData: FormData): { input?: Record<string, unknown>; error?: string } {
  const discount = percentToBp(text(formData, "discount"), { min: 100, max: 9000 });
  const startsAt = karachiTime(text(formData, "startsAt"));
  const endsText = text(formData, "endsAt");
  const endsAt = endsText ? karachiTime(endsText) : null;
  if (discount === null) return { error: "The discount is a percentage from 1 to 90, e.g. 15 or 12.5." };
  if (!startsAt || (endsText && !endsAt)) return { error: "Enter the start (and optional end) date and time." };
  return {
    input: {
      name: text(formData, "name"), preset: text(formData, "preset") || "custom", discount_bp: discount, starts_at: startsAt, ends_at: endsAt,
      referral_allowed: formData.get("noReferral") !== "on", require_reference: formData.get("requireReference") === "on",
    },
  };
}

export async function createCampaignAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  if (!UUID_PATTERN.test(requestId)) return OUT_OF_DATE;
  const { input, error } = campaignInput(formData);
  if (error) return { ok: false, message: error };
  const { state, answer } = await write("admin_create_campaign", { p_request_id: requestId, p_campaign: input }, "create campaign");
  if (state) return state;
  refresh();
  return { ok: true, done: true, campaignId: answer!.id, message: "Sale created as a draft. Choose its products next." };
}

export async function updateCampaignAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const campaignId = text(formData, "campaignId");
  const version = Number(text(formData, "version"));
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(campaignId) || !Number.isInteger(version)) return OUT_OF_DATE;
  const { input, error } = campaignInput(formData);
  if (error) return { ok: false, message: error };
  const { state, answer } = await write("admin_update_campaign", { p_campaign_id: campaignId, p_expected_version: version, p_request_id: requestId, p_campaign: input }, "update campaign");
  if (state) return state;
  refresh();
  return { ok: true, done: true, version: answer!.version, message: answer!.replayed ? "Already saved earlier." : "Saved." };
}

export async function campaignSelectionAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const campaignId = text(formData, "campaignId");
  const version = Number(text(formData, "version"));
  const changes = json(formData, "changes");
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(campaignId) || !Number.isInteger(version) || !Array.isArray(changes)) return OUT_OF_DATE;
  if (changes.length === 0) return { ok: false, message: "Nothing changed in the selection." };
  const { state, answer } = await write("admin_set_campaign_selection", { p_campaign_id: campaignId, p_expected_version: version, p_request_id: requestId, p_changes: changes }, "campaign selection");
  if (state) return state;
  refresh();
  return { ok: true, done: true, version: answer!.version, message: answer!.replayed ? "Already saved earlier." : "Selection saved. Prices change only when you review and apply the sale." };
}

export async function applyCampaignAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const campaignId = text(formData, "campaignId");
  const version = Number(text(formData, "version"));
  const token = text(formData, "token");
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(campaignId) || !Number.isInteger(version) || !/^[0-9a-f]{64}$/.test(token)) return OUT_OF_DATE;
  const { state, answer } = await write("admin_apply_campaign", { p_campaign_id: campaignId, p_expected_version: version, p_request_id: requestId, p_token: token }, "apply campaign");
  if (state) return state;
  if (answer!.result !== "stale") pricesChanged();
  const a = answer!;
  const what = a.result === "scheduled"
    ? `Scheduled: ${a.applied ?? 0} product(s) go on sale at the start time if they're still as reviewed.`
    : `${a.applied ?? 0} put on sale, ${a.removed ?? 0} taken off, ${typeof a.skipped === "number" ? a.skipped : 0} left out (see reasons).`;
  return staleOrDone(a, what);
}

export async function endCampaignAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  const requestId = text(formData, "requestId");
  const campaignId = text(formData, "campaignId");
  const version = Number(text(formData, "version"));
  const action = text(formData, "action");
  if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(campaignId) || !Number.isInteger(version) || !["end", "cancel", "unschedule"].includes(action)) return OUT_OF_DATE;
  const { state, answer } = await write("admin_end_campaign", { p_campaign_id: campaignId, p_expected_version: version, p_request_id: requestId, p_action: action }, `campaign ${action}`);
  if (state) return state;
  pricesChanged();
  const message = action === "end" ? `Sale ended: ${answer!.removed ?? 0} product(s) back at their regular price.` : action === "cancel" ? "Sale cancelled." : "Unscheduled: back to draft.";
  return { ok: true, done: true, version: answer!.version, message: answer!.replayed ? `Already done earlier. ${message}` : message };
}

export async function runScheduleAction(_previous: PricingFormState, formData: FormData): Promise<PricingFormState> {
  if (!UUID_PATTERN.test(text(formData, "requestId"))) return OUT_OF_DATE;
  const { state, answer } = await write("admin_run_sale_schedule", {}, "run sale schedule");
  if (state) return state;
  pricesChanged();
  const a = answer as { started?: number; ended?: number; failed?: number; error?: string | null };
  if (a.failed) return { ok: false, done: true, message: `Ran with a problem: ${a.error ?? "see the schedule health"}.` };
  return { ok: true, done: true, message: `Done: ${a.started ?? 0} sale(s) started, ${a.ended ?? 0} ended.` };
}
