import Link from "next/link";
import type { AdminAccess } from "@/lib/auth/admin";
import { AdminNotice } from "./admin-notice";
import { SignOutButton } from "./sign-out-button";

/** Shown instead of an admin page to members who aren't (or can't be confirmed as) admins. */
export function AccessNotice({ access, retryHref }: { access: AdminAccess; retryHref: string }) {
  if (access.status === "not-admin") {
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
  }

  return (
    <AdminNotice title="We couldn't verify your access">
      <p>Sign-in or the admin check isn&apos;t responding right now, so the admin area stays locked.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href={retryHref} className="btn btn-forest">
          Try again
        </Link>
        <SignOutButton />
      </div>
    </AdminNotice>
  );
}
