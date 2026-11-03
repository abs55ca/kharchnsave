import "server-only";
import { createHash, randomUUID } from "node:crypto";

/*
 * Cloudflare Turnstile, checked on the server (Siteverify). Behaviour from
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/:
 * tokens are single-use and expire after 300 seconds ("timeout-or-duplicate").
 *
 * The token is bound to one checkout key through cData (a short hash of the
 * key) and to the action "place_order". An expired or already-used token never
 * places an order: the customer is asked to complete the check again, and the
 * same checkout key is reused, so no duplicate order can result.
 *
 * If Siteverify can't be reached, or rejects our secret, checkout refuses the
 * submission (fails closed).
 *
 * Cloudflare's testing keys (https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
 * answer with metadata.result_with_testing_key and without our action or
 * cData. Such answers are REFUSED unless allowTestingKeys is set, which only
 * the local test configuration does (CHECKOUT_TURNSTILE_TESTING_KEYS=allow).
 * Real tokens are always checked in full.
 */

export const TURNSTILE_ACTION = "place_order";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" | "unavailable" };

type SiteverifyResponse = {
  success?: boolean;
  "error-codes"?: string[];
  hostname?: string;
  action?: string;
  cdata?: string;
  metadata?: { result_with_testing_key?: boolean };
};

/** The cData a checkout key's token must carry (same as the browser computes). */
export function cdataFor(checkoutKey: string) {
  return createHash("sha256").update(checkoutKey).digest("hex").slice(0, 32);
}

export async function verifyTurnstile(
  token: string,
  options: {
    secret: string;
    checkoutKey: string;
    remoteIp: string | null;
    hostnames: string[];
    allowTestingKeys?: boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<TurnstileOutcome> {
  if (!token || token.length > 2048) return { ok: false, reason: "invalid" };
  const fetchImpl = options.fetchImpl ?? fetch;
  // One idempotency key for this validation, reused if the request itself is retried.
  const idempotencyKey = randomUUID();
  const body = JSON.stringify({
    secret: options.secret,
    response: token,
    idempotency_key: idempotencyKey,
    ...(options.remoteIp ? { remoteip: options.remoteIp } : {}),
  });

  let result: SiteverifyResponse | null = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      const response = await fetchImpl(SITEVERIFY, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        cache: "no-store",
      });
      if (response.status >= 500) continue;
      result = (await response.json()) as SiteverifyResponse;
    } catch {
      // Network error or timeout: try once more, then give up.
    }
  }
  if (!result) return { ok: false, reason: "unavailable" };

  const codes = result["error-codes"] ?? [];
  if (result.success !== true) {
    if (codes.includes("timeout-or-duplicate")) return { ok: false, reason: "expired" };
    if (codes.some((c) => c === "invalid-input-response" || c === "missing-input-response")) {
      return { ok: false, reason: "invalid" };
    }
    // Our secret was refused, the request was malformed, or Cloudflare failed.
    return { ok: false, reason: "unavailable" };
  }
  if (result.metadata?.result_with_testing_key === true) {
    // A testing key can't carry our action or cData: accepted only in local tests.
    return options.allowTestingKeys ? { ok: true } : { ok: false, reason: "invalid" };
  }
  if (result.action !== TURNSTILE_ACTION || result.cdata !== cdataFor(options.checkoutKey)) {
    return { ok: false, reason: "invalid" };
  }
  if (options.hostnames.length > 0 && !options.hostnames.includes((result.hostname ?? "").toLowerCase())) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}
