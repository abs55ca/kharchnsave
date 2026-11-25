"use client";

import Image from "next/image";
import Link from "next/link";
import { MinusIcon, PlusIcon } from "@/components/icons";
import { StatusBadge } from "@/components/product/badges";
import type { CartLine } from "@/lib/cart/cart-store";
import { CONDITION_LABELS } from "@/lib/catalog/labels";
import { formatPrice } from "@/lib/format";
import { useCart } from "./cart-provider";

function QuantityControl({ line }: { line: CartLine }) {
  const { setQuantity } = useCart();

  if (line.status === "preloved") {
    return (
      <p className="text-xs text-muted">
        Qty 1 · one-off pre-loved pair
      </p>
    );
  }

  const atLimit = line.quantity >= line.maxQuantity;
  return (
    <div>
      <div className="inline-flex items-center rounded-md border border-line">
        <button
          type="button"
          onClick={() => setQuantity(line.sku, line.quantity - 1)}
          disabled={line.quantity <= 1}
          className="inline-flex size-8 items-center justify-center rounded-l-md hover:bg-cream disabled:cursor-not-allowed disabled:text-line"
          aria-label={`Decrease quantity of ${line.name}`}
        >
          <MinusIcon width={16} height={16} />
        </button>
        <span className="min-w-8 text-center text-sm font-medium" aria-live="polite">
          <span className="sr-only">Quantity </span>
          {line.quantity}
        </span>
        <button
          type="button"
          onClick={() => setQuantity(line.sku, line.quantity + 1)}
          disabled={atLimit}
          className="inline-flex size-8 items-center justify-center rounded-r-md hover:bg-cream disabled:cursor-not-allowed disabled:text-line"
          aria-label={`Increase quantity of ${line.name}`}
        >
          <PlusIcon width={16} height={16} />
        </button>
      </div>
      {atLimit ? (
        <p className="mt-1 text-xs text-muted">
          Only {line.maxQuantity} available in EU {line.size}
        </p>
      ) : null}
    </div>
  );
}

export function CartLines({
  onNavigate,
  imageSize = 88,
}: {
  onNavigate?: () => void;
  imageSize?: number;
}) {
  const { lines, remove, lineStatus } = useCart();

  return (
    <ul className="divide-y divide-line">
      {lines.map((line) => {
        const status = lineStatus(line.sku);
        const gone = status?.status === "unavailable";
        const soldOut = status?.status === "sold-out";
        const blocked = gone || soldOut;
        return (
          <li key={line.sku} className="flex gap-4 py-4">
            <div
              className={`relative shrink-0 overflow-hidden rounded-md bg-cream ${blocked ? "opacity-60" : ""}`}
              style={{ width: imageSize, height: imageSize }}
            >
              <Image
                src={line.image.src}
                alt={line.image.alt}
                fill
                sizes={`${imageSize}px`}
                className="object-cover"
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {line.brand}
                  </p>
                  {gone ? (
                    <p className="text-sm font-medium leading-snug">{line.name}</p>
                  ) : (
                    <Link
                      href={`/products/${line.slug}`}
                      onClick={onNavigate}
                      className="text-sm font-medium leading-snug hover:underline"
                    >
                      {line.name}
                    </Link>
                  )}
                </div>
                <p className={`shrink-0 text-sm font-semibold ${blocked ? "text-muted line-through" : ""}`}>
                  {formatPrice(line.price * line.quantity)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <StatusBadge status={line.status} />
                <span>EU {line.size}</span>
                {line.status === "preloved" ? (
                  <span>· {CONDITION_LABELS[line.condition]}</span>
                ) : (
                  <span>· {formatPrice(line.price)} each</span>
                )}
              </div>
              {gone ? (
                <p className="text-xs font-medium text-danger">
                  No longer available. This item isn&apos;t listed any more.
                </p>
              ) : soldOut ? (
                <p className="text-xs font-medium text-danger">Sold out since you added it.</p>
              ) : status?.status === "available" && status.stock < line.quantity ? (
                <p className="text-xs font-medium text-danger">
                  Only {status.stock} available now in EU {line.size}.
                </p>
              ) : null}
              <div className="mt-1 flex items-end justify-between gap-3">
                {blocked ? <span /> : <QuantityControl line={line} />}
                <button
                  type="button"
                  onClick={() => remove(line.sku)}
                  className="text-xs font-medium text-muted underline underline-offset-2 hover:text-danger"
                >
                  Remove<span className="sr-only"> {line.name}</span>
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Explains why the subtotal may leave items out, or that stock couldn't be checked. */
export function CartAvailabilityNote() {
  const { unavailableCount, availabilityFailed } = useCart();
  if (unavailableCount > 0) {
    return (
      <p className="rounded-md border border-danger/30 px-3 py-2 text-xs leading-relaxed text-danger">
        {unavailableCount === 1
          ? "1 item in your cart can't be bought any more and isn't included in the subtotal."
          : `${unavailableCount} items in your cart can't be bought any more and aren't included in the subtotal.`}{" "}
        Remove {unavailableCount === 1 ? "it" : "them"} to tidy up your cart.
      </p>
    );
  }
  if (availabilityFailed) {
    return (
      <p className="rounded-md bg-cream px-3 py-2 text-xs leading-relaxed text-muted">
        We couldn&apos;t check current stock just now, so an item may have sold since you
        added it.
      </p>
    );
  }
  return null;
}
