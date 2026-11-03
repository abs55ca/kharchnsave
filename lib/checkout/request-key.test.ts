import { describe, expect, it } from "vitest";
import { CHECKOUT_KEY_PATTERN } from "./input";
import { attemptForCart, newCheckoutKey, readAttempt, settleNeeded, turnstileCData, writeAttempt, ATTEMPT_STORAGE_KEY } from "./request-key";
import { cdataFor } from "./turnstile";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe("checkout keys", () => {
  it("are 32 random bytes as 43 base64url characters", () => {
    const key = newCheckoutKey();
    expect(key).toMatch(CHECKOUT_KEY_PATTERN);
    expect(newCheckoutKey()).not.toBe(key);
    expect(newCheckoutKey((b) => b.fill(255))).toBe("_".repeat(42) + "8");
  });

  it("are stored without personal details and read back strictly", () => {
    const storage = memoryStorage();
    const attempt = { key: newCheckoutKey(), cart: "A:1:100", state: "sent" as const, createdAt: 1 };
    writeAttempt(storage, attempt);
    expect(readAttempt(storage)).toEqual(attempt);
    expect(Object.keys(JSON.parse(storage.data.get(ATTEMPT_STORAGE_KEY)!)).sort()).toEqual(["cart", "createdAt", "key", "state"]);
    storage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify({ ...attempt, key: "short" }));
    expect(readAttempt(storage)).toBeNull();
    storage.setItem(ATTEMPT_STORAGE_KEY, "not json");
    expect(readAttempt(storage)).toBeNull();
  });
});

describe("which key to use", () => {
  const make = () => "k".repeat(43);

  it("starts a draft when there is none", () => {
    expect(attemptForCart(null, "A:1:100", 5, make)).toEqual({ key: make(), cart: "A:1:100", state: "draft", createdAt: 5 });
  });

  it("replaces a draft when the cart changes, keeps it otherwise", () => {
    const draft = { key: "d".repeat(43), cart: "A:1:100", state: "draft" as const, createdAt: 1 };
    expect(attemptForCart(draft, "A:1:100", 2, make)).toBe(draft);
    expect(attemptForCart(draft, "A:2:100", 2, make).key).toBe(make());
  });

  it("never replaces a sent key by itself, even for another cart: it must be settled first", () => {
    const sent = { key: "s".repeat(43), cart: "A:1:100", state: "sent" as const, createdAt: 1 };
    expect(attemptForCart(sent, "B:1:100", 2, make)).toBe(sent);
    expect(settleNeeded(sent, "B:1:100")).toBe(true);
    expect(settleNeeded(sent, "A:1:100")).toBe(false);
    expect(settleNeeded({ ...sent, state: "draft" }, "B:1:100")).toBe(false);
  });

  it("the browser's Turnstile cData matches what the server expects", async () => {
    const key = newCheckoutKey();
    expect(await turnstileCData(key)).toBe(cdataFor(key));
    expect(cdataFor(key)).toMatch(/^[0-9a-f]{32}$/);
  });
});
