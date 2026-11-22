import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { RequestScope } from "@/components/admin/agent-forms";
import { CampaignApply, CampaignDetailsForm, CampaignEndForm, CampaignSelection } from "@/components/admin/pricing-forms";
import { getCampaign, getCampaignCandidates, STATUS_LABELS, type CampaignPlan, type Candidate } from "@/lib/admin/pricing";
import { getAdminPageClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { formatBp } from "@/lib/pricing/rules";

export const metadata: Metadata = {
  title: "Sale",
};

export default function SalePage({ params }: PageProps<"/admin/sales/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Sale params={params} />
    </Suspense>
  );
}

const when = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });

async function Sale({ params }: Pick<PageProps<"/admin/sales/[id]">, "params">) {
  const { id } = await params;
  const href = `/admin/sales/${id}`;
  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  let plan: CampaignPlan | null = null;
  let candidates: Candidate[] | null = null;
  let failed = false;
  if (UUID_PATTERN.test(id)) {
    try {
      [plan, candidates] = await Promise.all([getCampaign(supabase, id), getCampaignCandidates(supabase, id)]);
    } catch (error) {
      console.error("[admin]", (error as Error).message);
      failed = true;
    }
  }

  return (
    <>
      <AdminNav current="sales" email={access.email} />
      <Link href="/admin/sales" className="text-sm font-semibold text-forest link-underline">← Sales</Link>
      {failed ? (
        <p role="alert" className="mt-6 text-sm text-danger">This sale couldn’t be loaded right now.</p>
      ) : !plan || !candidates ? (
        <p className="mt-6 text-sm">Sale not found.</p>
      ) : (
        <RequestScope>
          <SaleView plan={plan} candidates={candidates} />
        </RequestScope>
      )}
    </>
  );
}

function SaleView({ plan, candidates }: { plan: CampaignPlan; candidates: Candidate[] }) {
  const c = plan.campaign;
  const editable = c.status === "draft" || c.status === "active";
  return (
    <div className="mt-4 space-y-10">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">{c.name}</h1>
        <p className="mt-1 text-sm">
          <span className="rounded bg-cream px-1.5 py-0.5 text-xs font-semibold">{STATUS_LABELS[c.status]}</span> · {formatBp(c.discount_bp)} off ·{" "}
          {when.format(new Date(c.starts_at))} → {c.ends_at ? when.format(new Date(c.ends_at)) : "no end set"}
          {c.referral_allowed ? " · referral codes apply as each agent’s terms say" : " · no referral-code discounts (disclosed to shoppers)"}
          {c.require_reference ? " · only products with a supported “was” price" : ""}
        </p>
        {c.due ? <p className="mt-1 text-sm font-semibold text-danger">Its {c.due} is due: the schedule job or “Run due starts and ends now” (Sales) applies it.</p> : null}
      </header>

      <section aria-labelledby="preview-heading" className="space-y-3">
        <h2 id="preview-heading" className="text-lg font-bold">{c.status === "draft" ? "Preview" : c.status === "active" ? "Running: prices and changes" : "Products"}</h2>
        <CampaignApply plan={plan} />
      </section>

      <section aria-labelledby="selection-heading" className="space-y-3">
        <h2 id="selection-heading" className="text-lg font-bold">Products</h2>
        <CampaignSelection campaign={c} candidates={candidates} editable={editable} />
      </section>

      {c.status === "draft" ? (
        <section aria-labelledby="details-heading" className="space-y-3">
          <h2 id="details-heading" className="text-lg font-bold">Details</h2>
          <CampaignDetailsForm campaign={c} />
        </section>
      ) : null}

      <section aria-labelledby="end-heading" className="flex flex-wrap gap-3">
        <h2 id="end-heading" className="sr-only">End or cancel</h2>
        {/* Always rendered (in a fixed order) so a result stays visible after the status changes. */}
        <CampaignEndForm key="end" campaign={c} action="end" available={c.status === "active"} label="End the sale now" tone="danger"
          confirmText="End this sale now? Every product in it goes back to its regular price." />
        <CampaignEndForm key="unschedule" campaign={c} action="unschedule" available={c.status === "scheduled"} label="Unschedule (back to draft)"
          confirmText="Unschedule this sale? It goes back to draft; nothing goes on sale." />
        <CampaignEndForm key="cancel" campaign={c} action="cancel" available={c.status === "draft" || c.status === "scheduled"} label="Cancel the sale" tone="danger"
          confirmText="Cancel this sale for good?" />
      </section>
    </div>
  );
}
