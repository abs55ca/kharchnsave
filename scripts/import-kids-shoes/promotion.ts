import { randomUUID } from "node:crypto";
import { paisaToRupeesText, validateProduct, type ProductFields, type SizeRow } from "@/lib/admin/product-input";
import type { EditableProduct } from "@/lib/admin/products";
import type { OverviewItem, PromotionOverview } from "@/lib/admin/promotions";
import { discountPercent } from "@/lib/catalog/pricing";
import type { DbResult } from "@/lib/db/retry";
import { ImportStopped } from "./session";

/*
 * A genuine two-phase promotion for the imported kids' shoes, using the
 * promotion planner's saved percentages (seeded random, 20-35% per model):
 *
 *   Phase 1, "raise": each shoe's regular price becomes its current selling
 *   price ÷ (1 − its percentage), rounded UP to the whole rupee; the shoe is
 *   switched to manual pricing (its score and group stay recorded) and
 *   published. The shop sells it at that price. Pricing settings get a minimum
 *   of MIN_DAYS before a price can count as a "was" price.
 *
 *   Phase 2, "start-sale" (only after MIN_DAYS at that price, published, with
 *   no sale): the sale price is set back to the original selling price. The
 *   database itself decides the crossed-out "was" price from the price history
 *   (private.products_pricing_guard / reference_candidate); if it doesn't
 *   accept one, that shoe's sale is undone and reported.
 *
 * Rounding the regular price up to whole rupees keeps the true discount at or
 * just above the assigned percentage, so the shop's rounded-down "Save X%" is
 * exactly the assigned percentage (checked for every shoe before anything changes).
 */

export const MIN_DAYS = 28;

export type ShoeState = {
  itemCode: string;
  name: string;
  /** The selling price before phase 1: what the sale goes back to. */
  sellingPaisa: number;
  discountBp: number;
  /** The raised regular price. */
  regularPaisa: number;
  raisedAt?: string;
  publishedAt?: string;
  saleStartedAt?: string;
  referencePaisa?: number;
  /** Phase 2 refused (e.g. the price changed since phase 1). */
  problem?: string;
};

export type PromotionState = { project: string; minDays: number; createdAt: string; shoes: Record<string, ShoeState> };

export type Pricing = {
  mode: "manual" | "auto";
  group_id: string | null;
  score: number | null;
  price_paisa: number;
  sale_price_paisa: number | null;
  reference_price_paisa: number | null;
  publication_status: string;
  campaign: unknown | null;
  history: { regular_price_paisa: number; sale_price_paisa: number | null; publication_status: string; created_at: string }[];
};

export type PromotionBackend = {
  overview(): Promise<PromotionOverview>;
  settings(): Promise<Record<string, unknown> & { version: number; reference_min_days: number | null }>;
  saveSettings(version: number, requestId: string, settings: Record<string, unknown>): Promise<void>;
  pricing(id: string): Promise<Pricing | null>;
  pricingPreview(items: unknown[]): Promise<{ token: string; lines: { product_id: string; action: string; reason?: string | null }[] }>;
  pricingApply(requestId: string, items: unknown[], token: string): Promise<{ result: string }>;
  product(id: string): Promise<EditableProduct | null>;
  saveProduct(id: string, version: number, fields: ProductFields, sizes: SizeRow[], images: { id: string; alt: string; shows_defect: boolean }[]): Promise<DbResult<unknown>>;
  publish(id: string, version: number): Promise<DbResult<unknown>>;
};

/** selling ÷ (1 − bp/10000), rounded up to the whole rupee, in paisa. */
export function raisedRegular(sellingPaisa: number, discountBp: number): number {
  const d = 10000 - discountBp;
  // ceil(selling × 100 / d) rupees, exactly, in integers.
  const rupees = Math.floor((sellingPaisa * 100 + d - 1) / d);
  return rupees * 100;
}

/** What the shop will show as "Save X%" (its own rule: whole percent, rounded down). */
export const shopPercent = (regularPaisa: number, salePaisa: number) => discountPercent(regularPaisa / 100, salePaisa / 100);

/** Phase 1's plan: the shoes, their percentages and raised prices. Stops if any shoe can't take part. */
export function planRaise(ids: string[], items: OverviewItem[]): { shoes: Record<string, ShoeState>; problems: string[] } {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const shoes: Record<string, ShoeState> = {};
  const problems: string[] = [];
  for (const id of ids) {
    const i = byId.get(id);
    if (!i) {
      problems.push(`${id}: not in the planner (deleted, archived or unpriced?)`);
      continue;
    }
    if (!i.assignment) {
      problems.push(`${i.item_code}: no saved percentage in the promotion planner`);
      continue;
    }
    if (i.sale_price_paisa !== null) {
      problems.push(`${i.item_code}: already has a sale price`);
      continue;
    }
    const regular = raisedRegular(i.selling_price_paisa, i.assignment.discount_bp);
    const shown = shopPercent(regular, i.selling_price_paisa);
    if (shown !== i.assignment.discount_bp / 100) {
      problems.push(`${i.item_code}: the shop would show ${shown}% instead of ${i.assignment.discount_bp / 100}%`);
      continue;
    }
    shoes[id] = { itemCode: i.item_code, name: i.name, sellingPaisa: i.selling_price_paisa, discountBp: i.assignment.discount_bp, regularPaisa: regular };
  }
  return { shoes, problems };
}

const describe = (e: { code?: string; hint?: string | null; message?: string } | null) => [e?.code, e?.hint, e?.message].filter(Boolean).join(" ");

/** Saves a product with a new regular and/or sale price, everything else as it is (same checks as the product form). */
async function savePrices(b: PromotionBackend, id: string, regularPaisa: number, salePaisa: number | null) {
  const p = await b.product(id);
  if (!p) throw new ImportStopped(`Product ${id} no longer exists.`);
  const values = { ...p.values, price: paisaToRupeesText(regularPaisa), salePrice: salePaisa === null ? "" : paisaToRupeesText(salePaisa) };
  const checked = validateProduct(values, { savedLabelName: p.values.labelName, savedItemCode: p.values.itemCode });
  if (!checked.ok) throw new ImportStopped(`${p.values.itemCode}: ${Object.values(checked.errors).join("; ")}`);
  const images = p.photos.map((photo) => ({ id: photo.id, alt: photo.alt, shows_defect: photo.showsDefect }));
  const saved = await b.saveProduct(id, p.version, checked.fields, checked.sizes, images);
  if (saved.error) throw new ImportStopped(`${p.values.itemCode}: couldn't save the price (${describe(saved.error)}). Run it again to continue.`);
}

/** Phase 1. Resumable: each step is saved in the state file and skipped next time. */
export async function runRaise(state: PromotionState, b: PromotionBackend, save: (s: PromotionState) => Promise<void>, log: (s: string) => void, now = () => new Date().toISOString()) {
  const ids = Object.keys(state.shoes);

  // The minimum period before a price can be a "was" price.
  const settings = await b.settings();
  if (settings.reference_min_days === null || settings.reference_min_days < state.minDays) {
    const { version, updated_at: _updatedAt, ...rest } = settings;
    void _updatedAt;
    await b.saveSettings(version, randomUUID(), { ...rest, reference_min_days: state.minDays });
    log(`Pricing settings: a price must be offered for ${state.minDays} days before it can be a "was" price.`);
  }

  // Manual pricing, so the regular price can change (score and group stay recorded).
  const auto: { product_id: string; mode: string; group_id: string | null; score: number | null }[] = [];
  for (const id of ids) {
    const pr = await b.pricing(id);
    if (!pr) throw new ImportStopped(`${state.shoes[id].itemCode}: no longer exists.`);
    if (pr.campaign) throw new ImportStopped(`${state.shoes[id].itemCode} is in a running sale campaign; end it first.`);
    if (pr.mode === "auto") auto.push({ product_id: id, mode: "manual", group_id: pr.group_id, score: pr.score });
  }
  if (auto.length) {
    const preview = await b.pricingPreview(auto);
    const skipped = preview.lines.filter((l) => l.action === "skip");
    if (skipped.length) throw new ImportStopped(`Switching to manual pricing would skip ${skipped.length} shoe(s): ${skipped.map((l) => l.reason).join(", ")}`);
    const applied = await b.pricingApply(randomUUID(), auto, preview.token);
    if (applied.result !== "applied") throw new ImportStopped(`Switching to manual pricing: ${applied.result}. Nothing else was changed; run it again.`);
    log(`${auto.length} shoe(s) switched to manual pricing (their scores stay recorded).`);
  }

  for (const [n, id] of ids.entries()) {
    const shoe = state.shoes[id];
    const label = `[${n + 1}/${ids.length}] ${shoe.itemCode} ${shoe.name}`;
    let p = await b.product(id);
    if (!p) throw new ImportStopped(`${label}: no longer exists.`);
    const current = Math.round(Number(p.values.price.replace(/,/g, "")) * 100);
    if (current !== shoe.regularPaisa) {
      if (current !== shoe.sellingPaisa) throw new ImportStopped(`${label}: its price is now ${current / 100}, neither the original ${shoe.sellingPaisa / 100} nor the raised ${shoe.regularPaisa / 100}. Stopping.`);
      await savePrices(b, id, shoe.regularPaisa, null);
      shoe.raisedAt = now();
      await save(state);
      p = (await b.product(id))!;
    }
    if (p.status !== "published") {
      const published = await b.publish(id, p.version);
      if (published.error) throw new ImportStopped(`${label}: couldn't publish (${describe(published.error)}). Run it again to continue.`);
      shoe.publishedAt = now();
      await save(state);
    }
    log(`${label}: Rs. ${(shoe.regularPaisa / 100).toLocaleString("en-PK")}, published`);
  }
}

/** When the current run of being published at the raised price with no sale began (from the price history), or null. */
export function offeredSince(pr: Pricing, regularPaisa: number): Date | null {
  const rows = [...pr.history].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let since: Date | null = null;
  for (const h of rows) {
    const matches = h.publication_status === "published" && h.sale_price_paisa === null && h.regular_price_paisa === regularPaisa;
    since = matches ? (since ?? new Date(h.created_at)) : null;
  }
  return since;
}

export type SaleResult = { started: string[]; waiting: { itemCode: string; from: string }[]; refused: { itemCode: string; reason: string }[]; already: number };

/** Phase 2. Starts the sale on every shoe that qualifies; the rest are reported (with the date they qualify). */
export async function runSale(state: PromotionState, b: PromotionBackend, save: (s: PromotionState) => Promise<void>, log: (s: string) => void, now = () => new Date()) {
  const out: SaleResult = { started: [], waiting: [], refused: [], already: 0 };
  for (const [id, shoe] of Object.entries(state.shoes)) {
    if (shoe.saleStartedAt) {
      out.already++;
      continue;
    }
    const pr = await b.pricing(id);
    if (!pr) {
      out.refused.push({ itemCode: shoe.itemCode, reason: "no longer exists" });
      continue;
    }
    if (pr.price_paisa !== shoe.regularPaisa || pr.sale_price_paisa !== null || pr.publication_status !== "published") {
      out.refused.push({ itemCode: shoe.itemCode, reason: `not published at the raised price with no sale (now ${pr.price_paisa / 100}, sale ${pr.sale_price_paisa ?? "none"}, ${pr.publication_status})` });
      continue;
    }
    const since = offeredSince(pr, shoe.regularPaisa);
    const ready = since ? new Date(since.getTime() + state.minDays * 86_400_000) : null;
    if (!ready || ready > now()) {
      out.waiting.push({ itemCode: shoe.itemCode, from: ready ? ready.toISOString().slice(0, 10) : "unknown" });
      continue;
    }
    await savePrices(b, id, shoe.regularPaisa, shoe.sellingPaisa);
    const after = await b.pricing(id);
    if (after?.reference_price_paisa !== shoe.regularPaisa) {
      // The database didn't accept the "was" price: undo this shoe's sale.
      await savePrices(b, id, shoe.regularPaisa, null);
      out.refused.push({ itemCode: shoe.itemCode, reason: "the database didn't verify the was-price; sale undone" });
      continue;
    }
    shoe.saleStartedAt = now().toISOString();
    shoe.referencePaisa = after.reference_price_paisa;
    await save(state);
    out.started.push(shoe.itemCode);
    log(`${shoe.itemCode}: on sale at Rs. ${(shoe.sellingPaisa / 100).toLocaleString("en-PK")}, was Rs. ${(shoe.regularPaisa / 100).toLocaleString("en-PK")} (${shopPercent(shoe.regularPaisa, shoe.sellingPaisa)}% off)`);
  }
  return out;
}
