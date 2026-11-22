import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_LOGIN, AGENT_LOGIN, AGENT_PUBLIC } from "@/lib/auth/safe-redirect";
import {
  AGENT_AUTH_COOKIE,
  AGENT_SESSION_COOKIE_OPTIONS,
  getSupabaseConfig,
  SESSION_COOKIE_OPTIONS,
  sessionFetch,
} from "@/lib/supabase/config";

/*
 * Runs before /admin and /agent routes only (see `matcher`), so storefront
 * pages stay cookie-free and cacheable. Each area has its own session cookie
 * (name and path), so the two never see each other's login.
 *
 * 1. Visitors with no session cookie for the area are sent to its sign-in
 *    page (except the area's public pages: sign-in, password links). This is
 *    an optimistic shortcut; it decides nothing. Every page and action
 *    verifies the user and their membership on the server.
 * 2. Otherwise it refreshes an expiring session and writes the new auth
 *    cookies, which Server Components can't do themselves.
 * 3. Every response is marked uncacheable, so no shared cache can store a
 *    session cookie or signed-in content.
 */

const ADMIN_AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;
const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";

const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", NO_STORE);
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const agentArea = isUnder(pathname, "/agent");
  const area = agentArea
    ? { login: AGENT_LOGIN, home: "/agent", cookie: AGENT_AUTH_COOKIE, options: AGENT_SESSION_COOKIE_OPTIONS, public: AGENT_PUBLIC }
    : { login: ADMIN_LOGIN, home: "/admin", cookie: ADMIN_AUTH_COOKIE, options: SESSION_COOKIE_OPTIONS, public: [ADMIN_LOGIN] };
  const isPublic = area.public.some((path) => isUnder(pathname, path));
  const hasSessionCookie = request.cookies.getAll().some((cookie) => area.cookie.test(cookie.name));

  if (!isPublic && !hasSessionCookie) {
    const login = request.nextUrl.clone();
    login.pathname = area.login;
    login.search = "";
    if (pathname !== area.home) login.searchParams.set("next", `${pathname}${search}`);
    return noStore(NextResponse.redirect(login));
  }

  let response = NextResponse.next({ request });
  if (!hasSessionCookie) return noStore(response);
  try {
    const { url, key } = getSupabaseConfig();
    const supabase = createServerClient(url, key, {
      cookieOptions: area.options,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          for (const [header, value] of Object.entries(headers)) response.headers.set(header, value);
        },
      },
      // A stalled refresh gives up (timeout) instead of holding the response.
      global: { fetch: sessionFetch },
    });
    // Refreshes the session if the access token is expiring. Keep this
    // directly after createServerClient, before anything else reads it.
    await supabase.auth.getClaims();
  } catch (error) {
    // Misconfiguration or network failure: the page's own check fails closed.
    console.error("[proxy] Session refresh failed:", error);
  }
  return noStore(response);
}

export const config = {
  matcher: ["/admin/:path*", "/agent/:path*"],
};
