import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import type { Condition, Department, ItemStatus, Style } from "@/lib/catalog/types";
import { paisaToRupeesText, type FieldErrors, type ProductFormValues } from "./product-input";

/*
 * Admin reads of the catalogue, always through the verified admin's own
 * session client (never cached, never a service key): the database's RLS
 * lets only verified admins (member + aal2) see drafts and archived products.
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

export function adminPhotoSrc(productId: string, imageId: string) {
  return `/admin/products/${productId}/photos/${imageId}`;
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
  publication_status: string;
  listed_at: string | null;
  updated_at: string;
  product_variants: { sku: string; size_eu: number | string; stock: number }[];
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

const EDIT_COLUMNS = `
  id, version, item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, publication_status, listed_at, updated_at,
  product_variants (sku, size_eu, stock),
  product_images (id, src, storage_path, alt, width, height, sort_order, shows_defect)
`;

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
      brand: row.brand,
      colour: row.colour,
      department: row.department as Department,
      styles: row.styles as Style[],
      itemStatus: row.item_status as ItemStatus,
      condition: row.condition as Condition,
      conditionNotes: row.condition_notes.join("\n"),
      description: row.description,
      price: paisaToRupeesText(row.price_paisa),
      itemCode: row.item_code,
      slug: row.slug,
      sizes: row.product_variants
        .map((v) => ({ size: String(Number(v.size_eu)), stock: String(v.stock), sku: v.sku }))
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
  const { data, error } = await supabase.from("products").select(EDIT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new AdminDataError(`Couldn't load the product (${error.code || "no code"}).`, { cause: error });
  return data ? toEditable(data as ProductRow) : null;
}

export type ProductListItem = {
  id: string;
  itemCode: string;
  name: string;
  brand: string;
  status: PublicationStatus;
  itemStatus: ItemStatus;
  pricePaisa: number;
  totalStock: number;
  sizeCount: number;
  photoCount: number;
  thumbnailSrc: string | null;
  updatedAt: string;
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
      `id, item_code, name, brand, publication_status, item_status, price_paisa, updated_at,
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
    updated_at: string;
    product_variants: { stock: number }[];
    product_images: { id: string; src: string | null; storage_path: string | null; sort_order: number }[];
  };
  const items: ProductListItem[] = (data as Row[]).map((row) => {
    const first = [...row.product_images].sort((a, b) => a.sort_order - b.sort_order)[0];
    return {
      id: row.id,
      itemCode: row.item_code,
      name: row.name,
      brand: row.brand,
      status: row.publication_status,
      itemStatus: row.item_status,
      pricePaisa: row.price_paisa,
      totalStock: row.product_variants.reduce((sum, v) => sum + v.stock, 0),
      sizeCount: row.product_variants.length,
      photoCount: row.product_images.length,
      thumbnailSrc: first ? (first.storage_path ? adminPhotoSrc(row.id, first.id) : first.src) : null,
      updatedAt: row.updated_at,
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
  product_variants_preloved_stock: { field: "sizes", message: "A pre-loved pair’s stock is 1 (for sale) or 0 (sold)." },
  product_variants_stock_not_negative: { field: "sizes", message: "Stock can’t be negative." },
  product_variants_size_valid: { field: "sizes", message: "Sizes are whole or half EU sizes between 15 and 50." },
  products_published_price_positive: { field: "price", message: "A published product needs a price above zero." },
  products_published_needs_description: { field: "description", message: "A published product needs a description." },
  products_published_needs_style: { field: "styles", message: "A published product needs at least one style." },
  products_published_needs_size: { field: "sizes", message: "A published product needs at least one size." },
  products_published_needs_photo: { field: "photos", message: "A published product needs at least one photo." },
  products_condition_matches_item_status: { field: "condition", message: "New shoes are always condition “New”." },
};

const HINT_MESSAGES: Record<string, { field?: keyof FieldErrors; message: string }> = {
  item_code_locked: { field: "itemCode", message: "The item code can’t change once the product has been published." },
  variant_locked: {
    field: "sizes",
    message: "Sizes of a product that has been published can’t be removed. Set the stock to 0 instead.",
  },
  sku_locked: { field: "sizes", message: "Sizes can’t change once the product has been published." },
  too_many_photos: { field: "photos", message: "A product can have at most 12 photos." },
  bad_transition: { message: "That status change isn’t allowed. Reload the page and try again." },
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
