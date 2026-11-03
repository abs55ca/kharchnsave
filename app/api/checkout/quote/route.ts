import { headers } from "next/headers";
import { clientBucket, clientIp } from "@/lib/checkout/client-ip";
import { getCheckoutConfig } from "@/lib/checkout/config";
import { cleanText, MAX_QUOTE_LINES, parseOrderLines } from "@/lib/checkout/input";
import { json, readJson } from "@/lib/checkout/route";
import { logDbError, quoteOrder, registerAttempt } from "@/lib/checkout/server";

/**
 * POST /api/checkout/quote  { lines: [{sku, quantity, unit_price_paisa}], city }
 *
 * Read-only: live prices, availability and delivery for the checkout page,
 * straight from the database (never cached). Anyone can call this endpoint,
 * so it is limited like the rest of checkout: a small body (8 KB), at most
 * MAX_QUOTE_LINES lines, a city of at most 60 characters, and a shared
 * per-connection limit in the database (quotes_per_ip_10min). Carries no
 * personal details apart from the city. The order is recalculated again
 * when placed.
 */
export async function POST(request: Request) {
  const config = getCheckoutConfig();
  if (!config.enabled || !config.gatewaySecret) return json({ error: "disabled" }, 503);
  const secret = config.gatewaySecret;

  const body = await readJson(request, 8192);
  const lines = parseOrderLines(body?.lines);
  const rawCity = typeof body?.city === "string" ? body.city : "";
  if (!lines || lines.length > MAX_QUOTE_LINES || rawCity.length > 60) return json({ error: "bad_request" }, 400);
  const city = cleanText(rawCity);

  const attempt = await registerAttempt(secret, clientBucket(clientIp(await headers(), config.clientIp), secret), "quote");
  if (attempt.error || !attempt.data) {
    logDbError("quote limit", attempt.error);
    return json({ error: "unavailable" }, 503);
  }
  if (!attempt.data.allowed) {
    return json({ error: attempt.data.reason === "not_configured" ? "disabled" : "rate_limited" }, attempt.data.reason === "not_configured" ? 503 : 429);
  }

  const { data, error } = await quoteOrder(secret, lines, city || null);
  if (error || !data) {
    logDbError("quote", error);
    return json({ error: "unavailable" }, 503);
  }
  return json({ quote: data });
}
