import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_PRODUCT, LIMITS, validateProduct, type ProductFields, type SizeRow } from "@/lib/admin/product-input";
import { recordUploadedPhoto } from "@/lib/admin/photo-registration";
import { fullName, slugify } from "@/lib/catalog/product-utils";
import type { DbError, DbResult } from "@/lib/db/retry";
import { labelNameFor } from "@/lib/labels/name-fit";
import { ImportStopped } from "./session";
import { FOLDERS, MODELS, SKIPPED, type Model } from "./shoes";

/*
 * Plans and runs the kids' shoes import (scripts/import-kids-shoes/README.md).
 * Everything goes through the same database functions as the admin product
 * pages, as the signed-in admin: admin_create_product (a draft), then each
 * photo uploaded to Storage and recorded with admin_add_product_image, which
 * is keyed by the image id so a retry is never recorded twice.
 *
 * Safe to run again: progress (product ids and image ids) is saved after each
 * step, so a rerun continues where the last one stopped. A product whose
 * creation answer was lost is found again by its web address (unique).
 */

const BRAND = "Unbranded";
const SIZE_FILE = /^(\d{2}(?:\.5)?)\.(jpe?g)$/i;
const PHOTO_FILE = /\.(jpe?g|png|webp)$/i;

export type PlannedProduct = {
  folder: number;
  dir: string;
  fields: ProductFields;
  sizes: SizeRow[];
  /** File names in upload order: the timestamped shots, then the size photo (often a repeat or the sole). */
  photos: string[];
};

export type Plan = { products: PlannedProduct[]; problems: string[] };

/** Reads the folders and checks every listing with the admin form's own rules. Nothing is uploaded. */
export async function makePlan(root: string): Promise<Plan> {
  const problems: string[] = [];
  const products: PlannedProduct[] = [];
  const slugs = new Map<string, number>();
  const onDisk = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^Folder \d+$/.test(d.name))
    .map((d) => Number(d.name.slice(7)));

  for (const n of onDisk) {
    if (!(n in FOLDERS) && !(n in SKIPPED)) problems.push(`Folder ${n} is on disk but not in shoes.ts.`);
  }

  for (const [key, [modelKey, expectedSize]] of Object.entries(FOLDERS)) {
    const folder = Number(key);
    const dir = join(root, `Folder ${folder}`);
    if (!onDisk.includes(folder)) {
      problems.push(`Folder ${folder} is missing.`);
      continue;
    }
    const files = (await readdir(dir)).filter((f) => PHOTO_FILE.test(f)).sort((a, b) => a.localeCompare(b));
    const sizeFiles = files.filter((f) => SIZE_FILE.test(f));
    if (sizeFiles.length !== 1) {
      problems.push(`Folder ${folder}: expected one size photo, found ${sizeFiles.length}.`);
      continue;
    }
    const size = Number(SIZE_FILE.exec(sizeFiles[0])![1]);
    if (size !== expectedSize) {
      problems.push(`Folder ${folder}: its size photo says ${size}, shoes.ts says ${expectedSize}.`);
      continue;
    }
    const photos = [...files.filter((f) => f !== sizeFiles[0]), sizeFiles[0]];
    if (photos.length > LIMITS.photos) problems.push(`Folder ${folder}: ${photos.length} photos (at most ${LIMITS.photos}).`);

    const model: Model = MODELS[modelKey];
    const name = `${model.name} — ${model.colour}`;
    // Printed labels: the full name if it fits; otherwise the model name, with or without its last word.
    const labelName = labelNameFor({ name }).problem
      ? ([model.label, model.name, model.name.replace(/ (Sneakers|Trainers|Runners)$/, "")].find((l): l is string => !!l && !labelNameFor({ labelName: l, name }).problem) ?? model.name)
      : "";
    let slug = slugify(`${name} eu${size}`);
    const seen = (slugs.get(slug) ?? 0) + 1;
    slugs.set(slug, seen);
    if (seen > 1) slug = `${slug}-${seen}`;

    const checked = validateProduct({
      ...EMPTY_PRODUCT,
      name,
      labelName,
      brand: BRAND,
      colour: model.colour,
      department: "kids",
      styles: [...model.styles],
      itemStatus: "new",
      condition: "new",
      description: model.description,
      // Unpriced draft: priced later (product page or Pricing), then published.
      price: "0",
      autoItemCode: true,
      slug,
      sizes: [{ size: String(size), stock: "1" }],
    });
    if (!checked.ok) {
      problems.push(`Folder ${folder}: ${Object.entries(checked.errors).map(([f, m]) => `${f}: ${m}`).join("; ")}`);
      continue;
    }
    if (labelName && labelNameFor({ labelName, name }).problem) problems.push(`Folder ${folder}: no label name fits.`);
    products.push({ folder, dir, fields: checked.fields, sizes: checked.sizes, photos });
  }
  products.sort((a, b) => a.folder - b.folder);
  return { products, problems };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export type ProductState = { version: number; slug: string; name: string; photoIds: string[] } | null;

/** What the import needs from Supabase (index.mts); a fake in import.test.ts. */
export type Backend = {
  findBySlug(slug: string): Promise<string | null>;
  create(fields: ProductFields, sizes: SizeRow[]): Promise<DbResult<{ id: string }>>;
  get(id: string): Promise<ProductState>;
  /** The photo as stored (checked and re-encoded by the site's preparePhoto). */
  prepare(file: string): Promise<{ data: Buffer; width: number; height: number }>;
  /** Uploads to Storage; an existing object at the path (an earlier attempt) counts as uploaded. */
  upload(path: string, data: Buffer): Promise<{ ok: true } | { ok: false; message: string }>;
  addImage(args: { productId: string; version: number; imageId: string; path: string; width: number; height: number; alt: string }): Promise<DbResult<number>>;
  removeUpload(path: string): Promise<void>;
  newId(): string;
};

export type Progress = {
  project: string;
  folders: Record<string, { productId?: string; photos: Record<string, string>; done?: boolean }>;
};

export type Log = (line: string) => void;


const describe = (e: DbError | null | undefined) => [e?.code, e?.hint, e?.message].filter(Boolean).join(" ");

/** Creates (or finds) each product and records its photos, saving progress after every step. */
export async function runImport(
  products: PlannedProduct[],
  backend: Backend,
  progress: Progress,
  save: (p: Progress) => Promise<void>,
  log: Log,
): Promise<{ created: number; found: number; photos: number; finished: number }> {
  const totals = { created: 0, found: 0, photos: 0, finished: 0 };
  for (const [i, item] of products.entries()) {
    const label = `[${i + 1}/${products.length}] Folder ${item.folder} · ${item.fields.name} · EU ${item.sizes[0].size}`;
    const entry = (progress.folders[item.folder] ??= { photos: {} });
    if (entry.done) {
      totals.finished++;
      continue;
    }

    // 1. The product (a draft).
    if (!entry.productId) {
      const existing = await backend.findBySlug(item.fields.slug);
      if (existing) {
        entry.productId = existing;
        totals.found++;
        log(`${label}: found from an earlier run`);
      } else {
        const created = await backend.create(item.fields, item.sizes);
        if (created.error || !created.data?.id) {
          // A lost answer may still have created it: its web address says.
          const again = await backend.findBySlug(item.fields.slug);
          if (!again) throw new ImportStopped(`${label}: couldn't create the product (${describe(created.error) || "no answer"}). Nothing was saved for it; run the import again.`);
          entry.productId = again;
          totals.found++;
        } else {
          entry.productId = created.data.id;
          totals.created++;
        }
        log(`${label}: draft created`);
      }
      await save(progress);
    }
    const productId = entry.productId;

    // 2. Its photos, in order.
    for (const [n, file] of item.photos.entries()) {
      const state = await backend.get(productId);
      if (!state) throw new ImportStopped(`${label}: the product ${productId} no longer exists (deleted?). Remove Folder ${item.folder} from the progress file to create it again.`);
      if (state.slug !== item.fields.slug || state.name !== item.fields.name) {
        throw new ImportStopped(`${label}: product ${productId} is "${state.name}" (${state.slug}), not this shoe; stopping rather than guessing.`);
      }
      const known = entry.photos[file];
      if (known && state.photoIds.includes(known)) continue;

      // The image id is saved before uploading, so a retry reuses it (and is recognised).
      const imageId = known ?? backend.newId();
      if (!known) {
        entry.photos[file] = imageId;
        await save(progress);
      }
      const path = `${productId}/${imageId}.webp`;
      const photo = await backend.prepare(join(item.dir, file));
      const uploaded = await backend.upload(path, photo.data);
      if (!uploaded.ok) throw new ImportStopped(`${label}: couldn't upload ${file} (${uploaded.message}). Run the import again to continue.`);
      const alt = `${fullName({ brand: item.fields.brand, name: item.fields.name })}, photo ${n + 1}`.slice(0, LIMITS.alt);
      const outcome = await recordUploadedPhoto(
        () => backend.addImage({ productId, version: state.version, imageId, path, width: photo.width, height: photo.height, alt }),
        () => backend.removeUpload(path),
      );
      if (outcome.kind === "unknown") {
        throw new ImportStopped(`${label}: no answer when recording ${file}. Run the import again: it checks and continues (never records it twice).`);
      }
      if (outcome.kind === "refused") {
        // The upload was removed; a fresh id is used next time.
        delete entry.photos[file];
        await save(progress);
        throw new ImportStopped(`${label}: ${file} was refused (${describe(outcome.error)}). Run the import again; if it repeats, check the product in the admin.`);
      }
      totals.photos++;
    }

    entry.done = true;
    totals.finished++;
    await save(progress);
    log(`${label}: ${item.photos.length} photos ✓`);
  }
  return totals;
}
