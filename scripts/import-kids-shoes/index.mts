/*
 * Imports the kids' shoes as draft products, as a signed-in admin.
 * See scripts/import-kids-shoes/README.md. Run from the project folder:
 *
 *   npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts --dry-run
 *   npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts --only 1
 *   npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts
 *
 * Options: --dir <folder with "Folder 1" … "Folder 104">, --progress <file>,
 * --only 1,2,3 (just those folders), --dry-run (check everything, upload nothing).
 * It asks for the admin's email, password and 6-digit code; none are stored.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { preparePhoto } from "@/lib/admin/photos";
import { getEditableProduct } from "@/lib/admin/products";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { PRODUCT_PHOTOS_BUCKET } from "@/lib/catalog/photos";
import { makePlan, runImport, type Backend, type Progress } from "./import";
import { ImportStopped, projectFromEnv, signInAdmin } from "./session";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY_RUN = args.includes("--dry-run");
const ROOT = resolve(option("--dir") ?? "C:/Users/abs55/Documents/KharchnSave/images/New folder");
const PROGRESS = resolve(option("--progress") ?? join(dirname(ROOT), "kids-shoes-import-progress.json"));
const ONLY = option("--only")?.split(",").map((n) => Number(n.trim())).filter(Number.isInteger);

async function main() {
  console.log(`Folders:  ${ROOT}`);
  const plan = await makePlan(ROOT);
  const products = ONLY ? plan.products.filter((p) => ONLY.includes(p.folder)) : plan.products;
  if (plan.problems.length) {
    console.error("\nProblems (nothing uploaded):");
    for (const p of plan.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  if (products.length === 0) {
    console.error("Nothing to import (check --only).");
    process.exitCode = 1;
    return;
  }
  console.log(`Listings: ${products.length} drafts (kids, new, one size, stock 1, price Rs. 0), ${products.reduce((n, p) => n + p.photos.length, 0)} photos\n`);

  if (DRY_RUN) {
    let bytes = 0;
    for (const p of products) {
      for (const file of p.photos) {
        const prepared = await prepareFile(join(p.dir, file));
        bytes += prepared.data.length;
      }
      console.log(`  Folder ${String(p.folder).padEnd(3)} EU ${String(p.sizes[0].size).padEnd(4)} ${p.fields.name}${p.fields.label_name ? `  [label: ${p.fields.label_name}]` : ""}  (${p.photos.length} photos)  /products/${p.fields.slug}`);
    }
    console.log(`\nDry run: every listing passes the admin form's checks and every photo was processed (${(bytes / 1024 / 1024).toFixed(1)} MB as stored). Nothing was uploaded.`);
    return;
  }

  const { url, key, project } = projectFromEnv();
  console.log(`Supabase project: ${project}`);
  console.log(`Progress file:    ${PROGRESS}\n`);

  let progress: Progress = { project, folders: {} };
  if (existsSync(PROGRESS)) {
    progress = JSON.parse(await readFile(PROGRESS, "utf8")) as Progress;
    if (progress.project !== project) {
      throw new ImportStopped(`The progress file belongs to ${progress.project}, not ${project}. Use --progress with another file name.`);
    }
    const done = Object.values(progress.folders).filter((f) => f.done).length;
    console.log(`Continuing an earlier run: ${done} listing(s) already finished.\n`);
  }
  const save = async (p: Progress) => {
    const temp = `${PROGRESS}.tmp`;
    await writeFile(temp, JSON.stringify(p, null, 2));
    await rename(temp, PROGRESS);
  };

  const supabase = await signInAdmin(url, key);

  const client = supabase as unknown as AdminSessionClient;
  const bucket = supabase.storage.from(PRODUCT_PHOTOS_BUCKET);
  const backend: Backend = {
    async findBySlug(slug) {
      const { data, error } = await supabase.from("products").select("id").eq("slug", slug).maybeSingle();
      if (error) throw new ImportStopped(`Couldn't check for an existing product (${error.code || error.message}).`);
      return (data as { id: string } | null)?.id ?? null;
    },
    async create(fields, sizes) {
      const { data, error } = await supabase.rpc("admin_create_product", { p_fields: fields, p_sizes: sizes });
      return { data: (data as { id: string } | null) ?? null, error };
    },
    async get(id) {
      const product = await getEditableProduct(client, id);
      return product ? { version: product.version, slug: product.values.slug, name: product.values.name, photoIds: product.photos.map((p) => p.id) } : null;
    },
    prepare: prepareFile,
    async upload(path, data) {
      const { error } = await bucket.upload(path, data, { contentType: "image/webp", upsert: false });
      if (!error) return { ok: true };
      // The same path from an earlier attempt (same image id, same file).
      if (/exists|duplicate/i.test(error.message)) return { ok: true };
      return { ok: false, message: error.message };
    },
    async addImage(a) {
      const { data, error } = await supabase.rpc("admin_add_product_image", {
        p_product_id: a.productId,
        p_expected_version: a.version,
        p_image_id: a.imageId,
        p_storage_path: a.path,
        p_width: a.width,
        p_height: a.height,
        p_alt: a.alt,
      });
      return { data: typeof data === "number" ? data : null, error };
    },
    async removeUpload(path) {
      const { error } = await bucket.remove([path]);
      if (error) console.warn(`  (couldn't remove the refused upload ${path}: ${error.message}; it stays private and unused)`);
    },
    newId: randomUUID,
  };

  try {
    const totals = await runImport(products, backend, progress, save, (line) => console.log(line));
    console.log(`\nDone: ${totals.finished} of ${products.length} listings complete (${totals.created} created now, ${totals.found} found from an earlier run, ${totals.photos} photos recorded now).`);
    console.log("They are drafts at Rs. 0: set prices (product page, or in bulk under Pricing), then publish.");
  } finally {
    await supabase.auth.signOut();
  }
}

async function prepareFile(path: string) {
  const bytes = await readFile(path);
  const type = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
  const prepared = await preparePhoto(new File([bytes], basename(path), { type }));
  if (!prepared.ok) throw new ImportStopped(`${path}: ${prepared.error}`);
  return prepared.photo;
}

main().catch((error) => {
  console.error(error instanceof ImportStopped ? `\nStopped: ${error.message}` : error);
  process.exitCode = 1;
});
