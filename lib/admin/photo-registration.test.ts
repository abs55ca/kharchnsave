import { describe, expect, it } from "vitest";
import { isDatabaseAnswer, recordUploadedPhoto } from "./photo-registration";

/*
 * A fake database that behaves like admin_add_product_image after
 * 20261117120300_idempotent_photo_registration.sql (keyed by image id,
 * version-checked for new images), and a fake Storage bucket. The real
 * function's concurrency (a retry waiting for a call in flight) is tested on
 * PostgreSQL in db-tests/hardening.test.ts.
 */
function setup(version = 3) {
  // photos: id -> the original request and the version it produced (private.photo_registrations).
  const db = { version, photos: new Map<string, { expected: number; path: string; width: number; result: number }>() };
  const storage = new Set<string>(["p/img-1.webp"]);
  const register = (id: string, expected: number, path: string, width = 1500) => {
    const existing = db.photos.get(id);
    if (existing) {
      return existing.expected === expected && existing.path === path && existing.width === width
        ? { data: existing.result, error: null }
        : { data: null, error: { code: "PT409", hint: "image_conflict", message: "conflict" } };
    }
    if (expected !== db.version) return { data: null, error: { code: "PT409", hint: "version_conflict", message: "conflict" } };
    db.version++;
    db.photos.set(id, { expected, path, width, result: db.version });
    return { data: db.version, error: null };
  };
  const remove = async () => {
    storage.delete("p/img-1.webp");
  };
  return { db, storage, register, remove };
}

const noWait = { sleep: async () => {}, now: () => 0 };
const networkError = { data: null, error: { code: "", message: "TypeError: fetch failed" } };

describe("recording an uploaded photo", () => {
  it("records it on the first try", async () => {
    const { db, storage, register, remove } = setup();
    const outcome = await recordUploadedPhoto(async () => register("img-1", 3, "p/img-1.webp"), remove, noWait);
    expect(outcome).toEqual({ kind: "recorded", version: 4, attempts: 1 });
    expect(db.photos.size).toBe(1);
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("the answer is lost after the commit: the retry (same, now stale, version) gets the same result; one photo, file kept", async () => {
    const { db, storage, register, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      const result = register("img-1", 3, "p/img-1.webp");
      return calls === 1 ? networkError : result; // committed, but the response never arrived
    }, remove, noWait);
    expect(outcome).toEqual({ kind: "recorded", version: 4, attempts: 2 });
    expect(db.photos.size).toBe(1);
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("someone else saves between the lost answer and the retry: the retry reports the version the upload produced, not theirs", async () => {
    const { db, register, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      const result = register("img-1", 3, "p/img-1.webp");
      if (calls === 1) {
        db.version++; // another admin's save: version 5
        return networkError;
      }
      return result;
    }, remove, noWait);
    // 4, not 5: the editor's next save (with 4) is refused as a conflict instead of overwriting version 5.
    expect(outcome).toEqual({ kind: "recorded", version: 4, attempts: 2 });
  });

  it("a gateway error without a database code is treated as no answer, then settled by the retry", async () => {
    const { storage, register, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      const result = register("img-1", 3, "p/img-1.webp");
      return calls === 1 ? { data: null, error: { code: "", message: "upstream request timeout" } } : result;
    }, remove, noWait);
    expect(outcome.kind).toBe("recorded");
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("refused by the database (someone else saved first): nothing recorded, the file is removed", async () => {
    const { db, storage, register, remove } = setup();
    const outcome = await recordUploadedPhoto(async () => register("img-1", 2, "p/img-1.webp"), remove, noWait);
    expect(outcome).toMatchObject({ kind: "refused", error: { code: "PT409", hint: "version_conflict" }, attempts: 1 });
    expect(db.photos.size).toBe(0);
    expect(storage.has("p/img-1.webp")).toBe(false);
  });

  it("the same image id with different data is refused, and the earlier photo's row is untouched", async () => {
    const { db, register, remove } = setup();
    register("img-1", 3, "p/img-1.webp");
    const outcome = await recordUploadedPhoto(async () => register("img-1", 4, "p/img-1.webp", 1200), remove, noWait);
    expect(outcome).toMatchObject({ kind: "refused", error: { hint: "image_conflict" } });
    expect(db.photos.get("img-1")).toEqual({ expected: 3, path: "p/img-1.webp", width: 1500, result: 4 });
  });

  it("rolled back by a lock timeout every time: refused (nothing was recorded), the file is removed", async () => {
    const { storage, remove } = setup();
    const outcome = await recordUploadedPhoto(async () => ({ data: null, error: { code: "55P03", message: "lock timeout" } }), remove, noWait);
    expect(outcome.kind).toBe("refused");
    expect(outcome.attempts).toBe(5);
    expect(storage.has("p/img-1.webp")).toBe(false);
  });

  it("no answer at all: unknown, the file is KEPT (the photo may be recorded)", async () => {
    const { storage, remove } = setup();
    const outcome = await recordUploadedPhoto(async () => networkError, remove, noWait);
    expect(outcome).toMatchObject({ kind: "unknown", attempts: 5 });
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("no answer, then lock timeouts: still unknown (the first call may have committed)", async () => {
    const { storage, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      return calls === 1 ? networkError : { data: null, error: { code: "55P03", message: "lock timeout" } };
    }, remove, noWait);
    expect(outcome.kind).toBe("unknown");
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("no answer, then an access refusal (session expired): unknown, the file is KEPT", async () => {
    const { storage, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      return calls === 1 ? networkError : { data: null, error: { code: "42501", message: "Only verified admins can manage products." } };
    }, remove, noWait);
    expect(outcome).toMatchObject({ kind: "unknown", attempts: 2 });
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("an access refusal on the first try is a refusal (nothing reached the photo table)", async () => {
    const { storage, remove } = setup();
    const outcome = await recordUploadedPhoto(async () => ({ data: null, error: { code: "42501", message: "denied" } }), remove, noWait);
    expect(outcome.kind).toBe("refused");
    expect(storage.has("p/img-1.webp")).toBe(false);
  });

  it("no answer, then a version conflict (someone else saved, the first never arrived): refused, the file is removed", async () => {
    const { db, storage, register, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      if (calls === 1) {
        db.version++; // another admin's save lands; our first call never reached the database
        return networkError;
      }
      return register("img-1", 3, "p/img-1.webp");
    }, remove, noWait);
    expect(outcome).toMatchObject({ kind: "refused", error: { hint: "version_conflict" } });
    expect(db.photos.size).toBe(0);
    expect(storage.has("p/img-1.webp")).toBe(false);
  });

  it("a thrown error counts as no answer", async () => {
    const { storage, register, remove } = setup();
    let calls = 0;
    const outcome = await recordUploadedPhoto(async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return register("img-1", 3, "p/img-1.webp");
    }, remove, noWait);
    expect(outcome.kind).toBe("recorded");
    expect(storage.has("p/img-1.webp")).toBe(true);
  });

  it("stops retrying when the time budget is spent", async () => {
    let clock = 0;
    const outcome = await recordUploadedPhoto(async () => networkError, async () => {}, {
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      budgetMs: 1000,
    });
    expect(outcome).toMatchObject({ kind: "unknown", attempts: 3 });
  });
});

describe("isDatabaseAnswer", () => {
  it("SQLSTATEs and PostgREST codes are answers; empty codes are not", () => {
    expect(["PT409", "42501", "23505", "55P03", "PGRST202"].map((code) => isDatabaseAnswer({ code }))).toEqual([true, true, true, true, true]);
    expect([{ code: "" }, { message: "fetch failed" }, null].map((e) => isDatabaseAnswer(e))).toEqual([false, false, false]);
  });
});
