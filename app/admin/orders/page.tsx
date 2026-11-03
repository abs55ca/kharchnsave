import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { OrderActionForm } from "@/components/admin/order-action-form";
import { getCheckoutConfig } from "@/lib/checkout/config";
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from "@/lib/checkout/types";
import {
  getOrderHealth,
  healthWarnings,
  isOrderTab,
  listOrders,
  ORDER_TABS,
  type OrderListItem,
  type OrderTab,
} from "@/lib/admin/orders";
import { getAdminPageClient } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Orders",
};

export default function OrdersPage({ searchParams }: PageProps<"/admin/orders">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Orders searchParams={searchParams} />
    </Suspense>
  );
}

const dateTime = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });

async function Orders({ searchParams }: Pick<PageProps<"/admin/orders">, "searchParams">) {
  const { tab: rawTab } = await searchParams;
  const tab: OrderTab = isOrderTab(rawTab) ? rawTab : "confirm";
  const href = `/admin/orders?tab=${tab}`;
  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  // Reading only: rendering never changes anything. If expired holds are
  // waiting, the banner offers a button (a POST) to release them now.
  const [health, orders] = await Promise.all([
    getOrderHealth(supabase),
    listOrders(supabase, tab).catch((error: Error) => {
      console.error("[admin]", error.message);
      return null;
    }),
  ]);
  const warnings = healthWarnings(health, getCheckoutConfig().problems, getCheckoutConfig().turnstileTestingKeys);

  return (
    <>
      <AdminNav current="orders" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Orders</h1>
      {warnings.length > 0 ? (
        <div role="alert" className="mt-4 max-w-3xl rounded-md border border-danger/30 p-4 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-danger">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <div className="mt-3">
            <OrderActionForm action="expire" submitLabel="Release expired holds now" />
          </div>
        </div>
      ) : null}

      <nav aria-label="Order status" className="mt-6 flex flex-wrap gap-1 border-b border-line">
        {(Object.keys(ORDER_TABS) as OrderTab[]).map((key) => (
          <Link
            key={key}
            href={`/admin/orders?tab=${key}`}
            aria-current={key === tab ? "page" : undefined}
            className={`-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-semibold ${
              key === tab ? "border-forest text-forest" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {ORDER_TABS[key].label}
          </Link>
        ))}
      </nav>

      {orders === null ? (
        <p role="alert" className="mt-6 text-sm text-danger">Orders couldn’t be loaded right now.</p>
      ) : orders.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No orders here.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </>
  );
}

function OrderRow({ order }: { order: OrderListItem }) {
  return (
    <li>
      <Link href={`/admin/orders/${order.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 hover:bg-cream">
        <span className="min-w-0">
          <span className="font-semibold">{order.order_number}</span>
          <span className="text-muted">
            {" "}
            · {order.channel === "in_store" ? "In store" : `${order.customer_name ?? ""}, ${order.city ?? ""}`}
          </span>
          <span className="block text-xs text-muted">
            {dateTime.format(new Date(order.created_at))}
            {order.hold_expires_at ? ` · hold until ${dateTime.format(new Date(order.hold_expires_at))}` : ""}
          </span>
        </span>
        <span className="text-right text-sm">
          <span className="font-semibold">{formatPrice(order.total_paisa / 100)}</span>
          <span className="block text-xs text-muted">
            {ORDER_STATUS_LABELS[order.status]} · {PAYMENT_STATUS_LABELS[order.payment_status]}
          </span>
        </span>
      </Link>
    </li>
  );
}
