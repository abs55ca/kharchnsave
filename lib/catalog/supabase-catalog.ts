import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { getSupabase } from "@/lib/supabase/server";
import { CONDITIONS, DEPARTMENT_ORDER, STYLE_LABELS } from "./labels";
import { lightUpFromColumns } from "./light-up";
import { pricesFromColumns } from "./pricing";
import { productPhotoSrc } from "./photos";
import type { Condition, Department, ItemStatus, Product, Style } from "./types";

/*
 * Reads the published catalogue from Supabase (tables defined in
 * supabase/migrations/20261027120000_create_catalogue.sql) with the
 * publishable key, so row-level security limits it to published products.
 *
 * Caching: the result is cached with the "minutes" profile. Pages built from
 * it are prerendered with the catalogue as it was at build time, then
 * refreshed in the background at most once a minute while they get traffic;
 * after an hour without traffic the next request waits for fresh data.
 * Browsers may reuse a page for up to 5 minutes. The admin actions
 * (app/admin/products/actions.ts) call updateTag(CATALOGUE_TAG) after every
 * product change to refresh it at once.
 */

export const CATALOGUE_TAG = "catalogue";

/** The catalogue couldn't be read. Never answered with substitute data. */
export class CatalogueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CatalogueUnavailableError";
  }
}

// Never label_name: it's for printed labels only, and the publishable key
// can't read it (20261101120000_label_names_and_light_up.sql).
const PRODUCT_COLUMNS = `
  id, item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, sale_price_paisa, listed_at,
  light_up, light_up_condition, light_up_activation,
  product_variants (sku, size_eu, stock),
  product_images (src, storage_path, alt, width, height, sort_order, focus, shows_defect)
`;

type ProductRow = {
  id: string;
  item_code: string;
  slug: string;
  name: string;
  brand: string;
  department: string;
  styles: string[];
  item_status: string;
  condition: string;
  condition_notes: string[];
  colour: string;
  description: string;
  price_paisa: number;
  sale_price_paisa: number | null;
  listed_at: string | null;
  light_up: boolean | null;
  light_up_condition: string | null;
  light_up_activation: string | null;
  // PostgREST returns numeric columns as JSON numbers; strings are tolerated.
  product_variants: { sku: string; size_eu: number | string; stock: number }[];
  product_images: {
    src: string | null;
    storage_path: string | null;
    alt: string;
    width: number;
    height: number;
    sort_order: number;
    focus: string | null;
    shows_defect: boolean;
  }[];
};

const STATUSES: ItemStatus[] = ["new", "preloved"];
const CONDITION_VALUES = CONDITIONS.map((c) => c.value);
const STYLES = Object.keys(STYLE_LABELS) as Style[];

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, slug: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new CatalogueUnavailableError(`Product "${slug}" has an unknown ${field} "${value}".`);
}

function toProduct(row: ProductRow): Product {
  if (!row.listed_at) {
    throw new CatalogueUnavailableError(`Published product "${row.slug}" has no listing date.`);
  }
  const lightUp = lightUpFromColumns(row);
  if (lightUp === undefined) {
    throw new CatalogueUnavailableError(`Product "${row.slug}" has an unknown light-up condition "${row.light_up_condition}".`);
  }
  return {
    id: row.id,
    itemCode: row.item_code,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    department: oneOf<Department>(row.department, DEPARTMENT_ORDER, "department", row.slug),
    styles: row.styles.map((s) => oneOf(s, STYLES, "style", row.slug)),
    status: oneOf(row.item_status, STATUSES, "item status", row.slug),
    condition: oneOf<Condition>(row.condition, CONDITION_VALUES, "condition", row.slug),
    conditionNotes: row.condition_notes,
    colour: row.colour,
    // Paisa become rupees only here: what a shopper pays now, and the regular price while on sale.
    ...pricesFromColumns(row),
    description: row.description,
    lightUp,
    images: [...row.product_images]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((image) => ({
        // Uploaded photos are served from Storage by app/product-photos.
        src: image.storage_path ? productPhotoSrc(image.storage_path) : (image.src ?? ""),
        alt: image.alt,
        width: image.width,
        height: image.height,
        ...(image.focus ? { focus: image.focus } : {}),
        showsDefect: image.shows_defect,
      })),
    variants: row.product_variants
      .map((v) => ({ sku: v.sku, size: Number(v.size_eu), stock: v.stock }))
      .sort((a, b) => a.size - b.size),
    listedAt: row.listed_at,
  };
}

/** Every published product that can be shown: it needs a photo and a size. */
export async function fetchPublishedProducts(): Promise<Product[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOGUE_TAG);

  const { data, error } = await getSupabase()
    .from("products")
    .select(PRODUCT_COLUMNS)
    // RLS already hides unpublished rows from this key; this keeps the
    // query correct even if it ever runs with broader access.
    .eq("publication_status", "published")
    .order("listed_at", { ascending: false })
    .order("sort_order", { referencedTable: "product_images", ascending: true });

  if (error) {
    throw new CatalogueUnavailableError(
      `Couldn't load the catalogue from Supabase (${error.code || "no code"}: ${error.message}).`,
      { cause: error },
    );
  }

  const products: Product[] = [];
  for (const row of data as ProductRow[]) {
    if (row.product_images.length === 0 || row.product_variants.length === 0) {
      console.warn(
        `[catalogue] Published product "${row.slug}" is hidden from the storefront: ` +
          `it needs at least one photo and one size.`,
      );
      continue;
    }
    products.push(toProduct(row));
  }
  return products;
}
