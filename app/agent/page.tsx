import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AgentSignOutButton } from "@/components/agent/agent-forms";
import { CopyButton } from "@/components/copy-button";
import { formatPercent } from "@/lib/agents/code";
import { AGENT_PAGE_SIZE, AGENT_STATE_LABELS, getDashboard, getPayouts, getReferrals, type AgentDashboard, type AgentPayouts, type AgentReferral } from "@/lib/agents/dashboard";
import { getAgentPageClient, type AgentAccess } from "@/lib/auth/agent";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your referrals",
};

export default function AgentHomePage({ searchParams }: PageProps<"/agent">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Checking your access…</p>}>
      <AgentHome searchParams={searchParams} />
    </Suspense>
  );
}

const KARACHI = "Asia/Karachi";
const dateTime = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: KARACHI });
const dateOnly = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeZone: KARACHI });
const money = (paisa: number) => (paisa < 0 ? `−${formatPrice(-paisa / 100)}` : formatPrice(paisa / 100));
const pageNumber = (value: string | string[] | undefined) => {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : 0;
};

// Reads the session, so it renders per request behind the boundary and is
// never cached (the proxy also marks every /agent response no-store).
async function AgentHome({ searchParams }: Pick<PageProps<"/agent">, "searchParams">) {
  const { access, supabase } = await getAgentPageClient("/agent");
  if (!supabase || access.status !== "agent") return <AccessProblem access={access} />;
  const query = await searchParams;
  const referralPage = pageNumber(query.page);
  const payoutPage = pageNumber(query.payouts);

  let data: [AgentDashboard, { total: number; rows: AgentReferral[] }, AgentPayouts] | null = null;
  try {
    data = await Promise.all([getDashboard(supabase), getReferrals(supabase, referralPage), getPayouts(supabase, payoutPage)]);
  } catch (error) {
    console.error("[agent]", (error as Error).message);
  }
  if (!data) {
    return (
      <p role="alert" className="text-sm text-danger">
        Your figures couldn’t be loaded right now. <Link href="/agent" className="font-semibold link-underline">Try again</Link>
      </p>
    );
  }
  const [dashboard, referrals, payouts] = data;
  return <Dashboard dashboard={dashboard} referrals={referrals} payouts={payouts} referralPage={referralPage} payoutPage={payoutPage} />;
}

function AccessProblem({ access }: { access: AgentAccess }) {
  const text =
    access.status === "suspended"
      ? "Your agent access is paused. Ask the shop if you think this is a mistake. Your earnings are kept."
      : access.status === "not-agent"
        ? "This login isn’t a sales-agent account."
        : "We couldn’t check your access right now, so the agent area stays locked.";
  return (
    <section className="max-w-xl">
      <h1 className="text-2xl font-extrabold tracking-tight">Agent area</h1>
      <p className="mt-3 text-sm text-ink/85">{text}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {access.status === "unavailable" ? <Link href="/agent" className="btn btn-forest">Try again</Link> : null}
        <AgentSignOutButton />
      </div>
    </section>
  );
}

function Dashboard({
  dashboard: d,
  referrals,
  payouts,
  referralPage,
  payoutPage,
}: {
  dashboard: AgentDashboard;
  referrals: { total: number; rows: AgentReferral[] };
  payouts: AgentPayouts;
  referralPage: number;
  payoutPage: number;
}) {
  const t = d.totals;
  const cards: [string, number, string][] = [
    ["Estimated", t.awaiting_delivery_paisa, "Orders not delivered yet"],
    ["Held", t.held_paisa, "30 days from delivery"],
    ["Waiting for courier payment", t.awaiting_payment_paisa, "Hold over; the courier hasn’t paid the shop yet"],
    ...(t.on_hold_paisa > 0 ? [["On hold", t.on_hold_paisa, "The shop is checking a return"] as [string, number, string]] : []),
    ["Available", t.available_paisa, "Will be included in your next payout"],
    ["Paid to you", t.paid_paisa, "All payouts so far"],
    ["Adjustments", t.outstanding_adjustments_paisa, "Not yet settled by a payout"],
  ];
  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow text-muted">Kharch n Save sales agents</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl">Hi, {d.display_name}</h1>
        </div>
        <AgentSignOutButton />
      </header>

      <section aria-labelledby="code-heading" className="rounded-lg bg-cream p-5">
        <h2 id="code-heading" className="text-sm font-semibold text-muted">Your referral code</h2>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="font-mono text-3xl font-extrabold tracking-wider">{d.code}</span>
          <CopyButton value={d.code} label="Copy code" />
        </div>
        {d.code_enabled ? (
          <p className="mt-3 text-sm">
            Customers get <strong>{formatPercent(d.discount_bp)} off</strong> qualifying products
            {d.applies_to_sale_items === false ? " (not items already on sale)" : ""}. You earn{" "}
            <strong>{d.commission_bp === null ? "—" : formatPercent(d.commission_bp)}</strong> of those products after the discount.
            Delivery charges don’t earn commission. Anyone can share your code.
          </p>
        ) : (
          <p className="mt-3 text-sm font-medium text-danger">Your code isn’t being accepted at checkout at the moment. Ask the shop.</p>
        )}
      </section>

      <section aria-labelledby="earnings-heading">
        <h2 id="earnings-heading" className="text-lg font-bold">Your earnings</h2>
        <p className="mt-1 text-sm text-muted">
          {t.referred_orders} referred {t.referred_orders === 1 ? "order" : "orders"} · {t.cancelled_orders} cancelled · {t.returned_orders} returned
          {t.reversed_paisa > 0 ? ` (${money(t.reversed_paisa)} reversed)` : ""}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {cards.map(([label, value, hint]) => (
            <div key={label} className="rounded-lg border border-line p-3">
              <dt className="text-xs font-semibold text-muted">{label}</dt>
              <dd className={`mt-1 text-lg font-bold ${value < 0 ? "text-danger" : ""}`}>{money(value)}</dd>
              <dd className="mt-0.5 text-xs text-muted">{hint}</dd>
            </div>
          ))}
        </dl>
        {d.upcoming_releases.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Next releases</h3>
            <ul className="mt-1 space-y-1 text-sm">
              {d.upcoming_releases.map((r) => (
                <li key={r.order_number} className="flex justify-between gap-3">
                  <span>{r.order_number} · {dateTime.format(new Date(r.release_at))}</span>
                  <span>{money(r.commission_paisa)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted">Times are Pakistan time. After release, it becomes available once the courier has paid the shop.</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="referrals-heading">
        <h2 id="referrals-heading" className="text-lg font-bold">Referred orders</h2>
        {referrals.rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No orders with your code yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {referrals.rows.map((r) => (
              <li key={r.order_number} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto] sm:gap-4">
                <div>
                  <p className="font-semibold">{r.order_number} <span className="font-normal text-muted">· {dateOnly.format(new Date(r.placed_at))}</span></p>
                  <p className="text-xs text-muted">
                    Products {money(r.eligible_subtotal_paisa)} · customer discount {money(r.discount_paisa)} · your rate {formatPercent(r.commission_bp)}
                  </p>
                  <p className="text-xs">
                    {AGENT_STATE_LABELS[r.state]}
                    {r.state === "held" && r.release_at ? ` until ${dateTime.format(new Date(r.release_at))}` : ""}
                  </p>
                </div>
                <p className={`font-semibold sm:text-right ${r.earned_paisa === 0 ? "text-muted line-through" : ""}`}>
                  {money(r.commission_paisa)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Pager total={referrals.total} page={referralPage} param="page" other={{ payouts: payoutPage }} />
      </section>

      <section aria-labelledby="payouts-heading">
        <h2 id="payouts-heading" className="text-lg font-bold">Payouts and adjustments</h2>
        {payouts.payouts.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No payouts yet.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {payouts.payouts.map((p, i) => (
              <li key={i} className="flex justify-between gap-3 rounded-md border border-line p-3">
                <span>
                  {dateOnly.format(new Date(p.paid_on))} · {p.orders} {p.orders === 1 ? "order" : "orders"}
                  {p.reference ? <span className="block text-xs text-muted">Ref. {p.reference}</span> : null}
                </span>
                <span className="font-semibold">{money(p.amount_paisa)}</span>
              </li>
            ))}
          </ul>
        )}
        <Pager total={payouts.total} page={payoutPage} param="payouts" other={{ page: referralPage }} />
        {payouts.adjustments.length > 0 ? (
          <ul className="mt-4 space-y-1 text-sm">
            {payouts.adjustments.map((a, i) => (
              <li key={i} className="flex justify-between gap-3 border-b border-line py-1">
                <span>
                  {a.reason}
                  <span className="block text-xs text-muted">{dateOnly.format(new Date(a.created_at))} · {a.settled ? "settled in a payout" : "applies to your next payout"}</span>
                </span>
                <span className={a.amount_paisa < 0 ? "font-semibold text-danger" : "font-semibold"}>{money(a.amount_paisa)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function Pager({ total, page, param, other }: { total: number; page: number; param: string; other: Record<string, number> }) {
  const pages = Math.ceil(total / AGENT_PAGE_SIZE);
  if (pages <= 1) return null;
  const href = (p: number) => `/agent?${new URLSearchParams({ ...Object.fromEntries(Object.entries(other).map(([k, v]) => [k, String(v)])), [param]: String(p) })}`;
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center gap-3 text-sm">
      {page > 0 ? <Link href={href(page - 1)} prefetch={false} className="font-semibold text-forest link-underline">← Newer</Link> : null}
      <span className="text-muted">Page {page + 1} of {pages}</span>
      {page + 1 < pages ? <Link href={href(page + 1)} prefetch={false} className="font-semibold text-forest link-underline">Older →</Link> : null}
    </nav>
  );
}
