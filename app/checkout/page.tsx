import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CheckoutHandoff } from "@/components/cart/checkout-handoff";
import { CheckoutForm } from "@/components/checkout/checkout-form";
import { getCheckoutConfig } from "@/lib/checkout/config";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default function CheckoutPage() {
  return (
    <div className="container-page py-8 md:py-10">
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight md:text-3xl">Checkout</h1>
      <Suspense fallback={<p className="py-10 text-sm text-muted">Loading…</p>}>
        <Checkout />
      </Suspense>
    </div>
  );
}

// Whether checkout is open depends on server-only settings, read at request
// time (not baked in at build). Prices and stock are never rendered here: the
// form asks the database for a live quote.
async function Checkout() {
  await connection();
  const config = getCheckoutConfig();
  if (!config.enabled || !config.turnstileSiteKey) return <CheckoutHandoff />;
  return <CheckoutForm siteKey={config.turnstileSiteKey} />;
}
