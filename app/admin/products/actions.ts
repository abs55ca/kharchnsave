"use server";

import { randomUUID } from "node:crypto";
import { refresh, updateTag } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { recordUploadedPhoto } from "@/lib/admin/photo-registration";
import { flipPhoto, preparePhoto, type PreparedPhoto } from "@/lib/admin/photos";
import {
  LIMITS,
  publishProblems,
  readProductForm,
  rupeesToPaisa,
  validateProduct,
  type FieldErrors,
} from "@/lib/admin/product-input";
import {
  adminPhotoSrc,
  cleanSearch,
  describeDbError,
  getEditableProduct,
  listProducts,
  type AdminPhoto,
  type EditableProduct,
  type PublicationStatus,
} from "@/lib/admin/products";
import { BULK_PUBLISH_BATCH } from "@/lib/admin/bulk-publish";
import { answerForDbError, type BlockedReason } from "@/lib/admin/request-outcome";
import { getAdminClient, type AdminAccess, type AdminSessionClient } from "@/lib/auth/admin";
import { photoCacheTag, photoObjectPath, PRODUCT_PHOTOS_BUCKET, UUID_PATTERN } from "@/lib/catalog/photos";
import { fullName } from "@/lib/catalog/product-utils";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";

/*
 * Product management actions. Each one is a public endpoint, so each one
 * checks on the server that the caller is a verified admin (identity,
 * current membership and an aal2 session), validates its input, and writes
 * through the admin's own session client, where the database applies the
 * same rules again (RLS + constraints). Saves are atomic database functions
 * that refuse to overwrite a newer version. Nothing here returns raw
 * database errors, and nothing is logged except error codes.
 *
 * Access problems return a message instead of redirecting, so unsaved work
 * stays on the page while the admin signs in again in another tab.
 */

export type ProductFormState = {
  status: "idle" | "saved" | "error" | "conflict";
  message: string | null;
  errors: FieldErrors;
  /** The product as saved (normalised by the server), after a successful save. */
  product?: EditableProduct;
};

export type PhotoUploadResult =
  | { ok: true; version: number; photo: AdminPhoto }
  | { ok: false; error: string; conflict?: boolean };

export type StatusChangeResult =
  | { ok: true; product: EditableProduct }
  | { ok: false; error: string; conflict?: boolean };

function accessMessage(access: AdminAccess) {
  switch (access.status) {
    case "signed-out":
      return "You’ve been signed out. Sign in again in a new tab, then try again; your changes are still here.";
    case "mfa-required":
      return "Your session needs two-step verification again. Verify in a new tab, then try again.";
    case "not-admin":
      return "This account no longer has admin access.";
    default:
      return "We couldn’t verify your access right now. Please try again.";
  }
}

const failed = (message: string, errors: FieldErrors = {}): ProductFormState => ({ status: "error", message, errors });

function readVersion(formData: FormData) {
  const value = formData.get("version");
  return typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

function readProductId(formData: FormData) {
  const value = formData.get("productId");
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/** Removes photos that are no longer referenced. Failures leave private, unused objects (see README). */
async function removeStoredPhotos(supabase: AdminSessionClient, productId: string, paths: string[]) {
  const safe = paths.filter((p) => typeof p === "string" && p.startsWith(`${productId}/`));
  if (safe.length === 0) return;
  const { error } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).remove(safe);
  if (error) console.error("[admin] Couldn't remove unused product photos:", safe.length, error.name);
}

export async function createProduct(_previous: ProductFormState, formData: FormData): Promise<ProductFormState> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return failed(accessMessage(access));

  const checked = validateProduct(readProductForm(formData));
  if (!checked.ok) return failed("Check the highlighted fields.", checked.errors);

  let id: string;
  try {
    const { data, error } = await supabase.rpc("admin_create_product", {
      p_fields: checked.fields,
      p_sizes: checked.sizes,
    });
    if (error) {
      const problem = describeDbError(error);
      if (problem.kind === "general") console.error("[admin] Create product failed:", error.code);
      return problem.kind === "field"
        ? failed("Check the highlighted fields.", { [problem.field]: problem.message })
        : failed(problem.message);
    }
    id = (data as { id: string }).id;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[admin] Create product failed:", (error as Error).name);
    return failed("The product couldn’t be created right now. Please try again.");
  }

  redirect(`/admin/products/${id}?created=1`);
}

export async function saveProduct(_previous: ProductFormState, formData: FormData): Promise<ProductFormState> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return failed(accessMessage(access));

  const productId = readProductId(formData);
  const version = readVersion(formData);
  if (!productId || version === null) return failed("This form is out of date. Reload the page.");

  const values = readProductForm(formData);
  // The label name the form loaded: if it's unchanged, a name too wide for
  // the label doesn't block saving other changes (printing is refused instead).
  const savedLabelName = formData.get("labelNameWas");
  // The item code the form loaded: a product may keep its own automatic code.
  const savedItemCode = formData.get("itemCodeWas");
  const checked = validateProduct(values, {
    savedLabelName: typeof savedLabelName === "string" ? savedLabelName : "",
    savedItemCode: typeof savedItemCode === "string" ? savedItemCode : "",
  });
  const errors: FieldErrors = checked.ok ? {} : { ...checked.errors };

  // Photos to keep, in order, with their details.
  let photos: { id: string; alt: string; shows_defect: boolean }[] = [];
  try {
    const parsed: unknown = JSON.parse(String(formData.get("photos") ?? "[]"));
    if (!Array.isArray(parsed) || parsed.length > LIMITS.photos) throw new Error("bad photos");
    photos = parsed.map((p) => {
      if (typeof p?.id !== "string" || !UUID_PATTERN.test(p.id)) throw new Error("bad photo id");
      return { id: p.id, alt: typeof p.alt === "string" ? p.alt.trim() : "", shows_defect: p.showsDefect === true };
    });
  } catch {
    return failed("This form is out of date. Reload the page.");
  }
  if (photos.some((p) => !p.alt)) errors.photos = "Describe every photo (alt text) for shoppers using screen readers.";
  else if (photos.some((p) => p.alt.length > LIMITS.alt)) errors.photos = `Keep each description under ${LIMITS.alt} characters.`;

  if (!checked.ok || Object.keys(errors).length > 0) return failed("Check the highlighted fields.", errors);

  let removedPaths: string[] = [];
  try {
    const { data, error } = await supabase.rpc("admin_save_product", {
      p_product_id: productId,
      p_expected_version: version,
      p_fields: checked.fields,
      p_sizes: checked.sizes,
      p_images: photos,
    });
    if (error) {
      const problem = describeDbError(error);
      if (problem.kind === "conflict") return { status: "conflict", message: problem.message, errors: {} };
      if (problem.kind === "general") console.error("[admin] Save product failed:", error.code);
      return problem.kind === "field"
        ? failed("Check the highlighted fields.", { [problem.field]: problem.message })
        : failed(problem.message);
    }
    removedPaths = (data as { removed_paths: string[] }).removed_paths ?? [];
  } catch (error) {
    unstable_rethrow(error);
    console.error("[admin] Save product failed:", (error as Error).name);
    return failed("The product couldn’t be saved right now. Your changes are still here; please try again.");
  }

  // The save is committed. Clean-up and the refreshed copy are best effort.
  await removeStoredPhotos(supabase, productId, removedPaths);
  updateTag(CATALOGUE_TAG);
  // Removed photos stop being served from the CDN too (app/product-photos).
  if (removedPaths.length > 0) updateTag(photoCacheTag(productId));
  try {
    const product = await getEditableProduct(supabase, productId);
    if (product) return { status: "saved", message: "Saved.", errors: {}, product };
  } catch (error) {
    console.error("[admin] Reloading the saved product failed:", (error as Error).name);
  }
  return { status: "saved", message: "Saved. Reload the page to see the latest version.", errors: {} };
}

export async function uploadProductPhoto(formData: FormData): Promise<PhotoUploadResult> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return { ok: false, error: accessMessage(access) };

  const productId = readProductId(formData);
  const version = readVersion(formData);
  if (!productId || version === null) return { ok: false, error: "This form is out of date. Reload the page." };

  const prepared = await preparePhoto(formData.get("photo"));
  if (!prepared.ok) return { ok: false, error: prepared.error };

  let alt: string;
  try {
    const product = await getEditableProduct(supabase, productId);
    if (!product) return { ok: false, error: "This product no longer exists. Go back to the product list." };
    if (product.version !== version) return { ok: false, error: describeDbError({ code: "PT409" }).message, conflict: true };
    alt = `${fullName({ brand: product.values.brand, name: product.values.name })}, photo ${product.photos.length + 1}`.slice(0, LIMITS.alt);
  } catch (error) {
    console.error("[admin] Photo upload: product lookup failed:", (error as Error).name);
    return { ok: false, error: "The photo couldn’t be uploaded right now. Please try again." };
  }

  return storeAndRecord(supabase, productId, version, prepared.photo, alt);
}

/**
 * Stores a prepared photo at a new id and records it on the product (after the
 * photos it already has). Shared by uploads and flips.
 */
async function storeAndRecord(
  supabase: AdminSessionClient,
  productId: string,
  version: number,
  photo: PreparedPhoto,
  alt: string,
  showsDefect = false,
): Promise<PhotoUploadResult> {
  const imageId = randomUUID();
  const path = photoObjectPath(productId, imageId);
  const bucket = supabase.storage.from(PRODUCT_PHOTOS_BUCKET);

  const { error: uploadError } = await bucket.upload(path, photo.data, {
    contentType: "image/webp",
    upsert: false,
  });
  if (uploadError) {
    console.error("[admin] Photo upload to Storage failed:", uploadError.name);
    return { ok: false, error: "The photo couldn’t be uploaded to storage. Please try again." };
  }

  // Record it, keyed by the image id: repeated until the database answers
  // (lib/admin/photo-registration.ts). The upload is removed only when the
  // database refused it; without an answer the photo may be recorded, so the
  // file stays (an unused one stays private: README, "Product photos").
  const outcome = await recordUploadedPhoto(
    async () => {
      const { data, error } = await supabase.rpc("admin_add_product_image", {
        p_product_id: productId,
        p_expected_version: version,
        p_image_id: imageId,
        p_storage_path: path,
        p_width: photo.width,
        p_height: photo.height,
        p_alt: alt,
      });
      return { data: typeof data === "number" ? data : null, error };
    },
    () => removeStoredPhotos(supabase, productId, [path]),
  );
  if (outcome.kind === "refused") {
    const problem = describeDbError(outcome.error);
    if (problem.kind === "general") console.error("[admin] Recording a photo failed:", outcome.error.code);
    return { ok: false, error: problem.message, conflict: problem.kind === "conflict" };
  }
  if (outcome.kind === "unknown") {
    console.error("[admin] Recording a photo: no answer after", outcome.attempts, "attempts; the upload is kept.");
    return {
      ok: false,
      error: "We couldn’t confirm whether it was saved. Reload the page: if the photo is there, it was saved; if not, upload it again.",
    };
  }

  updateTag(CATALOGUE_TAG);
  return {
    ok: true,
    version: outcome.version,
    photo: {
      id: imageId,
      previewSrc: adminPhotoSrc(productId, imageId),
      alt,
      showsDefect,
      width: photo.width,
      height: photo.height,
    },
  };
}

/**
 * Mirrors an uploaded photo left to right. The mirrored copy is a new photo,
 * stored and recorded like an upload (the original is untouched); the editor
 * puts it in the original's place, so saving the product drops the original
 * (and its file), exactly as if the admin had removed it.
 */
export async function flipProductPhoto(formData: FormData): Promise<PhotoUploadResult> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return { ok: false, error: accessMessage(access) };

  const productId = readProductId(formData);
  const version = readVersion(formData);
  const imageId = formData.get("imageId");
  if (!productId || version === null || typeof imageId !== "string" || !UUID_PATTERN.test(imageId)) {
    return { ok: false, error: "This form is out of date. Reload the page." };
  }

  let original: AdminPhoto;
  let stored: Uint8Array;
  try {
    const product = await getEditableProduct(supabase, productId);
    if (!product) return { ok: false, error: "This product no longer exists. Go back to the product list." };
    if (product.version !== version) return { ok: false, error: describeDbError({ code: "PT409" }).message, conflict: true };
    const found = product.photos.find((p) => p.id === imageId);
    if (!found) return { ok: false, error: "That photo is no longer on this product. Reload the page." };
    original = found;
    if (product.photos.length >= LIMITS.photos) {
      return { ok: false, error: `The flipped copy needs a free photo slot (at most ${LIMITS.photos}). Remove a photo and save, then flip.` };
    }
    const { data: row, error } = await supabase
      .from("product_images")
      .select("storage_path")
      .eq("id", imageId)
      .eq("product_id", productId)
      .maybeSingle();
    if (error) throw error;
    if (!row?.storage_path) return { ok: false, error: "Only uploaded photos can be flipped." };
    const { data: file, error: downloadError } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).download(row.storage_path);
    if (downloadError || !file) throw downloadError ?? new Error("no file");
    stored = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    console.error("[admin] Photo flip: reading the photo failed:", (error as Error).name);
    return { ok: false, error: "The photo couldn’t be flipped right now. Please try again." };
  }

  let flipped: PreparedPhoto;
  try {
    flipped = await flipPhoto(stored);
  } catch (error) {
    console.error("[admin] Photo flip failed:", (error as Error).name);
    return { ok: false, error: "That photo couldn’t be flipped. Upload a mirrored copy instead." };
  }
  return storeAndRecord(supabase, productId, version, flipped, original.alt, original.showsDefect);
}

const TARGET_STATUSES: PublicationStatus[] = ["published", "draft", "archived"];

/** Publish, unpublish (back to draft), archive, or restore an archived product as a draft. */
export async function changeProductStatus(formData: FormData): Promise<StatusChangeResult> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return { ok: false, error: accessMessage(access) };

  const productId = readProductId(formData);
  const version = readVersion(formData);
  const status = formData.get("status") as PublicationStatus;
  if (!productId || version === null || !TARGET_STATUSES.includes(status)) {
    return { ok: false, error: "This page is out of date. Reload it." };
  }

  try {
    if (status === "published") {
      const product = await getEditableProduct(supabase, productId);
      if (!product) return { ok: false, error: "This product no longer exists." };
      const problems = publishProblems({
        pricePaisa: rupeesToPaisa(product.values.price) ?? 0,
        description: product.values.description,
        styles: product.values.styles,
        sizeCount: product.values.sizes.length,
        photoCount: product.photos.length,
      });
      if (problems.length > 0) {
        return { ok: false, error: `Before publishing, add ${problems.join(", ")}, then save.` };
      }
    }

    const { error } = await supabase.rpc("admin_set_publication_status", {
      p_product_id: productId,
      p_expected_version: version,
      p_status: status,
    });
    if (error) {
      const problem = describeDbError(error);
      if (problem.kind === "general") console.error("[admin] Status change failed:", error.code);
      return { ok: false, error: problem.message, conflict: problem.kind === "conflict" };
    }

    updateTag(CATALOGUE_TAG);
    // Unpublished or archived: its photos stop being served from the CDN too.
    if (status !== "published") updateTag(photoCacheTag(productId));
    const product = await getEditableProduct(supabase, productId);
    if (!product) return { ok: false, error: "The change was saved, but the product couldn’t be reloaded. Reload the page." };
    return { ok: true, product };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[admin] Status change failed:", (error as Error).name);
    return { ok: false, error: "The status couldn’t be changed right now. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Permanent deletion (supabase/migrations/20261122150000_product_deletion.sql)
// ---------------------------------------------------------------------------

/** Shaped for useRequestAction (components/admin/agent-forms.tsx): one request id per deletion, retried unchanged when unconfirmed. */
export type DeleteProductState = {
  ok: boolean;
  message: string | null;
  done?: boolean;
  uncertain?: boolean;
  blocked?: BlockedReason;
  /** Set once deleted: the product's item code (for the product list's notice). */
  deletedItemCode?: string;
};

const DELETE_REFUSALS: Record<string, string> = {
  confirm_mismatch: "Type the item code exactly as shown to confirm.",
  delete_blocked: "Orders containing this product block the delete. Reload the page to see why.",
  not_found: "This product no longer exists. It may have been deleted already: check the product list.",
  request_mismatch: "This form was already used. Reload the page.",
};

/** Every file in the product's Storage folder: its photos, and any upload that was never recorded. */
async function removeProductFolder(supabase: AdminSessionClient, productId: string, known: string[]) {
  const paths = new Set(known);
  const { data, error } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).list(productId, { limit: 1000 });
  if (error) console.error("[admin] Couldn't list a deleted product's photos:", error.name);
  for (const file of data ?? []) paths.add(`${productId}/${file.name}`);
  await removeStoredPhotos(supabase, productId, [...paths]);
}

export async function deleteProductAction(_previous: DeleteProductState, formData: FormData): Promise<DeleteProductState> {
  const requestId = formData.get("requestId");
  const productId = readProductId(formData);
  const token = formData.get("token");
  const confirm = formData.get("confirm");
  if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId) || !productId
    || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || typeof confirm !== "string") {
    return { ok: false, message: "This form is out of date. Reload the page." };
  }
  if (!confirm.trim()) return { ok: false, message: "Type the item code to confirm." };

  const { access, supabase } = await getAdminClient();
  if (!supabase) {
    const blocked: BlockedReason =
      access.status === "signed-out" ? "signed_out" : access.status === "unavailable" ? "unavailable" : "no_access";
    return { ok: false, blocked, message: accessMessage(access) };
  }

  const { data, error } = await supabase.rpc("admin_delete_product", {
    p_product_id: productId,
    p_expected_token: token,
    p_confirm_item_code: confirm.slice(0, 100),
    p_request_id: requestId,
  });
  if (error) {
    const answer = answerForDbError(error);
    if (answer.uncertain) return { ok: false, uncertain: true, message: "No answer from the database." };
    if (answer.blocked) return { ok: false, blocked: answer.blocked, message: "It couldn’t be checked right now." };
    const known = error.hint ? DELETE_REFUSALS[error.hint] : undefined;
    if (!known) console.error("[admin] Product deletion failed:", error.code);
    return { ok: false, message: known ?? "The product couldn’t be deleted right now. Please try again." };
  }

  const result = data as { result: string; item_code?: string; orders_deleted?: string[]; storage_paths?: string[]; replayed?: boolean };
  if (result.result === "stale") {
    // The page reloads with the current list; the admin checks it and confirms again.
    refresh();
    return {
      ok: false,
      message: "Something changed since this page loaded (an edit, a new order or an order’s status), so nothing was deleted. Check the updated details and confirm again.",
    };
  }
  if (result.result !== "deleted") {
    console.error("[admin] Product deletion: unexpected answer.");
    return { ok: false, uncertain: true, message: "Unexpected answer from the database." };
  }

  // Photos are private and no longer referenced; a file that can't be removed now stays private (logged).
  await removeProductFolder(supabase, productId, result.storage_paths ?? []);
  updateTag(CATALOGUE_TAG);
  updateTag(photoCacheTag(productId));
  const orders = result.orders_deleted?.length ?? 0;
  return {
    ok: true,
    done: true,
    deletedItemCode: result.item_code,
    message: `${result.replayed ? "Already deleted earlier: " : "Deleted "}${result.item_code}${orders ? ` and ${orders} order${orders === 1 ? "" : "s"}` : ""}.`,
  };
}

// ---------------------------------------------------------------------------
// Publishing several drafts at once (the product list)
// ---------------------------------------------------------------------------

export type BulkPublishResult = {
  id: string;
  itemCode: string | null;
  name: string | null;
  outcome: "published" | "already" | "skipped" | "failed";
  message?: string;
};

/**
 * Publishes drafts one by one with the same checks and database function as a
 * product's own Publish button. Each product succeeds or fails on its own; every
 * product gets an outcome (nothing is skipped silently). Safe to repeat: one
 * already published is reported as such.
 */
export async function publishProducts(ids: string[]): Promise<{ ok: true; results: BulkPublishResult[] } | { ok: false; error: string }> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return { ok: false, error: accessMessage(access) };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_PUBLISH_BATCH || !ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    return { ok: false, error: "This page is out of date. Reload it." };
  }

  const results: BulkPublishResult[] = [];
  for (const id of ids) {
    try {
      const product = await getEditableProduct(supabase, id);
      if (!product) {
        results.push({ id, itemCode: null, name: null, outcome: "failed", message: "It no longer exists." });
        continue;
      }
      const base = { id, itemCode: product.values.itemCode, name: product.values.name };
      if (product.status === "published") {
        results.push({ ...base, outcome: "already" });
        continue;
      }
      if (product.status !== "draft") {
        results.push({ ...base, outcome: "skipped", message: "It's archived: restore it as a draft first." });
        continue;
      }
      const problems = publishProblems({
        pricePaisa: rupeesToPaisa(product.values.price) ?? 0,
        description: product.values.description,
        styles: product.values.styles,
        sizeCount: product.values.sizes.length,
        photoCount: product.photos.length,
      });
      if (problems.length > 0) {
        results.push({ ...base, outcome: "skipped", message: `Add ${problems.join(", ")} first.` });
        continue;
      }
      const { error } = await supabase.rpc("admin_set_publication_status", {
        p_product_id: id,
        p_expected_version: product.version,
        p_status: "published",
      });
      if (error) {
        const problem = describeDbError(error);
        if (problem.kind === "general") console.error("[admin] Bulk publish failed:", error.code);
        results.push({ ...base, outcome: "failed", message: problem.message });
        continue;
      }
      results.push({ ...base, outcome: "published" });
    } catch (error) {
      unstable_rethrow(error);
      console.error("[admin] Bulk publish failed:", (error as Error).name);
      results.push({ id, itemCode: null, name: null, outcome: "failed", message: "It couldn't be published right now. Try again." });
    }
  }
  if (results.some((r) => r.outcome === "published")) updateTag(CATALOGUE_TAG);
  return { ok: true, results };
}

/** Every draft matching the list's search (all pages; at most 500), for "Select all drafts in this list". */
export async function listDraftIds(q: string): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const { access, supabase } = await getAdminClient();
  if (!supabase) return { ok: false, error: accessMessage(access) };
  try {
    const search = cleanSearch(q);
    const ids: string[] = [];
    for (let page = 1; page <= 25; page++) {
      const { items, total } = await listProducts(supabase, { q: search, status: "draft", page });
      ids.push(...items.map((i) => i.id));
      if (ids.length >= total || items.length === 0) break;
    }
    return { ok: true, ids };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[admin] Listing drafts failed:", (error as Error).name);
    return { ok: false, error: "The drafts couldn't be listed right now. Try again." };
  }
}
