import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { OrderActionForm } from "@/components/admin/order-action-form";
import { getOrder, type AdminOrder } from "@/lib/admin/orders";
import { getAdminPageClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/checkout/types";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Order",
};

export default function OrderPage({ params }: PageProps<"/admin/orders/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Order params={params} />
    </Suspense>
  );
}

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const LABEL = "mb-1 block text-sm font-semibold";
const dateTime = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });
const rupees = (paisa: number) => formatPrice(paisa / 100);

async function Order({ params }: Pick<PageProps<"/admin/orders/[id]">, "params">) {
  const { id } = await params;
  const href = `/admin/orders/${id}`;
  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  let order: AdminOrder | null = null;
  let failed = false;
  if (UUID_PATTERN.test(id)) {
    try {
      order = await getOrder(supabase, id);
    } catch (error) {
      console.error("[admin]", (error as Error).message);
      failed = true;
    }
  }

  return (
    <>
      <AdminNav current="orders" email={access.email} />
      <Link href="/admin/orders" className="text-sm font-semibold text-forest link-underline">
        ← All orders
      </Link>
      {failed ? (
        <p role="alert" className="mt-6 text-sm text-danger">This order couldn’t be loaded right now.</p>
      ) : !order ? (
        <p className="mt-6 text-sm">Order not found.</p>
      ) : (
        <OrderDetail order={order} />
      )}
    </>
  );
}

function OrderDetail({ order }: { order: AdminOrder }) {
  // A fresh request id per form, per render: a double submit is applied once.
  const form = (action: string) => ({ action, orderId: order.id, version: order.version, requestId: randomUUID() });
  const phone = order.customer_phone;
  const open = order.status === "awaiting_confirmation" || order.status === "confirmed";

  return (
    <div className="mt-4 grid gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">{order.order_number}</h1>
          <p className="mt-1 text-sm text-muted">
            {order.channel === "in_store" ? "In-store sale" : "Online, cash on delivery"} · placed {dateTime.format(new Date(order.created_at))}
          </p>
          <p className="mt-2 text-sm">
            <span className="font-semibold">{ORDER_STATUS_LABELS[order.status]}</span> · Payment:{" "}
            {PAYMENT_STATUS_LABELS[order.payment_status]}
            {order.hold_expires_at ? (
              <span className="text-danger"> · confirm by {dateTime.format(new Date(order.hold_expires_at))} or it is cancelled</span>
            ) : null}
          </p>
        </header>

        {order.channel === "online" ? (
          <section aria-labelledby="customer-heading" className="rounded-lg border border-line p-4 text-sm">
            <h2 id="customer-heading" className="font-bold">Customer</h2>
            <p className="mt-2">{order.customer_name}</p>
            {phone ? (
              <p className="mt-1 flex flex-wrap gap-3">
                <a className="font-semibold text-forest link-underline" href={`tel:${phone}`}>{phone}</a>
                <a className="font-semibold text-forest link-underline" href={`https://wa.me/${phone.slice(1)}`} target="_blank" rel="noreferrer">
                  WhatsApp
                </a>
              </p>
            ) : null}
            <p className="mt-2 whitespace-pre-line">{order.address}</p>
            <p>{order.city}</p>
            {order.landmark ? <p className="text-muted">Near {order.landmark}</p> : null}
            {order.delivery_note ? <p className="mt-1 text-muted">Note: {order.delivery_note}</p> : null}
            {order.courier ? (
              <p className="mt-2">
                Courier: {order.courier}
                {order.tracking_number ? ` · ${order.tracking_number}` : ""}
              </p>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="actions-heading" className="space-y-5">
          <h2 id="actions-heading" className="text-lg font-bold">Next step</h2>

          {order.status === "awaiting_confirmation" ? (
            <OrderActionForm {...form("confirm")} submitLabel="Confirm order (customer confirmed by phone)" tone="forest">
              <NoteField />
            </OrderActionForm>
          ) : null}

          {order.status === "confirmed" || order.status === "delivery_failed" ? (
            <OrderActionForm {...form("dispatch")} submitLabel={order.status === "confirmed" ? "Dispatch" : "Dispatch again"} tone="forest">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="courier">Courier</label>
                  <input id="courier" name="courier" className={`${INPUT} h-10`} defaultValue={order.courier ?? "TCS"} required maxLength={60} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="tracking">Tracking number</label>
                  <input id="tracking" name="tracking" className={`${INPUT} h-10`} defaultValue="" maxLength={60} />
                </div>
              </div>
            </OrderActionForm>
          ) : null}

          {order.status === "dispatched" || order.status === "delivery_failed" ? (
            <OrderActionForm {...form("delivered")} submitLabel="Mark delivered">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="cashCollected" defaultChecked /> The courier collected {rupees(order.total_paisa)} cash on delivery
              </label>
            </OrderActionForm>
          ) : null}

          {order.status === "dispatched" ? (
            <OrderActionForm {...form("failed")} submitLabel="Delivery failed">
              <p className="text-xs text-muted">Payment stays pending: you can dispatch it again, or receive it back.</p>
              <NoteField />
            </OrderActionForm>
          ) : null}

          {order.status === "delivery_failed" || order.status === "delivered" ? (
            <OrderActionForm {...form("return")} submitLabel="Parcel back at the shop" confirmText="Record this parcel as returned?">
              <p className="text-xs text-muted">
                Check each pair. Restocked pairs go back on sale; written-off pairs don’t.
              </p>
              {order.order_items.map((item) => (
                <fieldset key={item.id} className="rounded-md border border-line p-3 text-sm">
                  <legend className="px-1 font-semibold">
                    {item.quantity} × {item.brand} {item.product_name} · EU {Number(item.size_eu)}
                  </legend>
                  <input type="hidden" name="itemId" value={item.id} />
                  <div className="mt-1 grid grid-cols-2 gap-3">
                    <label>
                      Restock
                      <input name={`restock-${item.id}`} type="number" min={0} max={item.quantity} defaultValue={item.quantity} className={`${INPUT} h-10`} />
                    </label>
                    <label>
                      Write off
                      <input name={`writeOff-${item.id}`} type="number" min={0} max={item.quantity} defaultValue={0} className={`${INPUT} h-10`} />
                    </label>
                  </div>
                </fieldset>
              ))}
              <NoteField />
            </OrderActionForm>
          ) : null}

          {order.status === "delivered" && order.payment_status === "pending" ? (
            <OrderActionForm {...form("payment")} submitLabel="Record cash collected">
              <input type="hidden" name="paymentAction" value="collected" />
              <input type="hidden" name="amount" value={String(order.total_paisa / 100)} />
              <p className="text-xs text-muted">Records that {rupees(order.total_paisa)} was collected. The app doesn’t move money.</p>
            </OrderActionForm>
          ) : null}

          {order.payment_status === "collected" && order.status === "delivered" ? (
            <OrderActionForm {...form("payment")} submitLabel="Record courier payment received">
              <input type="hidden" name="paymentAction" value="settled" />
              <ReferenceField label="Remittance reference" />
            </OrderActionForm>
          ) : null}

          {order.payment_status === "refund_due" ? (
            <OrderActionForm {...form("payment")} submitLabel="Record refund made">
              <input type="hidden" name="paymentAction" value="refunded" />
              <div>
                <label className={LABEL} htmlFor="amount">Amount refunded (Rs.)</label>
                <input id="amount" name="amount" inputMode="decimal" className={`${INPUT} h-10`} required
                  defaultValue={String((order.collected_paisa ?? 0) / 100)} />
              </div>
              <ReferenceField label="How it was refunded (reference)" />
            </OrderActionForm>
          ) : null}

          {open ? (
            <OrderActionForm {...form("cancel")} submitLabel="Cancel order" tone="danger" confirmText="Cancel this order and release its items?">
              <div>
                <label className={LABEL} htmlFor="reason">Reason</label>
                <select id="reason" name="reason" className={`${INPUT} h-10`} defaultValue="customer_request">
                  <option value="customer_request">Customer asked to cancel</option>
                  <option value="unreachable">Couldn’t reach the customer</option>
                  <option value="spam">Fake or spam order</option>
                  <option value="out_of_stock">Item not available</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <NoteField />
            </OrderActionForm>
          ) : null}
        </section>

        <section aria-labelledby="history-heading">
          <h2 id="history-heading" className="text-lg font-bold">History</h2>
          <ol className="mt-3 space-y-2 text-sm">
            {order.order_events.map((event) => (
              <li key={event.id} className="border-l-2 border-line pl-3">
                <span className="font-semibold">{event.kind.replace(/_/g, " ")}</span>
                <span className="text-muted"> · {event.actor} · {dateTime.format(new Date(event.created_at))}</span>
                {event.note ? <p className="text-ink/85">{event.note}</p> : null}
              </li>
            ))}
          </ol>
          <div className="mt-4">
            <OrderActionForm {...form("note")} submitLabel="Add note">
              <NoteField required />
            </OrderActionForm>
          </div>
        </section>
      </div>

      <section aria-labelledby="items-heading" className="rounded-lg bg-cream p-5 text-sm">
        <h2 id="items-heading" className="text-base font-bold">Items</h2>
        <ul className="mt-3 space-y-2">
          {order.order_items.map((item) => (
            <li key={item.id} className="flex justify-between gap-4">
              <span className="min-w-0">
                {item.quantity} × {item.brand} {item.product_name}
                <span className="block text-xs text-muted">
                  EU {Number(item.size_eu)} · {item.sku} · {item.colour}
                </span>
              </span>
              <span className="shrink-0">{rupees(item.line_total_paisa)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 border-t border-line pt-3">
          <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd>{rupees(order.subtotal_paisa)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Delivery</dt><dd>{order.delivery_paisa === 0 ? "Free" : rupees(order.delivery_paisa)}</dd></div>
          <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{rupees(order.total_paisa)}</dd></div>
          {order.collected_paisa !== null ? <div className="flex justify-between"><dt className="text-muted">Collected</dt><dd>{rupees(order.collected_paisa)}</dd></div> : null}
          {order.refunded_paisa !== null ? <div className="flex justify-between"><dt className="text-muted">Refunded</dt><dd>{rupees(order.refunded_paisa)}</dd></div> : null}
        </dl>
      </section>
    </div>
  );
}

function NoteField({ required = false }: { required?: boolean }) {
  return (
    <label className={LABEL}>
      {required ? "Note" : "Note (optional)"}
      <input name="note" className={`${INPUT} mt-1 h-10 font-normal`} maxLength={1000} required={required} />
    </label>
  );
}

function ReferenceField({ label }: { label: string }) {
  return (
    <div>
      <label className={LABEL}>
        {label}
        <input name="reference" className={`${INPUT} mt-1 h-10`} maxLength={100} />
      </label>
    </div>
  );
}
