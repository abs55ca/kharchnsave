import { isOnSale, saleBadgeText, savings } from "@/lib/catalog/pricing";
import type { Product } from "@/lib/catalog/types";
import { formatPrice } from "@/lib/format";

/**
 * A product's price. With a supported "was" price (Product.regularPrice, from
 * genuine price history): the price customers pay first and prominent, then
 * "Was" and the was-price (smaller, muted, struck through in red), and on the product
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
  if (size === "card") {
    // Two fixed lines, so every card lines up: the price with a soft "35% OFF" tag, then "Was".
    return (
      <div className={`leading-tight ${className}`}>
        <p className="flex items-center gap-2">
          <span className={main}>
            <span className="sr-only">Sale price: </span>
            {formatPrice(product.price)}
          </span>
          {/* Bright red with white text (4.8:1 contrast) so the saving catches the eye. */}
          <span className="rounded-full bg-[#dc2626] px-2 py-0.5 text-[11px] font-bold tracking-wide text-white shadow-sm">
            {saleBadgeText(product.regularPrice!, product.price)}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Was <s className="decoration-muted/70">{formatPrice(product.regularPrice!)}</s>
        </p>
      </div>
    );
  }
  return (
    <p className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${className}`}>
      <span className={main}>
        <span className="sr-only">Sale price: </span>
        {formatPrice(product.price)}
      </span>
      {/* Labelled for everyone: the comparison price is always this product's own previous price
          (verified from its price history), never a suggested or calculated one. */}
      <span className="text-base text-muted">
        Was <s className="decoration-danger decoration-2">{formatPrice(product.regularPrice!)}</s>
      </span>
      {saved ? (
        <span className="text-sm font-semibold text-danger">
          Save {formatPrice(saved.rupees)}{saved.percent >= 1 ? ` (${saved.percent}%)` : ""}
        </span>
      ) : null}
    </p>
  );
}
