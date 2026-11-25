"use client";

import Link from "next/link";
import { DEPARTMENTS, DEPARTMENT_ORDER } from "@/lib/catalog/labels";
import { formatPrice, pluralize } from "@/lib/format";
import { CartAvailabilityNote, CartLines } from "./cart-lines";
import { useCart } from "./cart-provider";

export function CartPageView() {
  const { lines, count, subtotal, hydrated } = useCart();

  if (!hydrated) return <CartSkeleton />;

  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-14 text-center">
        <h2 className="text-lg font-bold">Your cart is empty</h2>
        <p className="mt-2 text-sm text-muted">
          Browse the latest pre-loved pairs and new kids&apos; styles.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {DEPARTMENT_ORDER.map((dept) => (
            <Link key={dept} href={DEPARTMENTS[dept].href} className="btn btn-outline">
              {DEPARTMENTS[dept].title}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <section aria-labelledby="cart-items-heading">
        <h2 id="cart-items-heading" className="sr-only">
          Items in your cart
        </h2>
        <div className="border-y border-line">
          <CartLines imageSize={112} />
        </div>
        <Link href="/shop" className="mt-4 inline-block text-sm font-semibold text-forest link-underline">
          Continue shopping
        </Link>
      </section>
      <section
        aria-labelledby="cart-summary-heading"
        className="space-y-4 rounded-lg border border-line p-5"
      >
        <h2 id="cart-summary-heading" className="text-base font-bold">
          Order summary
        </h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Items</dt>
            <dd>{pluralize(count, "item")}</dd>
          </div>
          <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
            <dt>Subtotal</dt>
            <dd>{formatPrice(subtotal)}</dd>
          </div>
        </dl>
        <CartAvailabilityNote />
        <Link href="/checkout" className="btn btn-lime h-12 w-full text-[15px]">
          Continue to checkout
        </Link>
      </section>
    </div>
  );
}

/**
 * Shown until the saved cart has been read on this device: the layout of a
 * one-item cart, at the same sizes, so the page doesn't jump when the cart
 * appears (more items still push the summary down on phones).
 */
function CartSkeleton() {
  const bar = "rounded bg-cream";
  return (
    <div aria-busy="true" className="grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <p role="status" className="sr-only">
        Loading your cart…
      </p>
      <div aria-hidden="true">
        <div className="flex gap-4 border-y border-line py-4">
          <div className={`size-28 shrink-0 ${bar}`} />
          <div className="flex-1 space-y-2 pt-0.5">
            <div className={`h-3 w-20 ${bar}`} />
            <div className={`h-4 w-3/4 ${bar}`} />
            <div className={`h-3 w-1/2 ${bar}`} />
            <div className={`mt-6 h-8 w-24 ${bar}`} />
          </div>
        </div>
        <div className={`mt-4 h-5 w-32 ${bar}`} />
      </div>
      <div aria-hidden="true" className="space-y-4 rounded-lg border border-line p-5">
        <div className={`h-6 w-36 ${bar}`} />
        <div className="space-y-2">
          <div className={`h-5 ${bar}`} />
          <div className={`h-9 border-t border-line pt-3`}>
            <div className={`h-6 ${bar}`} />
          </div>
        </div>
        <div className={`h-14 rounded-md ${bar}`} />
        <div className={`h-12 rounded-md ${bar}`} />
      </div>
    </div>
  );
}
