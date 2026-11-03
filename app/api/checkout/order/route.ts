import { headers } from "next/headers";
import { clientBucket, clientIp } from "@/lib/checkout/client-ip";
import { getCheckoutConfig } from "@/lib/checkout/config";
import { CHECKOUT_KEY_PATTERN } from "@/lib/checkout/input";
import { json, readJson } from "@/lib/checkout/route";
import { customerOrder, logDbError, registerAttempt, resolveCheckout } from "@/lib/checkout/server";

/**
 * POST /api/checkout/order  { key, action?: "view" | "settle" | "abandon" }
 *
 * The customer's own order, by the private key from their browser (the key
 * travels in the request body, never in a URL). Rate-limited per visitor.
 *
 *   view     the order, or { order: null }
 *   settle   what happened to a submission whose answer was lost:
 *            { state: "placed", order } | { state: "none" | "abandoned" }
 *   abandon  as settle, but if no order exists the key is given up for good,
 *            so no late request can ever place an order with it.
 *
 * Responses show only the order's own details: first name, the last three
 * digits of the phone number, the city, items and totals. Never the address.
 */
export async function POST(request: Request) {
  const config = getCheckoutConfig();
  if (!config.lookupsEnabled || !config.gatewaySecret) return json({ error: "disabled" }, 503);
  const secret = config.gatewaySecret;

  const body = await readJson(request, 1024);
  const key = typeof body?.key === "string" && CHECKOUT_KEY_PATTERN.test(body.key) ? body.key : null;
  const action = body?.action ?? "view";
  if (!key || !["view", "settle", "abandon"].includes(action as string)) return json({ error: "bad_request" }, 400);

  const attempt = await registerAttempt(secret, clientBucket(clientIp(await headers(), config.clientIp), secret), "lookup");
  if (attempt.error || !attempt.data) {
    logDbError("lookup limit", attempt.error);
    return json({ error: "unavailable" }, 503);
  }
  if (!attempt.data.allowed) return json({ error: "rate_limited" }, 429);

  if (action === "view") {
    const { data, error } = await customerOrder(secret, key);
    if (error) {
      logDbError("order lookup", error);
      return json({ error: "unavailable" }, 503);
    }
    return json({ order: data });
  }

  const { data, error } = await resolveCheckout(secret, key, null, action === "abandon");
  if (error || !data) {
    logDbError("settle", error);
    return json({ error: "unavailable" }, 503);
  }
  return json(data);
}
