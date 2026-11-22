import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SetPasswordForm } from "@/components/agent/agent-forms";
import { createSessionClient } from "@/lib/supabase/session";

export const metadata: Metadata = {
  title: "Choose a password",
};

export default function SetPasswordPage() {
  return (
    <div className="mx-auto max-w-sm">
      <p className="eyebrow text-muted">Kharch n Save sales agents</p>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">Choose a password</h1>
      <div className="mt-6">
        <Suspense fallback={<div className="h-64 rounded-md bg-cream" aria-busy="true" />}>
          <ForSignedIn />
        </Suspense>
      </div>
    </div>
  );
}

// Reached from a verified password link (/agent/auth/confirm), which signed this device in.
async function ForSignedIn() {
  const supabase = await createSessionClient("agent");
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    return (
      <p className="text-sm">
        Open the link the shop sent you again, or{" "}
        <Link href="/agent/login" prefetch={false} className="font-semibold text-forest link-underline">
          sign in
        </Link>
        .
      </p>
    );
  }
  return (
    <>
      <p className="mb-4 text-sm text-muted">For {data.user.email}</p>
      <SetPasswordForm />
    </>
  );
}
