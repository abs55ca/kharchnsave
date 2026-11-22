import { isOnSale, savings } from "@/lib/catalog/pricing";
import type { Product } from "@/lib/catalog/types";
import { formatPrice } from "@/lib/format";

/**
 * A product's price. With a supported "was" price (Product.regularPrice, from
 * genuine price history): the price customers pay first and prominent, then
 * the was-price, smaller, muted and struck through in red, and on the product
 * page the saving in rupees and percent (rounded down). Screen readers hear
 * "Sale price" and "Was" (a strikethrough alone isn't read out). Otherwise —
 * not on sale, or on sale without a supported reference — just the price.
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
  const saved = savings(product);
  return (
    <p className={`flex flex-wrap items-baseline gap-x-2 ${className}`}>
      <span className={main}>
        <span className="sr-only">Sale price: </span>
        {formatPrice(product.price)}
      </span>
      <span className={`text-muted ${size === "page" ? "text-base" : "text-xs"}`}>
        <span className="sr-only">Was: </span>
        <s className="decoration-danger decoration-2">{formatPrice(product.regularPrice!)}</s>
      </span>
      {size === "page" && saved ? (
        <span className="text-sm font-semibold text-danger">
          Save {formatPrice(saved.rupees)}{saved.percent >= 1 ? ` (${saved.percent}%)` : ""}
        </span>
      ) : null}
    </p>
  );
}
