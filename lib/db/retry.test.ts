import { describe, expect, it } from "vitest";
import { isRetryable, isUncertain, withDbRetry, type DbResult } from "./retry";

const instant = { sleep: async () => {}, random: () => 0.5 };

function sequence<T>(...results: DbResult<T>[]) {
  let calls = 0;
  const run = async () => results[Math.min(calls++, results.length - 1)];
  return { run, calls: () => calls };
}

describe("isRetryable", () => {
  it("retries lock timeouts, deadlocks, serialization failures and network errors", () => {
    for (const code of ["40001", "40P01", "55P03"]) expect(isRetryable({ code })).toBe(true);
    expect(isRetryable({ code: "", message: "TypeError: fetch failed" })).toBe(true);
  });

  it("never retries refusals, conflicts or bad input", () => {
    for (const code of ["42501", "PT400", "PT409", "23505", "23514", "PGRST202"]) expect(isRetryable({ code })).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable({ code: "", message: "Something else" })).toBe(false);
  });

  it("a network error is uncertain (the call may have arrived); a lock timeout is not", () => {
    expect(isUncertain({ message: "fetch failed" })).toBe(true);
    expect(isUncertain({ code: "55P03" })).toBe(false);
  });
});

describe("withDbRetry", () => {
  it("returns the first success without retrying", async () => {
    const s = sequence({ data: 1, error: null });
    const result = await withDbRetry(s.run, instant);
    expect(result).toMatchObject({ data: 1, error: null, attempts: 1 });
  });

  it("retries a lock timeout and then succeeds", async () => {
    const s = sequence<number>({ data: null, error: { code: "55P03" } }, { data: 2, error: null });
    expect(await withDbRetry(s.run, instant)).toMatchObject({ data: 2, attempts: 2 });
  });

  it("gives up after three retries (four attempts)", async () => {
    const s = sequence<number>({ data: null, error: { code: "40P01" } });
    const result = await withDbRetry(s.run, instant);
    expect(result.attempts).toBe(4);
    expect(result.error?.code).toBe("40P01");
    expect(s.calls()).toBe(4);
  });

  it("doesn't retry a refusal", async () => {
    const s = sequence<number>({ data: null, error: { code: "PT409" } }, { data: 1, error: null });
    expect(await withDbRetry(s.run, instant)).toMatchObject({ attempts: 1, error: { code: "PT409" } });
  });

  it("waits about 100, 250 and 600 ms, with jitter", async () => {
    const waits: number[] = [];
    const s = sequence<number>({ data: null, error: { code: "40001" } });
    await withDbRetry(s.run, { sleep: async (ms) => void waits.push(ms), random: () => 0 });
    expect(waits).toEqual([75, 188, 450]);
  });

  it("stops when the time budget would be exceeded", async () => {
    let clock = 0;
    const s = sequence<number>({ data: null, error: { code: "55P03" } });
    const result = await withDbRetry(s.run, {
      ...instant,
      budgetMs: 1000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms + 400),
    });
    expect(result.attempts).toBeLessThan(4);
  });

  it("turns a thrown error into a result", async () => {
    const result = await withDbRetry(async () => {
      throw new Error("fetch failed");
    }, { ...instant, delays: [] });
    expect(result).toMatchObject({ data: null, error: { message: "fetch failed" }, attempts: 1 });
  });
});
