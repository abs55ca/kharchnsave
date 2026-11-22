import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/agent/agent-forms";

export const metadata: Metadata = {
  title: "Reset your password",
};

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-sm">
      <p className="eyebrow text-muted">Kharch n Save sales agents</p>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">Reset your password</h1>
      <p className="mt-2 text-sm text-muted">
        We’ll email you a link to choose a new password. You can also ask the shop to send you one.
      </p>
      <div className="mt-6">
        <ForgotPasswordForm />
      </div>
      <p className="mt-6 text-sm">
        <Link href="/agent/login" prefetch={false} className="font-semibold text-forest link-underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
