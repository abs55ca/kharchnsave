"use server";

import { randomUUID } from "node:crypto";
import { updateTag } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { preparePhoto } from "@/lib/admin/photos";
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
  describeDbError,
  getEditableProduct,
  type AdminPhoto,
  type EditableProduct,
  type PublicationStatus,
} from "@/lib/admin/products";
import { getAdminClient, type AdminAccess, type AdminSessionClient } from "@/lib/auth/admin";
import { photoObjectPath, PRODUCT_PHOTOS_BUCKET, UUID_PATTERN } from "@/lib/catalog/photos";
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

  const imageId = randomUUID();
  const path = photoObjectPath(productId, imageId);
  const bucket = supabase.storage.from(PRODUCT_PHOTOS_BUCKET);

  const { error: uploadError } = await bucket.upload(path, prepared.photo.data, {
    contentType: "image/webp",
    upsert: false,
  });
  if (uploadError) {
    console.error("[admin] Photo upload to Storage failed:", uploadError.name);
    return { ok: false, error: "The photo couldn’t be uploaded to storage. Please try again." };
  }

  // Record it. If that fails, remove the upload so nothing points nowhere
  // (and nothing unreferenced is left behind, if Storage allows).
  let newVersion: number;
  try {
    const { data, error } = await supabase.rpc("admin_add_product_image", {
      p_product_id: productId,
      p_expected_version: version,
      p_image_id: imageId,
      p_storage_path: path,
      p_width: prepared.photo.width,
      p_height: prepared.photo.height,
      p_alt: alt,
    });
    if (error) {
      await removeStoredPhotos(supabase, productId, [path]);
      const problem = describeDbError(error);
      if (problem.kind === "general") console.error("[admin] Recording a photo failed:", error.code);
      return { ok: false, error: problem.message, conflict: problem.kind === "conflict" };
    }
    newVersion = data as number;
  } catch (error) {
    await removeStoredPhotos(supabase, productId, [path]);
    console.error("[admin] Recording a photo failed:", (error as Error).name);
    return { ok: false, error: "The photo couldn’t be saved right now. Please try again." };
  }

  updateTag(CATALOGUE_TAG);
  return {
    ok: true,
    version: newVersion,
    photo: {
      id: imageId,
      previewSrc: adminPhotoSrc(productId, imageId),
      alt,
      showsDefect: false,
      width: prepared.photo.width,
      height: prepared.photo.height,
    },
  };
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
    const product = await getEditableProduct(supabase, productId);
    if (!product) return { ok: false, error: "The change was saved, but the product couldn’t be reloaded. Reload the page." };
    return { ok: true, product };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[admin] Status change failed:", (error as Error).name);
    return { ok: false, error: "The status couldn’t be changed right now. Please try again." };
  }
}
