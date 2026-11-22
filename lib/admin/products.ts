import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import type { LightUpCondition } from "@/lib/catalog/light-up";
import type { Condition, Department, ItemStatus, Style } from "@/lib/catalog/types";
import { labelNameFor } from "@/lib/labels/name-fit";
import { readTimeout } from "@/lib/supabase/config";
import { paisaToRupeesText, type FieldErrors, type ProductFormValues } from "./product-input";

/*
 * Admin reads of the catalogue, always through the verified admin's own
 * session client (never cached, never a service key): the database's RLS
 * lets only verified admins (member + aal2) see drafts and archived products,
 * and the internal columns come only through admin_get_products.
 */

export type PublicationStatus = "draft" | "published" | "archived";
export const PUBLICATION_STATUSES: PublicationStatus[] = ["draft", "published", "archived"];

export type AdminPhoto = {
  id: string;
  /** Preview URL: the signed-in admin route for uploads, or the site path. */
  previewSrc: string;
  alt: string;
  showsDefect: boolean;
  width: number;
  height: number;
};

export type EditableProduct = {
  id: string;
  version: number;
  status: PublicationStatus;
  /** Set once the product has been published: item code and SKUs are then fixed. */
  listedAt: string | null;
  updatedAt: string;
  values: ProductFormValues;
  photos: AdminPhoto[];
};

/**
 * Longest side (pixels) of the admin previews, made on request from the
 * stored photo (app/admin/products/[id]/photos/[imageId]/route.ts): "thumb"
 * for the product list and the scan page (shown at 56–96 px), "preview" for
 * the editor (about 350 px). Both cover a 2x screen. "full" is the stored photo.
 */
export const ADMIN_PREVIEW_SIZES = { thumb: 256, preview: 720 } as const;
export type AdminPhotoSize = keyof typeof ADMIN_PREVIEW_SIZES | "full";

export function adminPhotoSrc(productId: string, imageId: string, size: AdminPhotoSize = "preview") {
  const path = `/admin/products/${productId}/photos/${imageId}`;
  return size === "full" ? path : `${path}?size=${size}`;
}

type ProductRow = {
  id: string;
  version: number;
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
  publication_status: string;
  listed_at: string | null;
  updated_at: string;
  label_name: string | null;
  light_up: boolean | null;
  light_up_condition: LightUpCondition | null;
  light_up_activation: string | null;
  product_variants: {
    sku: string;
    size_eu: number | string;
    stock: number;
    reserved: number;
    inventory_version: number | string;
    // One-to-one (variant_id is unique), so PostgREST returns an object;
    // an array is tolerated too.
    variant_barcodes: { barcode: string } | { barcode: string }[] | null;
  }[];
  product_images: {
    id: string;
    src: string | null;
    storage_path: string | null;
    alt: string;
    width: number;
    height: number;
    sort_order: number;
    shows_defect: boolean;
  }[];
};

/**
 * The editor's copy of products, internal columns included (label_name,
 * reserved, inventory_version), from admin_get_products: signed-in sessions
 * can't read those columns directly, and the function refuses anyone but a
 * verified admin (supabase/migrations/20261117120200_internal_columns_admin_reads.sql;
 * the direct column access is removed by 20261117120400_restrict_internal_columns.sql).
 * One call is one snapshot, so stock and inventory versions always match.
 */
async function getProductRows(supabase: AdminSessionClient, ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.rpc("admin_get_products", { p_product_ids: ids }).abortSignal(readTimeout());
  if (error) throw new AdminDataError(`Couldn't load the product (${error.code || "no code"}).`, { cause: error });
  return (data ?? []) as ProductRow[];
}

function barcodeOf(embedded: ProductRow["product_variants"][number]["variant_barcodes"]) {
  const row = Array.isArray(embedded) ? embedded[0] : embedded;
  return row?.barcode;
}

export class AdminDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AdminDataError";
  }
}

function toEditable(row: ProductRow): EditableProduct {
  return {
    id: row.id,
    version: row.version,
    status: row.publication_status as PublicationStatus,
    listedAt: row.listed_at,
    updatedAt: row.updated_at,
    values: {
      name: row.name,
      labelName: row.label_name ?? "",
      brand: row.brand,
      colour: row.colour,
      department: row.department as Department,
      styles: row.styles as Style[],
      itemStatus: row.item_status as ItemStatus,
      condition: row.condition as Condition,
      conditionNotes: row.condition_notes.join("\n"),
      description: row.description,
      lightUp: row.light_up === null ? "" : row.light_up ? "yes" : "no",
      lightUpCondition: row.light_up_condition ?? "not_checked",
      lightUpActivation: row.light_up_activation ?? "",
      price: paisaToRupeesText(row.price_paisa),
      salePrice: row.sale_price_paisa === null ? "" : paisaToRupeesText(row.sale_price_paisa),
      autoItemCode: false,
      itemCode: row.item_code,
      slug: row.slug,
      sizes: row.product_variants
        .map((v) => ({
          size: String(Number(v.size_eu)),
          stock: String(v.stock),
          sku: v.sku,
          barcode: barcodeOf(v.variant_barcodes),
          stockWas: String(v.stock),
          inventoryVersion: String(v.inventory_version),
          reserved: v.reserved,
        }))
        .sort((a, b) => Number(a.size) - Number(b.size)),
    },
    photos: [...row.product_images]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((image) => ({
        id: image.id,
        previewSrc: image.storage_path ? adminPhotoSrc(row.id, image.id) : (image.src ?? ""),
        alt: image.alt,
        showsDefect: image.shows_defect,
        width: image.width,
        height: image.height,
      })),
  };
}

/** One product for the edit screen, or null if it doesn't exist (or isn't visible). */
export async function getEditableProduct(supabase: AdminSessionClient, id: string) {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await getProductRows(supabase, [id]);
  return row ? toEditable(row) : null;
}

export type ProductListItem = {
  id: string;
  itemCode: string;
  name: string;
  brand: string;
  status: PublicationStatus;
  itemStatus: ItemStatus;
  pricePaisa: number;
  /** Set while on sale (below pricePaisa). */
  salePricePaisa: number | null;
  totalStock: number;
  sizeCount: number;
  photoCount: number;
  thumbnailSrc: string | null;
  updatedAt: string;
  /** Why its labels can't be printed yet (the name doesn't fit), or null. */
  labelProblem: string | null;
};

export const PAGE_SIZE = 20;

/** Letters, numbers, spaces and hyphens only: safe inside a PostgREST filter. */
export function cleanSearch(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60)
    : "";
}

export async function listProducts(
  supabase: AdminSessionClient,
  { q, status, page }: { q: string; status: PublicationStatus | null; page: number },
) {
  let query = supabase
    .from("products")
    .select(
      `id, item_code, name, brand, publication_status, item_status, price_paisa, sale_price_paisa, updated_at,
       product_variants (stock), product_images (id, src, storage_path, sort_order)`,
      { count: "exact" },
    )
    .order("updated_at", { ascending: false })
    .order("id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status) query = query.eq("publication_status", status);
  for (const word of q.split(" ").filter(Boolean)) {
    const pattern = `%${word}%`;
    query = query.or(`name.ilike.${pattern},brand.ilike.${pattern},item_code.ilike.${pattern},slug.ilike.${pattern},colour.ilike.${pattern}`);
  }

  const { data, error, count } = await query;
  if (error) throw new AdminDataError(`Couldn't load products (${error.code || "no code"}).`, { cause: error });

  type Row = {
    id: string;
    item_code: string;
    name: string;
    brand: string;
    publication_status: PublicationStatus;
    item_status: ItemStatus;
    price_paisa: number;
    sale_price_paisa: number | null;
    updated_at: string;
    product_variants: { stock: number }[];
    product_images: { id: string; src: string | null; storage_path: string | null; sort_order: number }[];
  };
  // Label names are internal: read through the admin function, for this page only.
  const rows = data as Row[];
  const labelNames = new Map((await getProductRows(supabase, rows.map((r) => r.id))).map((r) => [r.id, r.label_name]));
  const items: ProductListItem[] = rows.map((row) => {
    const first = [...row.product_images].sort((a, b) => a.sort_order - b.sort_order)[0];
    return {
      id: row.id,
      itemCode: row.item_code,
      name: row.name,
      brand: row.brand,
      status: row.publication_status,
      itemStatus: row.item_status,
      pricePaisa: row.price_paisa,
      salePricePaisa: row.sale_price_paisa,
      totalStock: row.product_variants.reduce((sum, v) => sum + v.stock, 0),
      sizeCount: row.product_variants.length,
      photoCount: row.product_images.length,
      thumbnailSrc: first ? (first.storage_path ? adminPhotoSrc(row.id, first.id, "thumb") : first.src) : null,
      updatedAt: row.updated_at,
      labelProblem: labelNameFor({ labelName: labelNames.get(row.id) ?? null, name: row.name }).problem,
    };
  });
  return { items, total: count ?? 0 };
}

export async function countByStatus(supabase: AdminSessionClient) {
  const counts = await Promise.all(
    PUBLICATION_STATUSES.map(async (status) => {
      const { count, error } = await supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("publication_status", status);
      if (error) throw new AdminDataError(`Couldn't count products (${error.code || "no code"}).`, { cause: error });
      return [status, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts) as Record<PublicationStatus, number>;
}

/* ---------- Database errors → messages ---------- */

type DbError = { code?: string; message?: string; hint?: string | null; details?: string | null };

const CONSTRAINT_MESSAGES: Record<string, { field?: keyof FieldErrors; message: string }> = {
  products_item_code_key: { field: "itemCode", message: "Another product already uses this item code." },
  products_slug_key: { field: "slug", message: "Another product already uses this web address name." },
  product_variants_sku_key: {
    field: "sizes",
    message: "One of these sizes’ SKUs is already used by another product. Check the item code.",
  },
  product_variants_one_per_preloved_product: { field: "sizes", message: "A pre-loved pair has exactly one size." },
  product_variants_preloved_stock: {
    field: "sizes",
    message: "A pre-loved pair’s stock is 1 (for sale) or 0 (sold, or held for an order).",
  },
  order_items_variant_id_fkey: { field: "sizes", message: "This size has been sold, so it can’t be removed. Set its stock to 0 instead." },
  product_variants_stock_not_negative: { field: "sizes", message: "Stock can’t be negative." },
  product_variants_size_valid: { field: "sizes", message: "Sizes are whole or half EU sizes between 15 and 50." },
  products_published_price_positive: { field: "price", message: "A published product needs a price above zero." },
  products_published_needs_description: { field: "description", message: "A published product needs a description." },
  products_published_needs_style: { field: "styles", message: "A published product needs at least one style." },
  products_published_needs_size: { field: "sizes", message: "A published product needs at least one size." },
  products_published_needs_photo: { field: "photos", message: "A published product needs at least one photo." },
  products_condition_matches_item_status: { field: "condition", message: "New shoes are always condition “New”." },
  products_item_code_not_barcode: {
    field: "itemCode",
    message: "An item code can’t look like a barcode (KNS or U followed by 8 digits). Use a different code.",
  },
  products_sale_price_valid: {
    field: "salePrice",
    message: "The sale price must be above zero and lower than the regular price. Lower it, or clear it to end the sale.",
  },
  products_label_name_valid: { field: "labelName", message: "Use a label name of up to 60 characters on one line." },
  products_light_up_condition_matches: { field: "lightUpCondition", message: "Choose whether the lights work." },
  products_light_up_activation_valid: {
    field: "lightUpActivation",
    message: "Describe the lights in up to 120 characters on one line, or leave it empty.",
  },
  products_item_code_not_kns_barcode: {
    field: "itemCode",
    message: "An item code can’t look like a barcode (KNS or U followed by 8 digits). Use a different code.",
  },
};

const HINT_MESSAGES: Record<string, { field?: keyof FieldErrors; message: string }> = {
  item_code_locked: { field: "itemCode", message: "The item code can’t change once the product has been published." },
  variant_locked: {
    field: "sizes",
    message: "Sizes of a product that has been published can’t be removed. Set the stock to 0 instead.",
  },
  sku_locked: { field: "sizes", message: "Sizes can’t change once the product has been published." },
  too_many_photos: { field: "photos", message: "A product can have at most 12 photos." },
  auto_priced: {
    field: "price",
    message: "This product is priced automatically from its score. Change it in “Pricing” on this page, or switch it to a manual price there.",
  },
  campaign_price: {
    field: "salePrice",
    message: "This product is in a running sale. Remove it from the sale (Sales) or end the sale before changing its prices here.",
  },
  bad_transition: { message: "That status change isn’t allowed. Reload the page and try again." },
  barcode_locked: { message: "Barcodes can’t be changed or removed. Reload the page and try again." },
  item_code_reserved: {
    field: "itemCode",
    message: "Codes like ITEM-000123 are assigned automatically. Use a different code.",
  },
  size_has_orders: { field: "sizes", message: "A size with pairs held for orders can’t be removed." },
  inventory_version_required: { field: "sizes", message: "This page is out of date. Reload it, then change the stock again." },
};

export const CONFLICT_MESSAGE =
  "Someone else saved this product after you opened it. Reload the page to see their changes, then make yours again.";

export type DbProblem =
  | { kind: "conflict"; message: string }
  | { kind: "field"; field: keyof FieldErrors; message: string }
  | { kind: "general"; message: string };

/** Turns a database error into a message an admin can act on (never raw SQL). */
export function describeDbError(error: DbError): DbProblem {
  const code = error.code ?? "";
  if (error.hint === "stock_changed") {
    return {
      kind: "field",
      field: "sizes",
      message: `The stock of EU ${error.details ?? "a size"} changed since you opened this page (an order or another admin). Reload to see the current stock, then make your change again.`,
    };
  }
  if (code === "PT409") return { kind: "conflict", message: CONFLICT_MESSAGE };
  if (code === "PT404") return { kind: "general", message: "This product no longer exists. Go back to the product list." };
  if (code === "42501") {
    return { kind: "general", message: "Your session no longer has admin access. Sign in again in a new tab, then retry." };
  }
  const byHint = error.hint ? HINT_MESSAGES[error.hint] : undefined;
  if (byHint) return byHint.field ? { kind: "field", field: byHint.field, message: byHint.message } : { kind: "general", message: byHint.message };
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  for (const [constraint, entry] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (text.includes(constraint)) {
      return entry.field ? { kind: "field", field: entry.field, message: entry.message } : { kind: "general", message: entry.message };
    }
  }
  return { kind: "general", message: "The product couldn’t be saved. Check the details and try again." };
}
