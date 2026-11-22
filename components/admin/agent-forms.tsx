"use client";

import Link from "@/components/admin/admin-link";
import { createContext, startTransition, useActionState, useContext, useEffect, useId, useMemo, useState } from "react";
import {
  addAdjustmentAction,
  agentChangeAction,
  checkAgentCode,
  commissionHoldAction,
  createAgentAction,
  createLoginLinkAction,
  recordPayoutAction,
  type AgentFormState,
} from "@/app/admin/agents/actions";
import { CopyButton } from "@/components/copy-button";
import { afterAnswer, blockedMessage, outcomeOf } from "@/lib/admin/request-outcome";
import { CODE_INPUT_MAX, isReferralCode, isUsername, normalizeReferralCode, normalizeUsername, suggestCode } from "@/lib/agents/code";
import { formatPrice } from "@/lib/format";

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest";
const LABEL = "mb-1 block text-sm font-semibold";
const HINT = "mt-1 text-xs text-muted";
const INITIAL: AgentFormState = { ok: true, message: null };
const rupees = (paisa: number) => formatPrice(paisa / 100);
const newRequestId = () => crypto.randomUUID();

type ServerAction = (previous: AgentFormState, formData: FormData) => Promise<AgentFormState>;
/** A request exactly as it was sent: every field, including its request id, target, action and expected version. */
type Snapshot = { entries: readonly (readonly [string, string])[] };
type Owner = { key: string; label: string };

const UNCONFIRMED =
  "No answer, so we can’t tell whether this was saved. “Retry unconfirmed save” sends exactly the same request again (it’s never applied twice). Changes made since aren’t included: make them once it’s resolved.";

/**
 * One unconfirmed request per page: while a form's outcome is unknown, the
 * other forms on the page wait, so nothing else (including the agent version
 * they share) can change underneath it.
 */
const UnconfirmedRequest = createContext<{ owner: Owner | null; setOwner: React.Dispatch<React.SetStateAction<Owner | null>> } | null>(null);

/**
 * Submits a form as one request with a request id.
 *   - The complete request is captured when it is first sent (a snapshot of
 *     every field), and that snapshot is what goes to the server.
 *   - No answer (network failure, or the database couldn't be reached): the
 *     outcome is unknown. The snapshot is kept and the button becomes "Retry
 *     unconfirmed save", which resends the snapshot unchanged, whatever has
 *     been typed since. Other forms on the page wait.
 *   - A definitive answer (applied, recognised as an earlier request, or
 *     refused, e.g. invalid input or a conflict): the snapshot is dropped and
 *     a new request id is made, so the next submission is a new request and
 *     corrected input can be sent.
 *   - Blocked (signed out, no admin access, sign-in or database unavailable,
 *     a lock busy): the request wasn't checked, so nothing is resolved. An
 *     unconfirmed snapshot stays, with its id, and the other forms keep
 *     waiting; the message says how to sign in again (in another tab) and
 *     then retry it. A new request that was blocked simply wasn't sent.
 *   (lib/admin/request-outcome.ts decides which is which.)
 * (React's form `action` would reset the fields after every submission; this
 * submits through onSubmit instead and resets only after success, if asked.)
 */
/*
 * An unconfirmed request is also kept in this tab's sessionStorage (per form,
 * `storageKey`) until it has a definitive outcome. If the session expires,
 * the admin page sends the tab to the sign-in page (Supabase clears the
 * session cookie during the retry and Next.js re-renders the page); after
 * signing in the admin comes back to the same page, and the form restores
 * the request, with its original id, ready to "Retry unconfirmed save".
 * A reload keeps it too. Closing the tab loses it (sessionStorage).
 */
type Saved = { requestId: string; entries: [string, string][]; label: string };
const STORAGE_PREFIX = "kharchnsave:unconfirmed:";

function readSaved(name: string): Saved | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(name) ?? "null") as Saved | null;
    return value && typeof value.requestId === "string" && Array.isArray(value.entries) ? value : null;
  } catch {
    return null;
  }
}

function writeSaved(name: string, value: Saved | null) {
  try {
    if (value) window.sessionStorage.setItem(name, JSON.stringify(value));
    else window.sessionStorage.removeItem(name);
  } catch {
    // Storage unavailable: the request is still kept in memory for this page.
  }
}

export function useRequestAction(
  action: ServerAction,
  options: { label: string; storageKey: string; onDone?: (state: AgentFormState) => void; resetOnDone?: boolean },
) {
  const key = useId();
  const scope = useContext(UnconfirmedRequest);
  const setOwner = scope?.setOwner;
  const storageName = STORAGE_PREFIX + options.storageKey;
  const [requestId, setRequestId] = useState(newRequestId);
  const [unconfirmed, setUnconfirmed] = useState<Snapshot | null>(null);

  // An unconfirmed request saved before a sign-in or reload: restore it, with its id.
  useEffect(() => {
    const saved = readSaved(storageName);
    if (!saved) return;
    startTransition(() => {
      setRequestId(saved.requestId);
      setUnconfirmed({ entries: saved.entries });
      setOwner?.({ key, label: saved.label });
    });
  }, [storageName, setOwner, key]);
  const [state, dispatch, pending] = useActionState(
    async (previous: AgentFormState, input: { snapshot: Snapshot; form: HTMLFormElement; replay: boolean }) => {
      const formData = new FormData();
      for (const [name, value] of input.snapshot.entries) formData.append(name, value);
      let result: AgentFormState;
      try {
        result = await action(previous, formData);
      } catch {
        result = { ok: false, uncertain: true, message: null };
      }
      const outcome = outcomeOf(result);
      const next = afterAnswer(outcome, input.replay);
      if (next.keepUnconfirmed) {
        setUnconfirmed(input.snapshot);
        scope?.setOwner({ key, label: options.label });
        const sentId = input.snapshot.entries.find(([name]) => name === "requestId")?.[1] ?? requestId;
        writeSaved(storageName, { requestId: sentId, entries: input.snapshot.entries.map(([n, v]) => [n, v]), label: options.label });
        return { ...result, message: result.blocked ? blockedMessage(result.blocked, true) : UNCONFIRMED };
      }
      if (outcome === "blocked") {
        // A new request that was never checked: nothing to resolve; the same id can be sent again.
        return { ...result, message: blockedMessage(result.blocked!, false) };
      }
      setUnconfirmed(null);
      writeSaved(storageName, null);
      scope?.setOwner((owner) => (owner?.key === key ? null : owner));
      if (next.newRequestId) setRequestId(newRequestId());
      if (result.done) {
        options.onDone?.(result);
        if (options.resetOnDone) input.form.reset();
      }
      return result;
    },
    INITIAL,
  );
  const blockedBy = scope?.owner && scope.owner.key !== key ? scope.owner.label : null;
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || blockedBy) return;
    const form = event.currentTarget;
    const snapshot: Snapshot = unconfirmed ?? {
      entries: [...new FormData(form)].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    };
    startTransition(() => dispatch({ snapshot, form, replay: unconfirmed !== null }));
  };
  return { state, onSubmit, pending, requestId, unconfirmed: unconfirmed !== null, blockedBy };
}

export type RequestControls = ReturnType<typeof useRequestAction>;

/**
 * Scopes unconfirmed requests to one page for forms outside an agent page
 * (the pricing and sales pages): while one form's request is unconfirmed,
 * the others on the page wait.
 */
export function RequestScope({ children }: { children: React.ReactNode }) {
  const [owner, setOwner] = useState<Owner | null>(null);
  return <UnconfirmedRequest.Provider value={{ owner, setOwner }}>{children}</UnconfirmedRequest.Provider>;
}

/** The submit button, with the unconfirmed-request states explained. */
export function SubmitButton({ r, label, busy, className, disabled = false }: { r: RequestControls; label: string; busy: string; className: string; disabled?: boolean }) {
  return (
    <>
      {r.unconfirmed && !r.state.message ? (
        <p className="text-sm font-medium text-danger">
          An earlier save from this form wasn’t confirmed. “Retry unconfirmed save” sends exactly the same request (it’s never
          applied twice). Resolve it before making other changes.
        </p>
      ) : null}
      {r.blockedBy ? (
        <p className="text-sm font-medium text-danger">Resolve the unconfirmed “{r.blockedBy}” first (use its “Retry unconfirmed save” button).</p>
      ) : null}
      {/* A retry resends the saved request, not the visible fields (which may be empty after a sign-in or reload): no field validation. */}
      <button type="submit" className={className} disabled={r.pending || !!r.blockedBy || (disabled && !r.unconfirmed)} formNoValidate={r.unconfirmed}>
        {r.pending ? busy : r.unconfirmed ? "Retry unconfirmed save" : label}
      </button>
    </>
  );
}

/**
 * The agent version this page's edits name. It starts as the version the page
 * was loaded with and then follows only the versions produced by this page's
 * own changes (a replay reports the version its original change produced).
 * A change made elsewhere is never adopted silently: the next edit is refused
 * as a conflict and the admin reloads. Also scopes unconfirmed requests to the page.
 */
const AgentVersion = createContext<{ version: number; setVersion: (version: number) => void } | null>(null);

export function AgentVersionProvider({ version, children }: { version: number; children: React.ReactNode }) {
  const [current, setVersion] = useState(version);
  const [owner, setOwner] = useState<Owner | null>(null);
  return (
    <AgentVersion.Provider value={{ version: current, setVersion }}>
      <UnconfirmedRequest.Provider value={{ owner, setOwner }}>{children}</UnconfirmedRequest.Provider>
    </AgentVersion.Provider>
  );
}

function Result({ state }: { state: AgentFormState }) {
  return (
    <div aria-live="polite" className="space-y-2">
      {state.message ? <p className={`text-sm ${state.ok ? "text-muted" : "font-medium text-danger"}`}>{state.message}</p> : null}
      {state.link ? <LoginLink link={state.link} /> : null}
      {!state.ok && state.agentId ? (
        <Link href={`/admin/agents/${state.agentId}`} className="text-sm font-semibold text-forest link-underline">
          Open this agent
        </Link>
      ) : null}
    </div>
  );
}

function LoginLink({ link }: { link: string }) {
  return (
    <div className="rounded-md border border-forest/40 bg-cream p-3">
      <p className="text-xs font-semibold">Password link (shown once; send it privately, e.g. on WhatsApp)</p>
      <p className="mt-1 break-all font-mono text-xs">{link}</p>
      <div className="mt-2">
        <CopyButton value={link} label="Copy link" />
      </div>
    </div>
  );
}

function SaleItemsChoice({ defaultValue, name = "saleItems" }: { defaultValue: boolean | null; name?: string }) {
  const id = useId();
  return (
    <fieldset>
      <legend className={LABEL}>Discount on items already on sale?</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} value="no" defaultChecked={defaultValue === false} id={`${id}-no`} /> No: sale items pay their sale price, no commission
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={name} value="yes" defaultChecked={defaultValue === true} id={`${id}-yes`} /> Yes: the discount applies on top
        </label>
      </div>
      <p className={HINT}>Choose explicitly; the code can’t be enabled until you do.</p>
    </fieldset>
  );
}

/** Create an agent: suggests the code from the username and checks it as you type. */
export function CreateAgentForm({ secretKeyConfigured }: { secretKeyConfigured: boolean }) {
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [availability, setAvailability] = useState<{ code: string; valid: boolean; available: boolean } | null>(null);
  const shownCode = codeEdited ? code : suggestCode(username);
  const normalized = normalizeReferralCode(shownCode);

  // A new request (and empty fields) once the agent was created.
  const r = useRequestAction(createAgentAction, {
    label: "Create agent",
    storageKey: "create-agent",
    resetOnDone: true,
    onDone: () => {
      setUsername("");
      setCode("");
      setCodeEdited(false);
    },
  });

  useEffect(() => {
    if (!isReferralCode(normalized)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkAgentCode(normalized).then((result) => {
        if (!cancelled && result?.code) setAvailability({ code: result.code, valid: result.valid, available: result.available });
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized]);

  const codeNote = !normalized
    ? "Letters A-Z and digits 0-9, 3 to 16 characters. Case and spaces don’t matter."
    : !isReferralCode(normalized)
      ? "Use 3 to 16 letters and digits only."
      : availability?.code === normalized
        ? availability.available
          ? `${normalized} is available.`
          : `${normalized} is taken. Codes are never reused; try ${normalized.slice(0, 14)}2 or similar.`
        : "Checking…";

  return (
    <form onSubmit={r.onSubmit} className="space-y-4">
      <input type="hidden" name="requestId" value={r.requestId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="agent-username">Username</label>
          <input id="agent-username" name="username" className={`${INPUT} h-10`} required maxLength={30} value={username}
            onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          <p className={HINT}>{username && !isUsername(normalizeUsername(username)) ? "3-30 lower-case letters, digits, dots, hyphens or underscores." : "Can be changed later; the code stays."}</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-name">Display name</label>
          <input id="agent-name" name="displayName" className={`${INPUT} h-10`} required minLength={2} maxLength={80} />
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-email">Email (their login)</label>
          <input id="agent-email" name="email" type="email" className={`${INPUT} h-10`} required maxLength={254} autoComplete="off" />
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-code">Referral code</label>
          <input id="agent-code" name="code" className={`${INPUT} h-10 uppercase`} required maxLength={CODE_INPUT_MAX} value={shownCode}
            onChange={(e) => {
              setCode(e.target.value);
              setCodeEdited(true);
            }} autoComplete="off" spellCheck={false} />
          <p className={HINT} aria-live="polite">{codeNote}</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-discount">Customer discount (%)</label>
          <input id="agent-discount" name="discount" inputMode="decimal" className={`${INPUT} h-10`} required defaultValue="10" />
        </div>
        <div>
          <label className={LABEL} htmlFor="agent-commission">Agent commission (%)</label>
          <input id="agent-commission" name="commission" inputMode="decimal" className={`${INPUT} h-10`} placeholder="e.g. 5" />
          <p className={HINT}>Of the qualifying products after the discount; never on delivery.</p>
        </div>
      </div>
      <SaleItemsChoice defaultValue={null} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enable" /> Enable the code now (needs a commission and a sale-item choice)
      </label>
      {!secretKeyConfigured ? (
        <p className="text-sm text-danger">SUPABASE_SECRET_KEY isn’t set on this website, so logins can’t be created yet.</p>
      ) : null}
      <SubmitButton r={r} label="Create agent and password link" busy="Creating…" className="btn btn-forest h-10" disabled={!secretKeyConfigured} />
      <Result state={r.state} />
    </form>
  );
}

/** "Create password link" for an existing agent. */
export function LoginLinkForm({ agentId, label }: { agentId: string; label: string }) {
  const r = useRequestAction(createLoginLinkAction, { label, storageKey: `login-link:${agentId}` });
  return (
    <form onSubmit={r.onSubmit} className="space-y-3">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="requestId" value={r.requestId} />
      <SubmitButton r={r} label={label} busy="Working…" className="btn btn-outline h-10" />
      <Result state={r.state} />
    </form>
  );
}

/** Profile, terms, code on/off and access: one form per change, with the agent's version and a request id. */
export function AgentChangeForm({
  action: change,
  agentId,
  version,
  submitLabel,
  tone = "outline",
  confirmText,
  children,
}: {
  action: string;
  agentId: string;
  version: number;
  submitLabel: string;
  tone?: "forest" | "outline" | "danger";
  confirmText?: string;
  children?: React.ReactNode;
}) {
  const shared = useContext(AgentVersion);
  const currentVersion = shared?.version ?? version;
  const r = useRequestAction(agentChangeAction, {
    label: submitLabel,
    storageKey: `agent:${agentId}:${change}`,
    onDone: (result) => {
      if (result.version !== undefined) shared?.setVersion(result.version);
    },
  });
  const toneClass = tone === "forest" ? "btn-forest" : tone === "danger" ? "btn-outline text-danger" : "btn-outline";
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) {
          event.preventDefault();
          return;
        }
        r.onSubmit(event);
      }}
    >
      <input type="hidden" name="action" value={change} />
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="version" value={currentVersion} />
      <input type="hidden" name="requestId" value={r.requestId} />
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton r={r} label={submitLabel} busy="Saving…" className={`btn ${toneClass} h-10`} />
        <Result state={r.state} />
      </div>
    </form>
  );
}

export function TermsFields({ discountBp, commissionBp, appliesToSale }: { discountBp: number; commissionBp: number | null; appliesToSale: boolean | null }) {
  const pct = (bp: number | null) => (bp === null ? "" : String(bp / 100));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>
            Customer discount (%)
            <input name="discount" inputMode="decimal" className={`${INPUT} mt-1 h-10 font-normal`} required defaultValue={pct(discountBp)} />
          </label>
        </div>
        <div>
          <label className={LABEL}>
            Agent commission (%)
            <input name="commission" inputMode="decimal" className={`${INPUT} mt-1 h-10 font-normal`} defaultValue={pct(commissionBp)} />
          </label>
        </div>
      </div>
      <SaleItemsChoice defaultValue={appliesToSale} />
    </div>
  );
}

type Payable = { id: string; label: string; amount_paisa: number; required: boolean; kind: "order" | "adjustment" };

/** Record a payout: pick what it covers; the total is worked out here and checked again by the database. */
export function PayoutForm({ agentId, items, today }: { agentId: string; items: Payable[]; today: string }) {
  const r = useRequestAction(recordPayoutAction, { label: "Record payout", storageKey: `payout:${agentId}`, resetOnDone: true });
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const total = useMemo(() => items.filter((i) => selected.has(i.id)).reduce((sum, i) => sum + i.amount_paisa, 0), [items, selected]);
  // An unconfirmed payout is always offered for retry, even when (because it went through) nothing is left to select.
  if (items.length === 0 && !r.unconfirmed) {
    // Keep the last result visible (e.g. "Payout recorded." after paying everything).
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">Nothing is available to pay right now.</p>
        <Result state={r.state} />
      </div>
    );
  }
  return (
    <form onSubmit={r.onSubmit} className="space-y-3">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="requestId" value={r.requestId} />
      <ul className="space-y-1 text-sm">
        {items.map((item) => (
          <li key={item.id}>
            <label className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={item.kind === "order" ? "orderId" : "adjustmentId"}
                  value={item.id}
                  checked={selected.has(item.id)}
                  disabled={item.required}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    setSelected(next);
                  }}
                />
                {item.label}
                {item.required ? <span className="text-xs text-muted">(deduction: always included)</span> : null}
              </span>
              <span className={item.amount_paisa < 0 ? "text-danger" : ""}>{item.amount_paisa < 0 ? `−${rupees(-item.amount_paisa)}` : rupees(item.amount_paisa)}</span>
            </label>
            {/* A disabled checkbox isn't submitted: send required deductions explicitly. */}
            {item.required ? <input type="hidden" name="adjustmentId" value={item.id} /> : null}
          </li>
        ))}
      </ul>
      <p className="text-sm font-semibold">Selected total: {total < 0 ? `−${rupees(-total)}` : rupees(total)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Amount paid (Rs.)
          <input name="amount" inputMode="decimal" className={`${INPUT} mt-1 h-10 font-normal`} required key={total} defaultValue={total > 0 ? String(total / 100) : ""} />
        </label>
        <label className={LABEL}>
          Payment date
          <input name="paidOn" type="date" className={`${INPUT} mt-1 h-10 font-normal`} required defaultValue={today} max={today} />
        </label>
        <label className={LABEL}>
          Method
          <select name="method" className={`${INPUT} mt-1 h-10 font-normal`} defaultValue="bank_transfer">
            <option value="bank_transfer">Bank transfer</option>
            <option value="easypaisa">Easypaisa</option>
            <option value="jazzcash">JazzCash</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className={LABEL}>
          Reference (optional)
          <input name="reference" className={`${INPUT} mt-1 h-10 font-normal`} maxLength={100} />
        </label>
      </div>
      <label className={LABEL}>
        Note (optional)
        <input name="note" className={`${INPUT} mt-1 h-10 font-normal`} maxLength={500} />
      </label>
      <SubmitButton r={r} label="Record payout" busy="Recording…" className="btn btn-forest h-10" disabled={total <= 0} />
      <Result state={r.state} />
    </form>
  );
}

export function AdjustmentForm({ agentId }: { agentId: string }) {
  const r = useRequestAction(addAdjustmentAction, { label: "Record adjustment", storageKey: `adjustment:${agentId}`, resetOnDone: true });
  return (
    <form onSubmit={r.onSubmit} className="space-y-3">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="requestId" value={r.requestId} />
      <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
        <label className={LABEL}>
          Type
          <select name="direction" className={`${INPUT} mt-1 h-10 font-normal`} defaultValue="deduct">
            <option value="deduct">Deduction</option>
            <option value="add">Addition</option>
          </select>
        </label>
        <label className={LABEL}>
          Amount (Rs.)
          <input name="amount" inputMode="decimal" className={`${INPUT} mt-1 h-10 font-normal`} required />
        </label>
      </div>
      <label className={LABEL}>
        Reason (required)
        <input name="reason" className={`${INPUT} mt-1 h-10 font-normal`} required minLength={5} maxLength={300} />
      </label>
      <SubmitButton r={r} label="Record adjustment" busy="Saving…" className="btn btn-outline h-10" />
      <Result state={r.state} />
    </form>
  );
}

/**
 * Puts one order's commission on hold (e.g. a return is being arranged), or
 * releases it. A reason is required. The form names the latest hold event the
 * page showed, so a form opened before someone else changed the hold is refused.
 */
export function CommissionHoldForm({ orderId, onHold, expectedEventId }: { orderId: string; onHold: boolean; expectedEventId: number | null }) {
  const label = onHold ? "Release the hold" : "Put commission on hold";
  const r = useRequestAction(commissionHoldAction, { label, storageKey: `hold:${orderId}`, resetOnDone: true });
  return (
    <form onSubmit={r.onSubmit} className="space-y-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="requestId" value={r.requestId} />
      <input type="hidden" name="hold" value={onHold ? "no" : "yes"} />
      <input type="hidden" name="expectedEventId" value={expectedEventId ?? ""} />
      <label className={LABEL}>
        {onHold ? "Why release it?" : "Why hold it? (e.g. return being arranged)"}
        <input name="reason" className={`${INPUT} mt-1 h-10 font-normal`} required minLength={5} maxLength={300} />
      </label>
      <SubmitButton r={r} label={label} busy="Saving…" className={`btn ${onHold ? "btn-outline" : "btn-outline text-danger"} h-10`} />
      <Result state={r.state} />
    </form>
  );
}
