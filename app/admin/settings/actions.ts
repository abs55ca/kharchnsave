"use server";

import { refresh } from "next/cache";
import { describeOrderError } from "@/lib/admin/orders";
import { rupeesToPaisa } from "@/lib/admin/product-input";
import { getAdminClient } from "@/lib/auth/admin";

/*
 * Shop settings and delivery cities, for verified admins. The database
 * checks the admin again, the version the form was opened with, every value's
 * range, and that ordering can only be switched on once everything required
 * is decided. A blank field means "not decided yet" (stored as null).
 */

export type SettingsState = { ok: boolean; message: string | null; field?: string };

const value = (formData: FormData, name: string) => {
  const v = formData.get(name);
  return typeof v === "string" ? v.trim() : "";
};

class FieldError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

function wholeNumber(formData: FormData, name: string, label: string): number | null {
  const v = value(formData, name);
  if (!v) return null;
  if (!/^\d{1,6}$/.test(v)) throw new FieldError(name, `${label}: enter a whole number, or leave it blank if not decided.`);
  return Number(v);
}

function rupees(formData: FormData, name: string, label: string): number | null {
  const v = value(formData, name);
  if (!v) return null;
  const paisa = rupeesToPaisa(v);
  if (paisa === null) throw new FieldError(name, `${label}: enter an amount in rupees, e.g. 300 or 4999.50.`);
  return paisa;
}

const choice = (formData: FormData, name: string): boolean | null =>
  value(formData, name) === "yes" ? true : value(formData, name) === "no" ? false : null;

export async function saveSettings(_previous: SettingsState, formData: FormData): Promise<SettingsState> {
  const { supabase } = await getAdminClient();
  if (!supabase) return { ok: false, message: "Admin access required. Sign in again in a new tab." };

  let settings: Record<string, unknown>;
  try {
    const hours = wholeNumber(formData, "holdHours", "Hold");
    const freeMode = value(formData, "freeDelivery");
    settings = {
      orders_open: formData.get("ordersOpen") === "on",
      delivery_area_mode: ["nationwide", "selected"].includes(value(formData, "areaMode")) ? value(formData, "areaMode") : null,
      standard_delivery_fee_paisa: rupees(formData, "deliveryFee", "Delivery fee"),
      free_delivery_enabled: freeMode === "minimum" ? true : freeMode === "none" ? false : null,
      free_delivery_min_paisa: freeMode === "minimum" ? rupees(formData, "freeMinimum", "Free delivery minimum") : null,
      hold_minutes: hours === null ? null : hours * 60,
      max_lines_per_order: wholeNumber(formData, "maxLines", "Sizes per order"),
      max_units_per_order: wholeNumber(formData, "maxUnits", "Pairs per order"),
      max_units_per_line: wholeNumber(formData, "maxUnitsPerLine", "Pairs of one size"),
      max_open_orders_per_phone: wholeNumber(formData, "maxPerPhone", "Unconfirmed orders per phone"),
      place_attempts_per_ip_10min: wholeNumber(formData, "ip10", "Attempts per connection (10 minutes)"),
      place_attempts_per_ip_day: wholeNumber(formData, "ipDay", "Attempts per connection (day)"),
      lookups_per_ip_10min: wholeNumber(formData, "lookups10", "Order lookups per connection"),
      quotes_per_ip_10min: wholeNumber(formData, "quotes10", "Price checks per connection"),
      orders_per_minute_global: wholeNumber(formData, "globalMinute", "Orders per minute"),
      in_store_sells_unpublished: choice(formData, "inStoreUnpublished"),
    };
    if (freeMode === "minimum" && settings.free_delivery_min_paisa === null) {
      throw new FieldError("freeMinimum", "Enter the free-delivery minimum, or choose another option.");
    }
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, message: error.message, field: error.field };
    throw error;
  }

  const version = Number(value(formData, "version"));
  const { error } = await supabase.rpc("admin_update_shop_settings", { p_expected_version: version, p_settings: settings });
  if (error) {
    console.error(`[admin] settings save failed: ${error.code || "no code"}`);
    return { ok: false, message: error.hint === "version_conflict" ? "The settings were changed elsewhere. Reload and try again." : describeOrderError(error) };
  }
  refresh();
  return { ok: true, message: "Settings saved." };
}

/** One city per line: "Lahore" (standard fee) or "Lahore, 250" (its own fee in rupees). */
export async function saveCities(_previous: SettingsState, formData: FormData): Promise<SettingsState> {
  const { supabase } = await getAdminClient();
  if (!supabase) return { ok: false, message: "Admin access required. Sign in again in a new tab." };

  const cities: { city: string; active: boolean; fee_paisa: number | null }[] = [];
  for (const line of value(formData, "cities").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, fee] = trimmed.split(",").map((part) => part.trim());
    const paisa = fee ? rupeesToPaisa(fee) : null;
    if (!name || (fee && paisa === null)) return { ok: false, message: `Couldn’t read “${trimmed}”. Use “City” or “City, fee”.`, field: "cities" };
    cities.push({ city: name, active: true, fee_paisa: paisa });
  }

  const { error } = await supabase.rpc("admin_save_delivery_cities", {
    p_expected_version: Number(value(formData, "version")),
    p_cities: cities,
  });
  if (error) {
    console.error(`[admin] cities save failed: ${error.code || "no code"}`);
    return {
      ok: false,
      message: error.code === "23505" ? "A city is listed twice." : error.hint === "version_conflict"
        ? "The settings were changed elsewhere. Reload and try again." : describeOrderError(error),
    };
  }
  refresh();
  return { ok: true, message: "Cities saved." };
}
