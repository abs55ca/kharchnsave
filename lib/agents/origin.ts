import "server-only";

/**
 * The site address put in agents' password links (and the reset email's
 * return address). In order:
 *   1. AGENT_LINK_ORIGIN, e.g. https://kharchnsave.pk (set it on the host);
 *   2. the Origin of the request: a Server Action is posted from the admin's
 *      (or agent's) own page, and Next.js has already checked it matches the host;
 *   3. the Host header.
 * Next.js's own request URL isn't used: behind `next start` it can say
 * "localhost" while the browser uses another name, and a link or redirect
 * to the other name loses the session cookie.
 */
export function linkOrigin(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  const configured = env.AGENT_LINK_ORIGIN?.trim().replace(/\/$/, "");
  if (configured && /^https?:\/\/[^/\s]+$/.test(configured)) return configured;
  const origin = headers.get("origin");
  if (origin && /^https?:\/\/[^/\s]+$/.test(origin)) return origin;
  const host = headers.get("host") ?? "localhost:3000";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
