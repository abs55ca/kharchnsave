"use client";

import Link from "next/link";
import { fullName } from "@/lib/catalog/product-utils";
import { formatPrice, pluralize } from "@/lib/format";
import { CartAvailabilityNote } from "./cart-lines";
import { useCart } from "./cart-provider";

/**
 * Shown instead of the checkout while ordering is switched off on the server.
 * It never collects payment or personal details.
 */
export function CheckoutHandoff() {
  const { lines, subtotal, hydrated, lineStatus } = useCart();
  const isBlocked = (sku: string) => {
    const status = lineStatus(sku)?.status;
    return status === "unavailable" || status === "sold-out";
  };
  const buyableCount = lines
    .filter((line) => !isBlocked(line.sku))
    .reduce((sum, line) => sum + line.quantity, 0);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <div className="rounded-lg border border-line p-6 md:p-8">
        <p className="eyebrow text-muted">Checkout</p>
        <h2 className="mt-2 text-xl font-bold md:text-2xl">Online ordering is paused right now</h2>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-ink/85">
          <p>
            We can&apos;t take orders on the website at the moment. Your cart is saved on this
            device, so you can come back and place your order later. Nothing has been charged.
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/cart" className="btn btn-forest">
            Back to cart
          </Link>
          <Link href="/shop" className="btn btn-outline">
            Continue shopping
          </Link>
        </div>
      </div>

      <section aria-labelledby="handoff-summary" className="rounded-lg bg-cream p-5">
        <h2 id="handoff-summary" className="text-base font-bold">
          Cart summary
        </h2>
        {!hydrated ? (
          <p className="mt-3 text-sm text-muted">Loading your cart…</p>
        ) : lines.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Your cart is empty.</p>
        ) : (
          <>
            <ul className="mt-3 space-y-2 text-sm">
              {lines.map((line) => (
                <li key={line.sku} className="flex justify-between gap-4">
                  <span className="min-w-0">
                    {line.quantity} × {fullName(line)}
                    <span className="text-muted"> · EU {line.size}</span>
                    {isBlocked(line.sku) ? <span className="text-danger"> · unavailable</span> : null}
                  </span>
                  <span className={`shrink-0 ${isBlocked(line.sku) ? "text-muted line-through" : ""}`}>
                    {formatPrice(line.price * line.quantity)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 flex justify-between border-t border-line pt-3 font-semibold">
              <span>Subtotal ({pluralize(buyableCount, "item")})</span>
              <span>{formatPrice(subtotal)}</span>
            </p>
            <div className="mt-3">
              <CartAvailabilityNote />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
