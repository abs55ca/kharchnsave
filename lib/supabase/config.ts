/*
 * Supabase project settings shared by every client (catalogue, admin
 * session and the proxy). The values are the public URL and publishable key,
 * so this module is safe to import anywhere on the server, including
 * proxy.ts, which can't import "server-only" modules.
 */

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

/** The project URL and publishable key, or a clear error if they're unusable. */
export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    const missing = [
      !url && "NEXT_PUBLIC_SUPABASE_URL",
      !key && "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ].filter(Boolean);
    throw new Error(
      `Supabase isn't configured: set ${missing.join(" and ")} in .env.local ` +
        "(see .env.example), then restart the server.",
    );
  }
  if (key.startsWith("sb_secret_")) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the " +
        "project's publishable key; secret keys must never be NEXT_PUBLIC_.",
    );
  }
  return { url, key };
}

/**
 * Auth cookie settings for the admin session. Nothing in the browser reads
 * the session (there is no client-side Supabase), so the cookies are
 * HttpOnly, and they're scoped to /admin so storefront requests never carry
 * them.
 */
export const SESSION_COOKIE_OPTIONS = {
  path: "/admin",
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
} as const;

/**
 * fetch for Supabase clients: keeps requests out of Next's fetch cache, which
 * persists across builds. Catalogue reads are cached explicitly with
 * "use cache"; session requests must never be cached at all.
 */
export function noStoreFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

/**
 * How long an admin page waits for Supabase Auth or a read. Without a limit,
 * one stalled request leaves the page on its loading state ("Checking your
 * access…") until the browser is refreshed; with it, the check fails closed
 * and the page offers "Try again".
 */
export const SESSION_READ_TIMEOUT_MS = 10_000;

/** For read-only RPCs made while a page renders: `.abortSignal(readTimeout())`. */
export const readTimeout = () => AbortSignal.timeout(SESSION_READ_TIMEOUT_MS);

/**
 * fetch for the admin session client and the proxy: never cached, and Auth
 * requests and reads (GET/HEAD) give up after `timeoutMs`. Writes (RPCs,
 * photo uploads) aren't cut short: the database may already have applied
 * them, and an abort would hide that.
 */
export function createSessionFetch(timeoutMs = SESSION_READ_TIMEOUT_MS) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url = new URL(request ? request.url : String(input));
    if (method !== "GET" && method !== "HEAD" && !url.pathname.startsWith("/auth/v1/")) return noStoreFetch(input, init);
    const timeout = AbortSignal.timeout(timeoutMs);
    return noStoreFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

export const sessionFetch = createSessionFetch();
