/*
 * The kids' shoes' genuine two-phase promotion (scripts/import-kids-shoes/promotion.ts).
 * From the project folder:
 *
 *   Phase 1: raise the prices and publish (asks you to type "yes"):
 *     npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/promote.mts raise
 *
 *   Phase 2, 28 days later: start the sale (shoes not yet eligible are listed with their date):
 *     npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/promote.mts start-sale
 *
 * Progress is kept in C:\Users\abs55\Documents\KharchnSave\images\kids-shoes-promotion.json
 * (don't delete it before phase 2): both phases can be run again safely.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getEditableProduct } from "@/lib/admin/products";
import { buildPreview, getPromotionOverview } from "@/lib/admin/promotions";
import type { AdminSessionClient } from "@/lib/auth/admin";
import type { Progress } from "./import";
import { MIN_DAYS, planRaise, runRaise, runSale, shopPercent, type Pricing, type PromotionBackend, type PromotionState } from "./promotion";
import { ask, ImportStopped, projectFromEnv, signInAdmin } from "./session";

const [command] = process.argv.slice(2);
const IMPORT_PROGRESS = resolve("C:/Users/abs55/Documents/KharchnSave/images/kids-shoes-import-progress.json");
const STATE = resolve("C:/Users/abs55/Documents/KharchnSave/images/kids-shoes-promotion.json");
const rs = (paisa: number) => `Rs. ${(paisa / 100).toLocaleString("en-PK")}`;
const karachiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());

async function main() {
  if (command !== "raise" && command !== "start-sale") {
    console.log('Use "raise" (phase 1) or "start-sale" (phase 2, after 28 days).');
    process.exitCode = 1;
    return;
  }
  const { url, key, project } = projectFromEnv();
  console.log(`Supabase project: ${project}`);
  console.log(`State file:       ${STATE}\n`);
  let state: PromotionState | null = existsSync(STATE) ? (JSON.parse(await readFile(STATE, "utf8")) as PromotionState) : null;
  if (state && state.project !== project) throw new ImportStopped(`The state file is for ${state.project}, but .env.local points at ${project}.`);
  if (command === "start-sale" && !state) throw new ImportStopped("Run phase 1 (raise) first: there is no state file.");
  const save = async (s: PromotionState) => {
    await writeFile(`${STATE}.tmp`, JSON.stringify(s, null, 2));
    await rename(`${STATE}.tmp`, STATE);
  };

  const supabase = await signInAdmin(url, key);
  const client = supabase as unknown as AdminSessionClient;
  const rpc = async <T,>(fn: string, params: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) throw new ImportStopped(`${fn} failed: ${[error.code, error.hint, error.message].filter(Boolean).join(" ")}`);
    return data as T;
  };
  const backend: PromotionBackend = {
    overview: () => getPromotionOverview(client),
    settings: async () => (await rpc<{ settings: Record<string, unknown> & { version: number; reference_min_days: number | null } }>("admin_pricing_overview")).settings,
    saveSettings: async (version, requestId, settings) => {
      await rpc("admin_save_pricing_settings", { p_expected_version: version, p_request_id: requestId, p_settings: settings });
    },
    pricing: (id) => rpc<Pricing | null>("admin_product_pricing", { p_product_id: id }),
    pricingPreview: (items) => rpc("admin_preview_product_pricing", { p_items: items }),
    pricingApply: (requestId, items, token) => rpc("admin_apply_product_pricing", { p_request_id: requestId, p_items: items, p_token: token }),
    product: (id) => getEditableProduct(client, id),
    saveProduct: async (id, version, fields, sizes, images) => {
      const { data, error } = await supabase.rpc("admin_save_product", { p_product_id: id, p_expected_version: version, p_fields: fields, p_sizes: sizes, p_images: images });
      return { data, error };
    },
    publish: async (id, version) => {
      const { data, error } = await supabase.rpc("admin_set_publication_status", { p_product_id: id, p_expected_version: version, p_status: "published" });
      return { data, error };
    },
  };

  try {
    if (command === "raise") {
      if (!state) {
        const progress = JSON.parse(await readFile(IMPORT_PROGRESS, "utf8")) as Progress;
        const ids = Object.values(progress.folders).filter((f) => f.done && f.productId).map((f) => f.productId!);
        // The planner's percentages: saved now for any shoe that has none yet (the same as "Save assignments").
        let overview = await backend.overview();
        const unsaved = buildPreview(overview, karachiToday()).toSave;
        if (unsaved.length) {
          const r = await rpc<{ assigned: number; refreshed: number }>("admin_save_promotion_assignments", { p_items: unsaved });
          console.log(`Promotion planner: ${r.assigned} percentage(s) saved, ${r.refreshed} proposal(s) refreshed.`);
          overview = await backend.overview();
        }
        const { shoes, problems } = planRaise(ids, overview.items);
        if (problems.length) throw new ImportStopped(`Nothing was changed:\n  - ${problems.join("\n  - ")}`);
        state = { project, minDays: MIN_DAYS, createdAt: new Date().toISOString(), shoes };
      }
      const list = Object.values(state.shoes);
      console.log(`Phase 1 for ${list.length} kids' shoes:`);
      for (const bp of [2000, 2500, 3000, 3500]) {
        const group = list.filter((s) => s.discountBp === bp);
        if (group.length) console.log(`  ${bp / 100}% sale later: ${group.length} shoe(s)`);
      }
      console.log("\n  e.g.");
      for (const s of list.slice(0, 6)) {
        console.log(`    ${s.itemCode} ${s.name}: now ${rs(s.sellingPaisa)} → regular ${rs(s.regularPaisa)}; on sale later at ${rs(s.sellingPaisa)} (${shopPercent(s.regularPaisa, s.sellingPaisa)}% off)`);
      }
      console.log(`\nThis switches them to manual pricing, raises their prices, PUBLISHES them, and sets a ${state.minDays}-day minimum`);
      console.log(`before a price can be shown as "was". Customers pay the raised prices for at least ${state.minDays} days.`);
      if ((await ask('\nType "yes" to do it: ')).toLowerCase() !== "yes") {
        console.log("Not done. Nothing changed.");
        return;
      }
      await save(state);
      await runRaise(state, backend, save, console.log);
      const ready = new Date(Date.now() + state.minDays * 86_400_000).toISOString().slice(0, 10);
      console.log(`\nPhase 1 done. Run "start-sale" on or after ${ready} (Pakistan time; each shoe is checked against its own history).`);
    } else {
      const result = await runSale(state!, backend, save, console.log);
      console.log(`\nOn sale now: ${result.started.length}; already on sale: ${result.already}.`);
      if (result.waiting.length) {
        console.log(`Not yet ${state!.minDays} days at the raised price (${result.waiting.length}):`);
        for (const w of result.waiting) console.log(`  ${w.itemCode}: from ${w.from}`);
      }
      if (result.refused.length) {
        console.log(`Not put on sale (${result.refused.length}):`);
        for (const r of result.refused) console.log(`  ${r.itemCode}: ${r.reason}`);
      }
    }
  } finally {
    await supabase.auth.signOut();
  }
}

main().catch((error) => {
  console.error(error instanceof ImportStopped ? `\nStopped: ${error.message}` : error);
  process.exitCode = 1;
});
