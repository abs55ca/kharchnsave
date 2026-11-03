import type { SizeValue } from "./product-input";

/*
 * The product edit page renders the server's copy of a product again after
 * order actions, when the admin returns to the tab (RefreshOnReturn) and when
 * Next.js shows the page again. The editor's own state is only initialised
 * from that copy, so it decides here what to do with a newer one.
 */

/** What a copy of a product is versioned by: the product's version and each size's inventory version. */
export function productFingerprint(version: number, sizes: Pick<SizeValue, "size" | "sku" | "inventoryVersion">[]) {
  return JSON.stringify([version, sizes.map((s) => [s.sku ?? s.size, s.inventoryVersion ?? null])]);
}

/**
 * - "in-sync": the server's copy is what the editor is already based on
 *   (for example, right after its own save or photo upload).
 * - "adopt": no unsaved changes, so show the newer copy.
 * - "hold": unsaved changes (or a save in flight). Keep them, and keep the
 *   version and stock they were based on, so saving is refused rather than
 *   overwriting the newer copy; offer the newer copy instead.
 */
export type ServerCopyAction = "in-sync" | "adopt" | "hold";

export function onServerCopy({ server, baseline, dirty, saving }: { server: string; baseline: string; dirty: boolean; saving: boolean }): ServerCopyAction {
  if (server === baseline) return "in-sync";
  return dirty || saving ? "hold" : "adopt";
}
