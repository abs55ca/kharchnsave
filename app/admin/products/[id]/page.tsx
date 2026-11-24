import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { ProductDeletePanel } from "@/components/admin/product-delete-panel";
import { ProductEditor } from "@/components/admin/product-editor";
import { RefreshOnReturn } from "@/components/admin/refresh-on-return";
import { RequestScope } from "@/components/admin/agent-forms";
import { ProductPricingPanel } from "@/components/admin/pricing-forms";
import { getProductPricing, type ProductPricing } from "@/lib/admin/pricing";
import type { DeletionPreview } from "@/lib/admin/product-deletion";
import { getDeletionPreview, getEditableProduct, type EditableProduct } from "@/lib/admin/products";
import { getAdminPageClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";

export const metadata: Metadata = {
  title: "Edit product",
};

export default function EditProductPage({ params, searchParams }: PageProps<"/admin/products/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading the product…</p>}>
      <EditProduct params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function EditProduct({ params, searchParams }: PageProps<"/admin/products/[id]">) {
  const { id } = await params;
  const { created } = await searchParams;
  if (!UUID_PATTERN.test(id)) notFound();

  const { access, supabase } = await getAdminPageClient(`/admin/products/${id}`);
  if (!supabase) return <AccessNotice access={access} retryHref={`/admin/products/${id}`} />;

  let product: EditableProduct | null;
  try {
    product = await getEditableProduct(supabase, id);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
    return (
      <>
        <AdminNav current="products" email={access.email} />
        <p role="alert" className="text-sm font-medium text-danger">
          This product couldn&apos;t be loaded right now.{" "}
          <Link href={`/admin/products/${id}`} className="underline">
            Try again
          </Link>
        </p>
      </>
    );
  }
  if (!product) notFound();

  // Both optional on this page: if one can't be read, the editor still works (without that panel).
  let pricing: ProductPricing | null = null;
  let deletion: DeletionPreview | null = null;
  const [pricingRead, deletionRead] = await Promise.allSettled([getProductPricing(supabase, id), getDeletionPreview(supabase, id)]);
  if (pricingRead.status === "fulfilled") pricing = pricingRead.value;
  else console.error("[admin]", (pricingRead.reason as Error).message);
  if (deletionRead.status === "fulfilled") deletion = deletionRead.value;
  else console.error("[admin]", (deletionRead.reason as Error).message);
  const priceLock = pricing?.mode === "auto"
    ? "Priced automatically from its score: change it in “Pricing” below, or switch it to a manual price there."
    : pricing?.campaign
      ? `In the running sale “${pricing.campaign.name}”: its prices change through the sale (Sales) or Pricing below.`
      : null;

  return (
    <>
      <AdminNav current="products" email={access.email} />
      <RefreshOnReturn />
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        <Link href="/admin/products" className="hover:underline">
          Products
        </Link>{" "}
        / <span className="font-mono normal-case">{product.values.itemCode}</span>
      </p>
      <h1 className="mt-1 mb-6 text-2xl font-extrabold tracking-tight md:text-3xl">{product.values.name}</h1>
      {/* Keyed by product: re-renders keep the editor's own state; it decides what to do with a newer copy. */}
      <ProductEditor key={product.id} product={product} created={created === "1"} priceLock={priceLock} />
      {pricing ? (
        <div className="mt-10">
          <RequestScope>
            <ProductPricingPanel pricing={pricing} />
          </RequestScope>
        </div>
      ) : null}
      {deletion ? (
        <div className="mt-10">
          <RequestScope>
            <ProductDeletePanel key={deletion.product.id} preview={deletion} />
          </RequestScope>
        </div>
      ) : null}
    </>
  );
}
