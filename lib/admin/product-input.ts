import { looksLikeBarcode } from "@/lib/barcodes/code";
import { CONDITIONS, DEPARTMENT_ORDER, STYLE_LABELS } from "@/lib/catalog/labels";
import { ACTIVATION_MAX, LIGHT_UP_CONDITION_VALUES, type LightUpCondition } from "@/lib/catalog/light-up";
import { slugify } from "@/lib/catalog/product-utils";
import { formatPrice } from "@/lib/format";
import type { Condition, Department, ItemStatus, Style } from "@/lib/catalog/types";
import { LABEL_NAME_MAX_CHARS, labelNameFor, tidyLabelName } from "@/lib/labels/name-fit";

/*
 * The admin product form: its values, and the server-side checks that turn
 * them into database fields. The database enforces the same critical rules
 * (supabase/migrations/20261029120000_admin_product_management.sql); these
 * checks exist to give clear, per-field messages first.
 */

export const LIMITS = {
  name: 120,
  labelName: LABEL_NAME_MAX_CHARS,
  lightUpActivation: ACTIVATION_MAX,
  brand: 60,
  colour: 60,
  description: 4000,
  itemCode: 40,
  slug: 120,
  conditionNotes: 12,
  conditionNote: 200,
  alt: 300,
  sizes: 30,
  stock: 9999,
  /** Rs. 10,00,000 */
  priceRupees: 1_000_000,
  photos: 12,
} as const;

/** Photo uploads: checked again on the server by their contents (lib/admin/photos.ts). */
export const PHOTO_UPLOAD = {
  accept: "image/jpeg,image/png,image/webp",
  /** 4 MB; Server Actions accept up to 4.5 MB (next.config.ts). */
  maxBytes: 4 * 1024 * 1024,
} as const;

export const STYLES = Object.keys(STYLE_LABELS) as Style[];
export const PRELOVED_CONDITIONS = CONDITIONS.filter((c) => c.value !== "new").map((c) => c.value);

/** sku and barcode are set for sizes that have been saved (display only; never sent back). */
/**
 * A size row in the form. stockWas and inventoryVersion are what the form
 * loaded for a saved size: the database writes the stock only if it was
 * changed, and only if nobody else changed it since (inventory version).
 * reserved is shown, never edited: pairs held for orders.
 */
export type SizeValue = {
  size: string;
  stock: string;
  sku?: string;
  barcode?: string;
  stockWas?: string;
  inventoryVersion?: string;
  reserved?: number;
};

/** What the form edits. Text stays text until the server parses it. */
export type ProductFormValues = {
  name: string;
  /** Short name for printed labels only; empty: the labels use the name. */
  labelName: string;
  brand: string;
  colour: string;
  department: Department;
  styles: Style[];
  itemStatus: ItemStatus;
  condition: Condition;
  /** One note per line. */
  conditionNotes: string;
  description: string;
  /** Light-up soles: "" not recorded (every product before this existed), "no", or "yes". */
  lightUp: LightUpAnswer;
  /** Used only when lightUp is "yes". */
  lightUpCondition: LightUpCondition;
  /** Used only when lightUp is "yes"; optional. */
  lightUpActivation: string;
  /** The regular price: rupees, as typed, e.g. "8,500" or "8500.50". */
  price: string;
  /** Optional sale price, rupees as typed; empty: no sale. Customers pay it while it is set. */
  salePrice: string;
  /** New products only: the database assigns the item code (ITEM-000123) when the draft is created. */
  autoItemCode: boolean;
  itemCode: string;
  slug: string;
  sizes: SizeValue[];
};

export type LightUpAnswer = "" | "yes" | "no";

export type FieldName = keyof ProductFormValues | "photos";
export type FieldErrors = Partial<Record<FieldName, string>>;

/** Database columns for admin_create_product / admin_save_product. */
export type ProductFields = {
  /** null with auto_item_code: assigned by the database. */
  item_code: string | null;
  auto_item_code: boolean;
  slug: string;
  name: string;
  brand: string;
  department: Department;
  styles: Style[];
  item_status: ItemStatus;
  condition: Condition;
  condition_notes: string[];
  colour: string;
  description: string;
  price_paisa: number;
  sale_price_paisa: number | null;
  label_name: string | null;
  /** null: not recorded. */
  light_up: boolean | null;
  light_up_condition: LightUpCondition | null;
  light_up_activation: string | null;
};

export type SizeRow = { size: number; stock: number; stock_was?: number; inventory_version?: number };

export const EMPTY_PRODUCT: ProductFormValues = {
  name: "",
  labelName: "",
  brand: "",
  colour: "",
  department: "men",
  styles: [],
  itemStatus: "preloved",
  condition: "excellent",
  conditionNotes: "",
  description: "",
  // Not recorded until someone checks: nothing is assumed about new products either.
  lightUp: "",
  lightUpCondition: "not_checked",
  lightUpActivation: "",
  price: "",
  salePrice: "",
  autoItemCode: true,
  itemCode: "",
  slug: "",
  sizes: [{ size: "", stock: "1" }],
};

/**
 * Rupees text → whole paisa, exactly (no floating-point arithmetic):
 * "8,500" → 850000, "8500.5" → 850050, "Rs. 99.99" → 9999. Null if it isn't
 * a valid amount with at most two decimals.
 */
export function rupeesToPaisa(input: string): number | null {
  const cleaned = input.trim().replace(/^rs\.?\s*/i, "").replace(/[,\s]/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Paisa → "Rs. 8,500" for messages. */
const formatPaisa = (paisa: number) => formatPrice(paisa / 100);

/** Paisa → rupees text for the form: 850000 → "8500", 850050 → "8500.50". */
export function paisaToRupeesText(paisa: number): string {
  const rupees = Math.trunc(paisa / 100);
  const rest = paisa % 100;
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, "0")}`;
}

/** A suggested slug: brand, name and (for a single pair) its size. */
export function suggestSlug(values: Pick<ProductFormValues, "brand" | "name" | "itemStatus" | "sizes">) {
  const brand = values.brand.trim().toLowerCase() === "unbranded" ? "" : values.brand;
  const size = values.itemStatus === "preloved" && values.sizes[0]?.size ? `eu${values.sizes[0].size}` : "";
  return slugify(`${brand} ${values.name} ${size}`).slice(0, LIMITS.slug).replace(/-+$/, "");
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
};

function parseSizes(raw: string): SizeValue[] | null {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed) || parsed.length > 100) return null;
    return parsed.map((row) => ({
      size: typeof row?.size === "string" ? row.size.trim() : String(row?.size ?? ""),
      stock: typeof row?.stock === "string" ? row.stock.trim() : String(row?.stock ?? ""),
      ...(typeof row?.stockWas === "string" && /^\d{1,4}$/.test(row.stockWas) ? { stockWas: row.stockWas } : {}),
      ...(typeof row?.inventoryVersion === "string" && /^\d{1,15}$/.test(row.inventoryVersion)
        ? { inventoryVersion: row.inventoryVersion }
        : {}),
    }));
  } catch {
    return null;
  }
}

/** Reads the form fields (not photos) back into form values, unvalidated. */
export function readProductForm(formData: FormData): ProductFormValues {
  const itemStatus = text(formData, "itemStatus") === "new" ? "new" : "preloved";
  const lightUp = text(formData, "lightUp");
  const lightUpCondition = text(formData, "lightUpCondition");
  return {
    name: text(formData, "name"),
    labelName: tidyLabelName(text(formData, "labelName")),
    brand: text(formData, "brand"),
    colour: text(formData, "colour"),
    department: text(formData, "department") as Department,
    styles: formData.getAll("styles").filter((s): s is Style => typeof s === "string" && (STYLES as string[]).includes(s)),
    itemStatus,
    condition: (itemStatus === "new" ? "new" : text(formData, "condition")) as Condition,
    conditionNotes: text(formData, "conditionNotes"),
    description: text(formData, "description"),
    lightUp: lightUp === "yes" || lightUp === "no" ? lightUp : "",
    // Checked by validateProduct; "" if it's missing or unknown.
    lightUpCondition: (LIGHT_UP_CONDITION_VALUES as string[]).includes(lightUpCondition)
      ? (lightUpCondition as LightUpCondition)
      : ("" as LightUpCondition),
    lightUpActivation: text(formData, "lightUpActivation").replace(/\s+/g, " "),
    price: text(formData, "price"),
    salePrice: text(formData, "salePrice"),
    // Only the Add Product form has this box; saves always send the item code.
    autoItemCode: formData.get("autoItemCode") === "on",
    itemCode: text(formData, "itemCode").toUpperCase(),
    slug: text(formData, "slug").toLowerCase(),
    sizes: parseSizes(text(formData, "sizes")) ?? [],
  };
}

const ITEM_CODE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
/** The form automatic item codes take (supabase/migrations/20261101130000_item_codes_and_sale_prices.sql). */
export const AUTO_ITEM_CODE = /^ITEM-[0-9]+$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Control characters (other than the spaces already tidied away). */
const CONTROL = /\p{Cc}/u;

/**
 * Checks the form values; returns database fields or per-field messages.
 *
 * The label name: one that was typed or changed must fit the label
 * (lib/labels/name-fit.ts). One that is unchanged since the form was loaded
 * (savedLabelName) never blocks saving other changes, and neither does a
 * product name too wide for the label: the form and the label page flag
 * those, and printing is refused until the label name is fixed.
 */
export function validateProduct(
  values: ProductFormValues,
  { savedLabelName = "", savedItemCode = "" }: { savedLabelName?: string; savedItemCode?: string } = {},
):
  | { ok: true; fields: ProductFields; sizes: SizeRow[]; values: ProductFormValues }
  | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const tooLong = (value: string, max: number) => value.length > max;

  if (!values.name) errors.name = "Enter the product name.";
  else if (tooLong(values.name, LIMITS.name)) errors.name = `Keep the name under ${LIMITS.name} characters.`;

  if (tooLong(values.labelName, LIMITS.labelName)) {
    errors.labelName = `Keep the label name under ${LIMITS.labelName} characters.`;
  } else if (CONTROL.test(values.labelName)) {
    errors.labelName = labelNameFor({ labelName: values.labelName, name: values.name }).problem!;
  } else if (values.labelName && values.labelName !== tidyLabelName(savedLabelName)) {
    const problem = labelNameFor({ labelName: values.labelName, name: values.name }).problem;
    if (problem) errors.labelName = problem;
  }

  if (values.lightUp === "yes" && !(LIGHT_UP_CONDITION_VALUES as string[]).includes(values.lightUpCondition)) {
    errors.lightUpCondition = "Choose whether the lights work.";
  }
  if (values.lightUp === "yes") {
    if (tooLong(values.lightUpActivation, LIMITS.lightUpActivation)) {
      errors.lightUpActivation = `Keep it under ${LIMITS.lightUpActivation} characters.`;
    } else if (CONTROL.test(values.lightUpActivation)) {
      errors.lightUpActivation = "Use plain text on one line.";
    }
  }
  if (!values.brand) errors.brand = "Enter the brand, or “Unbranded”.";
  else if (tooLong(values.brand, LIMITS.brand)) errors.brand = `Keep the brand under ${LIMITS.brand} characters.`;
  if (!values.colour) errors.colour = "Enter the colour, e.g. “White/Orange”.";
  else if (tooLong(values.colour, LIMITS.colour)) errors.colour = `Keep the colour under ${LIMITS.colour} characters.`;
  if (!DEPARTMENT_ORDER.includes(values.department)) errors.department = "Choose a department.";
  if (values.itemStatus === "preloved" && !PRELOVED_CONDITIONS.includes(values.condition)) {
    errors.condition = "Choose the pair’s condition.";
  }
  if (tooLong(values.description, LIMITS.description)) {
    errors.description = `Keep the description under ${LIMITS.description} characters.`;
  }

  const notes = values.conditionNotes.split("\n").map((n) => n.trim()).filter(Boolean);
  if (notes.length > LIMITS.conditionNotes) errors.conditionNotes = `Use at most ${LIMITS.conditionNotes} notes.`;
  else if (notes.some((n) => n.length > LIMITS.conditionNote)) {
    errors.conditionNotes = `Keep each note under ${LIMITS.conditionNote} characters.`;
  }

  const paisa = rupeesToPaisa(values.price);
  if (!values.price) errors.price = "Enter the price in rupees.";
  else if (paisa === null) errors.price = "Enter the price in rupees, e.g. 8500 or 8500.50.";
  else if (paisa > LIMITS.priceRupees * 100) errors.price = "That price is over Rs. 10,00,000. Check for an extra digit.";

  const sale = values.salePrice ? rupeesToPaisa(values.salePrice) : null;
  if (values.salePrice) {
    if (sale === null) errors.salePrice = "Enter the sale price in rupees, e.g. 6800, or leave it empty for no sale.";
    else if (sale <= 0) errors.salePrice = "A sale price must be above zero. Leave it empty for no sale.";
    else if (paisa !== null && !errors.price && sale >= paisa) {
      errors.salePrice = `The sale price must be lower than the regular price (${formatPaisa(paisa)}). Lower it, or clear it to end the sale.`;
    }
  }

  if (values.autoItemCode) {
    // Assigned by the database when the draft is created.
  } else if (!values.itemCode) errors.itemCode = "Enter an item code, e.g. PL-M-1001.";
  else if (!ITEM_CODE.test(values.itemCode) || tooLong(values.itemCode, LIMITS.itemCode)) {
    errors.itemCode = "Use capital letters and numbers separated by single hyphens, e.g. PL-M-1001.";
  } else if (looksLikeBarcode(values.itemCode)) {
    errors.itemCode = "An item code can’t look like a barcode (KNS or U followed by 8 digits). Use a different code.";
  } else if (AUTO_ITEM_CODE.test(values.itemCode) && values.itemCode !== savedItemCode) {
    errors.itemCode = "Codes like ITEM-000123 are assigned automatically. Choose “Automatically generate”, or use a different code.";
  }

  const slug = values.slug || suggestSlug(values);
  if (!slug) errors.slug = "Enter a web address name, e.g. nike-air-max-white-eu43.";
  else if (!SLUG.test(slug) || tooLong(slug, LIMITS.slug)) {
    errors.slug = "Use lowercase letters and numbers separated by single hyphens.";
  }

  const sizes: SizeRow[] = [];
  const sizeProblem = (() => {
    if (values.sizes.length === 0) return values.itemStatus === "preloved" ? "Enter the pair’s EU size." : "Add at least one size.";
    if (values.itemStatus === "preloved" && values.sizes.length !== 1) return "A pre-loved pair has exactly one size.";
    if (values.sizes.length > LIMITS.sizes) return `Use at most ${LIMITS.sizes} sizes.`;
    for (const row of values.sizes) {
      if (!/^\d{2}(\.[05])?$/.test(row.size)) return "Sizes are whole or half EU sizes, e.g. 42 or 42.5.";
      const size = Number(row.size);
      if (size < 15 || size > 50) return "Sizes are between EU 15 and EU 50.";
      if (!/^\d{1,4}$/.test(row.stock)) return "Stock is a whole number, 0 or more.";
      const stock = Number(row.stock);
      if (values.itemStatus === "preloved" && stock > 1) return "A pre-loved pair’s stock is 1 (for sale) or 0 (sold).";
      if (sizes.some((s) => s.size === size)) return `EU ${size} is listed twice.`;
      sizes.push({
        size,
        stock,
        ...(row.stockWas !== undefined && row.inventoryVersion !== undefined
          ? { stock_was: Number(row.stockWas), inventory_version: Number(row.inventoryVersion) }
          : {}),
      });
    }
    return null;
  })();
  if (sizeProblem) errors.sizes = sizeProblem;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    values: { ...values, slug },
    sizes,
    fields: {
      item_code: values.autoItemCode ? null : values.itemCode,
      auto_item_code: values.autoItemCode,
      slug,
      name: values.name,
      brand: values.brand,
      department: values.department,
      styles: STYLES.filter((s) => values.styles.includes(s)),
      item_status: values.itemStatus,
      condition: values.itemStatus === "new" ? "new" : values.condition,
      condition_notes: notes,
      colour: values.colour,
      description: values.description,
      price_paisa: paisa!,
      sale_price_paisa: sale,
      label_name: values.labelName || null,
      light_up: values.lightUp === "" ? null : values.lightUp === "yes",
      light_up_condition: values.lightUp === "yes" ? values.lightUpCondition : null,
      light_up_activation: values.lightUp === "yes" ? values.lightUpActivation || null : null,
    },
  };
}

/** Why a saved product can't be published yet (empty if it can). */
export function publishProblems(product: {
  pricePaisa: number;
  description: string;
  styles: string[];
  sizeCount: number;
  photoCount: number;
}): string[] {
  const problems: string[] = [];
  if (product.pricePaisa <= 0) problems.push("a price above zero");
  if (!product.description.trim()) problems.push("a description");
  if (product.styles.length === 0) problems.push("at least one style");
  if (product.sizeCount === 0) problems.push("at least one size");
  if (product.photoCount === 0) problems.push("at least one photo");
  return problems;
}
