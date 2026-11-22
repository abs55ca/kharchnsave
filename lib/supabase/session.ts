import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AGENT_SESSION_COOKIE_OPTIONS, getSupabaseConfig, SESSION_COOKIE_OPTIONS, sessionFetch } from "./config";

/**
 * Session-aware Supabase client for the admin area (and, with "agent", the
 * sales-agent area, whose session lives in its own cookie). It reads the signed-in
 * user's auth cookies, so it must be created per request and its results
 * must never be cached or shared ("use cache" scopes can't read cookies, by
 * design). The anonymous catalogue client in ./server.ts is kept separate.
 *
 * In Server Components cookies can't be written; the session is refreshed
 * by proxy.ts before the page renders. Server Actions can write them, which
 * is how sign-in and sign-out set and clear the session.
 *
 * Supabase Auth compares the token's expiry with Date.now() as soon as the
 * client is created and on every session read. cookies() alone still allows
 * a runtime prefetch, where the current time isn't available, so wait for
 * the actual request first.
 */
export async function createSessionClient(area: "admin" | "agent" = "admin") {
  await connection();
  const { url, key } = getSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    // The agent area (/agent) has its own cookie name and path; see config.ts.
    cookieOptions: area === "agent" ? AGENT_SESSION_COOKIE_OPTIONS : SESSION_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: the proxy writes refreshed cookies.
        }
      },
    },
    // Never cached; Auth calls and reads give up after a timeout (see config.ts).
    global: { fetch: sessionFetch },
  });
}
