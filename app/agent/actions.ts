"use server";

import { isAuthApiError } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { MIN_PASSWORD_LENGTH } from "@/lib/agents/code";
import { linkOrigin } from "@/lib/agents/origin";
import { AGENT_LOGIN, safeAgentPath } from "@/lib/auth/safe-redirect";
import { AGENT_AUTH_COOKIE, AGENT_SESSION_COOKIE_OPTIONS } from "@/lib/supabase/config";
import { createSessionClient } from "@/lib/supabase/session";

/*
 * Sign-in, sign-out and passwords for the sales-agent area. The session lives
 * in the agent area's own cookie (lib/supabase/config.ts). Messages never say
 * whether an account exists. Signing in grants nothing by itself: every agent
 * page checks for an ACTIVE agent membership (lib/auth/agent.ts), and so does
 * the database.
 */

export type AgentFormState = { error: string | null; done?: boolean; email?: string };

const GENERIC_FAILURE = "The email or password is incorrect.";

export async function agentSignIn(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const email = String(formData.get("email") ?? "").trim().slice(0, 254);
  const password = String(formData.get("password") ?? "");
  const next = safeAgentPath(formData.get("next"));
  if (!email.includes("@") || password.length === 0 || password.length > 1024) return { error: GENERIC_FAILURE, email };

  let failed: string | null = null;
  try {
    const supabase = await createSessionClient("agent");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      failed = isAuthApiError(error) && error.status === 429
        ? "Too many attempts. Please wait a minute and try again."
        : isAuthApiError(error) && error.status < 500
          ? GENERIC_FAILURE
          : "We couldn't sign you in right now. Please try again.";
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error("[agent] Sign-in failed:", (error as Error).name);
    failed = "We couldn't sign you in right now. Please try again.";
  }
  if (failed) return { error: failed, email };
  redirect(next);
}

/** Ends this device's agent session, even if Supabase can't be reached. */
export async function agentSignOut() {
  try {
    const supabase = await createSessionClient("agent");
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) throw error;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[agent] Sign-out request failed; clearing the session cookies:", (error as Error).name);
    const cookieStore = await cookies();
    for (const { name } of cookieStore.getAll()) {
      if (AGENT_AUTH_COOKIE.test(name)) cookieStore.delete({ name, path: AGENT_SESSION_COOKIE_OPTIONS.path });
    }
  }
  redirect(AGENT_LOGIN);
}

/** Sets the password of the login that opened a password link (/agent/auth/confirm). */
export async function setAgentPassword(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 72) {
    return { error: `Use ${MIN_PASSWORD_LENGTH} to 72 characters.` };
  }
  if (password !== confirm) return { error: "The two passwords don’t match." };

  let failed: string | null = null;
  try {
    const supabase = await createSessionClient("agent");
    const { data } = await supabase.auth.getUser();
    if (!data.user) return { error: "This password link has expired. Ask the shop for a new one." };
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      failed = error.code === "weak_password"
        ? "Choose a stronger password (longer, and not a common one)."
        : error.code === "same_password"
          ? "That’s your current password. Choose a new one."
          : "Your password couldn’t be saved. Open the link again or ask the shop for a new one.";
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error("[agent] Setting a password failed:", (error as Error).name);
    failed = "Your password couldn’t be saved right now. Please try again.";
  }
  if (failed) return { error: failed };
  redirect("/agent");
}

/**
 * Emails a password reset link, if the address has an account. Always answers
 * the same way. Needs the project's email sending (custom SMTP) to reach
 * agents; otherwise the shop can create a link on the agent's admin page.
 */
export async function requestAgentPasswordReset(_previous: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const email = String(formData.get("email") ?? "").trim().slice(0, 254);
  if (!email.includes("@")) return { error: "Enter your email address.", email };
  try {
    const origin = linkOrigin(await headers());
    const supabase = await createSessionClient("agent");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/agent/auth/confirm` });
    if (error && !(isAuthApiError(error) && error.status < 500 && error.status !== 429)) {
      console.error("[agent] Password reset request failed:", error.code ?? error.status ?? "no code");
      if (isAuthApiError(error) && error.status === 429) return { error: "Too many requests. Please wait a while and try again.", email };
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error("[agent] Password reset request failed:", (error as Error).name);
  }
  return { error: null, done: true, email };
}
