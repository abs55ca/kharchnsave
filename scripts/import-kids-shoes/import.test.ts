import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DbResult } from "@/lib/db/retry";
import { runImport, type Backend, type PlannedProduct, type Progress } from "./import";
import { ImportStopped } from "./session";

/*
 * The import's resume and retry rules, with a fake Supabase (no network):
 *   npx vitest run --config scripts/import-kids-shoes/vitest.config.mts
 */

type Row = { id: string; slug: string; name: string; version: number; photos: string[] };

function fakeBackend() {
  const rows = new Map<string, Row>();
  const stored = new Set<string>();
  const registered = new Map<string, string>(); // image id -> product id
  const faults: { createLost?: number; addLost?: number; addRefused?: number } = {};
  const calls = { create: 0, add: 0, upload: 0 };
  const backend: Backend = {
    async findBySlug(slug) {
      return [...rows.values()].find((r) => r.slug === slug)?.id ?? null;
    },
    async create(fields) {
      calls.create++;
      if ([...rows.values()].some((r) => r.slug === fields.slug)) return { data: null, error: { code: "23505", message: "duplicate slug" } };
      const id = randomUUID();
      rows.set(id, { id, slug: fields.slug, name: fields.name, version: 1, photos: [] });
      if (faults.createLost && faults.createLost-- > 0) return { data: null, error: { message: "fetch failed" } };
      return { data: { id }, error: null };
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { version: r.version, slug: r.slug, name: r.name, photoIds: [...r.photos] } : null;
    },
    async prepare() {
      return { data: Buffer.from("webp"), width: 800, height: 800 };
    },
    async upload(path) {
      calls.upload++;
      stored.add(path);
      return { ok: true };
    },
    async addImage(a): Promise<DbResult<number>> {
      calls.add++;
      const r = rows.get(a.productId)!;
      if (faults.addRefused && faults.addRefused-- > 0) return { data: null, error: { code: "PT400", hint: "bad_photo", message: "refused" } };
      if (!registered.has(a.imageId)) {
        if (a.version !== r.version) return { data: null, error: { code: "PT409", message: "version_conflict" } };
        registered.set(a.imageId, a.productId);
        r.photos.push(a.imageId);
        r.version++;
      }
      // Applied (or a replay of an applied one), but the answer may be lost on the way back.
      if (faults.addLost && faults.addLost-- > 0) return { data: null, error: { message: "fetch failed" } };
      return { data: r.version, error: null };
    },
    async removeUpload(path) {
      stored.delete(path);
    },
    newId: randomUUID,
  };
  return { backend, rows, stored, faults, calls };
}

const product = (folder: number, photos = 3): PlannedProduct => ({
  folder,
  dir: `/shoes/Folder ${folder}`,
  fields: {
    item_code: null, auto_item_code: true, slug: `shoe-${folder}`, name: `Shoe ${folder} — Pink`, brand: "Unbranded", department: "kids",
    styles: ["sneakers"], item_status: "new", condition: "new", condition_notes: [], colour: "Pink", description: "Test", price_paisa: 0,
    sale_price_paisa: null, label_name: null, light_up: null, light_up_condition: null, light_up_activation: null,
  },
  sizes: [{ size: 30, stock: 1 }],
  photos: Array.from({ length: photos }, (_, i) => `p${i + 1}.jpg`),
});

const start = (): Progress => ({ project: "test.supabase.co", folders: {} });
const quiet = () => {};
/** Saves a deep copy, like the JSON file would. */
const saver = (into: { last?: Progress }) => async (p: Progress) => {
  into.last = JSON.parse(JSON.stringify(p));
};

describe("runImport", () => {
  it("creates each draft and records its photos in order", async () => {
    const f = fakeBackend();
    const progress = start();
    const totals = await runImport([product(1), product(2, 5)], f.backend, progress, saver({}), quiet);
    expect(totals).toEqual({ created: 2, found: 0, photos: 8, finished: 2 });
    const one = f.rows.get(progress.folders[1].productId!)!;
    expect(one.photos).toEqual(["p1.jpg", "p2.jpg", "p3.jpg"].map((file) => progress.folders[1].photos[file]));
    expect(progress.folders[2].done).toBe(true);
  });

  it("a rerun after everything finished changes nothing", async () => {
    const f = fakeBackend();
    const progress = start();
    await runImport([product(1)], f.backend, progress, saver({}), quiet);
    const before = { ...f.calls };
    const totals = await runImport([product(1)], f.backend, progress, saver({}), quiet);
    expect(totals.finished).toBe(1);
    expect(f.calls).toEqual(before);
  });

  it("a lost answer to the create: the draft is found by its web address, not created twice", async () => {
    const f = fakeBackend();
    f.faults.createLost = 1;
    const progress = start();
    const totals = await runImport([product(1)], f.backend, progress, saver({}), quiet);
    expect(totals).toMatchObject({ created: 0, found: 1, finished: 1 });
    expect(f.rows.size).toBe(1);
  });

  it("a lost answer to a photo stops the run; the rerun recognises it and records the rest once", async () => {
    const f = fakeBackend();
    f.faults.addLost = 1;
    const saved: { last?: Progress } = {};
    // registerPhoto retries an unanswered call: the replay is answered, so this run goes on.
    await runImport([product(1)], f.backend, start(), saver(saved), quiet);
    const row = [...f.rows.values()][0];
    expect(row.photos).toHaveLength(3);
    expect(new Set(row.photos).size).toBe(3);

    // Now the answer stays lost for longer than the retry budget: stop, then resume from the saved file.
    const g = fakeBackend();
    g.faults.addLost = 99;
    const saved2: { last?: Progress } = {};
    await expect(runImport([product(1)], g.backend, start(), saver(saved2), quiet)).rejects.toBeInstanceOf(ImportStopped);
    g.faults.addLost = 0;
    const resumed = saved2.last!;
    await runImport([product(1)], g.backend, resumed, saver({}), quiet);
    const row2 = [...g.rows.values()][0];
    expect(row2.photos).toHaveLength(3);
    expect(row2.photos).toEqual(["p1.jpg", "p2.jpg", "p3.jpg"].map((file) => resumed.folders[1].photos[file]));
    expect(g.rows.size).toBe(1);
  }, 20_000);

  it("a crash between steps: the saved progress continues with the next photo", async () => {
    const f = fakeBackend();
    const saved: { last?: Progress } = {};
    let saves = 0;
    const crashing = async (p: Progress) => {
      await saver(saved)(p);
      if (++saves === 3) throw new Error("power cut");
    };
    await expect(runImport([product(1, 4)], f.backend, start(), crashing, quiet)).rejects.toThrow("power cut");
    await runImport([product(1, 4)], f.backend, saved.last!, saver({}), quiet);
    const row = [...f.rows.values()][0];
    expect(row.photos).toHaveLength(4);
    expect(new Set(row.photos).size).toBe(4);
  });

  it("a refused photo removes its upload, forgets its id and stops", async () => {
    const f = fakeBackend();
    f.faults.addRefused = 1;
    const saved: { last?: Progress } = {};
    await expect(runImport([product(1)], f.backend, start(), saver(saved), quiet)).rejects.toThrow(/was refused/);
    expect(f.stored.size).toBe(0);
    expect(saved.last!.folders[1].photos).toEqual({});
    await runImport([product(1)], f.backend, saved.last!, saver({}), quiet);
    expect([...f.rows.values()][0].photos).toHaveLength(3);
  });

  it("stops instead of adopting a different product with the same web address, or a deleted one", async () => {
    const f = fakeBackend();
    f.rows.set("other", { id: "other", slug: "shoe-1", name: "Someone else's shoe", version: 1, photos: [] });
    await expect(runImport([product(1)], f.backend, start(), saver({}), quiet)).rejects.toThrow(/not this shoe/);
    expect(f.calls.add).toBe(0);

    const g = fakeBackend();
    const progress = start();
    await runImport([product(1)], g.backend, progress, saver({}), quiet);
    g.rows.clear();
    progress.folders[1].done = false;
    await expect(runImport([product(1)], g.backend, progress, saver({}), quiet)).rejects.toThrow(/no longer exists/);
  });
});
