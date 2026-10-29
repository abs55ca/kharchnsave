import type { Metadata } from "next";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { ProductEditor } from "@/components/admin/product-editor";
import { getAdminPageClient } from "@/lib/auth/admin";

export const metadata: Metadata = {
  title: "Add product",
};

export default function NewProductPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Checking your access…</p>}>
      <NewProduct />
    </Suspense>
  );
}

async function NewProduct() {
  const { access, supabase } = await getAdminPageClient("/admin/products/new");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin/products/new" />;

  return (
    <>
      <AdminNav current="new" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Add a product</h1>
      <p className="mt-1 mb-8 text-sm text-muted">
        It&apos;s saved as a draft, hidden from shoppers until you publish it.
      </p>
      <ProductEditor />
    </>
  );
}
