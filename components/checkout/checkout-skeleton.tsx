/*
 * Placeholders for the checkout while it loads, at the sizes of what replaces
 * them (components/checkout/checkout-form.tsx), so the page doesn't jump when
 * the saved cart is read or the live quote arrives.
 */

const BAR = "rounded bg-cream";

/** The order summary's lines and totals while the quote is on its way. */
export function QuoteSkeleton({ lines }: { lines: number }) {
  return (
    <div aria-hidden="true">
      <ul className="mt-3 space-y-3">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
          <li key={i} className={`h-5 ${BAR}`} />
        ))}
      </ul>
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <div className={`h-5 ${BAR}`} />
        <div className={`h-5 ${BAR}`} />
        <div className="border-t border-line pt-2">
          <div className={`h-6 ${BAR}`} />
        </div>
      </div>
    </div>
  );
}

function FieldSkeleton({ tall = false, hint = false }: { tall?: boolean; hint?: boolean }) {
  return (
    <div>
      <div className={`mb-1.5 h-5 w-28 ${BAR}`} />
      <div className={`${tall ? "h-[90px]" : "h-11"} rounded-md border border-line`} />
      {hint ? <div className={`mt-1 h-4 w-3/4 ${BAR}`} /> : null}
    </div>
  );
}

/** The whole checkout (summary first on phones, then the delivery form) before the cart is read. */
export function CheckoutSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-8 lg:grid-cols-[1fr_380px] lg:items-start">
      <p role="status" className="sr-only">
        Loading your cart…
      </p>
      <div aria-hidden="true" className="space-y-5">
        <div className={`h-7 w-40 ${BAR}`} />
        <FieldSkeleton />
        <FieldSkeleton hint />
        <FieldSkeleton />
        <FieldSkeleton tall hint />
        <FieldSkeleton />
        <FieldSkeleton />
        <div className={`h-28 rounded-lg ${BAR}`} />
        <div className="h-[65px]" />
        <div className={`h-12 rounded-md ${BAR}`} />
      </div>
      <div aria-hidden="true" className="order-first rounded-lg border border-line p-5 lg:order-none">
        <div className={`h-6 w-28 ${BAR}`} />
        <QuoteSkeleton lines={1} />
      </div>
    </div>
  );
}
