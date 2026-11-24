import Image from "next/image";
import Link from "next/link";
import { CONDITION_LABELS } from "@/lib/catalog/labels";
import { showsLightUpBadge } from "@/lib/catalog/light-up";
import { isInStock, productHref, sizeLabel } from "@/lib/catalog/product-utils";
import type { Product } from "@/lib/catalog/types";
import { kidsAgeLabel } from "@/lib/sizes";
import { LightUpBadge, SoldOutBadge, StatusBadge } from "./badges";
import { ProductPrice } from "./product-price";

export const PRODUCT_GRID_SIZES =
  "(min-width: 1280px) 290px, (min-width: 1024px) 30vw, (min-width: 768px) 33vw, 50vw";

/**
 * `eager`: the card is in the first row the page shows, where the largest
 * image (LCP) usually is: load its photo at once, at high priority, instead
 * of lazily. Every other card stays lazy.
 */
export function ProductCard({ product, eager = false }: { product: Product; eager?: boolean }) {
  const image = product.images[0];
  const inStock = isInStock(product);
  const kidsAge = product.department === "kids" ? kidsAgeLabel(product.variants.map((v) => v.size)) : null;

  return (
    <article className="group relative flex flex-col rounded-md has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-forest">
      <div className="relative aspect-square overflow-hidden rounded-md bg-cream">
        <Image
          src={image.src}
          alt={image.alt}
          fill
          sizes={PRODUCT_GRID_SIZES}
          {...(eager ? { loading: "eager" as const, fetchPriority: "high" as const } : {})}
          className={`object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03] ${
            inStock ? "" : "opacity-60 grayscale-[35%]"
          }`}
          style={image.focus ? { objectPosition: image.focus } : undefined}
        />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          {/* New is the default, so only pre-loved shoes get a tag; the sale tag sits by the price. */}
          {product.status === "preloved" ? <StatusBadge status={product.status} /> : null}
          {showsLightUpBadge(product.lightUp) ? <LightUpBadge /> : null}
          {!inStock ? <SoldOutBadge /> : null}
        </div>
      </div>
      <div className="mt-2.5 flex flex-1 flex-col gap-0.5">
        {/* "Unbranded" says nothing useful on a card; real brands still show. */}
        {product.brand.trim().toLowerCase() !== "unbranded" ? (
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            {product.brand}
          </p>
        ) : null}
        {/* One line, cut with "…" when too long (the full name shows on hover and to screen readers),
            so sizes and prices line up across a row. */}
        <h3 className="truncate font-sans text-sm font-medium leading-snug" title={product.name}>
          <Link
            href={productHref(product)}
            className="after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:outline-none"
          >
            {product.name}
          </Link>
        </h3>
        {/* New is the default (no tag or label); pre-loved shoes show their condition. */}
        <p className="text-xs text-muted">
          Size: <span className="font-medium text-ink">{sizeLabel(product)}</span>
          {kidsAge ? (
            <>
              <span aria-hidden="true"> · </span>
              {kidsAge}
            </>
          ) : null}
          {product.status === "new" ? null : (
            <>
              <span aria-hidden="true"> · </span>
              {CONDITION_LABELS[product.condition]}
            </>
          )}
        </p>
        <ProductPrice product={product} size="card" className="mt-1.5" />
      </div>
    </article>
  );
}

/** `eagerCount`: how many leading cards load their photo eagerly (see ProductCard). */
export function ProductGrid({ products, eagerCount = 0 }: { products: Product[]; eagerCount?: number }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-7 sm:gap-x-4 md:grid-cols-3 xl:grid-cols-4">
      {products.map((product, index) => (
        <li key={product.id}>
          <ProductCard product={product} eager={index < eagerCount} />
        </li>
      ))}
    </ul>
  );
}
