import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { AdjustmentForm, AgentChangeForm, AgentVersionProvider, LoginLinkForm, PayoutForm, TermsFields } from "@/components/admin/agent-forms";
import { formatPercent } from "@/lib/agents/code";
import {
  ACCESS_LABELS,
  getAgent,
  getAgentCommissions,
  getAgentPayouts,
  PAGE_SIZE,
  PAYOUT_METHODS,
  STATE_LABELS,
  type AdminPayouts,
  type AgentDetail,
  type CommissionRow,
  type Page,
} from "@/lib/admin/agents";
import { getAdminPageClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Sales agent",
};

export default function AgentPage({ params, searchParams }: PageProps<"/admin/agents/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Agent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const LABEL = "mb-1 block text-sm font-semibold";
const KARACHI = "Asia/Karachi";
const dateTime = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short", timeZone: KARACHI });
const dateOnly = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeZone: KARACHI });
const signed = (paisa: number) => (paisa < 0 ? `−${formatPrice(-paisa / 100)}` : formatPrice(paisa / 100));
const pageNumber = (value: string | string[] | undefined) => {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : 0;
};

async function Agent({ params, searchParams }: Pick<PageProps<"/admin/agents/[id]">, "params" | "searchParams">) {
  const { id } = await params;
  const query = await searchParams;
  const href = `/admin/agents/${id}`;
  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  const referralPage = pageNumber(query.page);
  const payoutPage = pageNumber(query.payouts);
  let agent: AgentDetail | null = null;
  let commissions: Page<CommissionRow> | null = null;
  let payouts: AdminPayouts | null = null;
  let failed = false;
  if (UUID_PATTERN.test(id)) {
    try {
      [agent, commissions, payouts] = await Promise.all([
        getAgent(supabase, id),
        getAgentCommissions(supabase, id, referralPage),
        getAgentPayouts(supabase, id, payoutPage),
      ]);
    } catch (error) {
      console.error("[admin]", (error as Error).message);
      failed = true;
    }
  }

  return (
    <>
      <AdminNav current="agents" email={access.email} />
      <Link href="/admin/agents" className="text-sm font-semibold text-forest link-underline">
        ← All agents
      </Link>
      {failed ? (
        <p role="alert" className="mt-6 text-sm text-danger">This agent couldn’t be loaded right now.</p>
      ) : !agent || !commissions || !payouts ? (
        <p className="mt-6 text-sm">Agent not found.</p>
      ) : (
        <AgentVersionProvider version={agent.version}>
          <AgentDetailView agent={agent} commissions={commissions} payouts={payouts} referralPage={referralPage} payoutPage={payoutPage} />
        </AgentVersionProvider>
      )}
    </>
  );
}

function AgentDetailView({
  agent,
  commissions,
  payouts,
  referralPage,
  payoutPage,
}: {
  agent: AgentDetail;
  commissions: Page<CommissionRow>;
  payouts: AdminPayouts;
  referralPage: number;
  payoutPage: number;
}) {
  const t = agent.totals;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: KARACHI }).format(new Date());
  const payable = [
    ...agent.outstanding_adjustments.map((a) => ({
      id: a.id, kind: "adjustment" as const, amount_paisa: a.amount_paisa, required: a.amount_paisa < 0,
      label: `${a.kind === "manual" ? "Adjustment" : "Return after payout"}: ${a.reason}`,
    })),
    ...agent.available.map((c) => ({ id: c.order_id, kind: "order" as const, amount_paisa: c.commission_paisa, required: false, label: `Order ${c.order_number}` })),
  ];
  const base = { agentId: agent.id, version: agent.version };

  return (
    <div className="mt-4 space-y-10">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">{agent.display_name}</h1>
        <p className="mt-1 text-sm text-muted">
          @{agent.username} · {agent.email} · {ACCESS_LABELS[agent.access_status]} · added {dateOnly.format(new Date(agent.created_at))}
        </p>
        <p className="mt-2 text-sm">
          Code <span className="font-mono font-semibold">{agent.code}</span> ·{" "}
          <span className={agent.code_enabled ? "text-forest" : "text-danger"}>{agent.code_enabled ? "accepted at checkout" : "not accepted at checkout"}</span>
        </p>
      </header>

      <section aria-labelledby="totals-heading">
        <h2 id="totals-heading" className="text-lg font-bold">Earnings</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-7">
          {[
            ["Estimated (not delivered)", t.awaiting_delivery_paisa],
            ["Held (30 days)", t.held_paisa],
            ["Waiting for courier payment", t.awaiting_payment_paisa],
            ["On hold (admin)", t.on_hold_paisa],
            ["Available", t.available_paisa],
            ["Outstanding adjustments", t.outstanding_adjustments_paisa],
            ["Payable now", t.payable_paisa],
          ].map(([label, value]) => (
            <div key={label as string} className="rounded-lg border border-line p-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className={`mt-1 text-lg font-bold ${(value as number) < 0 ? "text-danger" : ""}`}>{signed(value as number)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">
          {t.referred_orders} referred orders · {t.cancelled_orders} cancelled · {t.returned_orders} returned (reversed {signed(t.reversed_paisa)}) · paid out {signed(t.paid_paisa)}
          {t.next_release_at ? ` · next release ${dateTime.format(new Date(t.next_release_at))}` : ""}
        </p>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="payout-heading" className="rounded-lg border border-line p-5">
          <h2 id="payout-heading" className="text-lg font-bold">Record a payout</h2>
          <p className="mt-1 text-xs text-muted">
            After paying the agent outside the app. Only available earnings can be paid, each once; every outstanding deduction is
            included.
          </p>
          <div className="mt-4">
            <PayoutForm agentId={agent.id} items={payable} today={today} />
          </div>
        </section>
        <section aria-labelledby="adjust-heading" className="rounded-lg border border-line p-5">
          <h2 id="adjust-heading" className="text-lg font-bold">Manual adjustment</h2>
          <p className="mt-1 text-xs text-muted">A correction with a reason; settled by the next payout. Recorded with your account and the time.</p>
          <div className="mt-4">
            <AdjustmentForm agentId={agent.id} />
          </div>
        </section>
      </div>

      <section aria-labelledby="referrals-heading">
        <h2 id="referrals-heading" className="text-lg font-bold">Referred orders</h2>
        <p className="mt-1 text-xs text-muted">Terms shown are the ones saved on each order when it was placed.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3">Placed</th>
                <th className="py-2 pr-3">Qualifying</th>
                <th className="py-2 pr-3">Discount</th>
                <th className="py-2 pr-3">Terms (saved)</th>
                <th className="py-2 pr-3">Commission</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {commissions.rows.map((c) => (
                <tr key={c.order_id} className="border-b border-line align-top">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/orders/${c.order_id}`} className="font-semibold text-forest link-underline">{c.order_number}</Link>
                  </td>
                  <td className="py-2 pr-3">{dateOnly.format(new Date(c.placed_at))}</td>
                  <td className="py-2 pr-3">{signed(c.eligible_subtotal_paisa)}</td>
                  <td className="py-2 pr-3">{signed(c.discount_paisa)}</td>
                  <td className="py-2 pr-3 text-xs">
                    {formatPercent(c.discount_bp)} off · {formatPercent(c.commission_bp)}
                    <span className="block text-muted">v{c.terms_version}{c.applies_to_sale_items ? " · incl. sale items" : ""}</span>
                  </td>
                  <td className="py-2 pr-3">
                    {signed(c.commission_paisa)}
                    {c.reversed_paisa > 0 ? <span className="block text-xs text-danger">reversed {signed(c.reversed_paisa)}</span> : null}
                  </td>
                  <td className="py-2 text-xs">
                    {STATE_LABELS[c.state]}
                    {c.state === "held" && c.release_at ? <span className="block text-muted">until {dateTime.format(new Date(c.release_at))}</span> : null}
                    {c.on_hold && c.hold_reason ? <span className="block text-danger">Hold: {c.hold_reason}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager total={commissions.total} page={referralPage} param="page" agentId={agent.id} other={{ payouts: payoutPage }} />
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-bold">Payouts and adjustments</h2>
        {payouts.payouts.length === 0 ? <p className="mt-2 text-sm text-muted">No payouts yet.</p> : (
          <ul className="mt-3 space-y-2 text-sm">
            {payouts.payouts.map((p) => (
              <li key={p.id} className="rounded-md border border-line p-3">
                <p className="font-semibold">
                  {signed(p.amount_paisa)} · {dateOnly.format(new Date(p.paid_on))} · {PAYOUT_METHODS[p.method as keyof typeof PAYOUT_METHODS] ?? p.method}
                  {p.reference ? ` · ${p.reference}` : ""}
                </p>
                <p className="text-xs text-muted">
                  {(p.lines ?? []).map((l) => `${l.order_number ?? "adjustment"} ${signed(l.amount_paisa)}`).join(" · ")}
                  {p.note ? ` · ${p.note}` : ""} · recorded {dateTime.format(new Date(p.created_at))}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Pager total={payouts.total} page={payoutPage} param="payouts" agentId={agent.id} other={{ page: referralPage }} />
        {payouts.adjustments.length > 0 ? (
          <ul className="mt-4 space-y-1 text-sm">
            {payouts.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                <span>
                  {a.kind === "manual" ? "Adjustment" : "Return after payout"}: {a.reason}
                  <span className="text-xs text-muted"> · {dateTime.format(new Date(a.created_at))} · {a.payout_id ? "settled" : "outstanding"}</span>
                </span>
                <span className={a.amount_paisa < 0 ? "text-danger" : ""}>{signed(a.amount_paisa)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="terms-heading" className="rounded-lg border border-line p-5">
          <h2 id="terms-heading" className="text-lg font-bold">Current terms</h2>
          <p className="mt-1 text-xs text-muted">Apply to orders placed from now on. Orders already placed keep their own terms.</p>
          <div className="mt-4">
            <AgentChangeForm action="terms" {...base} submitLabel="Save terms" tone="forest">
              <TermsFields discountBp={agent.discount_bp} commissionBp={agent.commission_bp} appliesToSale={agent.applies_to_sale_items} />
            </AgentChangeForm>
          </div>
        </section>

        <section aria-labelledby="access-heading" className="space-y-5 rounded-lg border border-line p-5">
          <h2 id="access-heading" className="text-lg font-bold">Code and access</h2>
          {agent.code_enabled ? (
            <AgentChangeForm action="disable-code" {...base} submitLabel="Stop accepting the code" tone="danger"
              confirmText="New orders won’t accept this code. Earnings so far are kept. Continue?" />
          ) : (
            <AgentChangeForm action="enable-code" {...base} submitLabel="Accept the code at checkout" tone="forest" />
          )}
          {agent.access_status === "active" ? (
            <AgentChangeForm action="suspend" {...base} submitLabel="Suspend their access" tone="danger"
              confirmText="They won’t be able to use the agent area. Their code keeps working unless you stop it. Continue?" />
          ) : agent.access_status === "suspended" ? (
            <AgentChangeForm action="reactivate" {...base} submitLabel="Restore their access" />
          ) : null}
          <div>
            <p className="text-sm">
              {agent.access_status === "pending"
                ? "Their login isn’t set up yet (or set-up was interrupted). This finishes it."
                : "A new one-time link for setting a password (e.g. if they forgot it)."}
            </p>
            <div className="mt-2">
              <LoginLinkForm agentId={agent.id} label={agent.access_status === "pending" ? "Finish set-up and create password link" : "Create password link"} />
            </div>
          </div>
        </section>
      </div>

      <section aria-labelledby="profile-heading" className="max-w-xl rounded-lg border border-line p-5">
        <h2 id="profile-heading" className="text-lg font-bold">Profile</h2>
        <p className="mt-1 text-xs text-muted">The referral code doesn’t change when these do.</p>
        <div className="mt-4">
          <AgentChangeForm action="profile" {...base} submitLabel="Save profile">
            <label className={LABEL}>
              Username
              <input name="username" className={`${INPUT} mt-1 h-10 font-normal`} defaultValue={agent.username} required maxLength={30} />
            </label>
            <label className={LABEL}>
              Display name
              <input name="displayName" className={`${INPUT} mt-1 h-10 font-normal`} defaultValue={agent.display_name} required maxLength={80} />
            </label>
          </AgentChangeForm>
        </div>
      </section>

      <section aria-labelledby="log-heading">
        <h2 id="log-heading" className="text-lg font-bold">Change log</h2>
        <ol className="mt-3 space-y-1 text-sm">
          {agent.events.map((e, i) => (
            <li key={i} className="border-l-2 border-line pl-3">
              <span className="font-semibold">{e.kind.replace(/_/g, " ")}</span>
              <span className="text-xs text-muted"> · {dateTime.format(new Date(e.created_at))}{e.actor_user_id ? ` · by ${e.actor_user_id.slice(0, 8)}` : ""}</span>
              {e.kind === "terms_changed" && e.details ? <TermsChange details={e.details} /> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function TermsChange({ details }: { details: Record<string, unknown> }) {
  const describe = (t: unknown) => {
    const terms = t as { discount_bp: number; commission_bp: number | null; applies_to_sale_items: boolean | null };
    return `${formatPercent(terms.discount_bp)} off, ${terms.commission_bp === null ? "no commission set" : `${formatPercent(terms.commission_bp)} commission`}, sale items ${terms.applies_to_sale_items === null ? "not chosen" : terms.applies_to_sale_items ? "included" : "excluded"}`;
  };
  return <p className="text-xs text-muted">{describe(details.from)} → {describe(details.to)}</p>;
}

function Pager({ total, page, param, agentId, other }: { total: number; page: number; param: string; agentId: string; other: Record<string, number> }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const href = (p: number) => `/admin/agents/${agentId}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(other).map(([k, v]) => [k, String(v)])), [param]: String(p) })}`;
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center gap-3 text-sm">
      {page > 0 ? <Link href={href(page - 1)} className="font-semibold text-forest link-underline">← Newer</Link> : null}
      <span className="text-muted">Page {page + 1} of {pages}</span>
      {page + 1 < pages ? <Link href={href(page + 1)} className="font-semibold text-forest link-underline">Older →</Link> : null}
    </nav>
  );
}
