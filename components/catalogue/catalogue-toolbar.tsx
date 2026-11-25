"use client";

import { useId, useState } from "react";
import { CloseIcon, FilterIcon } from "@/components/icons";
import { Drawer } from "@/components/ui/drawer";
import type { Facets } from "@/lib/catalog/catalog";
import { CONDITION_LABELS, DEPARTMENTS, STATUS_LABELS, STYLE_LABELS } from "@/lib/catalog/labels";
import {
  activeFilterCount,
  PRICE_RANGES,
  SORT_OPTIONS,
  type CatalogQuery,
  type SortKey,
} from "@/lib/catalog/query";
import { pluralize } from "@/lib/format";
import { useCatalogue } from "./catalogue-state";
import { FilterPanel } from "./filter-panel";

export function SortSelect() {
  const { query, update } = useCatalogue();
  const id = useId();
  return (
    // Phones: the label is for screen readers only and the select may shrink, so the toolbar never overflows the screen.
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="sr-only whitespace-nowrap text-sm text-muted sm:not-sr-only">
        Sort by
      </label>
      <select
        id={id}
        value={query.sort}
        onChange={(event) => update({ sort: event.target.value as SortKey })}
        className="h-10 w-full min-w-0 max-w-full truncate rounded-md border border-line bg-white pl-3 pr-8 text-sm font-medium hover:border-forest sm:w-auto"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function MobileFilters({ facets, total }: { facets: Facets; total: number }) {
  const [open, setOpen] = useState(false);
  const { query } = useCatalogue();
  const titleId = useId();
  const active = activeFilterCount(query);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="btn btn-outline h-10 lg:hidden"
      >
        <FilterIcon width={18} height={18} />
        Filters
        {active ? (
          <span className="rounded-full bg-lime px-1.5 text-xs font-bold text-forest">
            {active}
            <span className="sr-only"> active</span>
          </span>
        ) : null}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="left"
        title="Filters"
        titleId={titleId}
        footer={
          <button type="button" onClick={() => setOpen(false)} className="btn btn-lime w-full">
            Show {pluralize(total, "result")}
          </button>
        }
      >
        <div className="px-5 py-4">
          <FilterPanel facets={facets} />
        </div>
      </Drawer>
    </>
  );
}

type Chip = { key: string; label: string; remove: Partial<CatalogQuery> };

function activeChips(query: CatalogQuery, facets: Facets): Chip[] {
  const brandLabel = new Map(facets.brands.map((b) => [b.value, b.label]));
  return [
    ...(query.q
      ? [{ key: "q", label: `Search: “${query.q}”`, remove: { q: "" } }]
      : []),
    ...query.categories.map((v) => ({
      key: `category-${v}`,
      label: DEPARTMENTS[v].label,
      remove: { categories: query.categories.filter((x) => x !== v) },
    })),
    ...query.types.map((v) => ({
      key: `type-${v}`,
      label: STATUS_LABELS[v],
      remove: { types: query.types.filter((x) => x !== v) },
    })),
    ...query.sizes.map((v) => ({
      key: `size-${v}`,
      label: `EU ${v}`,
      remove: { sizes: query.sizes.filter((x) => x !== v) },
    })),
    ...(query.price
      ? [
          {
            key: "price",
            label: PRICE_RANGES.find((r) => r.id === query.price)?.label ?? "Price",
            remove: { price: null },
          },
        ]
      : []),
    ...query.brands.map((v) => ({
      key: `brand-${v}`,
      label: brandLabel.get(v) ?? v,
      remove: { brands: query.brands.filter((x) => x !== v) },
    })),
    ...query.conditions.map((v) => ({
      key: `condition-${v}`,
      label: CONDITION_LABELS[v],
      remove: { conditions: query.conditions.filter((x) => x !== v) },
    })),
    ...query.styles.map((v) => ({
      key: `style-${v}`,
      label: STYLE_LABELS[v],
      remove: { styles: query.styles.filter((x) => x !== v) },
    })),
    ...(query.inStock
      ? [{ key: "stock", label: "In stock only", remove: { inStock: false } }]
      : []),
  ];
}

export function ActiveFilters({ facets }: { facets: Facets }) {
  const { query, update } = useCatalogue();
  const chips = activeChips(query, facets);
  if (chips.length === 0) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <h2 className="sr-only">Active filters</h2>
      <ul className="contents">
        {chips.map((chip) => (
          <li key={chip.key}>
            <button
              type="button"
              onClick={() => update(chip.remove)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-cream py-1 pl-3 pr-2 text-[13px] font-medium hover:border-forest"
            >
              {chip.label}
              <CloseIcon width={14} height={14} />
              <span className="sr-only">(remove filter)</span>
            </button>
          </li>
        ))}
      </ul>
      {activeFilterCount(query) > 0 ? (
        <button
          type="button"
          onClick={() =>
            update({
              categories: [],
              types: [],
              styles: [],
              sizes: [],
              brands: [],
              conditions: [],
              price: null,
              inStock: false,
            })
          }
          className="ml-1 text-[13px] font-semibold text-forest link-underline"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
