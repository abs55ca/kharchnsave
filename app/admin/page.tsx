import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { PUBLICATION_LABELS } from "@/components/admin/publication-badge";
import { countByStatus, PUBLICATION_STATUSES } from "@/lib/admin/products";
import { getAdminPageClient } from "@/lib/auth/admin";

export const metadata: Metadata = {
  title: "Admin",
};

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Checking your access…</p>}>
      <AdminHome />
    </Suspense>
  );
}

// Reads the session, so it renders per request behind the boundary and is
// never cached. Access (identity, membership and a two-step-verified
// session) is decided here on the server, not by the proxy.
async function AdminHome() {
  const { access, supabase } = await getAdminPageClient("/admin");
  if (!supabase) return <AccessNotice access={access} retryHref="/admin" />;

  let counts: Awaited<ReturnType<typeof countByStatus>> | null = null;
  try {
    counts = await countByStatus(supabase);
  } catch (error) {
    console.error("[admin]", (error as Error).message);
  }

  return (
    <>
      <AdminNav current="home" email={access.email} />
      <section aria-labelledby="admin-heading">
        <p className="eyebrow text-muted">Kharch n Save admin</p>
        <h1 id="admin-heading" className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">
          Welcome{access.email ? `, ${access.email}` : ""}
        </h1>
        <p className="mt-3 max-w-xl text-sm text-ink/85">
          You&apos;re signed in as a store administrator. Add and edit products, then publish them to the shop.
        </p>

        <ul className="mt-8 grid max-w-2xl gap-3 sm:grid-cols-3">
          {PUBLICATION_STATUSES.map((status) => (
            <li key={status}>
              <Link
                href={`/admin/products?status=${status}`}
                className="block rounded-lg border border-line p-4 hover:border-forest"
              >
                <span className="block text-2xl font-extrabold">{counts ? counts[status] : "–"}</span>
                <span className="text-sm text-muted">{PUBLICATION_LABELS[status]}</span>
              </Link>
            </li>
          ))}
        </ul>
        {counts ? null : (
          <p role="alert" className="mt-3 text-sm text-danger">
            Product counts couldn&apos;t be loaded right now.
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/admin/products/new" className="btn btn-forest">
            Add product
          </Link>
          <Link href="/admin/products" className="btn btn-outline">
            All products
          </Link>
          <Link href="/admin/scan" className="btn btn-outline">
            Scan
          </Link>
        </div>
      </section>
    </>
  );
}
