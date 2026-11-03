import { isUncertain, type DbResult } from "@/lib/db/retry";
import {
  CHECKOUT_KEY_PATTERN,
  isPaisa,
  parseOrderLines,
  validateCustomer,
  type CustomerErrors,
  type CustomerInput,
} from "./input";
import type { AttemptResult, OrderBody, PlaceResult, ResolveResult } from "./server";
import type { TurnstileOutcome } from "./turnstile";
import type { CustomerOrderView, Quote } from "./types";

/*
 * Placing an order, step by step (the Server Action in app/checkout/actions.ts
 * supplies the real dependencies; the unit tests supply fakes):
 *
 * 1. Check the input.
 * 2. Has this checkout key already placed an order? If so, and the contents
 *    are the same, that order is the answer (a retry after a lost response).
 *    The same key with different contents is refused, never accepted.
 * 3. Count the attempt against the rate limits.
 * 4. Verify the Turnstile token. An expired or used token asks the customer to
 *    redo the check; the key stays the same, so no duplicate can result.
 * 5. Place the order. The database recalculates everything and either places
 *    it or explains what changed.
 *
 * When the database can't be reached and we can't tell whether the order was
 * placed, the result is "unknown": the browser keeps the key and asks again.
 */

export type SubmitInput = {
  key: unknown;
  lines: unknown;
  deliveryPaisa: unknown;
  totalPaisa: unknown;
  customer: Partial<CustomerInput>;
  turnstileToken: unknown;
};

export type SubmitResult =
  | { status: "placed"; order: CustomerOrderView }
  | { status: "invalid"; errors: CustomerErrors }
  | { status: "bad_request" }
  | { status: "quote_changed"; quote: Quote }
  | { status: "limits"; maxLines: number; maxUnits: number; maxUnitsPerLine: number }
  | {
      status:
        | "disabled"
        | "closed"
        | "reused"
        | "abandoned"
        | "phone_limit"
        | "rate_limited"
        | "verify_again"
        | "verify_failed"
        | "verification_unavailable"
        | "unknown"
        | "error";
    };

export type SubmitDeps = {
  enabled: boolean;
  clientBucket: string | null;
  remoteIp: string | null;
  resolve: (key: string, order: OrderBody) => Promise<DbResult<ResolveResult>>;
  registerAttempt: (client: string | null) => Promise<DbResult<AttemptResult>>;
  verifyTurnstile: (token: string, key: string, remoteIp: string | null) => Promise<TurnstileOutcome>;
  place: (key: string, order: OrderBody) => Promise<DbResult<PlaceResult>>;
  onPlaced?: () => void;
  logError?: (where: string, error: { code?: string } | null) => void;
};

function failure(error: DbResult<unknown>["error"], where: string, deps: SubmitDeps): SubmitResult {
  deps.logError?.(where, error);
  // A network error after retries: the order may or may not exist.
  return { status: isUncertain(error) ? "unknown" : "error" };
}

export async function submitOrder(input: SubmitInput, deps: SubmitDeps): Promise<SubmitResult> {
  if (!deps.enabled) return { status: "disabled" };

  // 1. Input.
  const key = typeof input.key === "string" && CHECKOUT_KEY_PATTERN.test(input.key) ? input.key : null;
  const lines = parseOrderLines(input.lines);
  if (!key || !lines || !isPaisa(input.deliveryPaisa) || !isPaisa(input.totalPaisa)) return { status: "bad_request" };
  const checked = validateCustomer(input.customer ?? {});
  if (!checked.ok) return { status: "invalid", errors: checked.errors };
  const order: OrderBody = {
    lines,
    delivery_paisa: input.deliveryPaisa,
    total_paisa: input.totalPaisa,
    customer: checked.customer,
  };

  // 2. Already placed with this key?
  const resolved = await deps.resolve(key, order);
  if (resolved.error || !resolved.data) return failure(resolved.error, "resolve", deps);
  if (resolved.data.state === "placed") {
    return resolved.data.matches ? { status: "placed", order: resolved.data.order } : { status: "reused" };
  }
  if (resolved.data.state === "abandoned") return { status: "abandoned" };

  // 3. Rate limits.
  const attempt = await deps.registerAttempt(deps.clientBucket);
  if (attempt.error || !attempt.data) return failure(attempt.error, "register attempt", deps);
  if (!attempt.data.allowed) return { status: attempt.data.reason === "not_configured" ? "closed" : "rate_limited" };

  // 4. Turnstile.
  const token = typeof input.turnstileToken === "string" ? input.turnstileToken : "";
  const verified = await deps.verifyTurnstile(token, key, deps.remoteIp);
  if (!verified.ok) {
    return {
      status: verified.reason === "expired" ? "verify_again" : verified.reason === "invalid" ? "verify_failed" : "verification_unavailable",
    };
  }

  // 5. Place.
  const placed = await deps.place(key, order);
  if (placed.error || !placed.data) return failure(placed.error, "place order", deps);
  const result = placed.data;
  switch (result.result) {
    case "placed":
    case "existing":
      if (result.result === "placed") deps.onPlaced?.();
      return { status: "placed", order: result.order };
    case "quote_changed":
      return { status: "quote_changed", quote: result.quote };
    case "limits":
      return { status: "limits", maxLines: result.max_lines, maxUnits: result.max_units, maxUnitsPerLine: result.max_units_per_line };
    case "mismatch":
      return { status: "reused" };
    case "abandoned":
    case "closed":
    case "phone_limit":
      return { status: result.result };
    default:
      return { status: "error" };
  }
}
