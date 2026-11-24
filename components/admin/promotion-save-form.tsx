"use client";

import { useActionState } from "react";
import { savePromotionPlanAction, type PromotionSaveState } from "@/app/admin/pricing/promotions/actions";

export function PromotionSaveForm({ pending, label }: { pending: number; label: string }) {
  const [state, action, saving] = useActionState<PromotionSaveState>(savePromotionPlanAction, { ok: true, message: null });
  return (
    <form action={action} className="space-y-2">
      <button type="submit" className="btn btn-forest h-11" disabled={saving || pending === 0}>
        {saving ? "Saving…" : label}
      </button>
      {state.message ? (
        <p aria-live="polite" className={`text-sm ${state.ok ? "text-forest" : "font-medium text-danger"}`}>{state.message}</p>
      ) : null}
    </form>
  );
}
