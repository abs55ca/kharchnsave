import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AgentLoginForm } from "@/components/agent/agent-forms";
import { safeAgentPath } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function AgentLoginPage({ searchParams }: PageProps<"/agent/login">) {
  return (
    <div className="mx-auto max-w-sm">
      <p className="eyebrow text-muted">Kharch n Save sales agents</p>
      <h1 className="mt-2 text-2xl font-extrabold tracking-tight md:text-3xl">Sign in</h1>
      <p className="mt-2 text-sm text-muted">For sales agents. Accounts are set up by the shop.</p>
      <div className="mt-6">
        <Suspense fallback={<div className="h-64 rounded-md bg-cream" aria-busy="true" />}>
          <Form searchParams={searchParams} />
        </Suspense>
      </div>
      <p className="mt-6 text-sm">
        <Link href="/agent/forgot-password" prefetch={false} className="font-semibold text-forest link-underline">
          Forgot your password?
        </Link>
      </p>
    </div>
  );
}

async function Form({ searchParams }: Pick<PageProps<"/agent/login">, "searchParams">) {
  const { next, link } = await searchParams;
  return (
    <>
      {link === "expired" ? (
        <p role="alert" className="mb-4 rounded-md border border-danger/30 px-3 py-2 text-sm text-danger">
          That link has expired or was already used. Ask the shop for a new one, or sign in if you’ve set your password.
        </p>
      ) : null}
      <AgentLoginForm next={safeAgentPath(Array.isArray(next) ? next[0] : next)} />
    </>
  );
}
