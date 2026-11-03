import "server-only";

/*
 * Checkout configuration, read from server-only environment variables at
 * request time (callers render dynamically: see app/checkout/page.tsx).
 * Checkout is OFF unless every one of these is set; the database adds its own
 * switch (shop_settings.orders_open). Nothing here is ever sent to the
 * browser except the Turnstile site key, which is public by design.
 *
 *   CHECKOUT_ENABLED=true
 *   CHECKOUT_GATEWAY_SECRET   the gateway secret (its SHA-256 is registered in
 *                             the database: scripts/checkout-gateway-key.mjs)
 *   TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY   Cloudflare Turnstile
 *   CLIENT_IP_SOURCE          "header:<name>" for the single request header
 *                             the host sets to the visitor's IP (from the
 *                             host's documentation), or "none" to use one
 *                             shared rate-limit bucket for everyone
 *   TURNSTILE_ALLOWED_HOSTNAMES   optional, comma-separated: hostnames a
 *                             Turnstile token must have been solved on
 *   CHECKOUT_TURNSTILE_TESTING_KEYS=allow   LOCAL TESTS ONLY: accept answers
 *                             from Cloudflare's testing keys. Never set it on
 *                             a host; the admin pages warn while it is set.
 */

export type ClientIpSource = { kind: "header"; header: string } | { kind: "none" };

export type CheckoutConfig = {
  /** Orders can be taken (the database must agree, too). */
  enabled: boolean;
  /** Order lookups and key settling work (the gateway secret is set). */
  lookupsEnabled: boolean;
  /** What is missing, by variable name only. */
  problems: string[];
  gatewaySecret: string | null;
  turnstileSiteKey: string | null;
  turnstileSecret: string | null;
  turnstileHostnames: string[];
  /** Local tests only: accept Cloudflare testing-key answers. */
  turnstileTestingKeys: boolean;
  clientIp: ClientIpSource | null;
};

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

export function parseClientIpSource(value: string | undefined): ClientIpSource | null {
  const raw = value?.trim().toLowerCase();
  if (raw === "none") return { kind: "none" };
  const match = raw ? /^header:(.+)$/.exec(raw) : null;
  // Never trust X-Forwarded-For: its first value is whatever the client sent.
  if (match && HEADER_NAME.test(match[1]) && match[1] !== "x-forwarded-for") return { kind: "header", header: match[1] };
  return null;
}

export function getCheckoutConfig(env: Record<string, string | undefined> = process.env): CheckoutConfig {
  const problems: string[] = [];
  const gatewaySecret = env.CHECKOUT_GATEWAY_SECRET?.trim() || null;
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim() || null;
  const clientIp = parseClientIpSource(env.CLIENT_IP_SOURCE);

  if (env.CHECKOUT_ENABLED?.trim() !== "true") problems.push("CHECKOUT_ENABLED");
  if (!gatewaySecret || gatewaySecret.length < 32) problems.push("CHECKOUT_GATEWAY_SECRET");
  if (!turnstileSiteKey) problems.push("TURNSTILE_SITE_KEY");
  if (!turnstileSecret) problems.push("TURNSTILE_SECRET_KEY");
  if (!clientIp) problems.push("CLIENT_IP_SOURCE");

  return {
    enabled: problems.length === 0,
    lookupsEnabled: !!gatewaySecret && gatewaySecret.length >= 32,
    problems,
    gatewaySecret: gatewaySecret && gatewaySecret.length >= 32 ? gatewaySecret : null,
    turnstileSiteKey,
    turnstileSecret,
    turnstileHostnames: (env.TURNSTILE_ALLOWED_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    turnstileTestingKeys: env.CHECKOUT_TURNSTILE_TESTING_KEYS?.trim() === "allow",
    clientIp,
  };
}
