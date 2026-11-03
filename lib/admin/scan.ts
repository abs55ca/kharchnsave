import "server-only";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { readTimeout } from "@/lib/supabase/config";
import type { ItemStatus } from "@/lib/catalog/types";
import { adminPhotoSrc, AdminDataError, type PublicationStatus } from "./products";

/*
 * Barcode and item-code lookups for the scan and label pages, through the
 * verified admin's own session. Both database functions are read-only
 * (STABLE) and return nothing to anyone but a verified admin
 * (supabase/migrations/20261029200000_variant_barcodes.sql).
 */

export type ScanUnit = {
  variantId: string;
  sku: string;
  size: number;
  stock: number;
  barcode: string | null;
};

export type ScanProduct = {
  id: string;
  itemCode: string;
  name: string;
  /** Short name for printed labels; null: the labels use the name (lib/labels/name-fit.ts). */
  labelName: string | null;
  brand: string;
  colour: string;
  itemStatus: ItemStatus;
  status: PublicationStatus;
  /** Regular price. */
  pricePaisa: number;
  /** Sale price while on sale: what to charge (the database charges it too). */
  salePricePaisa: number | null;
  photo: { src: string; alt: string } | null;
  units: ScanUnit[];
};

export type ScanResult =
  | { kind: "unit"; matchedBy: "barcode" | "sku"; code: string; product: ScanProduct }
  | { kind: "product"; matchedBy: "item_code"; code: string; product: ScanProduct }
  /** currentBarcode: the barcode now on that product's size with the same EU size, if any. */
  | { kind: "retired"; code: string; sku: string; size: number; currentBarcode: string | null; product: ScanProduct | null }
  | { kind: "not_found"; code: string };

type ProductJson = {
  id: string;
  item_code: string;
  name: string;
  /** Absent before 20261101120000_label_names_and_light_up.sql. */
  label_name?: string | null;
  brand: string;
  colour: string;
  item_status: ItemStatus;
  publication_status: PublicationStatus;
  price_paisa: number;
  /** Absent before 20261101130000_item_codes_and_sale_prices.sql. */
  sale_price_paisa?: number | null;
  photo: { id: string; src: string | null; storage_path: string | null; alt: string } | null;
  units: { variant_id: string; sku: string; size_eu: number | string; stock: number; barcode: string | null }[];
};

function toScanProduct(row: ProductJson): ScanProduct {
  const photo = row.photo;
  return {
    id: row.id,
    itemCode: row.item_code,
    name: row.name,
    labelName: row.label_name ?? null,
    brand: row.brand,
    colour: row.colour,
    itemStatus: row.item_status,
    status: row.publication_status,
    pricePaisa: row.price_paisa,
    salePricePaisa: row.sale_price_paisa ?? null,
    photo: photo
      ? { src: photo.storage_path ? adminPhotoSrc(row.id, photo.id) : (photo.src ?? ""), alt: photo.alt }
      : null,
    units: row.units.map((unit) => ({
      variantId: unit.variant_id,
      sku: unit.sku,
      size: Number(unit.size_eu),
      stock: unit.stock,
      barcode: unit.barcode,
    })),
  };
}

/** Looks up a scanned barcode, item code or SKU (already normalised). Never changes anything. */
export async function scanLookup(supabase: AdminSessionClient, code: string): Promise<ScanResult> {
  const { data, error } = await supabase.rpc("admin_scan_lookup", { p_code: code }).abortSignal(readTimeout());
  if (error) throw new AdminDataError(`Couldn't look up the code (${error.code || "no code"}).`, { cause: error });

  const result = data as {
    kind: string;
    matched_by?: string;
    code: string;
    sku?: string;
    size_eu?: number | string;
    current_barcode?: string | null;
    product?: ProductJson | null;
  };
  const product = result.product ? toScanProduct(result.product) : null;
  if (result.kind === "retired") {
    return {
      kind: "retired",
      code: result.code,
      sku: result.sku ?? "",
      size: Number(result.size_eu),
      currentBarcode: result.current_barcode ?? null,
      product,
    };
  }
  if (result.kind === "unit" && product) {
    return { kind: "unit", matchedBy: result.matched_by === "sku" ? "sku" : "barcode", code: result.code, product };
  }
  if (result.kind === "product" && product) return { kind: "product", matchedBy: "item_code", code: result.code, product };
  return { kind: "not_found", code: result.code };
}

/** A product with all its sizes and their barcodes, or null if it doesn't exist (or isn't visible). */
export async function getScanProduct(supabase: AdminSessionClient, productId: string) {
  if (!UUID_PATTERN.test(productId)) return null;
  const { data, error } = await supabase.rpc("admin_scan_product", { p_product_id: productId, p_variant_id: null }).abortSignal(readTimeout());
  if (error) throw new AdminDataError(`Couldn't load the product (${error.code || "no code"}).`, { cause: error });
  return data ? toScanProduct(data as ProductJson) : null;
}
