import { describe, expect, it, vi } from "vitest";
import type { DbResult } from "@/lib/db/retry";
import type { AttemptResult, PlaceResult, ResolveResult } from "./server";
import { submitOrder, type SubmitDeps, type SubmitInput } from "./submit";
import type { CustomerOrderView } from "./types";

const KEY = "a".repeat(43);
const ORDER = { order_number: "KO-100001" } as CustomerOrderView;
const ok = <T,>(data: T): DbResult<T> => ({ data, error: null });

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  key: KEY,
  lines: [{ sku: "A-1", quantity: 1, unit_price_paisa: 245000 }],
  deliveryPaisa: 30000,
  totalPaisa: 275000,
  customer: { name: "Ayesha Khan", phone: "0300 1234567", city: "Lahore", address: "House 12, Street 4, Model Town", landmark: "", note: "" },
  turnstileToken: "token",
  ...over,
});

function deps(over: Partial<SubmitDeps> = {}) {
  const d = {
    enabled: true,
    clientBucket: "ip:abc",
    remoteIp: "203.0.113.5",
    resolve: vi.fn(async () => ok<ResolveResult>({ state: "none" })),
    registerAttempt: vi.fn(async () => ok<AttemptResult>({ allowed: true, reason: "ok" })),
    verifyTurnstile: vi.fn(async () => ({ ok: true as const })),
    place: vi.fn(async () => ok<PlaceResult>({ result: "placed", order: ORDER })),
    onPlaced: vi.fn(),
    logError: vi.fn(),
    ...over,
  };
  return d;
}

describe("submitOrder", () => {
  it("places an order after checking the key, the rate limit and Turnstile, in that order", async () => {
    const d = deps();
    expect(await submitOrder(input(), d)).toEqual({ status: "placed", order: ORDER });
    expect(d.resolve).toHaveBeenCalledWith(KEY, expect.objectContaining({ customer: expect.objectContaining({ phone: "+923001234567" }) }));
    expect(d.registerAttempt).toHaveBeenCalledWith("ip:abc");
    expect(d.verifyTurnstile).toHaveBeenCalledWith("token", KEY, "203.0.113.5");
    expect(d.onPlaced).toHaveBeenCalledOnce();
  });

  it("is closed while checkout is disabled", async () => {
    const d = deps({ enabled: false });
    expect(await submitOrder(input(), d)).toEqual({ status: "disabled" });
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed keys, lines and totals before calling anything", async () => {
    for (const bad of [{ key: "short" }, { lines: [] }, { totalPaisa: -1 }, { deliveryPaisa: 1.5 }]) {
      const d = deps();
      expect(await submitOrder(input(bad), d)).toEqual({ status: "bad_request" });
      expect(d.resolve).not.toHaveBeenCalled();
    }
  });

  it("returns field errors for bad details", async () => {
    const result = await submitOrder(input({ customer: { name: "", phone: "1", city: "", address: "" } }), deps());
    expect(result.status).toBe("invalid");
  });

  describe("a key that already placed an order", () => {
    it("same contents (a retry after a lost response): that order, without Turnstile or a new attempt", async () => {
      const d = deps({ resolve: vi.fn(async () => ok<ResolveResult>({ state: "placed", matches: true, order: ORDER })) });
      expect(await submitOrder(input({ turnstileToken: "" }), d)).toEqual({ status: "placed", order: ORDER });
      expect(d.registerAttempt).not.toHaveBeenCalled();
      expect(d.verifyTurnstile).not.toHaveBeenCalled();
      expect(d.place).not.toHaveBeenCalled();
      expect(d.onPlaced).not.toHaveBeenCalled();
    });

    it("different contents: refused, never accepted", async () => {
      const d = deps({ resolve: vi.fn(async () => ok<ResolveResult>({ state: "placed", matches: false, order: ORDER })) });
      expect(await submitOrder(input(), d)).toEqual({ status: "reused" });
      expect(d.place).not.toHaveBeenCalled();
    });

    it("an abandoned key can't be used", async () => {
      const d = deps({ resolve: vi.fn(async () => ok<ResolveResult>({ state: "abandoned" })) });
      expect(await submitOrder(input(), d)).toEqual({ status: "abandoned" });
      expect(d.place).not.toHaveBeenCalled();
    });
  });

  it("rate-limited attempts never reach Turnstile or the order", async () => {
    const d = deps({ registerAttempt: vi.fn(async () => ok<AttemptResult>({ allowed: false, reason: "rate_limited" })) });
    expect(await submitOrder(input(), d)).toEqual({ status: "rate_limited" });
    expect(d.verifyTurnstile).not.toHaveBeenCalled();
    expect(d.place).not.toHaveBeenCalled();
  });

  it("an expired or used Turnstile token asks for a new check and places nothing", async () => {
    const d = deps({ verifyTurnstile: vi.fn(async () => ({ ok: false as const, reason: "expired" as const })) });
    expect(await submitOrder(input(), d)).toEqual({ status: "verify_again" });
    expect(d.place).not.toHaveBeenCalled();
  });

  it("Turnstile unavailable: refused (fails closed)", async () => {
    const d = deps({ verifyTurnstile: vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const })) });
    expect(await submitOrder(input(), d)).toEqual({ status: "verification_unavailable" });
    expect(d.place).not.toHaveBeenCalled();
  });

  it("maps the database's answers", async () => {
    const cases: [PlaceResult, string][] = [
      [{ result: "existing", order: ORDER }, "placed"],
      [{ result: "mismatch" }, "reused"],
      [{ result: "closed" }, "closed"],
      [{ result: "phone_limit" }, "phone_limit"],
      [{ result: "abandoned" }, "abandoned"],
      [{ result: "limits", max_lines: 5, max_units: 6, max_units_per_line: 4 }, "limits"],
      [{ result: "quote_changed", quote: { exact: false } as never }, "quote_changed"],
    ];
    for (const [answer, status] of cases) {
      const d = deps({ place: vi.fn(async () => ok(answer)) });
      expect((await submitOrder(input(), d)).status).toBe(status);
      expect(d.onPlaced).not.toHaveBeenCalled();
    }
  });

  it("a network failure after retries is 'unknown' (the order may exist); a refusal is an error", async () => {
    const network = deps({ place: vi.fn(async () => ({ data: null, error: { message: "TypeError: fetch failed" } })) });
    expect(await submitOrder(input(), network)).toEqual({ status: "unknown" });
    const refused = deps({ place: vi.fn(async () => ({ data: null, error: { code: "42501", message: "Not allowed." } })) });
    expect(await submitOrder(input(), refused)).toEqual({ status: "error" });
    expect(refused.logError).toHaveBeenCalledWith("place order", { code: "42501", message: "Not allowed." });
  });
});
