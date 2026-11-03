"use client";

import { useActionState } from "react";
import { orderAction, type OrderActionState } from "@/app/admin/orders/actions";

const INITIAL: OrderActionState = { ok: true, message: null };

/**
 * One admin order action. The hidden fields identify the order, the version
 * the admin is looking at and this form's request id (so a double click is
 * applied once). The result is announced next to the button.
 */
export function OrderActionForm({
  action,
  orderId,
  version,
  requestId,
  submitLabel,
  tone = "outline",
  confirmText,
  children,
}: {
  action: string;
  orderId?: string;
  version?: number;
  requestId?: string;
  submitLabel: string;
  tone?: "forest" | "outline" | "danger";
  confirmText?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(orderAction, INITIAL);
  const toneClass = tone === "forest" ? "btn-forest" : tone === "danger" ? "btn-outline text-danger" : "btn-outline";
  return (
    <form
      action={formAction}
      className="space-y-3"
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      <input type="hidden" name="action" value={action} />
      {orderId ? <input type="hidden" name="orderId" value={orderId} /> : null}
      {version !== undefined ? <input type="hidden" name="version" value={version} /> : null}
      {requestId ? <input type="hidden" name="requestId" value={requestId} /> : null}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={`btn ${toneClass} h-10`} disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        <p aria-live="polite" className={`text-sm ${state.ok ? "text-muted" : "font-medium text-danger"}`}>
          {state.message}
        </p>
      </div>
    </form>
  );
}
