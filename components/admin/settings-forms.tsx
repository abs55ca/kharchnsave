"use client";

import { useActionState } from "react";
import { saveCities, saveSettings, type SettingsState } from "@/app/admin/settings/actions";

export type ShopSettings = {
  version: number;
  orders_open: boolean;
  delivery_area_mode: "nationwide" | "selected" | null;
  standard_delivery_fee_paisa: number | null;
  free_delivery_enabled: boolean | null;
  free_delivery_min_paisa: number | null;
  hold_minutes: number | null;
  max_lines_per_order: number | null;
  max_units_per_order: number | null;
  max_units_per_line: number | null;
  max_open_orders_per_phone: number | null;
  place_attempts_per_ip_10min: number | null;
  place_attempts_per_ip_day: number | null;
  lookups_per_ip_10min: number | null;
  quotes_per_ip_10min: number | null;
  orders_per_minute_global: number | null;
  in_store_sells_unpublished: boolean | null;
};

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest aria-[invalid=true]:border-danger";
const LABEL = "mb-1 block text-sm font-semibold";
const HINT = "mt-1 text-xs text-muted";
const INITIAL: SettingsState = { ok: true, message: null };
const text = (n: number | null) => (n === null ? "" : String(n));
const rupeesText = (paisa: number | null) => (paisa === null ? "" : String(paisa / 100));

function NumberField({ name, label, hint, defaultValue, state }: { name: string; label: string; hint?: string; defaultValue: string; state: SettingsState }) {
  return (
    <div>
      <label className={LABEL} htmlFor={name}>{label}</label>
      <input id={name} name={name} inputMode="decimal" defaultValue={defaultValue} placeholder="Not decided"
        className={`${INPUT} h-10`} aria-invalid={state.field === name} />
      {hint ? <p className={HINT}>{hint}</p> : null}
    </div>
  );
}

export function SettingsForm({ settings }: { settings: ShopSettings }) {
  const [state, action, pending] = useActionState(saveSettings, INITIAL);
  const freeMode = settings.free_delivery_enabled === null ? "" : settings.free_delivery_enabled ? "minimum" : "none";
  return (
    <form action={action} className="max-w-2xl space-y-6">
      <input type="hidden" name="version" value={settings.version} />

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 font-bold">Ordering</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="ordersOpen" defaultChecked={settings.orders_open} className="mt-1" />
          <span>
            <span className="font-semibold">Take orders</span>
            <span className="block text-xs text-muted">
              Only possible once every setting below that orders need is decided. The website must also be configured
              (README, “Checkout”).
            </span>
          </span>
        </label>
        <NumberField name="holdHours" label="Hold unconfirmed orders for (hours)" defaultValue={settings.hold_minutes === null ? "" : String(settings.hold_minutes / 60)}
          hint="Items are held for a new order until you confirm it; after this, it is cancelled and the items go back on sale." state={state} />
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 font-bold">Delivery</legend>
        <div>
          <label className={LABEL} htmlFor="areaMode">Where you deliver</label>
          <select id="areaMode" name="areaMode" defaultValue={settings.delivery_area_mode ?? ""} className={`${INPUT} h-10`}>
            <option value="">Not decided</option>
            <option value="nationwide">Anywhere in Pakistan</option>
            <option value="selected">Only the cities listed below</option>
          </select>
        </div>
        <NumberField name="deliveryFee" label="Standard delivery fee (Rs.)" defaultValue={rupeesText(settings.standard_delivery_fee_paisa)} state={state} />
        <div>
          <label className={LABEL} htmlFor="freeDelivery">Free delivery</label>
          <select id="freeDelivery" name="freeDelivery" defaultValue={freeMode} className={`${INPUT} h-10`}>
            <option value="">Not decided</option>
            <option value="none">Never free</option>
            <option value="minimum">Free when the items cost at least…</option>
          </select>
        </div>
        <NumberField name="freeMinimum" label="Free delivery from (Rs., inclusive)" defaultValue={rupeesText(settings.free_delivery_min_paisa)}
          hint="Inclusive: 5000 means Rs. 5,000 and above are free. “Above Rs. 4,999” would be 4999.01 (it includes Rs. 4,999.50)." state={state} />
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 font-bold">Order limits</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField name="maxLines" label="Sizes per order" defaultValue={text(settings.max_lines_per_order)} state={state} />
          <NumberField name="maxUnits" label="Pairs per order" defaultValue={text(settings.max_units_per_order)} state={state} />
          <NumberField name="maxUnitsPerLine" label="Pairs of one size per order" defaultValue={text(settings.max_units_per_line)} state={state} />
          <NumberField name="maxPerPhone" label="Unconfirmed orders per phone number" defaultValue={text(settings.max_open_orders_per_phone)}
            hint="A supplementary check: anyone can type a different number." state={state} />
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 font-bold">Protection against fake orders</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField name="ip10" label="Order attempts per connection, per 10 minutes" defaultValue={text(settings.place_attempts_per_ip_10min)} state={state} />
          <NumberField name="ipDay" label="Order attempts per connection, per day" defaultValue={text(settings.place_attempts_per_ip_day)} state={state} />
          <NumberField name="lookups10" label="Order-page lookups per connection, per 10 minutes" defaultValue={text(settings.lookups_per_ip_10min)} state={state} />
          <NumberField name="quotes10" label="Price checks per connection, per 10 minutes" defaultValue={text(settings.quotes_per_ip_10min)}
            hint="Checkout re-checks prices when the cart or city changes." state={state} />
          <NumberField name="globalMinute" label="Order attempts per minute, whole shop" defaultValue={text(settings.orders_per_minute_global)} state={state} />
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-line p-4">
        <legend className="px-1 font-bold">In-store sales</legend>
        <div>
          <label className={LABEL} htmlFor="inStoreUnpublished">Sell draft or archived products in the shop</label>
          <select id="inStoreUnpublished" name="inStoreUnpublished" className={`${INPUT} h-10`}
            defaultValue={settings.in_store_sells_unpublished === null ? "" : settings.in_store_sells_unpublished ? "yes" : "no"}>
            <option value="">Not decided (refused)</option>
            <option value="yes">Yes</option>
            <option value="no">No, published products only</option>
          </select>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-forest h-11" disabled={pending}>{pending ? "Saving…" : "Save settings"}</button>
        <p aria-live="polite" className={`text-sm ${state.ok ? "text-muted" : "font-medium text-danger"}`}>{state.message}</p>
      </div>
    </form>
  );
}

export function CitiesForm({ version, cities }: { version: number; cities: { city: string; fee_paisa: number | null }[] }) {
  const [state, action, pending] = useActionState(saveCities, INITIAL);
  return (
    <form action={action} className="max-w-2xl space-y-3">
      <input type="hidden" name="version" value={version} />
      <label className={LABEL} htmlFor="cities">Delivery cities</label>
      <textarea id="cities" name="cities" rows={6} className={`${INPUT} py-2`} aria-invalid={state.field === "cities"}
        defaultValue={cities.map((c) => (c.fee_paisa === null ? c.city : `${c.city}, ${c.fee_paisa / 100}`)).join("\n")} />
      <p className={HINT}>
        One per line: “Lahore” for the standard fee, or “Lahore, 250” for its own fee. Used when you deliver only to listed
        cities; a fee here also applies when you deliver everywhere. Use the courier’s city names.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-outline h-10" disabled={pending}>{pending ? "Saving…" : "Save cities"}</button>
        <p aria-live="polite" className={`text-sm ${state.ok ? "text-muted" : "font-medium text-danger"}`}>{state.message}</p>
      </div>
    </form>
  );
}
