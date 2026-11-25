"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useCart } from "@/components/cart/cart-provider";
import { isOnSale } from "@/lib/catalog/pricing";
import { formatPrice } from "@/lib/format";
import { fullName } from "@/lib/catalog/product-utils";
import type { Product, ProductVariant } from "@/lib/catalog/types";
import { sizeConversion } from "@/lib/sizes";

function stockMessage(variant: ProductVariant | undefined, oneOff: boolean) {
  if (!variant) return null;
  if (variant.stock === 0) return { text: "Sold out", tone: "text-danger" };
  if (oneOff) return { text: "In stock: one pair available", tone: "text-forest" };
  if (variant.stock <= 2) return { text: `Only ${variant.stock} left in EU ${variant.size}`, tone: "text-forest" };
  return { text: `In stock in EU ${variant.size}`, tone: "text-forest" };
}

export function PurchasePanel({ product }: { product: Product }) {
  const { lines, add, openCart } = useCart();
  const oneOff = product.status === "preloved";
  const single = product.variants.length === 1 ? product.variants[0] : undefined;
  const [selectedSku, setSelectedSku] = useState<string | null>(single?.sku ?? null);
  const [error, setError] = useState("");
  const groupId = useId();
  const errorId = useId();

  const selected = product.variants.find((v) => v.sku === selectedSku);
  const inCart = selected ? lines.find((l) => l.sku === selected.sku)?.quantity ?? 0 : 0;
  const soldOut = product.variants.every((v) => v.stock === 0);
  const atLimit = !!selected && selected.stock > 0 && inCart >= selected.stock;
  const status = stockMessage(selected, oneOff);
  const mainButton = useRef<HTMLButtonElement>(null);
  const showBar = useStickyBar(mainButton);

  function handleAdd() {
    if (!selected) {
      setError("Please select a size.");
      return;
    }
    setError("");
    const result = add({
      sku: selected.sku,
      productId: product.id,
      slug: product.slug,
      name: product.name,
      brand: product.brand,
      size: selected.size,
      price: product.price,
      status: product.status,
      condition: product.condition,
      image: { src: product.images[0].src, alt: product.images[0].alt },
      maxQuantity: selected.stock,
    });
    if (result === "added") {
      openCart(`Added ${fullName(product)} (EU ${selected.size}) to your cart.`);
    } else if (result === "limit") {
      openCart(
        oneOff
          ? "This one-off pair is already in your cart."
          : `You already have all ${selected.stock} available in EU ${selected.size}.`,
      );
    } else {
      setError("Sorry, this size is sold out.");
    }
  }

  return (
    <div className="space-y-5">
      {single ? (
        <div>
          <p className="text-sm">
            <span className="font-semibold">Size:</span> EU {single.size}
            {sizeConversion(single.size, product.department) ? (
              <span className="text-muted">
                {" "}
                ({sizeConversion(single.size, product.department)}, approx.)
              </span>
            ) : null}
          </p>
          {oneOff ? (
            <p className="mt-1 text-xs text-muted">
              Each pre-loved pair is a one-off. When it sells, it&apos;s gone.
            </p>
          ) : null}
        </div>
      ) : (
        <fieldset aria-describedby={error ? errorId : undefined}>
          <legend className="mb-2 flex w-full items-baseline justify-between text-sm">
            <span>
              <span className="font-semibold">Select size (EU)</span>
              {selected ? (
                <span className="text-muted"> · {sizeConversion(selected.size, product.department)}</span>
              ) : null}
            </span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {product.variants.map((variant) => {
              const id = `${groupId}-${variant.sku}`;
              const unavailable = variant.stock === 0;
              return (
                <div key={variant.sku}>
                  <input
                    id={id}
                    type="radio"
                    name={`size-${groupId}`}
                    value={variant.sku}
                    checked={selectedSku === variant.sku}
                    disabled={unavailable}
                    onChange={() => {
                      setSelectedSku(variant.sku);
                      setError("");
                    }}
                    className="peer sr-only"
                  />
                  <label
                    htmlFor={id}
                    className="flex h-11 min-w-12 cursor-pointer items-center justify-center rounded-md border border-line px-3 text-sm font-medium hover:border-forest peer-checked:border-forest peer-checked:bg-forest peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-forest peer-disabled:cursor-not-allowed peer-disabled:border-dashed peer-disabled:text-muted/60 peer-disabled:line-through"
                  >
                    {variant.size}
                    {unavailable ? <span className="sr-only"> (sold out)</span> : null}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="space-y-2">
        {status ? (
          <p className={`text-sm font-medium ${status.tone}`} aria-live="polite">
            {status.text}
          </p>
        ) : null}
        {/* One button whose action changes, so focus can return to it after
            the cart drawer closes. */}
        <button
          ref={mainButton}
          type="button"
          onClick={atLimit ? () => openCart() : handleAdd}
          disabled={soldOut}
          aria-describedby={error ? errorId : undefined}
          className={`btn h-12 w-full text-[15px] ${
            soldOut ? "btn-outline" : atLimit ? "btn-forest" : "btn-lime"
          }`}
        >
          {soldOut ? "Sold out" : atLimit ? "In your cart · View cart" : "Add to cart"}
        </button>
        {atLimit ? (
          <p className="text-xs text-muted">
            {oneOff
              ? "This one-off pair is already in your cart."
              : `You have all ${selected?.stock} available in this size in your cart.`}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        {!oneOff && !soldOut ? (
          <p className="text-xs text-muted">
            Unsure of the size?{" "}
            <Link href="/size-guide#kids-sizes" className="link-underline">
              See the kids&apos; size guide
            </Link>
          </p>
        ) : null}
      </div>
      {showBar ? (
        // Phones: the price and the same button, kept at the bottom of the screen while the main one is out of view.
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-[0_-4px_16px_rgb(0_0_0/0.08)] backdrop-blur lg:hidden">
          <div className="mx-auto flex max-w-xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted">{selected ? `EU ${selected.size}` : "Choose a size"}</p>
              <p className="text-base font-bold leading-tight">
                {formatPrice(product.price)}
                {isOnSale(product) ? (
                  <s className="ml-1.5 text-xs font-normal text-muted">{formatPrice(product.regularPrice!)}</s>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (atLimit) return openCart();
                if (!selected) {
                  // A size has to be picked first: take them to the sizes.
                  mainButton.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
                handleAdd();
              }}
              disabled={soldOut}
              className={`btn h-12 shrink-0 px-6 text-[15px] ${soldOut ? "btn-outline" : atLimit ? "btn-forest" : "btn-lime"}`}
            >
              {soldOut ? "Sold out" : atLimit ? "View cart" : "Add to cart"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether the phone add-to-cart bar shows: the main button is off screen and
 * the footer isn't in view (so the bar never covers it).
 */
function useStickyBar(target: React.RefObject<HTMLElement | null>) {
  const [mainVisible, setMainVisible] = useState(true);
  const [footerVisible, setFooterVisible] = useState(false);
  useEffect(() => {
    const main = target.current;
    const footer = document.querySelector("footer");
    if (!main || typeof IntersectionObserver === "undefined") return;
    const a = new IntersectionObserver(([e]) => setMainVisible(e.isIntersecting));
    a.observe(main);
    const b = new IntersectionObserver(([e]) => setFooterVisible(e.isIntersecting));
    if (footer) b.observe(footer);
    return () => {
      a.disconnect();
      b.disconnect();
    };
  }, [target]);
  return !mainVisible && !footerVisible;
}
