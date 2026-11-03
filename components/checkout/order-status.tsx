"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CHECKOUT_KEY_PATTERN } from "@/lib/checkout/input";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, type CustomerOrderView } from "@/lib/checkout/types";
import { formatPrice } from "@/lib/format";

const rupees = (paisa: number) => formatPrice(paisa / 100);

// The key is in the link's fragment (#k=…), which browsers never send to the
// server, so it stays out of server logs and Referer headers.
function readKey() {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  return match && CHECKOUT_KEY_PATTERN.test(match[1]) ? match[1] : null;
}
const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

type State =
  | { kind: "loading" }
  | { kind: "found"; order: CustomerOrderView }
  | { kind: "none" }
  | { kind: "error"; message: string };

export function OrderStatus() {
  const key = useSyncExternalStore(subscribe, readKey, () => undefined);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch("/api/checkout/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, action: "view" }),
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 429) throw new Error("Too many lookups from this connection. Try again in a few minutes.");
        if (!response.ok) throw new Error("We couldn’t load your order just now. Try again shortly.");
        return (await response.json()) as { order: CustomerOrderView | null };
      })
      .then((body) => !cancelled && setState(body.order ? { kind: "found", order: body.order } : { kind: "none" }))
      .catch((error: Error) => !cancelled && setState({ kind: "error", message: error.message }));
    return () => {
      cancelled = true;
    };
  }, [key]);

  if (key === undefined) return <p className="text-sm text-muted">Loading…</p>;
  if (key === null || state.kind === "none") {
    return (
      <div className="rounded-lg border border-line p-6 text-sm">
        <p className="font-semibold">We couldn’t find an order for this link.</p>
        <p className="mt-2 text-muted">Check that you opened the full link you saved after ordering.</p>
      </div>
    );
  }
  if (state.kind === "loading") return <p className="text-sm text-muted">Loading your order…</p>;
  if (state.kind === "error") return <p className="text-sm text-danger">{state.message}</p>;

  const { order } = state;
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <section className="rounded-lg border border-line p-6">
        <p className="eyebrow text-muted">Order {order.order_number}</p>
        <h2 className="mt-2 text-xl font-bold md:text-2xl">{ORDER_STATUS_LABELS[order.status]}</h2>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink/85">
          {order.status === "awaiting_confirmation" ? (
            <p>
              Thank you, {order.first_name}. We’ll call or WhatsApp you on the number ending {order.phone_last_digits} to
              confirm your order before we send it. Your items are held for you until then.
            </p>
          ) : null}
          {order.status === "dispatched" && order.tracking_number ? (
            <p>
              Sent with {order.courier}. Tracking number: <span className="font-semibold">{order.tracking_number}</span>
            </p>
          ) : null}
          <p>Delivering to {order.city}. Payment: {PAYMENT_STATUS_LABELS[order.payment_status]}.</p>
        </div>
        <div className="mt-5 rounded-md bg-cream p-4 text-sm">
          <p className="font-semibold">Save this private link</p>
          <p className="mt-1 text-muted">
            Anyone with this link can see this order’s status, so keep it to yourself. It doesn’t show your address.
          </p>
          <button
            type="button"
            className="btn btn-outline mt-3 h-10"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
            }}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
        <Link href="/shop" className="mt-5 inline-block text-sm font-semibold text-forest link-underline">
          Continue shopping
        </Link>
      </section>
      <section aria-labelledby="order-items" className="rounded-lg bg-cream p-5">
        <h2 id="order-items" className="text-base font-bold">
          Items
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {order.items.map((item, index) => (
            <li key={index} className="flex justify-between gap-4">
              <span className="min-w-0">
                {item.quantity} × {item.brand} {item.name}
                <span className="text-muted"> · EU {Number(item.size_eu)}</span>
              </span>
              <span className="shrink-0">{rupees(item.line_total_paisa)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-2 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Subtotal</dt>
            <dd>{rupees(order.subtotal_paisa)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Delivery</dt>
            <dd>{order.delivery_paisa === 0 ? "Free" : rupees(order.delivery_paisa)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{rupees(order.total_paisa)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
