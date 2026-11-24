/*
 * Prices the imported kids' shoes by size: automatic pricing in the
 * "Kids Sneakers" group (max Rs. 4,000), score 45 (EU 22) rising to 100
 * (EU 36). See scripts/import-kids-shoes/README.md. From the project folder:
 *
 *   npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/price.mts --dry-run
 *   npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/price.mts
 *
 * It prices exactly the products the import created (from its progress file),
 * shows the database's preview per size, and applies only after you type "yes".
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getEditableProduct } from "@/lib/admin/products";
import type { AdminSessionClient } from "@/lib/auth/admin";
import { scorePrice } from "@/lib/pricing/rules";
import { FOLDERS } from "./shoes";
import { applyPricing, findOrCreateGroup, previewPricing, summary, type Plan, type PricingBackend } from "./pricing";
import { ask, ImportStopped, projectFromEnv, signInAdmin } from "./session";
import { GROUP_MAX_PAISA, GROUP_NAME, sizeScore } from "./size-score";
import type { Progress } from "./import";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PROGRESS = resolve(option("--progress") ?? "C:/Users/abs55/Documents/KharchnSave/images/kids-shoes-import-progress.json");

async function main() {
  if (args.includes("--dry-run")) {
    // From shoes.ts and the rules alone (assumes the default Rs. 95 price ending); nothing is read or changed online.
    const sizes = [...new Set(Object.values(FOLDERS).map(([, size]) => size))].sort((a, b) => a - b);
    console.log(`"${GROUP_NAME}", max Rs. ${GROUP_MAX_PAISA / 100}, by size (expected; the database's preview is what counts):`);
    for (const size of sizes) {
      const count = Object.values(FOLDERS).filter(([, s]) => s === size).length;
      const r = scorePrice(GROUP_MAX_PAISA, sizeScore(size), 95);
      console.log(`  EU ${String(size).padEnd(4)}  ${String(count).padStart(3)} shoe(s)  score ${sizeScore(size)}  →  ${r.status === "ok" ? `Rs. ${(r.pricePaisa / 100).toLocaleString("en-PK")}` : r.status}`);
    }
    return;
  }

  const progress = JSON.parse(await readFile(PROGRESS, "utf8")) as Progress;
  const { url, key, project } = projectFromEnv();
  if (progress.project !== project) throw new ImportStopped(`The progress file is for ${progress.project}, but .env.local points at ${project}.`);
  const ids = Object.values(progress.folders).filter((f) => f.done && f.productId).map((f) => f.productId!);
  console.log(`Supabase project: ${project}`);
  console.log(`Products:         ${ids.length} imported kids' shoes (from ${PROGRESS})\n`);

  const supabase = await signInAdmin(url, key);
  const client = supabase as unknown as AdminSessionClient;
  const rpc = async <T,>(fn: string, params: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) throw new ImportStopped(`${fn} failed: ${[error.code, error.hint, error.message].filter(Boolean).join(" ")}`);
    return data as T;
  };
  const backend: PricingBackend = {
    groups: async () => (await rpc<{ groups: { id: string; name: string; max_price_paisa: number }[] }>("admin_pricing_overview")).groups,
    createGroup: (requestId, name, max) => rpc("admin_create_pricing_group", { p_request_id: requestId, p_name: name, p_max_price_paisa: max }),
    async product(id) {
      const p = await getEditableProduct(client, id);
      return p ? { itemCode: p.values.itemCode, name: p.values.name, sizes: p.values.sizes.map((s) => Number(s.size)) } : null;
    },
    preview: (items) => rpc<Plan>("admin_preview_product_pricing", { p_items: items }),
    apply: (requestId, items, token) => rpc("admin_apply_product_pricing", { p_request_id: requestId, p_items: items, p_token: token }),
  };

  try {
    const groupId = await findOrCreateGroup(backend, console.log);
    const { rows, items, token } = await previewPricing(ids, groupId, backend);
    const changing = rows.filter((r) => r.action === "apply").length;
    console.log(`\nPreview from the database (${changing} to change, ${rows.length - changing} already priced this way):`);
    for (const line of summary(rows)) console.log(line);
    if (changing === 0) {
      console.log("\nNothing to change.");
      return;
    }
    const answer = await ask(`\nApply these prices to ${changing} product(s)? They stay drafts. Type "yes" to apply: `);
    if (answer.toLowerCase() !== "yes") {
      console.log("Not applied. Nothing changed.");
      return;
    }
    const applied = await applyPricing(backend, items, token);
    console.log(`\nDone: ${applied} product(s) priced. They're still drafts: publish them when you're ready.`);
  } finally {
    await supabase.auth.signOut();
  }
}

main().catch((error) => {
  console.error(error instanceof ImportStopped ? `\nStopped: ${error.message}` : error);
  process.exitCode = 1;
});
