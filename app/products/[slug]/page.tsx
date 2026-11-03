import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InfoIcon } from "@/components/icons";
import { LightUpBadge, SaleBadge, StatusBadge } from "@/components/product/badges";
import { ProductGrid } from "@/components/product/product-card";
import { ProductGallery } from "@/components/product/product-gallery";
import { ProductPrice } from "@/components/product/product-price";
import { PurchasePanel } from "@/components/product/purchase-panel";
import { getAllProducts, getProductBySlug, getRelatedProducts } from "@/lib/catalog/catalog";
import { CONDITIONS, DEPARTMENTS, STATUS_LABELS, STYLE_LABELS } from "@/lib/catalog/labels";
import { lightUpDisclosure, showsLightUpBadge } from "@/lib/catalog/light-up";
import { isOnSale, saleBadgeText } from "@/lib/catalog/pricing";
import { fullName } from "@/lib/catalog/product-utils";
import { formatPrice } from "@/lib/format";

// Prerenders the products published at build time; others render on first
// request. Cache Components needs at least one entry, so an empty catalogue
// gets a placeholder that resolves to the not-found page.
export async function generateStaticParams() {
  const products = await getAllProducts();
  if (products.length === 0) return [{ slug: "no-products-yet" }];
  return products.map((product) => ({ slug: product.slug }));
}

export async function generateMetadata({
  params,
}: PageProps<"/products/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Product not found" };
  return {
    title: fullName(product),
    description: `${STATUS_LABELS[product.status]} ${product.name} — ${formatPrice(product.price)}${
      isOnSale(product) ? ` (sale; regular price ${formatPrice(product.regularPrice!)})` : ""
    }. ${product.description}`,
  };
}

// The page shell is shared by every product link, so the part that reads the
// URL (`params`) streams in behind Suspense.
export default function ProductPage({ params }: PageProps<"/products/[slug]">) {
  return (
    <div className="container-page py-6 md:py-8">
      <Suspense fallback={<ProductSkeleton />}>
        <ProductDetails params={params} />
      </Suspense>
    </div>
  );
}

async function ProductDetails({ params }: Pick<PageProps<"/products/[slug]">, "params">) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const related = await getRelatedProducts(product);
  const department = DEPARTMENTS[product.department];
  const condition = CONDITIONS.find((c) => c.value === product.condition)!;
  const lights = product.lightUp ? lightUpDisclosure(product.lightUp) : null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-muted">
        <ol className="flex flex-wrap gap-1.5">
          <li>
            <Link href="/" className="hover:text-forest hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={department.href} className="hover:text-forest hover:underline">
              {department.title}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-ink">
            {product.name}
          </li>
        </ol>
      </nav>

      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <ProductGallery images={product.images} name={product.name} />

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{product.brand}</p>
          <h1 className="mt-1 text-2xl font-extrabold leading-tight tracking-tight md:text-3xl">
            {product.name}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={product.status} />
            {showsLightUpBadge(product.lightUp) ? <LightUpBadge /> : null}
            <span>
              <span className="text-muted">Condition: </span>
              <Link href="/condition-guide" className="font-medium link-underline">
                {condition.label}
              </Link>
            </span>
            {lights?.warning ? (
              <span className="font-semibold text-danger">Light-up soles: {lights.short}</span>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ProductPrice product={product} size="page" />
            {isOnSale(product) ? <SaleBadge text={saleBadgeText(product.regularPrice!, product.price)} /> : null}
          </div>

          <div className="mt-6 border-t border-line pt-6">
            <PurchasePanel product={product} />
          </div>

          <section aria-labelledby="condition-heading" className="mt-8 rounded-lg bg-cream p-5">
            <h2 id="condition-heading" className="text-base font-bold">
              {product.status === "preloved" ? "Condition notes" : "Condition"}
            </h2>
            <p className="mt-1 text-sm">
              <span className="font-semibold">{condition.label}:</span> {condition.summary}
            </p>
            {product.conditionNotes.length > 0 ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink/85">
                {product.conditionNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
            {product.lightUp && lights ? (
              <div className="mt-3 text-sm">
                <p className={lights.warning ? "font-semibold text-danger" : undefined}>{lights.text}</p>
                {product.lightUp.activation ? (
                  <p className="mt-1">
                    <span className="text-muted">{lights.activationLabel}: </span>
                    {product.lightUp.activation}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Link href="/condition-guide" className="mt-3 inline-block text-sm font-semibold text-forest link-underline">
              Read the condition guide
            </Link>
          </section>

          <section aria-labelledby="details-heading" className="mt-8">
            <h2 id="details-heading" className="text-base font-bold">
              Details
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink/85">{product.description}</p>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted">Brand</dt>
              <dd>{product.brand}</dd>
              <dt className="text-muted">Department</dt>
              <dd>{department.label}</dd>
              <dt className="text-muted">Style</dt>
              <dd>{product.styles.map((s) => STYLE_LABELS[s]).join(", ")}</dd>
              <dt className="text-muted">Colour</dt>
              <dd>{product.colour}</dd>
              <dt className="text-muted">Item code</dt>
              <dd>{product.itemCode}</dd>
            </dl>
          </section>

          <p className="mt-8 flex gap-2 rounded-md border border-line p-3 text-xs leading-relaxed text-muted">
            <InfoIcon width={16} height={16} className="mt-px shrink-0" />
            <span>
              Sample listing for the demo store. Photos are temporary stock images and
              don&apos;t show an actual pair for sale.
            </span>
          </p>
        </div>
      </div>

      {related.length > 0 ? (
        <section aria-labelledby="related-heading" className="mt-16">
          <div className="mb-5 flex items-end justify-between gap-4">
            <h2 id="related-heading" className="text-xl font-bold md:text-2xl">
              You might also like
            </h2>
            <Link href={department.href} className="text-sm font-semibold text-forest hover:underline">
              View all
            </Link>
          </div>
          <ProductGrid products={related} />
        </section>
      ) : null}
    </>
  );
}

function ProductSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading product…</span>
      <div className="mb-4 h-3 w-48 rounded bg-cream" />
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <div className="aspect-square rounded-lg bg-cream" />
        <div>
          <div className="h-3 w-20 rounded bg-cream" />
          <div className="mt-2 h-8 w-3/4 rounded bg-cream" />
          <div className="mt-3 h-5 w-40 rounded bg-cream" />
          <div className="mt-4 h-7 w-28 rounded bg-cream" />
          <div className="mt-6 space-y-3 border-t border-line pt-6">
            <div className="h-4 w-32 rounded bg-cream" />
            <div className="h-12 rounded-md bg-cream" />
          </div>
          <div className="mt-8 h-32 rounded-lg bg-cream" />
        </div>
      </div>
    </div>
  );
}
