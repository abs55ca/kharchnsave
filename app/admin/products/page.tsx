import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { PUBLICATION_LABELS, PublicationBadge } from "@/components/admin/publication-badge";
import { RefreshOnReturn } from "@/components/admin/refresh-on-return";
import { paisaToRupeesText } from "@/lib/admin/product-input";
import {
  cleanSearch,
  listProducts,
  PAGE_SIZE,
  PUBLICATION_STATUSES,
  type PublicationStatus,
} from "@/lib/admin/products";
import { getAdminPageClient } from "@/lib/auth/admin";
import { formatPrice, pluralize } from "@/lib/format";

export const metadata: Metadata = {
  title: "Products",
};

export default function AdminProductsPage({ searchParams }: PageProps<"/admin/products">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading products…</p>}>
      <ProductList searchParams={searchParams} />
    </Suspense>
  );
}

function listHref(params: { q: string; status: PublicationStatus | null; page?: number }) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.page && params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `/admin/products?${query}` : "/admin/products";
}

async function ProductList({ searchParams }: Pick<PageProps<"/admin/products">, "searchParams">) {
  const params = await searchParams;
  const q = cleanSearch(params.q);
  const status = PUBLICATION_STATUSES.find((s) => s === params.status) ?? null;
  const pageParam = Number(params.page);
  const page = Number.isInteger(pageParam) && pageParam > 0 && pageParam < 10_000 ? pageParam : 1;

  const { access, supabase } = await getAdminPageClient(listHref({ q, status, page }));
  if (!supabase) return <AccessNotice access={access} retryHref={listHref({ q, status, page })} />;

  let result: Awaited<ReturnType<typeof listProducts>>;
  try {
    result = await listProducts(supabase, { q, status, page });
  } catch (error) {
    console.error("[admin]", (error as Error).message);
    return (
      <>
        <AdminNav current="products" email={access.email} />
        <p role="alert" className="text-sm font-medium text-danger">
          Products couldn&apos;t be loaded right now.{" "}
          <Link href={listHref({ q, status, page })} className="underline">
            Try again
          </Link>
        </p>
      </>
    );
  }
  const { items, total } = result;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <AdminNav current="products" email={access.email} />
      <RefreshOnReturn />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Products</h1>
          <p className="mt-1 text-sm text-muted">
            {pluralize(total, "product")}
            {status ? ` · ${PUBLICATION_LABELS[status].toLowerCase()}` : ""}
            {q ? ` matching “${q}”` : ""}
          </p>
        </div>
        <Link href="/admin/products/new" className="btn btn-forest">
          Add product
        </Link>
      </div>

      <form role="search" action="/admin/products" className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <label htmlFor="product-search" className="mb-1.5 block text-sm font-semibold">
            Search
          </label>
          <input
            id="product-search"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Name, brand, colour or item code"
            className="h-10 w-full rounded-md border border-line px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest"
          />
        </div>
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <button type="submit" className="btn btn-outline h-10">
          Search
        </button>
        {q ? (
          <Link href={listHref({ q: "", status })} className="pb-2 text-sm font-semibold text-forest underline">
            Clear search
          </Link>
        ) : null}
      </form>

      <nav aria-label="Filter by status" className="mt-4">
        <ul className="flex flex-wrap gap-2">
          {[null, ...PUBLICATION_STATUSES].map((s) => (
            <li key={s ?? "all"}>
              <Link
                href={listHref({ q, status: s })}
                aria-current={s === status ? "page" : undefined}
                className={`inline-flex h-8 items-center rounded-full border px-3 text-sm font-semibold ${
                  s === status ? "border-forest bg-forest text-white" : "border-line hover:border-forest"
                }`}
              >
                {s ? PUBLICATION_LABELS[s] : "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {items.length === 0 ? (
        <p className="mt-8 text-sm">
          {q || status ? "No products match. Try another search or filter." : "No products yet. Add your first one."}
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-line border-y border-line">
          {items.map((item) => (
            <li key={item.id} className="relative flex items-center gap-4 py-3 hover:bg-cream/60">
              <div className="size-14 shrink-0 overflow-hidden rounded bg-cream">
                {item.thumbnailSrc ? (
                  // Admin previews of private photos: never through next/image's shared cache.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.thumbnailSrc} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <span className="flex size-full items-center justify-center text-[10px] text-muted">No photo</span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {item.brand} · <span className="font-mono normal-case">{item.itemCode}</span>
                </p>
                <p className="truncate text-sm font-semibold">
                  <Link href={`/admin/products/${item.id}`} className="after:absolute after:inset-0 hover:underline">
                    {item.name}
                  </Link>
                </p>
                <p className="text-xs text-muted">
                  {item.itemStatus === "preloved" ? "Pre-loved" : "New"} · {pluralize(item.sizeCount, "size")} ·{" "}
                  {item.totalStock > 0 ? `${item.totalStock} in stock` : "sold out"} · {pluralize(item.photoCount, "photo")}
                </p>
                {item.labelProblem ? (
                  <p className="text-xs font-semibold text-danger" title={item.labelProblem}>
                    Needs a shorter label name before printing
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1 text-right">
                <PublicationBadge status={item.status} />
                <span className="text-sm font-semibold" title={`Rs. ${paisaToRupeesText(item.salePricePaisa ?? item.pricePaisa)}`}>
                  {formatPrice((item.salePricePaisa ?? item.pricePaisa) / 100)}
                </span>
                {item.salePricePaisa !== null ? (
                  <span className="text-xs text-muted">
                    Sale; regular <s className="decoration-danger">{formatPrice(item.pricePaisa / 100)}</s>
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 ? (
        <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={listHref({ q, status, page: page - 1 })} className="btn btn-outline h-9">
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {Math.min(page, pages)} of {pages}
          </span>
          {page < pages ? (
            <Link href={listHref({ q, status, page: page + 1 })} className="btn btn-outline h-9">
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}
