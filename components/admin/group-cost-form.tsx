"use client";

import { useActionState, useState } from "react";
import { setGroupCostAction, type PricingFormState } from "@/app/admin/pricing/actions";
import type { PricingGroup } from "@/lib/admin/pricing";

/*
 * One cost per pair for every shoe in a group (Group totals). Setting the same
 * cost twice changes nothing, so a double click or a retry is harmless.
 */
export function GroupCostForm({ groups, shoes }: { groups: PricingGroup[]; shoes: Record<string, number> }) {
  const [state, action, pending] = useActionState<PricingFormState, FormData>(setGroupCostAction, { ok: false, message: null });
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const group = groups.find((g) => g.id === groupId);
  if (groups.length === 0) return null;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        const cost = new FormData(e.currentTarget).get("cost");
        if (!window.confirm(`Set the cost of all ${shoes[groupId] ?? 0} shoe(s) in ${group?.name ?? "this group"} to Rs. ${cost} each? This replaces any costs entered before. Prices don't change.`)) e.preventDefault();
      }}
      className="space-y-2 rounded-md border border-line p-3"
    >
      <p className="text-sm font-semibold">Same cost for every shoe in a group</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <label className="text-xs font-semibold">
          Group
          <select
            name="groupId"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-normal"
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name} ({shoes[g.id] ?? 0} shoes)</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold">
          Cost per pair (Rs.)
          <input
            name="cost"
            inputMode="decimal"
            required
            placeholder="e.g. 1000"
            className="mt-1 h-10 w-full rounded-md border border-line bg-white px-3 text-sm font-normal"
          />
        </label>
        <button type="submit" className="btn btn-forest h-10" disabled={pending}>
          {pending ? "Setting…" : "Set cost for all"}
        </button>
      </div>
      <p className="text-xs text-muted">
        Shoes added to the group later start without a cost: set it again to include them.
      </p>
      {state.message ? (
        <p role={state.ok ? "status" : "alert"} className={`text-sm font-medium ${state.ok ? "text-forest" : "text-danger"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
