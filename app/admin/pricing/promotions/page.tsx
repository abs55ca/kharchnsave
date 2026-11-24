import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { PromotionSaveForm } from "@/components/admin/promotion-save-form";
import { buildPreview, getPromotionOverview } from "@/lib/admin/promotions";
import { getAdminPageClient } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/format";
import { DISTRIBUTION, formatPercentHundredths, OPTIONS_BP } from "@/lib/promotions/plan";

export const metadata: Metadata = {
  title: "Promotion planner",
};

export default function PromotionsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Promotions />
    </Suspense>
  );
}

const rupees = (paisa: number) => formatPrice(paisa / 100);

async function Promotions() {
  const href = "/admin/pricing/promotions";
  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  let preview: ReturnType<typeof buildPreview>;
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
    preview = buildPreview(await getPromotionOverview(supabase), today);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
    return (
      <>
        <AdminNav current="pricing" email={access.email} />
        <p role="alert" className="text-sm font-medium text-danger">The promotion planner couldn’t be loaded right now.</p>
      </>
    );
  }
  const { rows } = preview;
  const pending = preview.unsaved + preview.outdated;

  return (
    <>
      <AdminNav current="pricing" email={access.email} />
      <Link href="/admin/pricing" className="text-sm font-semibold text-forest link-underline">← Pricing</Link>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">Promotion planner</h1>

      <div className="mt-4 max-w-3xl space-y-3 text-sm">
        <p>
          Each product gets a discount percentage, and the <strong>proposed regular price</strong> that would make its current selling price
          that discount: selling price ÷ (1 − discount), to the paisa. <strong>Nothing here changes a price.</strong> Selling prices, checkout
          and orders stay exactly as they are, and shoppers never see these proposals.
        </p>
        <p className="text-muted">
          The shop shows a crossed-out price only during a sale, and only a <strong>verified previous price</strong>: what the product was
          really offered at, from its price history (labelled “Was”). A proposal becomes usable only once the product has genuinely been sold
          at that price. The last column shows whether that check passes today. No MSRP or other reference
          price is on record.
        </p>
      </div>

      <section aria-labelledby="plan-heading" className="mt-6 space-y-3">
        <h2 id="plan-heading" className="text-lg font-bold">Assignments</h2>
        <p className="text-sm">
          {preview.basis === "age_and_sales"
            ? `Larger discounts go to older and slower-selling stock (${preview.reason}).`
            : `Default distribution, assigned at random with a fixed seed: stock age and sales aren't reliable yet (${preview.reason}).`}{" "}
          Every size of a model shares its percentage, and a saved percentage never changes.
        </p>
        <ul className="flex flex-wrap gap-2 text-sm">
          {OPTIONS_BP.map((bp) => (
            <li key={bp} className="rounded border border-line px-2 py-1">
              <strong>{bp / 100}%</strong>: {preview.distribution[bp]} product(s){" "}
              <span className="text-muted">
                ({rows.length ? Math.round((preview.distribution[bp] * 100) / rows.length) : 0}%, target {DISTRIBUTION[bp] / 100}%)
              </span>
            </li>
          ))}
        </ul>
        {pending > 0 ? (
          <p className="text-sm font-semibold">
            {preview.unsaved > 0 ? `${preview.unsaved} product(s) not saved yet` : ""}
            {preview.unsaved > 0 && preview.outdated > 0 ? "; " : ""}
            {preview.outdated > 0 ? `${preview.outdated} proposal(s) out of date (selling price changed)` : ""}.
          </p>
        ) : null}
        <PromotionSaveForm pending={pending} label={preview.unsaved > 0 ? "Save assignments" : "Refresh proposals"} />
      </section>

      <section aria-labelledby="preview-heading" className="mt-8">
        <h2 id="preview-heading" className="text-lg font-bold">Preview ({rows.length} products)</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-2 pr-3">Product</th>
                <th scope="col" className="py-2 pr-3">Score</th>
                <th scope="col" className="py-2 pr-3">Current selling price</th>
                <th scope="col" className="py-2 pr-3">Assigned</th>
                <th scope="col" className="py-2 pr-3">Proposed regular price</th>
                <th scope="col" className="py-2 pr-3">Actual saving</th>
                <th scope="col" className="py-2">Reference-price verification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.productId}>
                  <td className="py-2 pr-3">
                    <Link href={`/admin/products/${r.productId}`} className="font-semibold link-underline">{r.name}</Link>
                    <span className="block text-xs text-muted">
                      <span className="font-mono">{r.itemCode}</span> · EU {r.sizes.join(", ")} · {r.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{r.score ?? <span className="text-muted">manual</span>}</td>
                  <td className="py-2 pr-3 font-semibold">{rupees(r.sellingPaisa)}</td>
                  <td className="py-2 pr-3">
                    {r.discountBp / 100}%
                    {!r.saved ? <span className="block text-xs text-muted">not saved yet</span> : null}
                    {r.outdated ? <span className="block text-xs text-danger">out of date</span> : null}
                  </td>
                  <td className="py-2 pr-3">{rupees(r.proposedPaisa)}</td>
                  <td className="py-2 pr-3">
                    {rupees(r.savingPaisa)} <span className="text-muted">({formatPercentHundredths(r.actualHundredths)})</span>
                  </td>
                  <td className={`py-2 ${r.verified ? "text-forest" : "text-muted"}`}>
                    {r.verificationText}
                    {r.publicReferencePaisa !== null ? (
                      <span className="block text-xs text-ink">Shop shows now: Was {rupees(r.publicReferencePaisa)} (verified)</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
