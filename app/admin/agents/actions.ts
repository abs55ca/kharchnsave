"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { isReferralCode, normalizeReferralCode, normalizeUsername, percentToBasisPoints } from "@/lib/agents/code";
import { issueLoginLink, loginLinkUrl, provisionAgent, type AgentInput, type AgentRecord, type GeneratedLink, type ProvisionDeps, type ProvisionResult } from "@/lib/agents/provision";
import { linkOrigin as originFrom } from "@/lib/agents/origin";
import { describeAgentError } from "@/lib/admin/agents";
import { answerForDbError, type BlockedReason } from "@/lib/admin/request-outcome";
import { rupeesToPaisa } from "@/lib/admin/product-input";
import { getAdminClient, type AdminSessionClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { getAuthAdmin, isAuthAdminConfigured } from "@/lib/supabase/auth-admin";

/*
 * Sales-agent admin actions. Each is a public endpoint, so each first checks
 * for a verified admin (identity, current membership, aal2) and then calls
 * the database through the admin's own session, where the same is checked
 * again. Only the login set-up uses the Auth admin API (secret key, server
 * only), and only after that check. Every form carries a request id made when
 * it was rendered, so a double click or a retry is applied once.
 */

/**
 * `done`: the request was answered (applied now, or earlier: a replay), so the
 * form needs a new request id for its next change. `version`: the agent
 * version THIS change produced (for a replay, the original one), which the
 * page's next edit must name. Without `done`, the form keeps its request id,
 * so an uncertain retry is recognised by the database.
 */
export type AgentFormState = {
  ok: boolean;
  message: string | null;
  link?: string;
  agentId?: string;
  done?: boolean;
  version?: number;
  /** No answer from the database: the change may or may not have been applied. Retry the same request. */
  uncertain?: boolean;
  /**
   * The request couldn't be checked at all (signed out, no admin access,
   * sign-in or database unavailable, a lock busy). Nothing was decided about
   * it, so an earlier unconfirmed request stays unconfirmed (lib/admin/request-outcome.ts).
   */
  blocked?: BlockedReason;
};

/** A database error as a form answer: refused, uncertain (no answer) or blocked (not checked). */
function failure(error: { code?: string; message?: string; hint?: string | null } | null): AgentFormState {
  const answer = answerForDbError(error);
  if (answer.uncertain) return { ok: false, uncertain: true, message: "No answer from the database." };
  if (answer.blocked) return { ok: false, blocked: answer.blocked, message: describeAgentError(error) };
  return { ok: false, message: describeAgentError(error) };
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * The verified admin's session client, or why there isn't one. Not having one
 * means the request was never checked: "blocked", not a refusal of the request.
 */
async function adminClient(): Promise<AdminSessionClient | AgentFormState> {
  const { access, supabase } = await getAdminClient();
  if (supabase) return supabase;
  const blocked: BlockedReason =
    access.status === "signed-out" ? "signed_out" : access.status === "unavailable" ? "unavailable" : "no_access";
  return { ok: false, blocked, message: blocked === "signed_out" ? "You’ve been signed out." : "Admin access required." };
}

const NO_SECRET_KEY: AgentFormState = {
  ok: false,
  blocked: "unavailable",
  message: "SUPABASE_SECRET_KEY isn’t set on this website, so logins can’t be created (README, “Sales agents”).",
};

const isState = (value: unknown): value is AgentFormState => typeof value === "object" && value !== null && "ok" in value;

/** Where the agent's password link points (lib/agents/origin.ts). */
async function linkOrigin(): Promise<string> {
  return originFrom(await headers());
}

async function generateLink(type: "invite" | "recovery", email: string): Promise<GeneratedLink> {
  try {
    const auth = getAuthAdmin();
    const { data, error } = type === "invite" ? await auth.generateLink({ type: "invite", email }) : await auth.generateLink({ type: "recovery", email });
    if (error) {
      if (type === "invite" && (error.code === "email_exists" || error.code === "user_already_exists" || error.status === 422)) {
        return { ok: false, reason: "exists" };
      }
      console.error(`[admin] Auth ${type} link failed: ${error.code ?? error.status ?? "no code"}`);
      return { ok: false, reason: "error" };
    }
    const tokenHash = data.properties?.hashed_token;
    return tokenHash ? { ok: true, tokenHash } : { ok: false, reason: "error" };
  } catch (error) {
    console.error(`[admin] Auth ${type} link failed:`, (error as Error).name);
    return { ok: false, reason: "error" };
  }
}

function provisionDeps(supabase: AdminSessionClient): ProvisionDeps {
  return {
    createAgent: async (requestId, input) => {
      const { data, error } = await supabase.rpc("admin_create_agent", { p_request_id: requestId, p_agent: input });
      return { data, error };
    },
    linkAgent: async (agentId) => {
      const { data, error } = await supabase.rpc("admin_link_agent_user", { p_agent_id: agentId });
      return { data, error };
    },
    generateLink,
    noteLink: (agentId, requestId, type) =>
      Promise.resolve(supabase.rpc("admin_note_agent_invite", { p_agent_id: agentId, p_request_id: requestId, p_kind: type })),
  };
}

async function describeProvision(result: ProvisionResult): Promise<AgentFormState> {
  switch (result.status) {
    case "ready":
      return {
        ok: true,
        done: true,
        agentId: result.agentId,
        link: loginLinkUrl(await linkOrigin(), result.tokenHash, result.linkType),
        message:
          result.linkType === "invite"
            ? "Agent created. Send them this link to set their password. It works once and expires (Auth settings: email link expiry)."
            : "Password link created. Send it to the agent. It works once and expires.",
      };
    case "email_exists":
      return { ok: false, agentId: result.agentId, message: "An agent with this email already exists. Open their page to create a password link." };
    case "username_taken":
      return { ok: false, message: "That username is taken." };
    case "code_taken":
      return { ok: false, message: "That code is taken (codes are never reused, even after an agent is deactivated). Choose another." };
    case "mismatch":
      return { ok: false, message: "This form was already used for a different agent. Reload the page." };
    case "is_admin":
      return { ok: false, agentId: result.agentId, message: "This email belongs to an admin. Admins can’t also be agents; use another email." };
    case "linked_elsewhere":
      return { ok: false, agentId: result.agentId, message: "This email’s login already belongs to another agent." };
    case "auth_failed":
      return {
        ok: false,
        agentId: result.agentId,
        message: "The agent was saved, but their login couldn’t be set up right now. Open their page and choose “Create password link” to try again.",
      };
    case "db_error":
      return result.uncertain
        ? { ok: false, uncertain: true, message: "No answer from the database." }
        : failure({ code: result.code ?? undefined, hint: result.hint });
  }
}

/** Create an agent and their login, and return the password link. */
export async function createAgentAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  if (!isAuthAdminConfigured()) return NO_SECRET_KEY;

  const requestId = text(formData, "requestId");
  const code = normalizeReferralCode(text(formData, "code"));
  const discount = percentToBasisPoints(text(formData, "discount"));
  const commissionText = text(formData, "commission");
  const commission = commissionText ? percentToBasisPoints(commissionText) : null;
  const sale = text(formData, "saleItems");
  const enable = formData.get("enable") === "on";
  if (!UUID_PATTERN.test(requestId)) return { ok: false, message: "This form is out of date. Reload the page." };
  if (!isReferralCode(code)) return { ok: false, message: "Codes are 3-16 letters and digits." };
  if (discount === null || (commissionText && commission === null)) return { ok: false, message: "Discount and commission are percentages from 0 to 50, e.g. 10 or 7.5." };
  if (enable && (commission === null || !["yes", "no"].includes(sale))) {
    return { ok: false, message: "To enable the code now, set the commission and choose whether sale items qualify." };
  }
  const input: AgentInput = {
    username: normalizeUsername(text(formData, "username")),
    display_name: text(formData, "displayName"),
    email: text(formData, "email").toLowerCase(),
    code,
    discount_bp: discount,
    commission_bp: commission,
    applies_to_sale_items: sale === "yes" ? true : sale === "no" ? false : null,
    code_enabled: enable,
  };
  const result = await provisionAgent(requestId, input, provisionDeps(supabase));
  if (result.status !== "db_error") refresh();
  return describeProvision(result);
}

/** For the creation form: is this code well-formed and free? */
export async function checkAgentCode(code: string): Promise<{ code: string | null; valid: boolean; available: boolean } | null> {
  const supabase = await adminClient();
  if (isState(supabase) || typeof code !== "string" || code.length > 64) return null;
  const { data, error } = await supabase.rpc("admin_check_agent_code", { p_code: code });
  return error ? null : data;
}

/** A new password link for an existing agent (also finishes a set-up that failed part-way). */
export async function createLoginLinkAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  if (!isAuthAdminConfigured()) return NO_SECRET_KEY;
  const agentId = text(formData, "agentId");
  const requestId = text(formData, "requestId");
  if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(requestId)) return { ok: false, message: "This form is out of date. Reload the page." };
  const { data, error } = await supabase.rpc("admin_get_agent", { p_agent_id: agentId });
  if (error || !data) return failure(error);
  const result = await issueLoginLink(data as AgentRecord, requestId, provisionDeps(supabase));
  refresh();
  return describeProvision(result);
}

/** Profile, terms, code on/off and access. */
export async function agentChangeAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  const action = text(formData, "action");
  const agentId = text(formData, "agentId");
  const requestId = text(formData, "requestId");
  const version = Number(text(formData, "version"));
  if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(requestId) || !Number.isInteger(version)) {
    return { ok: false, message: "This form is out of date. Reload the page." };
  }
  const base = { p_agent_id: agentId, p_expected_version: version, p_request_id: requestId };

  let call;
  switch (action) {
    case "profile":
      call = supabase.rpc("admin_update_agent_profile", { ...base, p_username: normalizeUsername(text(formData, "username")), p_display_name: text(formData, "displayName") });
      break;
    case "terms": {
      const discount = percentToBasisPoints(text(formData, "discount"));
      const commissionText = text(formData, "commission");
      const commission = commissionText ? percentToBasisPoints(commissionText) : null;
      const sale = text(formData, "saleItems");
      if (discount === null || (commissionText && commission === null)) return { ok: false, message: "Discount and commission are percentages from 0 to 50, e.g. 10 or 7.5." };
      call = supabase.rpc("admin_update_agent_terms", {
        ...base,
        p_terms: { discount_bp: discount, commission_bp: commission, applies_to_sale_items: sale === "yes" ? true : sale === "no" ? false : null },
      });
      break;
    }
    case "enable-code":
    case "disable-code":
      call = supabase.rpc("admin_set_agent_code_enabled", { ...base, p_enabled: action === "enable-code" });
      break;
    case "suspend":
    case "reactivate":
      call = supabase.rpc("admin_set_agent_access", { ...base, p_access: action === "suspend" ? "suspended" : "active" });
      break;
    default:
      return { ok: false, message: "Unknown action." };
  }
  const { data, error } = await call;
  if (error) {
    console.error(`[admin] agent ${action} failed: ${error.code || "no code"}${error.hint ? ` (${error.hint})` : ""}`);
    return failure(error);
  }
  refresh();
  const answer = (data as { result?: string; version?: number } | null) ?? {};
  if (answer.result === "username_taken") return { ok: false, message: "That username is taken." };
  return { ok: true, done: true, version: answer.version, message: answer.result === "replayed" ? "Already saved earlier." : "Saved." };
}

/** Holds or releases one order's commission (pending return), with a reason. */
export async function commissionHoldAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  const orderId = text(formData, "orderId");
  const requestId = text(formData, "requestId");
  const hold = text(formData, "hold");
  // The latest hold event the page showed ("" = none yet): the database refuses the change if the hold has moved on.
  const expected = text(formData, "expectedEventId");
  if (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(requestId) || !["yes", "no"].includes(hold) || !/^\d{0,18}$/.test(expected)) {
    return { ok: false, message: "This form is out of date. Reload the page." };
  }
  const { data, error } = await supabase.rpc("admin_set_commission_hold", {
    p_order_id: orderId, p_expected_event_id: expected === "" ? null : expected, p_request_id: requestId,
    p_hold: hold === "yes", p_reason: text(formData, "reason"),
  });
  if (error) {
    console.error(`[admin] commission hold failed: ${error.code || "no code"}${error.hint ? ` (${error.hint})` : ""}`);
    return failure(error);
  }
  refresh();
  const answer = data as { result: string; on_hold: boolean };
  return {
    ok: true,
    done: true,
    message: answer.result === "replayed" ? "Already saved earlier." : answer.on_hold ? "Commission put on hold." : "Hold released.",
  };
}

/** A manual adjustment, with a reason. */
export async function addAdjustmentAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  const agentId = text(formData, "agentId");
  const requestId = text(formData, "requestId");
  const amount = rupeesToPaisa(text(formData, "amount").replace(/^\+/, "").replace(/^-/, ""));
  const negative = text(formData, "direction") === "deduct";
  if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(requestId)) return { ok: false, message: "This form is out of date. Reload the page." };
  if (amount === null || amount === 0) return { ok: false, message: "Enter the amount in rupees, e.g. 500 or 250.50." };
  const { data, error } = await supabase.rpc("admin_add_agent_adjustment", {
    p_agent_id: agentId, p_request_id: requestId, p_amount_paisa: negative ? -amount : amount, p_reason: text(formData, "reason"),
  });
  if (error) return failure(error);
  refresh();
  const result = (data as { result: string }).result;
  if (result === "mismatch") return { ok: false, message: "This form was already used for a different adjustment. Reload the page." };
  return { ok: true, done: true, message: result === "replayed" ? "Already recorded." : "Adjustment recorded." };
}

/** Records a payout made outside the app. */
export async function recordPayoutAction(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const supabase = await adminClient();
  if (isState(supabase)) return supabase;
  const agentId = text(formData, "agentId");
  const requestId = text(formData, "requestId");
  const orderIds = formData.getAll("orderId").map(String);
  const adjustmentIds = formData.getAll("adjustmentId").map(String);
  const amount = rupeesToPaisa(text(formData, "amount"));
  const paidOn = text(formData, "paidOn");
  if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(requestId) || ![...orderIds, ...adjustmentIds].every((id) => UUID_PATTERN.test(id))) {
    return { ok: false, message: "This form is out of date. Reload the page." };
  }
  if (orderIds.length + adjustmentIds.length === 0) return { ok: false, message: "Select what this payout covers." };
  if (amount === null) return { ok: false, message: "Enter the amount paid in rupees." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return { ok: false, message: "Enter the payment date." };
  const { data, error } = await supabase.rpc("admin_record_agent_payout", {
    p_agent_id: agentId, p_request_id: requestId, p_order_ids: orderIds, p_adjustment_ids: adjustmentIds, p_amount_paisa: amount,
    p_paid_on: paidOn, p_method: text(formData, "method"), p_reference: text(formData, "reference") || null, p_note: text(formData, "note") || null,
  });
  if (error) {
    console.error(`[admin] payout failed: ${error.code || "no code"}${error.hint ? ` (${error.hint})` : ""}`);
    return failure(error);
  }
  refresh();
  const result = (data as { result: string }).result;
  if (result === "mismatch") return { ok: false, message: "This form was already used for a different payout. Reload the page." };
  return { ok: true, done: true, message: result === "replayed" ? "Already recorded." : "Payout recorded." };
}
