import { isOnSale } from "@/lib/catalog/pricing";
import type { Product } from "@/lib/catalog/types";
import { formatPrice } from "@/lib/format";

/**
 * A product's price. On sale: the sale price first and prominent, then the
 * regular price, smaller, muted and struck through in red. Screen readers
 * hear "Sale price" and "Regular price" (a strikethrough alone isn't read
 * out); the % OFF badge (SaleBadge) says it in text too. Not on sale: the
 * price as before.
 */
export function ProductPrice({
  product,
  size,
  className = "",
}: {
  product: Pick<Product, "price" | "regularPrice">;
  size: "card" | "page";
  className?: string;
}) {
  const main = size === "page" ? "text-2xl font-bold" : "text-[15px] font-semibold text-ink";
  if (!isOnSale(product)) return <p className={`${main} ${className}`}>{formatPrice(product.price)}</p>;
  return (
    <p className={`flex flex-wrap items-baseline gap-x-2 ${className}`}>
      <span className={main}>
        <span className="sr-only">Sale price: </span>
        {formatPrice(product.price)}
      </span>
      <span className={`text-muted ${size === "page" ? "text-base" : "text-xs"}`}>
        <span className="sr-only">Regular price: </span>
        <s className="decoration-danger decoration-2">{formatPrice(product.regularPrice!)}</s>
      </span>
    </p>
  );
}
