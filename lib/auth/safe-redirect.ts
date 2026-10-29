const BASE = "http://internal.invalid";

export const ADMIN_HOME = "/admin";
export const ADMIN_LOGIN = "/admin/login";
export const ADMIN_MFA = "/admin/mfa";

const isUnder = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * Where to send someone after signing in. Only paths inside the admin area
 * are allowed (never another site, a protocol-relative URL such as
 * "//evil.example", a backslash trick, or the login and two-step pages
 * themselves); anything else falls back to the admin home page.
 */
export function safeAdminPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return ADMIN_HOME;
  // Must be a plain absolute path: no scheme, no "//host", no "\", no control characters.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return ADMIN_HOME;
  }

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return ADMIN_HOME;
  }
  if (url.origin !== BASE) return ADMIN_HOME;

  const path = url.pathname;
  if (!isUnder(path, ADMIN_HOME) || isUnder(path, ADMIN_LOGIN) || isUnder(path, ADMIN_MFA)) {
    return ADMIN_HOME;
  }

  return `${path}${url.search}${url.hash}`;
}

/** The two-step verification page, returning to `next` (a safeAdminPath) afterwards. */
export function mfaPath(next: string): string {
  return next === ADMIN_HOME ? ADMIN_MFA : `${ADMIN_MFA}?next=${encodeURIComponent(next)}`;
}

/** The login page, returning to `next` (a safeAdminPath) afterwards. */
export function loginPath(next: string): string {
  return next === ADMIN_HOME ? ADMIN_LOGIN : `${ADMIN_LOGIN}?next=${encodeURIComponent(next)}`;
}
