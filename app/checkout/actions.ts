"use server";

import { revalidateTag } from "next/cache";
import { headers } from "next/headers";
import { clientBucket, clientIp } from "@/lib/checkout/client-ip";
import { getCheckoutConfig } from "@/lib/checkout/config";
import { logDbError, placeCodOrder, registerAttempt, resolveCheckout } from "@/lib/checkout/server";
import { submitOrder, type SubmitInput, type SubmitResult } from "@/lib/checkout/submit";
import { verifyTurnstile } from "@/lib/checkout/turnstile";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";

/*
 * Places a cash-on-delivery order. A Server Action is a public endpoint, so
 * nothing here trusts the browser: lib/checkout/submit.ts checks the input,
 * and the database recalculates prices, availability and totals. Next.js
 * rejects cross-site POSTs to actions (Origin check). Nothing personal is
 * logged; failures are logged by database error code only.
 */
export async function placeOrder(input: SubmitInput): Promise<SubmitResult> {
  const config = getCheckoutConfig();
  const secret = config.gatewaySecret ?? "";
  const ip = clientIp(await headers(), config.clientIp);

  return submitOrder(input, {
    enabled: config.enabled,
    clientBucket: clientBucket(ip, secret),
    remoteIp: ip,
    resolve: (key, order) => resolveCheckout(secret, key, order, false),
    registerAttempt: (client) => registerAttempt(secret, client, "place"),
    verifyTurnstile: (token, key, remoteIp) =>
      verifyTurnstile(token, {
        secret: config.turnstileSecret ?? "",
        checkoutKey: key,
        remoteIp,
        hostnames: config.turnstileHostnames,
        allowTestingKeys: config.turnstileTestingKeys,
      }),
    place: (key, order) => placeCodOrder(secret, key, order),
    // Stock changed: refresh the shop's cached catalogue in the background
    // (stale-while-revalidate), so a burst of orders can't slow pages down.
    onPlaced: () => revalidateTag(CATALOGUE_TAG, "max"),
    logError: logDbError,
  });
}
