import "server-only";
import { isAuthApiError, isAuthSessionMissingError } from "@supabase/supabase-js";
import { redirect, unstable_rethrow } from "next/navigation";
import { readTimeout } from "@/lib/supabase/config";
import { createSessionClient } from "@/lib/supabase/session";
import { AGENT_HOME, AGENT_LOGIN, safeAgentPath } from "./safe-redirect";

/*
 * Sales-agent authorization, checked on the server for every /agent page and
 * action:
 *
 * 1. Identity: the agent-area session (its own cookie, path /agent) is
 *    verified with Supabase Auth (getUser()), never just read.
 * 2. Membership: public.agent_session() says whether this login is an ACTIVE
 *    agent (supabase/migrations/20261118120000_sales_agents.sql). Suspended
 *    agents and other logins get no data.
 *
 * The database checks the same again in every agent_* function, so a page
 * that forgot this check would still show nothing. It fails closed.
 */

export type AgentAccess =
  | { status: "signed-out" }
  | { status: "not-agent"; email: string | null }
  | { status: "suspended"; email: string | null }
  | { status: "unavailable" }
  | { status: "agent"; userId: string; email: string | null; displayName: string; username: string };

type SessionClient = Awaited<ReturnType<typeof createSessionClient>>;

const isInvalidSession = (error: unknown) =>
  isAuthSessionMissingError(error) || (isAuthApiError(error) && [400, 401, 403, 404].includes(error.status ?? 0));

export async function getAgentClient(): Promise<{ access: AgentAccess; supabase: SessionClient | null }> {
  let supabase: SessionClient;
  try {
    supabase = await createSessionClient("agent");
  } catch (error) {
    unstable_rethrow(error);
    console.error("[agent] Supabase isn't configured:", error);
    return { access: { status: "unavailable" }, supabase: null };
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    if (!error || isInvalidSession(error)) return { access: { status: "signed-out" }, supabase: null };
    console.error("[agent] Couldn't verify the session:", error.name, error.status ?? "");
    return { access: { status: "unavailable" }, supabase: null };
  }
  const email = data.user.email ?? null;

  const session = await supabase.rpc("agent_session").abortSignal(readTimeout());
  if (session.error || !session.data) {
    console.error("[agent] Membership check failed:", session.error?.code ?? "no data");
    return { access: { status: "unavailable" }, supabase: null };
  }
  const result = session.data as { status: string; display_name?: string; username?: string };
  if (result.status === "suspended") return { access: { status: "suspended", email }, supabase: null };
  if (result.status !== "active") return { access: { status: "not-agent", email }, supabase: null };
  return {
    access: { status: "agent", userId: data.user.id, email, displayName: result.display_name ?? "", username: result.username ?? "" },
    supabase,
  };
}

/** For agent pages: signed-out visitors go to the agent sign-in page, returning to `path`. */
export async function getAgentPageClient(path: string) {
  const result = await getAgentClient();
  if (result.access.status === "signed-out") {
    const next = safeAgentPath(path);
    redirect(next === AGENT_HOME ? AGENT_LOGIN : `${AGENT_LOGIN}?next=${encodeURIComponent(next)}`);
  }
  return result;
}
