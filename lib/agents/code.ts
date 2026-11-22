/*
 * Referral codes and percentages, shared by the browser and the server. The
 * database applies the same rules (supabase/migrations/20261118120000_sales_agents.sql)
 * and is the one that decides; these give instant feedback.
 *
 * A code is 3-16 letters A-Z and digits 0-9. Case doesn't matter, and spaces
 * and hyphens are ignored: "ah-med", " Ahmed " and "AHMED" are the same code.
 */

export const CODE_MIN = 3;
export const CODE_MAX = 16;
/** Agent passwords: at least this long (Supabase Auth's own minimum applies too). */
export const MIN_PASSWORD_LENGTH = 10;
/** The longest code input accepted at all (before normalising). */
export const CODE_INPUT_MAX = 32;
const CODE = /^[A-Z0-9]{3,16}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/** Removes whitespace and hyphens, upper-cases. Null if nothing is left. */
export function normalizeReferralCode(input: string | null | undefined): string | null {
  const code = (input ?? "").replace(/[\s-]+/g, "").toUpperCase();
  return code === "" ? null : code;
}

export function isReferralCode(code: string | null | undefined): code is string {
  return typeof code === "string" && CODE.test(code);
}

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function isUsername(username: string): boolean {
  return USERNAME.test(username);
}

/** A code suggested from a username: its letters and digits, upper-cased. */
export function suggestCode(username: string): string {
  return normalizeUsername(username).replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, CODE_MAX);
}

/** "10" or "7.5" (percent, at most two decimals, 0-50) -> basis points (1000, 750). */
export function percentToBasisPoints(input: string): number | null {
  const value = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bp <= 5000 ? bp : null;
}

/** 1000 -> "10%", 750 -> "7.5%", 1234 -> "12.34%". */
export function formatPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const fraction = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

/** Basis points as the form shows them: 750 -> "7.5". */
export function basisPointsToInput(bp: number | null): string {
  return bp === null ? "" : formatPercent(bp).slice(0, -1);
}
