/*
 * The checkout key, kept in the customer's browser.
 *
 * A key is 32 random bytes made in the browser. It identifies one order
 * attempt (so retries can never create a second order) and, afterwards, it
 * is the private link to that order (/order#k=…). The database stores only
 * its hash.
 *
 * What is stored here: the key, a description of the cart it was made for
 * (SKUs, quantities and prices; no personal details) and whether it has been
 * sent. Name, phone and address are never stored.
 *
 *   draft  never sent: replaced freely when the cart changes.
 *   sent   a submission may have reached the server, even if no answer came
 *          back. The key is kept, unchanged, until its outcome is settled:
 *          either an order exists (show it), or the server has marked the key
 *          abandoned so no late request can ever use it. Only then is a new
 *          key made. "No order found" alone proves nothing: the first request
 *          may still be on its way.
 */

import { CHECKOUT_KEY_PATTERN } from "./input";

export const ATTEMPT_STORAGE_KEY = "kharchnsave:checkout:v1";

export type CheckoutAttempt = {
  key: string;
  cart: string;
  state: "draft" | "sent";
  createdAt: number;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export function newCheckoutKey(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readAttempt(storage: Storage | null): CheckoutAttempt | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(ATTEMPT_STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const a = parsed as Record<string, unknown>;
    if (typeof a.key !== "string" || !CHECKOUT_KEY_PATTERN.test(a.key)) return null;
    if (typeof a.cart !== "string" || (a.state !== "draft" && a.state !== "sent")) return null;
    return { key: a.key, cart: a.cart, state: a.state, createdAt: typeof a.createdAt === "number" ? a.createdAt : 0 };
  } catch {
    return null;
  }
}

export function writeAttempt(storage: Storage | null, attempt: CheckoutAttempt) {
  try {
    storage?.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // Storage unavailable: the attempt lives in memory only.
  }
}

export function clearAttempt(storage: Storage | null) {
  try {
    storage?.removeItem(ATTEMPT_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * The attempt to use for this cart. A sent key is returned as it is, even
 * for a different cart: the caller must settle it first (see settleNeeded).
 */
export function attemptForCart(existing: CheckoutAttempt | null, cart: string, now = Date.now(), makeKey = () => newCheckoutKey()): CheckoutAttempt {
  if (existing?.state === "sent") return existing;
  if (existing && existing.cart === cart) return existing;
  return { key: makeKey(), cart, state: "draft", createdAt: now };
}

/** A sent key whose cart has since changed: settle it before submitting again. */
export function settleNeeded(attempt: CheckoutAttempt | null, cart: string): boolean {
  return attempt?.state === "sent" && attempt.cart !== cart;
}

/** The Turnstile cData for a key: a short hash, so the key itself never leaves the site. */
export async function turnstileCData(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
