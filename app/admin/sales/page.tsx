import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { RequestScope } from "@/components/admin/agent-forms";
import { CreateCampaignForm, RunScheduleForm } from "@/components/admin/pricing-forms";
import {
  getCoverage,
  getScheduleHealth,
  listCampaigns,
  REASONS,
  REFERENCE_REASONS,
  STATUS_LABELS,
  type Campaign,
  type Coverage,
  type ScheduleHealth,
  type StatusCoverage,
} from "@/lib/admin/pricing";
import { getAdminPageClient } from "@/lib/auth/admin";
import { formatBp } from "@/lib/pricing/rules";

export const metadata: Metadata = {
  title: "Sales",
};

export default function SalesPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Sales />
    </Suspense>
  );
}

const when = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Karachi" });
const pct = (bp: number | null) => (bp === null ? "—" : `${Math.floor(bp / 100)}%`);

function CoverageCard({ title, c, note }: { title: string; c: StatusCoverage; note: string }) {
  return (
    <div className="rounded-md border border-line p-3 text-sm">
      <h3 className="font-bold">{title}</h3>
      <p className="mt-1 text-2xl font-extrabold">{c.on_sale} <span className="text-base font-semibold text-muted">of {c.eligible} on sale ({pct(c.coverage_bp)})</span></p>
      <p>Target {formatBp(c.target_bp)}: {c.target} listing(s){c.gap > 0 ? <span className="font-semibold text-danger">, {c.gap} short</span> : null}.</p>
      {c.no_badge ? <p className="text-danger">{c.no_badge} on sale without a supported “was” price (no badge shown).</p> : null}
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}

async function Sales() {
  const { access, supabase } = await getAdminPageClient("/admin/sales");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin/sales" />;

  let coverage: Coverage | null = null;
  let campaigns: Campaign[] | null = null;
  let health: ScheduleHealth | null = null;
  try {
    [coverage, campaigns, health] = await Promise.all([getCoverage(supabase), listCampaigns(supabase), getScheduleHealth(supabase)]);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
  }

  return (
    <>
      <AdminNav current="sales" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Sales</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/85">
        Coverage counts published, in-stock listings (a product, not its sizes or pairs). Targets are merchandising aims, not a
        reason to discount below your margins. One sale runs at a time; choices stay as you make them.
      </p>
      {!coverage || !campaigns || !health ? (
        <p role="alert" className="mt-6 text-sm text-danger">Sales couldn’t be loaded right now.</p>
      ) : (
        <RequestScope>
          <div className="mt-6 space-y-10">
            <section aria-labelledby="coverage-heading" className="space-y-3">
              <h2 id="coverage-heading" className="text-lg font-bold">Coverage{coverage.current_campaign ? `: ${coverage.current_campaign.name}` : ""}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <CoverageCard title="New shoes" c={coverage.statuses.new} note="Choose the pairs kept at the regular price yourself; nothing rotates." />
                <CoverageCard title="Pre-loved" c={coverage.statuses.preloved} note="All eligible pre-loved listings are suggested by default." />
              </div>
              {coverage.manual_sales ? <p className="text-sm">{coverage.manual_sales} listing(s) have a manual sale price set in the product editor.</p> : null}
              {coverage.agents.excluding_sale_items > 0 && coverage.agents.preloved_on_sale > 0 ? (
                <p role="status" className="rounded-md border border-danger p-3 text-sm">
                  <strong>Agents:</strong> {coverage.agents.excluding_sale_items} of {coverage.agents.enabled} enabled agent code(s) don’t apply to sale
                  items, so they earn nothing on the {coverage.agents.preloved_on_sale} pre-loved listing(s) on sale (of {coverage.agents.preloved_eligible}).
                  To let them earn on ordinary sale products, change their terms on <Link href="/admin/agents" className="font-semibold text-forest link-underline">Agents</Link>{" "}
                  (“Discount on items already on sale? Yes”). Orders already placed keep their terms.
                </p>
              ) : null}
              {coverage.needs_review.length > 0 ? (
                <details open={coverage.needs_review.length <= 10}>
                  <summary className="cursor-pointer text-sm font-semibold text-danger">{coverage.needs_review.length} published listing(s) not yet in or out of the sale: review them</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {coverage.needs_review.map((p) => (
                      <li key={p.product_id}><span className="font-mono text-xs">{p.item_code}</span> {p.name} · {p.item_status === "new" ? "new" : "pre-loved"}{p.listed_at ? ` · listed ${p.listed_at}` : ""}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {coverage.no_badge.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">{coverage.no_badge.length} on sale without a “was” price (shown at the selling price only)</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {coverage.no_badge.map((p) => <li key={p.product_id}><span className="font-mono text-xs">{p.item_code}</span> {p.name}: {REFERENCE_REASONS[p.reason] ?? p.reason}</li>)}
                  </ul>
                </details>
              ) : null}
              {coverage.skipped.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">{coverage.skipped.length} selected but left out</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {coverage.skipped.map((p) => <li key={p.product_id}><span className="font-mono text-xs">{p.item_code}</span> {p.name}: {REASONS[p.reason] ?? p.reason}</li>)}
                  </ul>
                </details>
              ) : null}
              {coverage.kept_regular.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">{coverage.kept_regular.length} kept at the regular price by choice</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {coverage.kept_regular.map((p) => <li key={p.product_id}><span className="font-mono text-xs">{p.item_code}</span> {p.name}{p.note ? `: ${p.note}` : ""}</li>)}
                  </ul>
                </details>
              ) : null}
            </section>

            <section aria-labelledby="campaigns-heading" className="space-y-3">
              <h2 id="campaigns-heading" className="text-lg font-bold">Sales campaigns</h2>
              {campaigns.length === 0 ? <p className="text-sm text-muted">No sales yet.</p> : (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {campaigns.map((c) => (
                    <li key={c.id} className="p-3 text-sm">
                      <Link href={`/admin/sales/${c.id}`} className="font-semibold text-forest link-underline">{c.name}</Link>{" "}
                      <span className="rounded bg-cream px-1.5 py-0.5 text-xs">{STATUS_LABELS[c.status]}</span>
                      {c.due ? <span className="ml-1 rounded bg-danger px-1.5 py-0.5 text-xs text-white">{c.due === "start" ? "start due" : "end due"}</span> : null}
                      <p className="text-xs text-muted">
                        {formatBp(c.discount_bp)} off · {when.format(new Date(c.starts_at))} → {c.ends_at ? when.format(new Date(c.ends_at)) : "no end set"} · {c.included} chosen, {c.kept_regular} kept regular, {c.live} on sale now
                        {c.referral_allowed ? "" : " · no referral discounts"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="schedule-heading" className="space-y-2">
              <h2 id="schedule-heading" className="text-lg font-bold">Scheduled starts and ends</h2>
              <p className="text-sm">
                {health.heartbeat?.last_succeeded_at
                  ? `The schedule job last ran ${when.format(new Date(health.heartbeat.last_succeeded_at))}.`
                  : "The schedule job hasn’t run yet (supabase/setup/schedule_sale_campaigns.sql sets it up; README, “Score pricing and sales”)."}
                {health.heartbeat?.last_error && health.heartbeat.consecutive_failures > 0 ? <span className="text-danger"> Last problem: {health.heartbeat.last_error}</span> : null}
              </p>
              {health.overdue.length > 0 ? <p className="text-sm font-semibold text-danger">Overdue: {health.overdue.map((c) => c.name).join(", ")}.</p> : null}
              <RunScheduleForm />
            </section>

            <section aria-labelledby="new-sale-heading" className="space-y-3">
              <h2 id="new-sale-heading" className="text-lg font-bold">New sale</h2>
              <p className="text-sm text-muted">Presets are starting points you can edit. Nothing classifies stock as slow-selling for you.</p>
              <CreateCampaignForm />
            </section>
          </div>
        </RequestScope>
      )}
    </>
  );
}
