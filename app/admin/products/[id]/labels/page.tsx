import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { LabelPrinter } from "@/components/admin/label-printer";
import { getScanProduct, type ScanProduct } from "@/lib/admin/scan";
import { getAdminPageClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { labelSize, shortLabelName } from "@/lib/labels/zpl";

export const metadata: Metadata = {
  title: "Print labels",
};

export default function LabelsPage({ params, searchParams }: PageProps<"/admin/products/[id]/labels">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Labels params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Labels({ params, searchParams }: PageProps<"/admin/products/[id]/labels">) {
  const { id } = await params;
  const { size } = await searchParams;
  if (!UUID_PATTERN.test(id)) notFound();
  const sizeText = typeof size === "string" && /^\d{1,2}(\.\d)?$/.test(size) ? size : null;
  const href = `/admin/products/${id}/labels${sizeText ? `?size=${sizeText}` : ""}`;

  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  let product: ScanProduct | null;
  try {
    product = await getScanProduct(supabase, id);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
    return (
      <>
        <AdminNav current="products" email={access.email} />
        <p role="alert" className="text-sm font-medium text-danger">
          The product couldn&apos;t be loaded right now.{" "}
          <Link href={href} className="underline">
            Try again
          </Link>
        </p>
      </>
    );
  }
  if (!product) notFound();

  const units = product.units
    .filter((unit) => sizeText === null || unit.size === Number(sizeText))
    .flatMap((unit) => (unit.barcode ? [{ size: unit.size, stock: unit.stock, barcode: unit.barcode }] : []));

  return (
    <>
      <AdminNav current="products" email={access.email} />
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        <Link href="/admin/products" className="hover:underline">
          Products
        </Link>{" "}
        /{" "}
        <Link href={`/admin/products/${product.id}`} className="font-mono normal-case hover:underline">
          {product.itemCode}
        </Link>{" "}
        / Labels
      </p>
      <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl">
        Labels{sizeText ? ` for ${labelSize(Number(sizeText))}` : ""}
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        {product.brand} {product.name}. Each label shows a short name, the EU size, the barcode and its ID. No price: the
        barcode looks it up.
      </p>

      {units.length === 0 ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {sizeText ? `This product has no size ${labelSize(Number(sizeText))}.` : "This product has no sizes yet."}{" "}
          {sizeText ? (
            <Link href={`/admin/products/${product.id}/labels`} className="underline">
              Show all sizes
            </Link>
          ) : null}
        </p>
      ) : (
        <div className="grid max-w-5xl gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <LabelPrinter
            productId={product.id}
            defaultName={shortLabelName(product.brand, product.name)}
            itemStatus={product.itemStatus}
            units={units}
            single={sizeText !== null}
          />
          <aside className="space-y-3 text-sm">
            <h2 className="font-bold">Printing</h2>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                <strong>Download .zpl</strong> (or <strong>Copy ZPL</strong>).
              </li>
              <li>Open Zebra Setup Utilities and select the ZD888.</li>
              <li>
                Use its option to send a file to the printer and choose the downloaded file, or open its window for
                communicating with the printer, paste the copied ZPL and send it.
              </li>
            </ol>
            <p className="text-muted">
              The browser can&apos;t print to the label printer directly; the file always goes through Zebra Setup
              Utilities.
            </p>
            {sizeText && product.units.length > 1 ? (
              <p>
                <Link href={`/admin/products/${product.id}/labels`} className="font-semibold text-forest underline">
                  Labels for all sizes
                </Link>
              </p>
            ) : null}
            <p>
              <a href="/admin/labels/calibration" className="font-semibold text-forest underline">
                Download the calibration labels
              </a>{" "}
              <span className="text-muted">(3 test labels for checking the layout on the printer).</span>
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
