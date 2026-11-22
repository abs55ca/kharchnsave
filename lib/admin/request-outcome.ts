import { isUncertain, RETRYABLE_CODES } from "@/lib/db/retry";

/*
 * What an answer to an admin form request means for that request
 * (components/admin/agent-forms.tsx, useRequestAction). Shared by the server
 * actions (which classify) and the forms (which decide what to keep).
 *
 *   done       the database applied it, or recognised it as an earlier request
 *   refused    the database (or the action's input check) refused it for good:
 *              nothing was applied, and resending it won't change that
 *   uncertain  no answer: it may or may not have been applied
 *   blocked    the request couldn't be checked at all: signed out, no admin
 *              access (e.g. two-step verification needed), sign-in or the
 *              database unavailable, or a lock busy. Nothing was decided
 *              about it, so an earlier unconfirmed request stays unconfirmed.
 */

export type BlockedReason = "signed_out" | "no_access" | "busy" | "unavailable";
export type Answer = { done?: boolean; uncertain?: boolean; blocked?: BlockedReason };
export type Outcome = "done" | "refused" | "uncertain" | "blocked";

export function outcomeOf(answer: Answer): Outcome {
  if (answer.uncertain) return "uncertain";
  if (answer.blocked) return "blocked";
  return answer.done ? "done" : "refused";
}

/**
 * What the form does after an answer. `replay`: the request was a resend of an
 * unconfirmed one. Only a definitive outcome (done or refused) resolves it.
 */
export function afterAnswer(outcome: Outcome, replay: boolean): { keepUnconfirmed: boolean; newRequestId: boolean } {
  switch (outcome) {
    case "done":
    case "refused":
      return { keepUnconfirmed: false, newRequestId: true };
    case "uncertain":
      return { keepUnconfirmed: true, newRequestId: false };
    case "blocked":
      // Not checked: an unconfirmed request stays exactly as it was; a new
      // request simply wasn't sent (it can be sent again once unblocked).
      return { keepUnconfirmed: replay, newRequestId: false };
  }
}

/** A database error as an answer. */
export function answerForDbError(error: { code?: string; message?: string } | null): Answer {
  if (!error || isUncertain(error)) return { uncertain: true };
  if (error.code === "42501") return { blocked: "no_access" };
  if (error.code && RETRYABLE_CODES.has(error.code)) return { blocked: "busy" };
  return {};
}

const UNCONFIRMED_FIX: Record<BlockedReason, string> = {
  signed_out:
    "You’re signed out, so your earlier save couldn’t be checked and is still unconfirmed (kept in this tab). Sign in again (here or in another tab), come back to this page and use “Retry unconfirmed save”. Don’t enter the change again.",
  no_access:
    "This session can’t check your earlier save (admin access or two-step verification is needed). Complete sign-in in another tab, then come back and use “Retry unconfirmed save”. Don’t enter the change again.",
  busy: "Someone else is changing this right now, so your earlier save couldn’t be checked yet. Use “Retry unconfirmed save” in a moment.",
  unavailable:
    "Sign-in or the database can’t be reached, so your earlier save couldn’t be checked yet. Use “Retry unconfirmed save” in a moment. Don’t enter the change again.",
};

const NEW_REQUEST_FIX: Record<BlockedReason, string> = {
  signed_out: "You’ve been signed out, so nothing was saved. Sign in again in another tab, then send this again.",
  no_access: "This session doesn’t have admin access (two-step verification may be needed), so nothing was saved. Sign in again in another tab, then send this again.",
  busy: "Someone else is changing this right now, so nothing was saved. Try again in a moment.",
  unavailable: "Sign-in or the database can’t be reached right now, so nothing was saved. Try again in a moment.",
};

export function blockedMessage(reason: BlockedReason, replay: boolean): string {
  return (replay ? UNCONFIRMED_FIX : NEW_REQUEST_FIX)[reason];
}
