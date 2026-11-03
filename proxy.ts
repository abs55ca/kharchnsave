import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_LOGIN } from "@/lib/auth/safe-redirect";
import { getSupabaseConfig, SESSION_COOKIE_OPTIONS, sessionFetch } from "@/lib/supabase/config";

/*
 * Runs before /admin routes only (see `matcher`), so storefront pages stay
 * cookie-free and cacheable.
 *
 * 1. Visitors with no Supabase session cookie are sent to the login page.
 *    This is an optimistic shortcut; it decides nothing. Every admin page and
 *    action verifies the user and their membership on the server.
 * 2. Otherwise it refreshes an expiring session and writes the new auth
 *    cookies, which Server Components can't do themselves.
 * 3. Every admin response is marked uncacheable, so no shared cache can store
 *    a session cookie or signed-in content.
 */

const AUTH_COOKIE = /^sb-.+-auth-token(\.\d+)?$/;
const NO_STORE = "private, no-cache, no-store, must-revalidate, max-age=0";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", NO_STORE);
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isLogin = pathname === ADMIN_LOGIN || pathname.startsWith(`${ADMIN_LOGIN}/`);
  const hasSessionCookie = request.cookies.getAll().some((cookie) => AUTH_COOKIE.test(cookie.name));

  if (!isLogin && !hasSessionCookie) {
    const login = request.nextUrl.clone();
    login.pathname = ADMIN_LOGIN;
    login.search = "";
    if (pathname !== "/admin") login.searchParams.set("next", `${pathname}${search}`);
    return noStore(NextResponse.redirect(login));
  }

  let response = NextResponse.next({ request });
  try {
    const { url, key } = getSupabaseConfig();
    const supabase = createServerClient(url, key, {
      cookieOptions: SESSION_COOKIE_OPTIONS,
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
  matcher: ["/admin/:path*"],
};
