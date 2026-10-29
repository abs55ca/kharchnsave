import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { ProductEditor } from "@/components/admin/product-editor";
import { getEditableProduct, type EditableProduct } from "@/lib/admin/products";
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

  return (
    <>
      <AdminNav current="products" email={access.email} />
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        <Link href="/admin/products" className="hover:underline">
          Products
        </Link>{" "}
        / <span className="font-mono normal-case">{product.values.itemCode}</span>
      </p>
      <h1 className="mt-1 mb-6 text-2xl font-extrabold tracking-tight md:text-3xl">{product.values.name}</h1>
      {/* Keyed by product: re-renders after a save keep the editor's own state. */}
      <ProductEditor key={product.id} product={product} created={created === "1"} />
    </>
  );
}
