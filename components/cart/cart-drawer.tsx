"use client";

import Link from "next/link";
import { useId } from "react";
import { Drawer } from "@/components/ui/drawer";
import { DEPARTMENTS, DEPARTMENT_ORDER } from "@/lib/catalog/labels";
import { formatPrice } from "@/lib/format";
import { CartAvailabilityNote, CartLines } from "./cart-lines";
import { useCart } from "./cart-provider";

export function CartDrawer() {
  const { lines, count, subtotal, isOpen, closeCart, notice } = useCart();
  const titleId = useId();
  const empty = lines.length === 0;

  return (
    <Drawer
      open={isOpen}
      onClose={closeCart}
      title={empty ? "Your cart" : `Your cart (${count})`}
      titleId={titleId}
      footer={
        empty ? null : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Subtotal</span>
              <span className="text-base font-semibold">{formatPrice(subtotal)}</span>
            </div>
            <CartAvailabilityNote />
            <div className="grid grid-cols-2 gap-2">
              <Link href="/cart" onClick={closeCart} className="btn btn-outline">
                View cart
              </Link>
              <Link href="/checkout" onClick={closeCart} className="btn btn-lime">
                Checkout
              </Link>
            </div>
          </div>
        )
      }
    >
      <p
        role="status"
        className={
          notice
            ? "mx-5 mt-4 rounded-md bg-forest-soft px-3 py-2 text-sm font-medium text-forest"
            : "sr-only"
        }
      >
        {notice}
      </p>
      {empty ? (
        <div className="px-5 py-10 text-center">
          <p className="font-heading text-lg font-bold">Your cart is empty</p>
          <p className="mt-1 text-sm text-muted">
            Find a pair you love and it will show up here.
          </p>
          <ul className="mt-6 grid gap-2">
            {DEPARTMENT_ORDER.map((dept) => (
              <li key={dept}>
                <Link
                  href={DEPARTMENTS[dept].href}
                  onClick={closeCart}
                  className="btn btn-outline w-full"
                >
                  Shop {DEPARTMENTS[dept].title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="px-5">
          <CartLines onNavigate={closeCart} />
        </div>
      )}
    </Drawer>
  );
}
