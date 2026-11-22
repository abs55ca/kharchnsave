import "server-only";
import { createClient, type GoTrueAdminApi } from "@supabase/supabase-js";
import { getSupabaseConfig, noStoreFetch } from "./config";

/*
 * Supabase Auth's admin API, for setting up sales-agent logins only
 * (app/admin/agents/actions.ts, after the admin's identity, membership and
 * aal2 have been verified). It uses the project's SECRET key, which bypasses
 * row-level security, so:
 *   - it is server-only and never NEXT_PUBLIC_;
 *   - only the Auth admin API is handed out (no database queries): every
 *     database change still goes through the admin's own session, where the
 *     database checks membership and aal2 again.
 *
 * SUPABASE_SECRET_KEY: Project Settings -> API Keys -> Secret keys (sb_secret_...).
 * Without it, agents can't be invited (the admin page says so); nothing else
 * depends on it.
 */

export function isAuthAdminConfigured(env: Record<string, string | undefined> = process.env) {
  return parseSecretKey(env.SUPABASE_SECRET_KEY) !== null;
}

/** The secret key, if it looks like one. Publishable keys are refused. */
export function parseSecretKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key || key.length < 20) return null;
  if (key.startsWith("sb_publishable_")) return null;
  return key;
}

let admin: GoTrueAdminApi | undefined;

export function getAuthAdmin(): GoTrueAdminApi {
  if (admin) return admin;
  const key = parseSecretKey(process.env.SUPABASE_SECRET_KEY);
  if (!key) throw new Error("SUPABASE_SECRET_KEY isn't set, so agent logins can't be set up.");
  const { url } = getSupabaseConfig();
  admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: noStoreFetch },
  }).auth.admin;
  return admin;
}
