"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import { agentSignIn, agentSignOut, requestAgentPasswordReset, setAgentPassword, type AgentFormState } from "@/app/agent/actions";
import { MIN_PASSWORD_LENGTH } from "@/lib/agents/code";

const INPUT =
  "h-11 w-full rounded-md border border-line bg-white px-3 text-base focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-forest";
const LABEL = "mb-1.5 block text-sm font-semibold";
const INITIAL: AgentFormState = { error: null };

function Field({ id, label, ...props }: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input id={id} className={INPUT} {...props} />
    </div>
  );
}

function ErrorText({ id, error }: { id: string; error: string | null }) {
  return (
    <p id={id} role="alert" className={error ? "text-sm font-medium text-danger" : "sr-only"}>
      {error}
    </p>
  );
}

export function AgentLoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(agentSignIn, INITIAL);
  const id = useId();
  return (
    <form action={action} className="space-y-4" aria-describedby={state.error ? `${id}-error` : undefined}>
      <input type="hidden" name="next" value={next} />
      <Field id={`${id}-email`} label="Email address" name="email" type="email" autoComplete="username" required defaultValue={state.email} />
      <Field id={`${id}-password`} label="Password" name="password" type="password" autoComplete="current-password" required />
      <ErrorText id={`${id}-error`} error={state.error} />
      <button type="submit" disabled={pending} className="btn btn-forest h-11 w-full">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function SetPasswordForm() {
  const [state, action, pending] = useActionState(setAgentPassword, INITIAL);
  const id = useId();
  return (
    <form action={action} className="space-y-4">
      <Field id={`${id}-password`} label="New password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={72} />
      <Field id={`${id}-confirm`} label="Type it again" name="confirm" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={72} />
      <p className="text-xs text-muted">At least {MIN_PASSWORD_LENGTH} characters. Don’t reuse a password from another site.</p>
      <ErrorText id={`${id}-error`} error={state.error} />
      <button type="submit" disabled={pending} className="btn btn-forest h-11 w-full">
        {pending ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestAgentPasswordReset, INITIAL);
  const id = useId();
  if (state.done) {
    return (
      <p role="status" className="rounded-md bg-cream p-4 text-sm">
        If {state.email} has an agent account, a reset link is on its way. If nothing arrives within a few minutes, ask the shop
        for a new password link.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-4">
      <Field id={`${id}-email`} label="Email address" name="email" type="email" autoComplete="username" required defaultValue={state.email} />
      <ErrorText id={`${id}-error`} error={state.error} />
      <button type="submit" disabled={pending} className="btn btn-forest h-11 w-full">
        {pending ? "Sending…" : "Email me a reset link"}
      </button>
    </form>
  );
}

function SignOutSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-outline h-9 px-3 text-sm">
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}

export function AgentSignOutButton() {
  return (
    <form action={agentSignOut}>
      <SignOutSubmit />
    </form>
  );
}
