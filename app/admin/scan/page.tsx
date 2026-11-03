import type { Metadata } from "next";
import { Suspense } from "react";
import { AccessNotice } from "@/components/admin/access-notice";
import { AdminNav } from "@/components/admin/admin-nav";
import { RefreshOnReturn } from "@/components/admin/refresh-on-return";
import { ScanForm } from "@/components/admin/scan-form";
import { ScanOutcome } from "@/components/admin/scan-result";
import { scanLookup, type ScanResult } from "@/lib/admin/scan";
import { getAdminPageClient } from "@/lib/auth/admin";
import { classifyScan } from "@/lib/barcodes/code";

export const metadata: Metadata = {
  title: "Scan",
};

export default function ScanPage({ searchParams }: PageProps<"/admin/scan">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Scan searchParams={searchParams} />
    </Suspense>
  );
}

// Lookups only read: the scanned code arrives as ?code= (a GET request) and
// the database function that answers it can't change anything.
async function Scan({ searchParams }: Pick<PageProps<"/admin/scan">, "searchParams">) {
  const { code } = await searchParams;
  const input = classifyScan(code);
  const href = input.code ? `/admin/scan?code=${encodeURIComponent(input.code)}` : "/admin/scan";

  const { access, supabase } = await getAdminPageClient(href);
  if (!supabase) return <AccessNotice access={access} retryHref={href} />;

  let result: ScanResult | null = null;
  let failed = false;
  if (input.kind === "barcode" || input.kind === "text") {
    try {
      result = await scanLookup(supabase, input.code);
    } catch (error) {
      console.error("[admin]", (error as Error).message);
      failed = true;
    }
  }

  return (
    <>
      <AdminNav current="scan" email={access.email} />
      <RefreshOnReturn />
      <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Scan</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Look up a pair by its label. Price and stock come from the database.</p>
      <ScanForm lastCode={input.code} />
      <div aria-live="polite" className="mt-6 max-w-3xl">
        <ScanOutcome input={input} result={result} failed={failed} />
      </div>
    </>
  );
}
