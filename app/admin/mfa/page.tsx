import type { Metadata } from "next";
import Link from "@/components/admin/admin-link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AdminNotice } from "@/components/admin/admin-notice";
import { MfaCodeForm } from "@/components/admin/mfa-code-form";
import { MfaSetup } from "@/components/admin/mfa-setup";
import { SignOutButton } from "@/components/admin/sign-out-button";
import { getAdminAccess } from "@/lib/auth/admin";
import { ADMIN_LOGIN, mfaPath, safeAdminPath } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = {
  title: "Two-step verification",
};

export default function AdminMfaPage({ searchParams }: PageProps<"/admin/mfa">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Checking your account…</p>}>
      <MfaStep searchParams={searchParams} />
    </Suspense>
  );
}

// The one admin page that accepts a member who hasn't completed two-step
// verification yet. It only renders the setup or code screen; setup itself
// starts from a button (a Server Action), never from rendering.
async function MfaStep({ searchParams }: Pick<PageProps<"/admin/mfa">, "searchParams">) {
  const { next: rawNext } = await searchParams;
  const next = safeAdminPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);
  const access = await getAdminAccess();

  switch (access.status) {
    case "signed-out":
      return redirect(ADMIN_LOGIN);
    case "admin":
      return redirect(next);
    case "not-admin":
      return (
        <AdminNotice title="This account doesn't have admin access">
          <p>
            You&apos;re signed in{access.email ? ` as ${access.email}` : ""}, but this account
            hasn&apos;t been given admin access. Ask the store owner if you need it.
          </p>
          <div className="mt-5">
            <SignOutButton />
          </div>
        </AdminNotice>
      );
    case "unavailable":
      return (
        <AdminNotice title="We couldn't verify your access">
          <p>Sign-in or the admin check isn&apos;t responding right now, so the admin area stays locked.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={mfaPath(next)} className="btn btn-forest">
              Try again
            </Link>
            <SignOutButton />
          </div>
        </AdminNotice>
      );
    case "mfa-required":
      return access.step === "enroll" ? (
        <AdminNotice title="Set up two-step verification">
          <MfaSetup next={next} />
          <div className="mt-8">
            <SignOutButton />
          </div>
        </AdminNotice>
      ) : (
        <AdminNotice title="Enter your authenticator code">
          <p className="mb-5">
            Signed in{access.email ? ` as ${access.email}` : ""}. One more step: enter the code from
            your authenticator app.
          </p>
          <MfaCodeForm next={next} submitLabel="Verify" />
          <p className="mt-6 text-xs text-muted">
            Lost your phone or authenticator app? Ask the store owner to reset your two-step
            verification.
          </p>
          <div className="mt-5">
            <SignOutButton />
          </div>
        </AdminNotice>
      );
  }
}
