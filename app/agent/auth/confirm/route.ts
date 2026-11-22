import type { EmailOtpType } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { AGENT_LOGIN } from "@/lib/auth/safe-redirect";
import { createSessionClient } from "@/lib/supabase/session";

/**
 * GET /agent/auth/confirm?token_hash=...&type=invite|recovery  (links made on
 * the agent's admin page) or ?code=...  (the reset email, PKCE).
 *
 * Verifies the one-time link with Supabase Auth on the server and starts an
 * agent-area session, then asks for a new password. A used, expired or
 * invalid link signs nothing in and goes to the sign-in page with a message.
 * The link's token never reaches any other page (redirects carry no query).
 * Redirects are relative, so the browser stays on the address it used (and
 * keeps the session cookie just set for it).
 */
const TYPES: EmailOtpType[] = ["invite", "recovery", "email", "magiclink"];
const go = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "private, no-store" } });

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");
  const failed = `${AGENT_LOGIN}?link=expired`;

  try {
    const supabase = await createSessionClient("agent");
    let ok = false;
    if (tokenHash && type && TYPES.includes(type) && tokenHash.length <= 200) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      ok = !error;
      if (error) console.error("[agent] Link verification failed:", error.code ?? error.status ?? "no code");
    } else if (code && code.length <= 200) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      ok = !error;
      if (error) console.error("[agent] Code exchange failed:", error.code ?? error.status ?? "no code");
    }
    if (!ok) return go(failed);
  } catch (error) {
    console.error("[agent] Link verification failed:", (error as Error).name);
    return go(failed);
  }
  return go("/agent/set-password");
}
