import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { RequestScope } from "@/components/admin/agent-forms";
import { BulkPricingTable, CreateGroupForm, GroupMaxEditor, SettingsForm } from "@/components/admin/pricing-forms";
import { GroupCostForm } from "@/components/admin/group-cost-form";
import { GroupTotalsTable } from "@/components/admin/group-totals-table";
import { SizeSalesPanel } from "@/components/admin/size-sales-panel";
import { getPricingOverview, getPricingProducts, getGroupProducts, getGroupSizes, getSizeSaleOverview, isMissingFunction, type PricingOverview, type PricingProduct } from "@/lib/admin/pricing";
import type { SizeSaleOverview } from "@/lib/pricing/size-sale-types";
import { getAdminPageClient } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/format";
import { formatBp } from "@/lib/pricing/rules";

export const metadata: Metadata = {
  title: "Pricing",
};

export default function PricingPage({ searchParams }: PageProps<"/admin/pricing">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Pricing searchParams={searchParams} />
    </Suspense>
  );
}

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function Pricing({ searchParams }: Pick<PageProps<"/admin/pricing">, "searchParams">) {
  const query = await searchParams;
  const { access, supabase } = await getAdminPageClient("/admin/pricing");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin/pricing" />;

  const q = one(query.q).slice(0, 60);
  const status = ["new", "preloved"].includes(one(query.status)) ? one(query.status) : "";
  const mode = ["auto", "manual"].includes(one(query.mode)) ? one(query.mode) : "";
  const group = /^[0-9a-f-]{36}$/.test(one(query.group)) ? one(query.group) : "";
  let overview: PricingOverview | null = null;
  let products: { total: number; items: PricingProduct[] } | null = null;
  try {
    [overview, products] = await Promise.all([
      getPricingOverview(supabase),
      getPricingProducts(supabase, { q, item_status: status || null, mode: mode || null, group_id: group || null, limit: 300 }),
    ]);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
  }
  // Each group's products: for the group totals and the sizes in Sales by size (null: couldn't be read).
  const groupProducts: Record<string, PricingProduct[] | null> = overview
    ? Object.fromEntries(await Promise.all(overview.groups.map(async (g) => [g.id, await getGroupProducts(supabase, g.id).catch((error) => {
        console.error("[admin]", (error as Error).message);
        return null;
      })] as const)))
    : {};
  // Optional on this page: without the size sales migration, only this section is unavailable.
  let sizeSales: Record<string, SizeSaleOverview> | null = null;
  let groupSizes: Record<string, { size: number; products: number }[]> = {};
  let sizeSalesNotInstalled = false;
  if (overview) {
    try {
      const [list, sizes] = await Promise.all([
        Promise.all(overview.groups.map((g) => getSizeSaleOverview(supabase, g.id))),
        // Helpful, not essential: without it the panel just doesn't list the sizes.
        Promise.all(overview.groups.map(async (g) => {
          const items = groupProducts[g.id];
          return [g.id, items ? await getGroupSizes(supabase, items).catch(() => null) : null] as const;
        })),
      ]);
      sizeSales = Object.fromEntries(list.map((o) => [o.group_id, o]));
      groupSizes = Object.fromEntries(sizes.filter(([, v]) => v !== null)) as Record<string, { size: number; products: number }[]>;
    } catch (error) {
      // Not installed on this database yet is a setup state, shown below; anything else is an error.
      if (isMissingFunction(error)) sizeSalesNotInstalled = true;
      else console.error("[admin]", (error as Error).message);
    }
  }

  return (
    <>
      <AdminNav current="pricing" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Pricing</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/85">
        Rank each pair from 0 to 100 instead of pricing it by hand: its price is the group’s maximum × score, ending in your
        price ending. Products stay on their manual price until you opt them in. Nothing changes without a preview you confirm.
      </p>
      {!overview || !products ? (
        <p role="alert" className="mt-6 text-sm text-danger">Pricing couldn’t be loaded right now. If this is a new setup, the pricing migration may not be applied yet (README, “Score pricing and sales”).</p>
      ) : (
        <RequestScope>
          <div className="mt-6 space-y-10">
            <section aria-labelledby="status-heading" className="space-y-2">
              <h2 id="status-heading" className="text-lg font-bold">At a glance</h2>
              <ul className="grid gap-2 text-sm sm:grid-cols-4">
                <li className="rounded-md bg-cream p-3"><strong className="block text-xl">{overview.counts.auto}</strong>automatic</li>
                <li className="rounded-md bg-cream p-3"><strong className="block text-xl">{overview.counts.manual}</strong>manual</li>
                <li className={`rounded-md p-3 ${overview.counts.out_of_date ? "bg-danger/10" : "bg-cream"}`}><strong className="block text-xl">{overview.counts.out_of_date}</strong>automatic prices out of date</li>
                <li className="rounded-md bg-cream p-3"><strong className="block text-xl">{overview.counts.unknown_cost}</strong>published with unknown cost</li>
              </ul>
              {overview.agents.enabled > 0 ? (
                <p className="text-xs text-muted">
                  Enabled agent codes: {overview.agents.terms.map((t) => `${t.agents} × ${formatBp(t.discount_bp)} off / ${formatBp(t.commission_bp)} commission${t.applies_to_sale_items ? "" : " (not on sale items)"}`).join("; ")}.
                </p>
              ) : null}
            </section>

            <section aria-labelledby="groups-heading" className="space-y-4">
              <h2 id="groups-heading" className="text-lg font-bold">Groups and maximum prices</h2>
              <GroupMaxEditor groups={overview.groups} outOfDate={overview.counts.out_of_date} />
              <CreateGroupForm />
            </section>

            <section aria-labelledby="totals-heading" className="space-y-3">
              <h2 id="totals-heading" className="text-lg font-bold">Group totals</h2>
              <p className="text-sm text-muted">
                Only for you: what each group&apos;s pairs in stock sell for, what they cost, what agents take, and the profit left.
                Drafts count; archived and sold-out shoes don&apos;t.
              </p>
              <GroupTotalsTable
                rows={overview.groups.map((g) => ({
                  id: g.id,
                  name: g.name,
                  items: groupProducts[g.id]?.map(({ stock, price_paisa, sale_price_paisa, cost_paisa, publication_status }) => ({
                    stock, price_paisa, sale_price_paisa, cost_paisa, publication_status,
                  })) ?? null,
                }))}
                // Starts at the highest rates your agents have now.
                defaultDiscountBp={Math.max(0, ...overview.agents.terms.filter((t) => t.agents > 0).map((t) => t.discount_bp))}
                defaultCommissionBp={Math.max(0, ...overview.agents.terms.filter((t) => t.agents > 0).map((t) => t.commission_bp))}
              />
              <GroupCostForm
                groups={overview.groups}
                shoes={Object.fromEntries(Object.entries(groupProducts).map(([id, items]) => [id, items?.length ?? 0]))}
              />
            </section>

            <section aria-labelledby="size-sales-heading" className="space-y-4">
              <h2 id="size-sales-heading" className="text-lg font-bold">Sales by size</h2>
              {sizeSales ? (
                <SizeSalesPanel groups={overview.groups} overviews={sizeSales} sizes={groupSizes} />
              ) : sizeSalesNotInstalled ? (
                <p role="status" className="rounded-md border border-line p-3 text-sm">
                  Sales by size isn&apos;t set up on this database yet. It needs the database update{" "}
                  <code className="font-mono text-xs">supabase/migrations/20261124120000_size_sales.sql</code> (README, &ldquo;Sales by
                  size&rdquo;). Everything else on this page works without it.
                </p>
              ) : (
                <p role="alert" className="text-sm text-danger">Sales by size couldn&apos;t be loaded right now.</p>
              )}
            </section>

            <section aria-labelledby="bulk-heading" className="space-y-4">
              <h2 id="bulk-heading" className="text-lg font-bold">Set up products</h2>
              <form className="grid gap-2 sm:grid-cols-[1fr_9rem_9rem_12rem_auto] sm:items-end" action="/admin/pricing">
                <label className="text-xs font-semibold">Search<input name="q" defaultValue={q} className={`${INPUT} mt-1 h-10 font-normal`} placeholder="Name, brand or item code" /></label>
                <label className="text-xs font-semibold">Type
                  <select name="status" defaultValue={status} className={`${INPUT} mt-1 h-10 font-normal`}>
                    <option value="">All</option><option value="new">New</option><option value="preloved">Pre-loved</option>
                  </select>
                </label>
                <label className="text-xs font-semibold">Pricing
                  <select name="mode" defaultValue={mode} className={`${INPUT} mt-1 h-10 font-normal`}>
                    <option value="">All</option><option value="auto">Automatic</option><option value="manual">Manual</option>
                  </select>
                </label>
                <label className="text-xs font-semibold">Group
                  <select name="group" defaultValue={group} className={`${INPUT} mt-1 h-10 font-normal`}>
                    <option value="">All</option>
                    {overview.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </label>
                <button className="btn btn-outline h-10" type="submit">Filter</button>
              </form>
              <p className="text-xs text-muted">{products.total} product(s){products.total > products.items.length ? `, first ${products.items.length} shown` : ""}. Archived products are left out.</p>
              <BulkPricingTable products={products.items} groups={overview.groups} settings={overview.settings} />
            </section>

            <section aria-labelledby="settings-heading" className="space-y-4">
              <h2 id="settings-heading" className="text-lg font-bold">Settings</h2>
              <p className="text-sm text-muted">
                Currently prices end in {overview.settings.price_ending_rupees}
                {overview.settings.min_profit_paisa !== null ? `; minimum profit ${formatPrice(overview.settings.min_profit_paisa / 100)}` : ""}
                {overview.settings.min_margin_bp !== null ? `; minimum margin ${formatBp(overview.settings.min_margin_bp)}` : ""}. Sales:{" "}
                <Link href="/admin/sales" className="font-semibold text-forest link-underline">coverage and campaigns</Link>. Discount proposals:{" "}
                <Link href="/admin/pricing/promotions" className="font-semibold text-forest link-underline">promotion planner</Link>.
              </p>
              <SettingsForm settings={overview.settings} />
            </section>
          </div>
        </RequestScope>
      )}
    </>
  );
}
