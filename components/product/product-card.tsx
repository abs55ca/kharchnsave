import Image from "next/image";
import Link from "next/link";
import { CONDITION_LABELS } from "@/lib/catalog/labels";
import { showsLightUpBadge } from "@/lib/catalog/light-up";
import { isOnSale, saleBadgeText } from "@/lib/catalog/pricing";
import { isInStock, productHref, sizeLabel } from "@/lib/catalog/product-utils";
import type { Product } from "@/lib/catalog/types";
import { LightUpBadge, SaleBadge, SoldOutBadge, StatusBadge } from "./badges";
import { ProductPrice } from "./product-price";

export const PRODUCT_GRID_SIZES =
  "(min-width: 1280px) 290px, (min-width: 1024px) 30vw, (min-width: 768px) 33vw, 50vw";

export function ProductCard({ product }: { product: Product }) {
  const image = product.images[0];
  const inStock = isInStock(product);

  return (
    <article className="group relative flex flex-col rounded-md has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-forest">
      <div className="relative aspect-square overflow-hidden rounded-md bg-cream">
        <Image
          src={image.src}
          alt={image.alt}
          fill
          sizes={PRODUCT_GRID_SIZES}
          className={`object-cover transition-transform duration-300 motion-safe:group-hover:scale-[1.03] ${
            inStock ? "" : "opacity-60 grayscale-[35%]"
          }`}
          style={image.focus ? { objectPosition: image.focus } : undefined}
        />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          <StatusBadge status={product.status} />
          {isOnSale(product) ? <SaleBadge text={saleBadgeText(product.regularPrice!, product.price)} /> : null}
          {showsLightUpBadge(product.lightUp) ? <LightUpBadge /> : null}
          {!inStock ? <SoldOutBadge /> : null}
        </div>
      </div>
      <div className="mt-2.5 flex flex-1 flex-col gap-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {product.brand}
        </p>
        <h3 className="font-sans text-sm font-medium leading-snug">
          <Link
            href={productHref(product)}
            className="after:absolute after:inset-0 after:rounded-md hover:underline focus-visible:outline-none"
          >
            {/* Keep the word before " — colour" attached so lines don't start with a dash. */}
            {product.name.replace(" — ", " — ")}
          </Link>
        </h3>
        <p className="text-xs text-muted">
          <span className="font-medium text-ink">{sizeLabel(product)}</span>
          <span aria-hidden="true"> · </span>
          {product.status === "new" ? "Brand new" : CONDITION_LABELS[product.condition]}
        </p>
        <ProductPrice product={product} size="card" className="mt-1" />
      </div>
    </article>
  );
}

export function ProductGrid({ products }: { products: Product[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-7 sm:gap-x-4 md:grid-cols-3 xl:grid-cols-4">
      {products.map((product) => (
        <li key={product.id}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}
