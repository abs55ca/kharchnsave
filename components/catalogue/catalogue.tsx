import Link from "next/link";
import { ProductGrid } from "@/components/product/product-card";
import { searchCatalog, type Facets } from "@/lib/catalog/catalog";
import { DEPARTMENTS, DEPARTMENT_ORDER, STYLE_LABELS } from "@/lib/catalog/labels";
import {
  activeFilterCount,
  catalogHref,
  parseCatalogQuery,
  type CatalogQuery,
} from "@/lib/catalog/query";
import { pluralize } from "@/lib/format";
import { CatalogueStateProvider, ResultsRegion } from "./catalogue-state";
import { ActiveFilters, MobileFilters, SortSelect } from "./catalogue-toolbar";
import { FilterPanel } from "./filter-panel";

type RawSearchParams = Record<string, string | string[] | undefined>;

function catalogueTitle(query: CatalogQuery, raw: RawSearchParams) {
  if (query.q) return `Results for “${query.q}”`;
  const onlyDept = query.categories.length === 1 ? query.categories[0] : null;
  const onlyStyle = query.styles.length === 1 ? query.styles[0] : null;
  const others =
    activeFilterCount(query) - query.categories.length - query.styles.length;
  if (others === 0) {
    if (onlyDept && !onlyStyle && query.styles.length === 0) return DEPARTMENTS[onlyDept].title;
    if (onlyDept && onlyStyle) return `${DEPARTMENTS[onlyDept].possessive} ${STYLE_LABELS[onlyStyle]}`;
    if (onlyStyle && query.categories.length === 0) return STYLE_LABELS[onlyStyle];
    if (activeFilterCount(query) === 0 && raw.sort === "newest") return "New Arrivals";
  }
  if (activeFilterCount(query) === 1 && query.sizes.length === 1) {
    return `Shoes in EU ${query.sizes[0]}`;
  }
  return "All Shoes";
}

function EmptyState({ query, facets, total }: { query: CatalogQuery; facets: Facets; total: number }) {
  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
        <h2 className="text-lg font-bold">No shoes are listed right now</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          New pairs are added regularly. Please check back soon.
        </p>
      </div>
    );
  }

  const clearFilters = catalogHref({ q: query.q, sort: query.sort });
  // Suggest the nearest sizes that do have stock under the other filters.
  const nearbySizes =
    query.sizes.length > 0
      ? facets.sizes
          .filter((s) => s.count > 0 && !query.sizes.includes(s.value))
          .sort(
            (a, b) =>
              Math.min(...query.sizes.map((x) => Math.abs(x - a.value))) -
              Math.min(...query.sizes.map((x) => Math.abs(x - b.value))),
          )
          .slice(0, 4)
          .sort((a, b) => a.value - b.value)
      : [];

  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <h2 className="text-lg font-bold">No shoes match {query.q ? "this search" : "these filters"}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Pre-loved pairs are one-offs, so stock changes often. Try removing a filter or
        browsing a nearby size.
      </p>
      {nearbySizes.length > 0 ? (
        <div className="mt-6">
          <p className="text-sm font-medium">Nearby sizes with pairs available</p>
          <ul className="mt-2 flex flex-wrap justify-center gap-2">
            {nearbySizes.map((size) => (
              <li key={size.value}>
                <Link
                  href={catalogHref({ ...query, sizes: [size.value] })}
                  className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm font-medium hover:border-forest"
                >
                  EU {size.value}
                  <span className="ml-1.5 text-xs text-muted">({size.count})</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {activeFilterCount(query) > 0 ? (
          <Link href={clearFilters} className="btn btn-forest">
            Clear filters
          </Link>
        ) : null}
        {query.q ? (
          <Link href={catalogHref({ ...query, q: "" })} className="btn btn-outline">
            Clear search
          </Link>
        ) : null}
        {DEPARTMENT_ORDER.map((dept) => (
          <Link key={dept} href={DEPARTMENTS[dept].href} className="btn btn-outline">
            {DEPARTMENTS[dept].title}
          </Link>
        ))}
      </div>
    </div>
  );
}

export async function Catalogue({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const query = parseCatalogQuery(raw);
  const { results, facets, total } = await searchCatalog(query);
  const title = catalogueTitle(query, raw);

  return (
    <CatalogueStateProvider query={query}>
      <div className="mb-5 border-b border-line pb-5">
        <nav aria-label="Breadcrumb" className="text-xs text-muted">
          <ol className="flex gap-1.5">
            <li>
              <Link href="/" className="hover:text-forest hover:underline">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">Shop</li>
          </ol>
        </nav>
        <h1 className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-muted" role="status">
          {pluralize(results.length, "item")}
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[232px_1fr] lg:gap-10">
        <aside aria-label="Filters" className="hidden lg:block">
          <FilterPanel facets={facets} />
        </aside>

        <div className="min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3 lg:justify-end">
            <MobileFilters facets={facets} total={results.length} />
            <SortSelect />
          </div>
          <ActiveFilters facets={facets} />
          <ResultsRegion>
            {results.length > 0 ? (
              <>
                <h2 className="sr-only">Products</h2>
                {/* The first row on a phone (two columns) holds the largest image. */}
                <ProductGrid products={results} eagerCount={2} />
              </>
            ) : (
              <EmptyState query={query} facets={facets} total={total} />
            )}
          </ResultsRegion>
        </div>
      </div>
    </CatalogueStateProvider>
  );
}

export function CatalogueSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading shoes…</span>
      <div className="mb-5 border-b border-line pb-5">
        <div className="h-3 w-24 rounded bg-cream" />
        <div className="mt-3 h-8 w-56 rounded bg-cream" />
        <div className="mt-2 h-4 w-16 rounded bg-cream" />
      </div>
      <div className="lg:grid lg:grid-cols-[232px_1fr] lg:gap-10">
        <div className="hidden space-y-3 lg:block">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-5 rounded bg-cream" />
          ))}
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-7 sm:gap-x-4 md:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <div className="aspect-square rounded-md bg-cream" />
              <div className="mt-3 h-3 w-1/3 rounded bg-cream" />
              <div className="mt-2 h-4 w-3/4 rounded bg-cream" />
              <div className="mt-2 h-4 w-1/4 rounded bg-cream" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
