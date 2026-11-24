import { randomUUID } from "node:crypto";
import { scorePrice } from "@/lib/pricing/rules";
import { ImportStopped } from "./session";
import { GROUP_MAX_PAISA, GROUP_NAME, MIN_SCORE, sizeScore } from "./size-score";

/*
 * Prices the imported kids' shoes by size (size-score.ts) through the
 * Pricing page's own database functions: the "Kids Sneakers" group (created
 * if it doesn't exist), then one preview of every shoe as automatic pricing
 * with its size's score, then (after you confirm) one apply with that
 * preview's token. If anything changed in between, nothing is applied.
 * Products stay drafts: publishing is a separate step.
 */

export type PricingBackend = {
  groups(): Promise<{ id: string; name: string; max_price_paisa: number }[]>;
  createGroup(requestId: string, name: string, maxPaisa: number): Promise<{ result: string; id?: string }>;
  /** The product's sizes, or null if it no longer exists. */
  product(id: string): Promise<{ itemCode: string; name: string; sizes: number[] } | null>;
  preview(items: unknown[]): Promise<Plan>;
  apply(requestId: string, items: unknown[], token: string): Promise<{ result: string; applied?: number; skipped?: unknown[] }>;
};

export type PlanLine = {
  product_id: string;
  item_code?: string;
  action: "apply" | "skip" | "unchanged";
  reason?: string | null;
  to?: { price_paisa?: number | null; score?: number | null } | null;
};
export type Plan = { lines: PlanLine[]; token: string };

export type Row = { productId: string; itemCode: string; name: string; size: number; score: number; pricePaisa: number | null; action: string };

/** The lowest regular price the rules give (score 45 with the price ending), for a last check on the preview. */
export const FLOOR_PAISA = (() => {
  const r = scorePrice(GROUP_MAX_PAISA, MIN_SCORE, 95);
  return r.status === "ok" ? r.pricePaisa : GROUP_MAX_PAISA * 0.45;
})();

export async function findOrCreateGroup(b: PricingBackend, log: (s: string) => void): Promise<string> {
  const existing = (await b.groups()).find((g) => g.name.toLowerCase() === GROUP_NAME.toLowerCase());
  if (existing) {
    if (existing.max_price_paisa !== GROUP_MAX_PAISA) {
      throw new ImportStopped(`The group "${existing.name}" already exists with a maximum of Rs. ${existing.max_price_paisa / 100}, not Rs. ${GROUP_MAX_PAISA / 100}. Change it on the Pricing page, or tell me which to use.`);
    }
    log(`Group "${existing.name}" (max Rs. ${GROUP_MAX_PAISA / 100}) already exists.`);
    return existing.id;
  }
  const created = await b.createGroup(randomUUID(), GROUP_NAME, GROUP_MAX_PAISA);
  if (created.result === "created" && created.id) {
    log(`Created the group "${GROUP_NAME}" (max Rs. ${GROUP_MAX_PAISA / 100}).`);
    return created.id;
  }
  const again = (await b.groups()).find((g) => g.name.toLowerCase() === GROUP_NAME.toLowerCase());
  if (!again) throw new ImportStopped(`Couldn't create the group "${GROUP_NAME}" (${created.result}).`);
  return again.id;
}

/** Previews every shoe; returns the plan rows, the items and the token, or stops if any shoe would be skipped. */
export async function previewPricing(productIds: string[], groupId: string, b: PricingBackend) {
  const rows: Row[] = [];
  const problems: string[] = [];
  for (const id of productIds) {
    const p = await b.product(id);
    if (!p) {
      problems.push(`Product ${id} no longer exists (deleted?).`);
      continue;
    }
    if (p.sizes.length !== 1) {
      problems.push(`${p.itemCode} ${p.name} has ${p.sizes.length} sizes; size-based pricing needs exactly one.`);
      continue;
    }
    rows.push({ productId: id, itemCode: p.itemCode, name: p.name, size: p.sizes[0], score: sizeScore(p.sizes[0]), pricePaisa: null, action: "" });
  }
  if (problems.length) throw new ImportStopped(`Nothing was priced:\n  - ${problems.join("\n  - ")}`);

  const items = rows.map((r) => ({ product_id: r.productId, mode: "auto", group_id: groupId, score: r.score }));
  const plan = await b.preview(items);
  const byId = new Map(plan.lines.map((l) => [l.product_id, l]));
  for (const r of rows) {
    const line = byId.get(r.productId);
    if (!line) problems.push(`${r.itemCode}: missing from the preview.`);
    else if (line.action === "skip") problems.push(`${r.itemCode} ${r.name}: would be skipped (${line.reason ?? "no reason given"}).`);
    else {
      r.action = line.action;
      r.pricePaisa = line.to?.price_paisa ?? null;
      if (line.action === "apply" && (r.pricePaisa === null || r.pricePaisa < FLOOR_PAISA)) {
        problems.push(`${r.itemCode}: preview price ${r.pricePaisa} is below the floor.`);
      }
    }
  }
  if (problems.length) throw new ImportStopped(`Nothing was priced:\n  - ${problems.join("\n  - ")}`);
  return { rows, items, token: plan.token };
}

/** One line per size: how many shoes, their score and price. */
export function summary(rows: Row[]): string[] {
  const bySize = new Map<number, Row[]>();
  for (const r of rows) bySize.set(r.size, [...(bySize.get(r.size) ?? []), r]);
  return [...bySize.entries()]
    .sort(([a], [b]) => a - b)
    .map(([size, list]) => {
      const prices = [...new Set(list.map((r) => r.pricePaisa))].map((p) => (p === null ? "?" : `Rs. ${(p / 100).toLocaleString("en-PK")}`));
      return `  EU ${String(size).padEnd(4)}  ${String(list.length).padStart(3)} shoe(s)  score ${list[0].score}  →  ${prices.join(", ")}`;
    });
}

export async function applyPricing(b: PricingBackend, items: unknown[], token: string) {
  const answer = await b.apply(randomUUID(), items, token);
  if (answer.result === "stale") throw new ImportStopped("Something changed since the preview (a price, a product or a setting), so nothing was applied. Run it again.");
  if (answer.result !== "applied") throw new ImportStopped(`Unexpected answer: ${answer.result}`);
  return answer.applied ?? 0;
}
