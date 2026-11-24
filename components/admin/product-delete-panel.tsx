"use client";

import Link from "@/components/admin/admin-link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deleteProductAction, type DeleteProductState } from "@/app/admin/products/actions";
import { SubmitButton, useRequestAction } from "@/components/admin/agent-forms";
import { BLOCKER_TEXT, type DeletionPreview } from "@/lib/admin/product-deletion";
import { ORDER_STATUS_LABELS } from "@/lib/checkout/types";
import { formatPrice } from "@/lib/format";

/*
 * "Delete permanently" on a product's edit page. Shows exactly what goes
 * (the product, its sizes and photos, and every order containing it, whole),
 * what blocks it, and asks for the item code before sending. The database
 * checks all of it again (public.admin_delete_product) and refuses if
 * anything changed since this page loaded.
 */

const dateFormat = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeZone: "Asia/Karachi" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ProductDeletePanel({ preview }: { preview: DeletionPreview }) {
  const router = useRouter();
  const { product, orders } = preview;
  const [typed, setTyped] = useState("");
  const r = useRequestAction(deleteProductAction, {
    label: "Delete permanently",
    storageKey: `product-delete:${product.id}`,
    onDone: (state) => {
      const code = (state as DeleteProductState).deletedItemCode ?? product.item_code;
      router.replace(`/admin/products?deleted=${encodeURIComponent(code)}`);
    },
  });
  const state = r.state as DeleteProductState;
  const matches = typed.trim().toUpperCase() === product.item_code;

  const summary = [
    `Permanently delete ${product.item_code}?`,
    `This removes the product, ${plural(preview.sizes, "size")} and ${plural(preview.photos, "photo")}`,
    orders.length ? `and ${plural(orders.length, "order")} (${orders.map((o) => o.order_number).join(", ")}), including every other product in them.` : ".",
    "It can't be undone.",
  ].join(" ");

  return (
    <section aria-labelledby="delete-heading" className="rounded-lg border border-danger p-4 md:p-5">
      <h2 id="delete-heading" className="text-lg font-bold text-danger">Delete permanently</h2>
      <p className="mt-1 text-sm">
        Removes this product, its {plural(preview.sizes, "size")} and {plural(preview.photos, "photo")} from the shop and the
        database for good. To only hide it, use <strong>Archive</strong> above instead.
      </p>

      {orders.length > 0 ? (
        <div className="mt-4">
          <p className="text-sm font-semibold">
            It is in {plural(orders.length, "order")}. {orders.length === 1 ? "That order is" : "Those orders are"} deleted too, whole: customer
            details, payment records, referral commission and any other products in {orders.length === 1 ? "it" : "them"}.
          </p>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line text-sm">
            {orders.map((o) => (
              <li key={o.id} className="p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <Link href={`/admin/orders/${o.id}`} className="font-mono font-semibold link-underline">{o.order_number}</Link>
                  <span className="text-muted">
                    {ORDER_STATUS_LABELS[o.status] ?? o.status} · {formatPrice(o.total_paisa / 100)} · {dateFormat.format(new Date(o.created_at))}
                  </span>
                </div>
                {o.other_products.length > 0 ? (
                  <p className="mt-1 text-muted">Also contains: {o.other_products.join("; ")}</p>
                ) : null}
                {o.has_referral ? <p className="mt-1 text-muted">Its referral and agent commission record is deleted too.</p> : null}
                {o.blockers.map((b) => (
                  <p key={b} className="mt-1 font-medium text-danger">Blocks the delete: this order {BLOCKER_TEXT[b]}.</p>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted">It isn’t in any orders.</p>
      )}

      {preview.blocked && !r.unconfirmed ? (
        <p role="status" className="mt-4 text-sm font-medium text-danger">
          It can’t be deleted until the orders marked above are dealt with.
        </p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            if (!r.unconfirmed && !window.confirm(summary)) {
              e.preventDefault();
              return;
            }
            r.onSubmit(e);
          }}
        >
          <input type="hidden" name="requestId" value={r.requestId} />
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="token" value={preview.token} />
          <div>
            <label htmlFor="delete-confirm" className="mb-1 block text-sm font-semibold">
              Type <span className="font-mono">{product.item_code}</span> to confirm
            </label>
            <input
              id="delete-confirm"
              name="confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-11 w-full max-w-xs rounded-md border border-line bg-white px-3 font-mono text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest"
            />
          </div>
          <SubmitButton
            r={r}
            label={orders.length ? `Delete product and ${plural(orders.length, "order")}` : "Delete product"}
            busy="Deleting…"
            className="btn btn-outline h-11 text-danger"
            disabled={!matches}
          />
        </form>
      )}
      {state.message ? (
        <p aria-live="polite" className={`mt-3 text-sm ${state.ok ? "text-forest" : "font-medium text-danger"}`}>{state.message}</p>
      ) : null}
    </section>
  );
}
