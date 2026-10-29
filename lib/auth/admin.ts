import "server-only";
import { isAuthApiError, isAuthSessionMissingError, type Factor } from "@supabase/supabase-js";
import { redirect, unstable_rethrow } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/session";
import { ADMIN_LOGIN, ADMIN_MFA, loginPath, mfaPath, safeAdminPath } from "./safe-redirect";

/*
 * Admin authorization, checked on the server for every admin page and
 * action. An admin must pass all three checks, every request:
 *
 * 1. Identity: the session is verified with Supabase Auth (getUser()).
 * 2. Membership: the user has a row in public.admin_members
 *    (supabase/migrations/20261027200000_create_admin_members.sql), which
 *    nobody can create through the API.
 * 3. Two-step verification: the user has a verified authenticator-app (TOTP)
 *    factor AND this session's verified JWT says it completed it (aal2).
 *    Having a factor enrolled is not enough on its own.
 *
 * It fails closed: if any check can't be completed, access is refused.
 */

export type AdminAccess =
  | { status: "signed-out" }
  | { status: "not-admin"; email: string | null }
  | { status: "unavailable" }
  // A member who still has to set up ("enroll") or enter ("verify") their
  // authenticator code. Only the two-step page and its actions accept this.
  | { status: "mfa-required"; step: "enroll" | "verify"; userId: string; email: string | null }
  | { status: "admin"; userId: string; email: string | null };

type SessionClient = Awaited<ReturnType<typeof createSessionClient>>;

type AccessCheck = {
  access: AdminAccess;
  supabase: SessionClient | null;
  factors: Factor[];
};

const fail = (access: AdminAccess): AccessCheck => ({ access, supabase: null, factors: [] });

const isInvalidSession = (error: unknown) =>
  isAuthSessionMissingError(error) ||
  (isAuthApiError(error) && [400, 401, 403, 404].includes(error.status ?? 0));

async function checkAccess(): Promise<AccessCheck> {
  let supabase: SessionClient;
  try {
    supabase = await createSessionClient();
  } catch (error) {
    // Let Next.js handle its own signals (connection() and cookies() during
    // prerendering).
    unstable_rethrow(error);
    console.error("[admin] Supabase isn't configured:", error);
    return fail({ status: "unavailable" });
  }

  // getUser() asks Supabase Auth to validate the session on every call, so a
  // signed-out, expired or deleted account is rejected straight away.
  // (getSession() only reads the cookie and must not be trusted here.)
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    if (!error || isInvalidSession(error)) return fail({ status: "signed-out" });
    console.error("[admin] Couldn't verify the session:", error.name, error.status ?? "");
    return fail({ status: "unavailable" });
  }
  const user = data.user;
  const email = user.email ?? null;

  // Row-level security only lets a user read their own membership row.
  const { data: membership, error: lookupError } = await supabase
    .from("admin_members")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (lookupError) {
    console.error("[admin] Membership lookup failed:", lookupError.code);
    return fail({ status: "unavailable" });
  }
  if (membership?.user_id !== user.id) return fail({ status: "not-admin", email });

  // The factor list comes from Supabase Auth (getUser above), not the cookie.
  const factors = user.factors ?? [];
  const hasVerifiedTotp = factors.some((f) => f.factor_type === "totp" && f.status === "verified");
  if (!hasVerifiedTotp) {
    return { access: { status: "mfa-required", step: "enroll", userId: user.id, email }, supabase, factors };
  }

  // The session's assurance level, from a JWT whose signature getClaims()
  // verifies (against the project's signing keys, or with Supabase Auth).
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData) {
    if (claimsError && isInvalidSession(claimsError)) return fail({ status: "signed-out" });
    console.error("[admin] Couldn't verify the session's claims:", claimsError?.name ?? "no claims");
    return fail({ status: "unavailable" });
  }
  if (claimsData.claims.sub !== user.id) {
    console.error("[admin] Session claims don't match the verified user.");
    return fail({ status: "unavailable" });
  }
  if (claimsData.claims.aal !== "aal2") {
    return { access: { status: "mfa-required", step: "verify", userId: user.id, email }, supabase, factors };
  }

  return { access: { status: "admin", userId: user.id, email }, supabase, factors };
}

/** For admin pages: who is asking, and how far they have got. */
export async function getAdminAccess(): Promise<AdminAccess> {
  return (await checkAccess()).access;
}

/**
 * For the two-step page's own actions only: a verified identity and current
 * admin membership, but not yet aal2. Returns the session client and the
 * user's factors (from Supabase Auth) to enroll or verify with. Never use it
 * to guard anything else.
 */
export async function getMfaContext() {
  return checkAccess();
}

/**
 * For Server Actions and Route Handlers that change admin data: returns the
 * verified admin (member + aal2), sends signed-out users to the login page
 * and unverified ones to the two-step page, and throws for everyone else.
 * Call it inside every such action, not just on the page.
 */
export async function requireAdmin() {
  const access = await getAdminAccess();
  if (access.status === "admin") return access;
  if (access.status === "signed-out") redirect(ADMIN_LOGIN);
  if (access.status === "mfa-required") redirect(ADMIN_MFA);
  throw new Error("Admin access required.");
}

export type AdminSessionClient = SessionClient;

/**
 * For admin data reads and writes: the verified admin (member + aal2) and
 * their session client, whose requests the database also checks with the
 * same rules (RLS: membership AND aal2). Anyone else gets `supabase: null`
 * and their access status, so the caller can explain what's wrong.
 */
export async function getAdminClient() {
  const { access, supabase } = await checkAccess();
  if (access.status === "admin" && supabase) return { access, supabase };
  return { access, supabase: null };
}

/**
 * For admin pages that show product data. Signed-out visitors go to the
 * login page and unverified sessions to the two-step page, both returning to
 * `path` afterwards. Members who aren't verified admins never get a client.
 */
export async function getAdminPageClient(path: string) {
  const result = await getAdminClient();
  const next = safeAdminPath(path);
  if (result.access.status === "signed-out") redirect(loginPath(next));
  if (result.access.status === "mfa-required") redirect(mfaPath(next));
  return result;
}
