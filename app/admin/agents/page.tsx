import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { CreateAgentForm } from "@/components/admin/agent-forms";
import { formatPercent } from "@/lib/agents/code";
import { ACCESS_LABELS, listAgents, type AdminAgent } from "@/lib/admin/agents";
import { getAdminPageClient } from "@/lib/auth/admin";
import { isAuthAdminConfigured } from "@/lib/supabase/auth-admin";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = {
  title: "Sales agents",
};

export default function AgentsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Agents />
    </Suspense>
  );
}

const rupees = (paisa: number) => formatPrice(paisa / 100);

async function Agents() {
  const { access, supabase } = await getAdminPageClient("/admin/agents");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin/agents" />;

  let agents: AdminAgent[] | null = null;
  try {
    agents = await listAgents(supabase);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
  }

  return (
    <>
      <AdminNav current="agents" email={access.email} />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Sales agents</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/85">
        Each agent has one referral code, fixed for good. Anyone may share it: every qualifying order placed with it earns
        the agent commission. Terms apply to new orders; each order keeps the terms it was placed with.
      </p>

      {!agents ? (
        <p role="alert" className="mt-6 text-sm text-danger">Agents couldn’t be loaded right now.</p>
      ) : agents.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No agents yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Terms now</th>
                <th className="py-2 pr-3">Orders</th>
                <th className="py-2 pr-3">Estimated</th>
                <th className="py-2 pr-3">Held</th>
                <th className="py-2 pr-3">Payable now</th>
                <th className="py-2">Paid</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-line align-top">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/agents/${a.id}`} className="font-semibold text-forest link-underline">{a.display_name}</Link>
                    <span className="block text-xs text-muted">@{a.username} · {ACCESS_LABELS[a.access_status]}</span>
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    {a.code}
                    <span className={`block text-xs font-sans ${a.code_enabled ? "text-forest" : "text-muted"}`}>{a.code_enabled ? "Enabled" : "Disabled"}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {formatPercent(a.discount_bp)} off
                    <span className="block">{a.commission_bp === null ? "Commission not set" : `${formatPercent(a.commission_bp)} commission`}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {a.totals.referred_orders}
                    <span className="block text-muted">{a.totals.cancelled_orders} cancelled · {a.totals.returned_orders} returned</span>
                  </td>
                  <td className="py-2 pr-3">{rupees(a.totals.awaiting_delivery_paisa)}</td>
                  <td className="py-2 pr-3">{rupees(a.totals.held_paisa)}</td>
                  <td className={`py-2 pr-3 font-semibold ${a.totals.payable_paisa < 0 ? "text-danger" : ""}`}>{rupees(a.totals.payable_paisa)}</td>
                  <td className="py-2">{rupees(a.totals.paid_paisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="new-agent-heading" className="mt-10 max-w-3xl rounded-lg border border-line p-5">
        <h2 id="new-agent-heading" className="text-lg font-bold">Add an agent</h2>
        <p className="mt-1 text-sm text-muted">
          Creates their login and a one-time password link for you to send them. Public sign-up stays off.
        </p>
        <div className="mt-4">
          <CreateAgentForm secretKeyConfigured={isAuthAdminConfigured()} />
        </div>
      </section>
    </>
  );
}
