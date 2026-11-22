"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { placeOrder } from "@/app/checkout/actions";
import { CODE_INPUT_MAX, formatPercent, normalizeReferralCode } from "@/lib/agents/code";
import { cartStore } from "@/lib/cart/cart-store";
import { fullName } from "@/lib/catalog/product-utils";
import {
  cartDigest,
  FIELD_LIMITS,
  orderLinesFromCart,
  validateCustomer,
  type CustomerErrors,
  type CustomerInput,
} from "@/lib/checkout/input";
import {
  attemptForCart,
  clearAttempt,
  readAttempt,
  settleNeeded,
  turnstileCData,
  writeAttempt,
  type CheckoutAttempt,
} from "@/lib/checkout/request-key";
import type { SubmitResult } from "@/lib/checkout/submit";
import type { CustomerOrderView, Quote, QuoteLine } from "@/lib/checkout/types";
import { formatPrice } from "@/lib/format";
import { useCart } from "@/components/cart/cart-provider";
import { CheckoutSkeleton, QuoteSkeleton } from "./checkout-skeleton";
import { TurnstileWidget } from "./turnstile-widget";

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-base focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-forest aria-[invalid=true]:border-danger";
const LABEL = "mb-1.5 block text-sm font-semibold";
const HINT = "mt-1 text-xs text-muted";
const ERROR = "mt-1 text-sm font-medium text-danger";

const rupees = (paisa: number) => formatPrice(paisa / 100);
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const MESSAGES: Partial<Record<SubmitResult["status"], string>> = {
  disabled: "Checkout isn’t open at the moment. Nothing was ordered.",
  closed: "We aren’t taking orders at the moment. Nothing was ordered.",
  bad_request: "Something in this order couldn’t be read. Reload the page and try again.",
  quote_changed: "Something changed since you opened checkout. Check the updated order below, then place it again.",
  phone_limit:
    "There are already orders waiting for confirmation on this phone number. We’ll contact you about them before you order again.",
  rate_limited: "Too many attempts from this connection. Please wait a few minutes and try again.",
  busy: "We’re receiving a lot of orders right now. Nothing was ordered yet: please try again in a minute.",
  verify_again: "The security check expired. Complete it again, then place your order.",
  verify_failed: "The security check didn’t pass. Complete it again, then place your order.",
  verification_unavailable:
    "We can’t run the security check right now, so we can’t take orders. Nothing was ordered. Please try again later.",
  reused: "This checkout was already used for a different order. Checking what happened…",
  abandoned: "This checkout was closed. Review your order and place it again.",
  unknown: "We couldn’t confirm whether your order went through. Don’t worry: checking again can’t create a second order.",
  error: "Something went wrong and your order wasn’t placed. Please try again.",
};

type Settled = { kind: "placed"; order: CustomerOrderView; key: string } | null;

/** The checkout, once the saved cart has been read on this device. */
export function CheckoutForm({ siteKey }: { siteKey: string }) {
  const { lines, hydrated } = useCart();
  if (!hydrated) return <CheckoutSkeleton />;
  if (lines.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line px-6 py-14 text-center">
        <h2 className="text-lg font-bold">Your cart is empty</h2>
        <p className="mt-2 text-sm text-muted">Add something to your cart, then come back to check out.</p>
        <Link href="/shop" className="btn btn-outline mt-6">
          Browse the shop
        </Link>
      </div>
    );
  }
  return <CheckoutFlow siteKey={siteKey} />;
}

function CheckoutFlow({ siteKey }: { siteKey: string }) {
  const router = useRouter();
  const { lines } = useCart();
  const orderLines = useMemo(() => orderLinesFromCart(lines), [lines]);
  const digest = cartDigest(orderLines);

  const [attempt, setAttempt] = useState<CheckoutAttempt>(() => attemptForCart(readAttempt(storage()), digest));
  const [checking, setChecking] = useState(attempt.state === "sent");
  const [settleRun, setSettleRun] = useState(0);
  const [settled, setSettled] = useState<Settled>(null);
  const [fields, setFields] = useState<CustomerInput>({ name: "", phone: "", city: "", address: "", landmark: "", note: "" });
  const [errors, setErrors] = useState<CustomerErrors>({});
  const [city, setCity] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteFailed, setQuoteFailed] = useState<false | "error" | "rate_limited">(false);
  const [token, setToken] = useState<string | null>(null);
  const [cData, setCData] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [turnstileDown, setTurnstileDown] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The referral code as typed, and the one applied to the quote (normalised).
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);

  // A key never sent is simply replaced when the cart changes.
  if (attempt.state === "draft" && attempt.cart !== digest) setAttempt(attemptForCart(attempt, digest));

  useEffect(() => writeAttempt(storage(), attempt), [attempt]);

  useEffect(() => {
    let cancelled = false;
    void turnstileCData(attempt.key).then((value) => !cancelled && setCData(value));
    return () => {
      cancelled = true;
    };
  }, [attempt.key]);

  // A key that was sent: find out what happened before doing anything else.
  // If the cart has changed since, give the key up (unless it placed an order).
  const mustAbandon = settleNeeded(attempt, digest);
  useEffect(() => {
    // Only on load, on request (checking) or after a cart change; never while a submission is in flight.
    if (attempt.state !== "sent" || (!checking && !mustAbandon)) return;
    let cancelled = false;
    fetch("/api/checkout/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: attempt.key, action: mustAbandon ? "abandon" : "settle" }),
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { state: "placed" | "none" | "abandoned"; order?: CustomerOrderView }) => {
        if (cancelled) return;
        if (body.state === "placed" && body.order) {
          clearAttempt(storage());
          if (attempt.cart === digest) {
            // The order is this cart: go to it, as after a normal order. (Emptying
            // the cart here would otherwise replace this page with "cart is empty".)
            cartStore.removeMany(orderLines.map((l) => l.sku));
            router.push(`/order#k=${attempt.key}`);
            return;
          }
          setSettled({ kind: "placed", order: body.order, key: attempt.key });
        } else if (body.state === "abandoned") {
          setAttempt(attemptForCart(null, digest));
        }
        setChecking(false);
      })
      .catch(() => {
        if (!cancelled) {
          setChecking(false);
          setMessage("We couldn’t check on your earlier attempt. Check your connection and reload the page.");
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the key or the need to abandon it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt.key, attempt.state, mustAbandon, settleRun, checking]);

  // Live quote: prices, stock, discount and delivery, re-checked when the cart, city or code changes.
  const linesJson = JSON.stringify(orderLines);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch("/api/checkout/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: JSON.parse(linesJson), city, referral_code: appliedCode }),
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
        .then((body: { quote: Quote }) => {
          if (cancelled) return;
          setQuote(body.quote);
          setQuoteFailed(false);
        })
        .catch((status) => !cancelled && setQuoteFailed(status === 429 ? "rate_limited" : "error"));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [linesJson, city, appliedCode]);

  if (settled) return <PlacedNotice order={settled.order} orderKey={settled.key} />;

  // A quote from before the code was applied or removed isn't this one yet.
  const quoteMatchesCode = !quote || (quote.referral?.code ?? null) === appliedCode;

  const changed = quote?.lines.filter((l) => l.status !== "ok" || l.price_changed) ?? [];
  const canPlace =
    !!quote && quoteMatchesCode && quote.exact && quote.orders_open && !!token && !pending && !checking && !mustAbandon && !turnstileDown;

  function applyCode(event?: React.SyntheticEvent) {
    event?.preventDefault();
    const code = normalizeReferralCode(codeInput);
    setAppliedCode(code);
    setCodeInput(code ?? "");
    setMessage(null);
  }

  function removeCode() {
    setAppliedCode(null);
    setCodeInput("");
    setMessage(null);
  }

  function update(field: keyof CustomerInput, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function acceptChanges() {
    if (!quote) return;
    cartStore.applyQuote(
      quote.lines.map((l) => ({
        sku: l.sku,
        quantity: l.status === "unavailable" || l.status === "sold_out" ? 0 : l.allowed_quantity,
        price: (l.unit_price_paisa ?? 0) / 100,
        maxQuantity: l.status === "unavailable" ? 0 : l.available,
      })),
    );
    setMessage(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    const checked = validateCustomer(fields);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    if (!quote || !canPlace) return;

    // From here the key may reach the server: keep it until its outcome is known.
    const sent: CheckoutAttempt = { ...attempt, state: "sent" };
    setAttempt(sent);
    writeAttempt(storage(), sent);

    startTransition(async () => {
      let result: SubmitResult;
      try {
        result = await placeOrder({
          key: sent.key,
          lines: orderLines,
          deliveryPaisa: quote.delivery_paisa,
          totalPaisa: quote.total_paisa,
          customer: fields,
          turnstileToken: token,
          referralCode: appliedCode,
          discountPaisa: appliedCode ? quote.discount_paisa : 0,
        });
      } catch {
        result = { status: "unknown" };
      }
      handle(result, sent);
    });
  }

  function handle(result: SubmitResult, sent: CheckoutAttempt) {
    switch (result.status) {
      case "placed":
        cartStore.removeMany(orderLines.map((l) => l.sku));
        clearAttempt(storage());
        router.push(`/order#k=${sent.key}`);
        return;
      case "invalid":
        setErrors(result.errors);
        setMessage("Check the highlighted details.");
        return;
      case "quote_changed":
        setQuote(result.quote);
        break;
      case "limits":
        setMessage(
          `An order can have at most ${result.maxUnitsPerLine} of a size and ${result.maxUnits} pairs in total. Reduce the quantities and try again.`,
        );
        return;
      case "reused":
      case "unknown":
        // Ask the server what happened to this key (settled above).
        setChecking(true);
        setSettleRun((n) => n + 1);
        break;
      case "abandoned":
        setAttempt(attemptForCart(null, digest));
        break;
    }
    setMessage(MESSAGES[result.status] ?? MESSAGES.error!);
    // Every token is single-use: ask for a fresh check before the next try.
    setResetSignal((n) => n + 1);
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-8 lg:grid-cols-[1fr_380px] lg:items-start">
      <section aria-labelledby="delivery-heading" className="space-y-5">
        <h2 id="delivery-heading" className="text-lg font-bold">
          Delivery details
        </h2>
        <Field id="name" label="Full name" error={errors.name}>
          <input id="name" className={`${INPUT} h-11`} autoComplete="name" maxLength={FIELD_LIMITS.name.max}
            value={fields.name} onChange={(e) => update("name", e.target.value)} aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "name-error" : undefined} />
        </Field>
        <Field id="phone" label="Mobile number" hint="We’ll call or WhatsApp this number to confirm your order." error={errors.phone}>
          <input id="phone" type="tel" inputMode="tel" className={`${INPUT} h-11`} autoComplete="tel" maxLength={20}
            placeholder="0300 1234567" value={fields.phone} onChange={(e) => update("phone", e.target.value)}
            aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "phone-error" : "phone-hint"} />
        </Field>
        <Field id="city" label="City" error={errors.city}>
          <input id="city" className={`${INPUT} h-11`} autoComplete="address-level2" maxLength={FIELD_LIMITS.city.max}
            value={fields.city}
            onChange={(e) => {
              update("city", e.target.value);
              setCity(e.target.value);
            }}
            aria-invalid={!!errors.city} aria-describedby={errors.city ? "city-error" : undefined} />
        </Field>
        <Field id="address" label="Full address" hint="House or flat number, street, block or sector, and area." error={errors.address}>
          <textarea id="address" rows={3} className={`${INPUT} py-2`} autoComplete="street-address"
            maxLength={FIELD_LIMITS.address.max} value={fields.address} onChange={(e) => update("address", e.target.value)}
            aria-invalid={!!errors.address} aria-describedby={errors.address ? "address-error" : "address-hint"} />
        </Field>
        <Field id="landmark" label="Nearest landmark (optional)" error={errors.landmark}>
          <input id="landmark" className={`${INPUT} h-11`} maxLength={FIELD_LIMITS.landmark.max} value={fields.landmark}
            onChange={(e) => update("landmark", e.target.value)} aria-invalid={!!errors.landmark} />
        </Field>
        <Field id="note" label="Delivery note (optional)" error={errors.note}>
          <input id="note" className={`${INPUT} h-11`} maxLength={FIELD_LIMITS.note.max} value={fields.note}
            onChange={(e) => update("note", e.target.value)} aria-invalid={!!errors.note} />
        </Field>

        <div className="rounded-lg bg-cream p-4 text-sm leading-relaxed">
          <p className="font-semibold">Pay cash on delivery</p>
          <p className="mt-1 text-ink/85">
            You pay the courier when your order arrives. We confirm every order by phone or WhatsApp before it’s
            dispatched; your items are held for you until then.
          </p>
        </div>

        {turnstileDown ? (
          <p className={ERROR}>
            The security check couldn’t load, so orders can’t be placed right now. Check your connection and reload
            the page.
          </p>
        ) : cData ? (
          <TurnstileWidget
            siteKey={siteKey}
            cData={cData}
            resetSignal={resetSignal}
            onToken={setToken}
            onUnavailable={() => setTurnstileDown(true)}
          />
        ) : null}

        <div aria-live="polite">
          {checking ? <p className="text-sm text-muted">Checking on your earlier attempt…</p> : null}
          {message ? <p className="rounded-md border border-danger/30 px-3 py-2 text-sm text-danger">{message}</p> : null}
        </div>

        <button type="submit" className="btn btn-lime h-12 w-full text-[15px]" disabled={!canPlace}>
          {pending
            ? "Placing your order…"
            : quote?.exact
              ? `Place order · pay ${rupees(quote.total_paisa)} on delivery`
              : "Place order"}
        </button>
        {!pending && quote?.exact && !token && !turnstileDown ? (
          <p className={HINT}>Complete the security check above to place your order.</p>
        ) : null}
      </section>

      {/* On phones the summary comes first, so changes are seen before the form. */}
      <section aria-labelledby="summary-heading" className="order-first rounded-lg border border-line p-5 lg:sticky lg:top-24 lg:order-none">
        <h2 id="summary-heading" className="text-base font-bold">
          Your order
        </h2>
        {quoteFailed ? (
          <p className="mt-3 text-sm text-danger">
            {quoteFailed === "rate_limited"
              ? "Too many price checks from this connection. Please wait a few minutes, then reload."
              : "We couldn’t check prices and stock just now. Check your connection."}
          </p>
        ) : !quote ? (
          <>
            <p className="sr-only" role="status">
              Checking prices and stock…
            </p>
            <QuoteSkeleton lines={lines.length} />
          </>
        ) : (
          <QuoteSummary quote={quote} lines={lines} changed={changed.length > 0} onAccept={acceptChanges} />
        )}
        <ReferralField
          input={codeInput}
          applied={appliedCode}
          referral={quote && quoteMatchesCode ? quote.referral : null}
          checking={!!appliedCode && (!quote || !quoteMatchesCode) && !quoteFailed}
          onInput={setCodeInput}
          onApply={applyCode}
          onRemove={removeCode}
        />
      </section>
    </form>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className={ERROR}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function lineNote(line: QuoteLine) {
  if (line.status === "unavailable") return "No longer available.";
  if (line.status === "sold_out") return "Sold out since you added it.";
  const parts: string[] = [];
  if (line.status === "reduced") parts.push(`Only ${line.allowed_quantity} available now (you chose ${line.quantity}).`);
  if (line.price_changed && line.unit_price_paisa !== null) {
    parts.push(`Price is now ${rupees(line.unit_price_paisa)} (was ${rupees(line.seen_price_paisa)}).`);
  }
  return parts.join(" ") || null;
}

function QuoteSummary({
  quote,
  lines,
  changed,
  onAccept,
}: {
  quote: Quote;
  lines: ReturnType<typeof useCart>["lines"];
  changed: boolean;
  onAccept: () => void;
}) {
  const bySku = new Map(lines.map((l) => [l.sku, l]));
  return (
    <>
      <ul className="mt-3 space-y-3 text-sm">
        {quote.lines.map((line) => {
          const cartLine = bySku.get(line.sku);
          const note = lineNote(line);
          const gone = line.status === "unavailable" || line.status === "sold_out";
          return (
            <li key={line.sku}>
              <div className="flex justify-between gap-4">
                <span className="min-w-0">
                  {line.allowed_quantity || line.quantity} × {cartLine ? fullName(cartLine) : (line.name ?? line.sku)}
                  <span className="text-muted"> · EU {line.size_eu ?? cartLine?.size}</span>
                </span>
                <span className={`shrink-0 ${gone ? "text-muted line-through" : ""}`}>
                  {line.unit_price_paisa !== null ? rupees(line.unit_price_paisa * (gone ? line.quantity : line.allowed_quantity)) : "—"}
                </span>
              </div>
              {/* A "was" price only with a supported reference (never just the current regular price). */}
              {!gone && line.unit_price_paisa !== null && (line.reference_price_paisa ?? 0) > line.unit_price_paisa ? (
                <p className="mt-0.5 text-xs text-muted">
                  Sale price {rupees(line.unit_price_paisa)} each; was{" "}
                  <s className="decoration-danger">{rupees(line.reference_price_paisa!)}</s>
                </p>
              ) : null}
              {note ? <p className="mt-0.5 text-xs font-medium text-danger">{note}</p> : null}
              {!gone && quote.referral?.status === "ok" ? (
                line.referral_eligible ? (
                  <p className="mt-0.5 text-xs text-forest">Code {quote.referral.code}: −{rupees(line.discount_paisa)}</p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted">
                    {line.referral_excluded ? "Clearance item: referral codes don’t apply" : "Sale item: the code doesn’t apply"}
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {changed ? (
        <div className="mt-4 rounded-md border border-danger/30 p-3 text-sm">
          <p className="text-danger">Some items changed since you added them. Nothing is ordered until you accept.</p>
          <button type="button" onClick={onAccept} className="btn btn-outline mt-3 h-10 w-full">
            Update my cart
          </button>
        </div>
      ) : null}
      <dl className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">Subtotal</dt>
          <dd>{rupees(quote.subtotal_paisa)}</dd>
        </div>
        {quote.discount_paisa > 0 ? (
          <div className="flex justify-between text-forest">
            <dt>
              Referral discount ({quote.referral?.code}
              {quote.referral?.discount_bp !== undefined ? `, ${formatPercent(quote.referral.discount_bp)}` : ""})
            </dt>
            <dd>−{rupees(quote.discount_paisa)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-muted">Delivery</dt>
          <dd>
            {quote.delivery_status === "ok"
              ? quote.delivery_paisa === 0
                ? "Free"
                : rupees(quote.delivery_paisa)
              : quote.delivery_status === "city_required"
                ? "Enter your city"
                : quote.delivery_status === "not_served"
                  ? "Not available"
                  : "Not set up yet"}
          </dd>
        </div>
        <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
          <dt>Total to pay on delivery</dt>
          <dd>{quote.delivery_status === "ok" ? rupees(quote.total_paisa) : "—"}</dd>
        </div>
      </dl>
      {quote.delivery_status === "not_served" ? (
        <p className="mt-2 text-xs text-danger">We don’t deliver to this city yet.</p>
      ) : null}
      {quote.free_delivery_min_paisa !== null && quote.delivery_status === "ok" && quote.delivery_paisa > 0 ? (
        <p className="mt-2 text-xs text-muted">
          Free delivery on orders of {rupees(quote.free_delivery_min_paisa)} or more
          {quote.discount_paisa > 0 ? ", after any discount" : ""}.
        </p>
      ) : null}
      {!quote.orders_open ? <p className="mt-2 text-xs text-danger">We aren’t taking orders at the moment.</p> : null}
    </>
  );
}

const REFERRAL_MESSAGES: Record<Exclude<NonNullable<Quote["referral"]>["status"], "ok">, string> = {
  invalid: "We don’t recognise this code. Check it, or remove it to continue.",
  disabled: "This code isn’t accepted at the moment. Remove it to continue.",
  no_eligible_items: "This code doesn’t apply to anything in your cart (sale items aren’t included). Remove it to continue.",
};

/**
 * One referral code per order. Applying it re-checks the quote; the database
 * decides whether it applies and works out the discount. Only the code and
 * its discount are shown, never whose code it is.
 */
function ReferralField({
  input,
  applied,
  referral,
  checking,
  onInput,
  onApply,
  onRemove,
}: {
  input: string;
  applied: string | null;
  referral: Quote["referral"];
  checking: boolean;
  onInput: (value: string) => void;
  onApply: (event?: React.SyntheticEvent) => void;
  onRemove: () => void;
}) {
  const problem = referral && referral.status !== "ok" ? REFERRAL_MESSAGES[referral.status] : null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      {applied ? (
        <div className="flex items-start justify-between gap-3 text-sm">
          <div aria-live="polite">
            <p className="font-semibold">Referral code {applied}</p>
            {checking ? (
              <p className="mt-0.5 text-xs text-muted">Checking…</p>
            ) : problem ? (
              <p className="mt-0.5 text-xs font-medium text-danger">{problem}</p>
            ) : referral?.status === "ok" ? (
              <p className="mt-0.5 text-xs text-forest">
                Applied{referral.discount_bp !== undefined ? `: ${formatPercent(referral.discount_bp)} off` : ""}
                {referral.applies_to_sale_items === false ? " (not on sale items)" : ""}.
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onRemove} className="btn btn-outline h-9 shrink-0 px-3 text-sm">
            Remove
          </button>
        </div>
      ) : (
        <div>
          <label htmlFor="referral-code" className={LABEL}>
            Referral code (optional)
          </label>
          <div className="flex gap-2">
            <input
              id="referral-code"
              className={`${INPUT} h-10 uppercase`}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={CODE_INPUT_MAX}
              value={input}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onApply(e);
              }}
            />
            <button type="button" onClick={onApply} disabled={!normalizeReferralCode(input)} className="btn btn-outline h-10 shrink-0 px-4 text-sm">
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlacedNotice({ order, orderKey }: { order: CustomerOrderView; orderKey: string }) {
  return (
    <div className="rounded-lg border border-line p-6">
      <h2 className="text-xl font-bold">Your order {order.order_number} was placed</h2>
      <p className="mt-2 text-sm text-ink/85">An earlier attempt from this device went through, so nothing was ordered twice.</p>
      <Link href={`/order#k=${orderKey}`} className="btn btn-forest mt-5">
        View your order
      </Link>
    </div>
  );
}
