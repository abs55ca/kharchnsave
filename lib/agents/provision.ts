import { isUncertain, type DbResult } from "@/lib/db/retry";

/*
 * Setting up a sales agent's login, step by step. Every step can be repeated,
 * so if anything fails part-way the admin just tries again (same form, same
 * request id, or "Create password link" on the agent's page):
 *
 * 1. Database: create the agent (admin_create_agent). A retry with the same
 *    request id returns the same agent; the same email under a new request
 *    returns that agent's id instead of a second one.
 * 2. Auth: create the login with an invitation link (generateLink "invite").
 *    If the login already exists (an earlier attempt created it), carry on.
 *    Auth refuses a second user with the same email, so there's never a
 *    duplicate identity.
 * 3. Database: link the agent to the login with that email
 *    (admin_link_agent_user). Refuses admins and logins already used by
 *    another agent.
 * 4. If step 2 didn't produce a link (login existed), make a password link
 *    now ("recovery"), only after step 3 confirmed the login is this agent's.
 *
 * The link is returned once, for the admin to send to the agent; it isn't
 * stored. Its expiry is the project's email link expiry (Auth settings).
 */

export type AgentInput = {
  username: string;
  display_name: string;
  email: string;
  code: string;
  discount_bp: number;
  commission_bp: number | null;
  applies_to_sale_items: boolean | null;
  code_enabled: boolean;
};

export type AgentRecord = { id: string; email: string; user_id: string | null; access_status: string; code: string; version: number };

export type CreateResult =
  | { result: "created" | "existing"; agent: AgentRecord }
  | { result: "email_exists"; agent_id: string }
  | { result: "mismatch" | "username_taken" | "code_taken" };

export type LinkResult =
  | { result: "linked" | "already_linked"; agent: AgentRecord }
  | { result: "no_auth_user" | "is_admin" | "linked_elsewhere" };

export type GeneratedLink = { ok: true; tokenHash: string } | { ok: false; reason: "exists" | "error" };

export type ProvisionDeps = {
  createAgent: (requestId: string, input: AgentInput) => Promise<DbResult<CreateResult>>;
  linkAgent: (agentId: string) => Promise<DbResult<LinkResult>>;
  generateLink: (type: "invite" | "recovery", email: string) => Promise<GeneratedLink>;
  noteLink: (agentId: string, requestId: string, type: "invite" | "recovery") => Promise<unknown>;
};

export type ProvisionResult =
  | { status: "ready"; agentId: string; linkType: "invite" | "recovery"; tokenHash: string }
  | { status: "email_exists"; agentId: string }
  | { status: "username_taken" | "code_taken" | "mismatch" }
  | { status: "is_admin" | "linked_elsewhere" | "auth_failed"; agentId: string }
  // uncertain: no answer from the database, so the step may have been applied.
  | { status: "db_error"; code: string | null; hint: string | null; uncertain: boolean };

const dbError = (error: { code?: string; message?: string; hint?: string | null } | null): ProvisionResult => ({
  status: "db_error",
  uncertain: !error || isUncertain(error),
  code: error?.code ?? null,
  hint: error?.hint ?? null,
});

/** Steps 2-4 for an agent that exists in the database. */
export async function issueLoginLink(agent: AgentRecord, requestId: string, deps: ProvisionDeps): Promise<ProvisionResult> {
  let invite: GeneratedLink | null = null;
  if (agent.user_id === null) {
    invite = await deps.generateLink("invite", agent.email);
    if (!invite.ok && invite.reason !== "exists") return { status: "auth_failed", agentId: agent.id };
    const linked = await deps.linkAgent(agent.id);
    if (linked.error || !linked.data) return dbError(linked.error);
    if (linked.data.result === "no_auth_user") return { status: "auth_failed", agentId: agent.id };
    if (linked.data.result === "is_admin" || linked.data.result === "linked_elsewhere") {
      return { status: linked.data.result, agentId: agent.id };
    }
  }
  let linkType: "invite" | "recovery" = "invite";
  let tokenHash = invite?.ok ? invite.tokenHash : null;
  if (!tokenHash) {
    const recovery = await deps.generateLink("recovery", agent.email);
    if (!recovery.ok) return { status: "auth_failed", agentId: agent.id };
    linkType = "recovery";
    tokenHash = recovery.tokenHash;
  }
  await deps.noteLink(agent.id, requestId, linkType);
  return { status: "ready", agentId: agent.id, linkType, tokenHash };
}

export async function provisionAgent(requestId: string, input: AgentInput, deps: ProvisionDeps): Promise<ProvisionResult> {
  const created = await deps.createAgent(requestId, input);
  if (created.error || !created.data) return dbError(created.error);
  const result = created.data;
  if (result.result === "email_exists") return { status: "email_exists", agentId: result.agent_id };
  if (result.result !== "created" && result.result !== "existing") return { status: result.result };
  return issueLoginLink(result.agent, requestId, deps);
}

/** Where the agent opens the link: our own page, which verifies it on the server. */
export function loginLinkUrl(origin: string, tokenHash: string, type: "invite" | "recovery"): string {
  const url = new URL("/agent/auth/confirm", origin);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", type);
  return url.toString();
}
