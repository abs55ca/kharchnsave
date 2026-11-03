import type { Metadata } from "next";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { CitiesForm, SettingsForm, type ShopSettings } from "@/components/admin/settings-forms";
import { getOrderHealth, healthWarnings } from "@/lib/admin/orders";
import { getAdminPageClient } from "@/lib/auth/admin";
import { getCheckoutConfig } from "@/lib/checkout/config";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Settings />
    </Suspense>
  );
}

async function Settings() {
  const { access, supabase } = await getAdminPageClient("/admin/settings");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin/settings" />;

  const [settings, cities, health] = await Promise.all([
    supabase.from("shop_settings").select("*").maybeSingle(),
    supabase.from("delivery_cities").select("city, fee_paisa").order("city"),
    getOrderHealth(supabase),
  ]);
  const warnings = healthWarnings(health, getCheckoutConfig().problems, getCheckoutConfig().turnstileTestingKeys);

  return (
    <>
      <AdminNav current="settings" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Settings</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-muted">
        Ordering, delivery and limits. Leave a field blank while it isn’t decided; the shop can’t take orders until the
        required ones are set.
      </p>
      {warnings.length > 0 ? (
        <ul role="alert" className="mb-6 max-w-2xl list-disc space-y-1 rounded-md border border-danger/30 p-4 pl-8 text-sm text-danger">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {settings.error || !settings.data ? (
        <p role="alert" className="text-sm text-danger">Settings couldn’t be loaded right now.</p>
      ) : (
        <div className="space-y-10">
          <SettingsForm settings={settings.data as ShopSettings} />
          <CitiesForm version={(settings.data as ShopSettings).version} cities={(cities.data ?? []) as { city: string; fee_paisa: number | null }[]} />
        </div>
      )}
    </>
  );
}
