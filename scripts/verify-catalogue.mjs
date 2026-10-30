/**
 * Checks the Supabase catalogue from the public's point of view: it uses the
 * publishable key in .env.local, the same access a shopper's browser has.
 *
 *   npm run db:verify                 (reads .env.local)
 *   npm run db:verify -- --env <path>  (another env file; not --env-file,
 *                                       which Node itself intercepts)
 *
 * Run it after applying supabase/migrations/20261027120000_create_catalogue.sql
 * and the development fixtures in supabase/seeds/dev_catalogue_fixtures.sql.
 *
 * It reads the fixtures, then attempts writes that must be refused. Those
 * attempts are built so they cannot change data even if they were allowed
 * (they match no rows or break a data rule). The URL and key are never printed.
 *
 * What it cannot prove: with the public key it cannot tell a hidden draft from
 * a missing one, so the "hidden" checks only count after the published
 * fixtures have been seen. supabase/tests/catalogue_test.sql covers the rest.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const KEY_VAR = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";

// What supabase/seeds/dev_catalogue_fixtures.sql creates.
const PUBLISHED = [
  {
    slug: "dev-nike-air-max-white-orange-eu43",
    department: "men",
    itemStatus: "preloved",
    pricePaisa: 850000,
    sizes: { "DEV-PL-M-1001-43": [43, 1] },
    images: ["/images/products/nike-air-max-sail-orange-1.jpg", "/images/products/nike-air-max-sail-orange-2.jpg"],
  },
  {
    slug: "dev-new-balance-x90-pink-grey-eu38",
    department: "women",
    itemStatus: "preloved",
    pricePaisa: 690000,
    sizes: { "DEV-PL-W-2001-38": [38, 1] },
    images: ["/images/products/new-balance-x90-pink.jpg"],
  },
  {
    slug: "dev-baby-canvas-sneakers-teal-print",
    department: "kids",
    itemStatus: "new",
    pricePaisa: 245000,
    sizes: {
      "DEV-NW-K-3001-18": [18, 3],
      "DEV-NW-K-3001-19": [19, 0],
      "DEV-NW-K-3001-20": [20, 2],
      "DEV-NW-K-3001-21": [21, 4],
    },
    images: ["/images/products/baby-canvas-sneakers-teal-1.jpg", "/images/products/baby-canvas-sneakers-teal-2.jpg"],
  },
];

const DRAFT = {
  slug: "dev-draft-nike-air-force-1-low-black-eu42",
  sku: "DEV-PL-M-1002-42",
  image: "/images/products/nike-air-force-1-black.jpg",
};

// Matches nothing, so update/delete attempts can never change a real row.
const NO_MATCH = "verify-no-such-row";
const NO_PRODUCT = "00000000-0000-0000-0000-000000000000";

let failures = 0;
let passes = 0;
let secrets = [];

function scrub(text) {
  return secrets.reduce((t, s) => (s ? t.split(s).join("<redacted>") : t), String(text));
}

function pass(message) {
  passes++;
  console.log(`PASS  ${message}`);
}

function fail(message, hint) {
  failures++;
  console.log(`FAIL  ${message}`);
  if (hint) console.log(`      ${scrub(hint)}`);
}

function finish() {
  console.log("");
  if (failures === 0) {
    console.log(`All ${passes} checks passed.`);
  } else {
    console.log(`${failures} check(s) failed, ${passes} passed.`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

function describeError(error) {
  if (!error) return "";
  const code = error.code ? `${error.code}: ` : "";
  return scrub(`${code}${error.message ?? error}`);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

// ---------------------------------------------------------------------------
// 1. Configuration (no network until this passes)
// ---------------------------------------------------------------------------

function loadConfig() {
  const envFile = argValue("--env") ?? ".env.local";
  // Checked first: Node exits outright when asked to load a missing file.
  if (!existsSync(envFile)) {
    fail(`${envFile} exists`, "Copy .env.example to .env.local and fill it in.");
    finish();
  }
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    fail(`could not read ${envFile}`, error.message);
    finish();
  }

  const url = process.env[URL_VAR] ?? "";
  const key = process.env[KEY_VAR] ?? "";
  secrets = [url, key];
  let ok = true;
  const check = (passed, message, hint) => {
    if (passed) pass(message);
    else {
      ok = false;
      fail(message, hint);
    }
  };

  check(url !== "", `${URL_VAR} is set`, `Add it to ${envFile}.`);
  check(!/\s/.test(url), `${URL_VAR} has no spaces or line breaks`, "Remove the whitespace from the value.");
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    // Reported below.
  }
  const local = parsed?.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  check(
    parsed?.protocol === "https:" || local,
    `${URL_VAR} is a valid URL (https, or http for a local Supabase)`,
    "Expected https://<project-ref>.supabase.co (or http://127.0.0.1:54321 for a local Supabase).",
  );
  check(
    !!parsed && parsed.pathname === "/" && !parsed.search && !parsed.username,
    `${URL_VAR} is just the project address (no path or query)`,
    "Use the base URL only, without /rest/v1 or anything after it.",
  );

  check(key !== "", `${KEY_VAR} is set`, `Add it to ${envFile}.`);
  check(!/\s/.test(key), `${KEY_VAR} has no spaces or line breaks`, "Remove the whitespace from the value.");
  check(
    key.startsWith("sb_publishable_"),
    `${KEY_VAR} is a publishable key`,
    key.startsWith("sb_secret_")
      ? "This is a SECRET key. Remove it from .env.local now and use the publishable key."
      : "Use the project's publishable key (starts with sb_publishable_). Legacy JWT keys are not accepted here because a service_role key would bypass the access rules being tested.",
  );

  if (!ok) finish();
  return { url: url.trim(), key };
}

// ---------------------------------------------------------------------------
// 2. Published fixtures are visible, and correct
// ---------------------------------------------------------------------------

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

async function checkProducts(supabase) {
  const { data, error } = await supabase
    .from("products")
    .select(
      "slug, department, item_status, publication_status, price_paisa, " +
        "product_variants (sku, size_eu, stock), product_images (src, sort_order)",
    )
    .in("slug", [...PUBLISHED.map((p) => p.slug), DRAFT.slug]);

  if (error) {
    const missingTable = ["PGRST205", "42P01"].includes(error.code);
    fail(
      "could not read products",
      missingTable
        ? "The catalogue tables don't exist yet: apply the migration first."
        : `${describeError(error)}. Check the URL, the key and your internet connection.`,
    );
    finish();
  }

  if (data.length === 0) {
    fail(
      "no fixture products were returned",
      "An empty result is not a pass. Either the seed hasn't been run, this is a different project, or the read policies hide published products.",
    );
    finish();
  }

  let allPublishedSeen = true;
  for (const expected of PUBLISHED) {
    const row = data.find((p) => p.slug === expected.slug);
    if (!row) {
      allPublishedSeen = false;
      fail(`published fixture is visible: ${expected.slug}`, "Run the seed, or check the read policy on products.");
      continue;
    }
    pass(`published fixture is visible: ${expected.slug}`);

    const problems = [];
    if (row.publication_status !== "published") problems.push(`publication_status ${row.publication_status}`);
    if (row.department !== expected.department) problems.push(`department ${row.department}`);
    if (row.item_status !== expected.itemStatus) problems.push(`item_status ${row.item_status}`);
    if (row.price_paisa !== expected.pricePaisa) problems.push(`price_paisa ${row.price_paisa}`);
    const sizes = row.product_variants.map((v) => `${v.sku}=${Number(v.size_eu)}/${v.stock}`);
    const expectedSizes = Object.entries(expected.sizes).map(([sku, [size, stock]]) => `${sku}=${size}/${stock}`);
    if (!sameSet(sizes, expectedSizes)) problems.push(`sizes [${sizes.join(", ")}]`);
    const images = [...row.product_images].sort((a, b) => a.sort_order - b.sort_order).map((i) => i.src);
    if (images.join() !== expected.images.join()) problems.push(`images [${images.join(", ")}]`);

    const label =
      `${expected.slug}: ${expected.department}, ${expected.itemStatus}, ` +
      `${Object.keys(expected.sizes).length} size(s), ${expected.images.length} image(s), price ${expected.pricePaisa} paisa`;
    if (problems.length === 0) pass(label);
    else fail(label, `Unexpected: ${problems.join("; ")}. Rerun the seed to reset the fixtures.`);
  }

  if (!allPublishedSeen) {
    fail("draft product is hidden", "Not checked: the published fixtures must be visible first, or a hidden draft can't be told apart from a missing one.");
    return false;
  }
  if (data.some((p) => p.slug === DRAFT.slug)) {
    fail("draft product is hidden", "The public key can read a draft. Check the read policy on products.");
  } else {
    pass("draft product is hidden from the public key");
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. Sizes and images, read directly (not through their product)
// ---------------------------------------------------------------------------

async function checkChildren(supabase) {
  const publishedSkus = PUBLISHED.flatMap((p) => Object.keys(p.sizes));
  const variants = await supabase.from("product_variants").select("sku").in("sku", [...publishedSkus, DRAFT.sku]);
  if (variants.error) {
    fail("could not read product_variants", describeError(variants.error));
  } else {
    const skus = variants.data.map((v) => v.sku);
    if (sameSet(skus.filter((s) => s !== DRAFT.sku), publishedSkus)) pass(`all ${publishedSkus.length} published sizes are readable directly`);
    else fail("published sizes are readable directly", `Got [${skus.join(", ")}].`);
    if (skus.includes(DRAFT.sku)) fail("draft's size is hidden", "The public key can read a draft's size. Check the read policy on product_variants.");
    else if (skus.length > 0) pass("draft's size is hidden, even when asked for by SKU");
  }

  const publishedImages = PUBLISHED.flatMap((p) => p.images);
  const images = await supabase.from("product_images").select("src").in("src", [...publishedImages, DRAFT.image]);
  if (images.error) {
    fail("could not read product_images", describeError(images.error));
  } else {
    const srcs = images.data.map((i) => i.src);
    if (publishedImages.every((src) => srcs.includes(src))) pass(`all ${publishedImages.length} published images are readable directly`);
    else fail("published images are readable directly", `Got [${srcs.join(", ")}].`);
    if (srcs.includes(DRAFT.image)) {
      fail("draft's image is hidden", "The public key can read the draft's image. Check the read policy on product_images (or another product uses the same photo).");
    } else if (srcs.length > 0) {
      pass("draft's image is hidden");
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Writes are refused
// ---------------------------------------------------------------------------

async function checkWritesRefused(supabase) {
  // Every attempt is harmless even if allowed: inserts break a data rule
  // (negative price, impossible size, zero-size image) and updates/deletes
  // match no rows.
  const attempts = [
    ["insert a product", () =>
      supabase.from("products").insert({
        item_code: "VERIFY-NOPE", slug: NO_MATCH, name: "x", brand: "x", department: "men",
        item_status: "preloved", condition: "good", colour: "x", price_paisa: -1,
      })],
    ["update products", () => supabase.from("products").update({ name: "x" }).eq("slug", NO_MATCH)],
    ["delete products", () => supabase.from("products").delete().eq("slug", NO_MATCH)],
    ["insert a size", () =>
      supabase.from("product_variants").insert({
        product_id: NO_PRODUCT, item_status: "new", sku: "VERIFY-NOPE", size_eu: 99, stock: -1,
      })],
    ["change stock", () => supabase.from("product_variants").update({ stock: 0 }).eq("sku", NO_MATCH)],
    ["delete sizes", () => supabase.from("product_variants").delete().eq("sku", NO_MATCH)],
    ["insert an image", () =>
      supabase.from("product_images").insert({
        product_id: NO_PRODUCT, src: "/verify-nope.jpg", alt: "x", width: 0, height: 0,
      })],
    ["update images", () => supabase.from("product_images").update({ alt: "x" }).eq("src", NO_MATCH)],
    ["delete images", () => supabase.from("product_images").delete().eq("src", NO_MATCH)],
  ];

  for (const [action, run] of attempts) {
    const { error } = await run();
    // 42501 covers both "permission denied" (no privilege: expected) and
    // "violates row-level security" (privilege granted, only RLS stopped it).
    if (error?.code === "42501" && !/row-level security/i.test(error.message ?? "")) {
      pass(`public key cannot ${action} (permission denied)`);
    } else if (error?.code === "42501") {
      fail(`public key cannot ${action}`, "Blocked by row-level security only: the public role has been granted this permission on the table. Revoke it.");
    } else if (!error) {
      fail(`public key cannot ${action}`, "The request was accepted. It matched no rows, so nothing changed, but the public role must not have this permission.");
    } else {
      fail(`public key cannot ${action}`, `Expected "permission denied" but got ${describeError(error)}. The write was only stopped by a data rule; check the table grants.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Barcodes are admin-only
// (supabase/migrations/20261029200000_variant_barcodes.sql)
// ---------------------------------------------------------------------------

async function checkBarcodesHidden(supabase) {
  const attempts = [
    ["read barcodes", () => supabase.from("variant_barcodes").select("barcode").limit(1)],
    ["look up a barcode", () => supabase.rpc("admin_scan_lookup", { p_code: "U00000013" })],
  ];
  for (const [action, run] of attempts) {
    const { error } = await run();
    if (error?.code === "PGRST205" || error?.code === "PGRST202") {
      console.log(`  - skipped "${action}": the barcode migration isn't applied yet`);
    } else if (error?.code === "42501") {
      pass(`public key cannot ${action} (permission denied)`);
    } else if (!error) {
      fail(`public key cannot ${action}`, "The request was accepted. Barcodes must be readable by verified admins only; check the grants.");
    } else {
      fail(`public key cannot ${action}`, `Expected "permission denied" but got ${describeError(error)}.`);
    }
  }
}

// ---------------------------------------------------------------------------

console.log("Kharch n Save catalogue check (public view, publishable key)\n");
const { url, key } = loadConfig();
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

console.log("");
if (await checkProducts(supabase)) await checkChildren(supabase);
console.log("");
await checkWritesRefused(supabase);
console.log("");
await checkBarcodesHidden(supabase);
finish();
