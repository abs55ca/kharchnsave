/*
 * Checkout input rules shared by the browser (instant feedback) and the
 * server (the actual check, before the database checks again). Prices are
 * whole paisa throughout; the browser's figures are only what the customer
 * saw, never what is charged.
 *
 * The address fields are provisional: confirm them against the courier's
 * booking requirements (README, "Checkout").
 */

export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_ORDER_LINES = 50;
/** A quote covers a cart; more lines than this is not a real cart. */
export const MAX_QUOTE_LINES = 30;

export const FIELD_LIMITS = {
  name: { min: 2, max: 80 },
  city: { min: 2, max: 60 },
  address: { min: 10, max: 300 },
  landmark: { min: 0, max: 100 },
  note: { min: 0, max: 200 },
} as const;

export type CustomerInput = {
  name: string;
  phone: string;
  city: string;
  address: string;
  landmark: string;
  note: string;
};

export type Customer = {
  name: string;
  /** E.164, e.g. +923001234567 */
  phone: string;
  city: string;
  address: string;
  landmark: string | null;
  note: string | null;
};

export type CustomerErrors = Partial<Record<keyof CustomerInput, string>>;

/** One cart line as sent to the server: what the customer saw. */
export type OrderLine = { sku: string; quantity: number; unit_price_paisa: number };

/**
 * A Pakistani mobile number in any common form → +923XXXXXXXXX, or null.
 * Accepts 0300 1234567, 0300-1234567, +92 300 1234567, 0092 300 1234567,
 * 92 300 1234567 and 300 1234567.
 */
export function normalizePakistanMobile(input: string): string | null {
  const digits = input.trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const national = digits.startsWith("0092")
    ? digits.slice(4)
    : digits.startsWith("92")
      ? digits.slice(2)
      : digits.startsWith("0")
        ? digits.slice(1)
        : digits;
  return /^3\d{9}$/.test(national) ? `+92${national}` : null;
}

/** Collapses whitespace (including line breaks) and trims. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Control characters other than whitespace (which cleanText collapses).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function validateCustomer(input: Partial<CustomerInput>):
  | { ok: true; customer: Customer }
  | { ok: false; errors: CustomerErrors } {
  const errors: CustomerErrors = {};
  const text = (field: keyof typeof FIELD_LIMITS, missing: string, tooShort: string) => {
    const raw = typeof input[field] === "string" ? input[field] : "";
    const value = cleanText(raw);
    const { min, max } = FIELD_LIMITS[field];
    if (CONTROL.test(raw)) errors[field] = "Remove any unusual characters.";
    else if (!value && min > 0) errors[field] = missing;
    else if (value && value.length < min) errors[field] = tooShort;
    else if (value.length > max) errors[field] = `Keep this under ${max} characters.`;
    return value;
  };

  const name = text("name", "Enter your full name.", "Enter your full name.");
  const city = text("city", "Enter your city.", "Enter your city.");
  const address = text("address", "Enter your full address.", "Add your house number, street and area.");
  const landmark = text("landmark", "", "");
  const note = text("note", "", "");
  const phone = normalizePakistanMobile(typeof input.phone === "string" ? input.phone : "");
  if (!phone) errors.phone = "Enter a Pakistani mobile number, e.g. 0300 1234567.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, customer: { name, phone: phone!, city, address, landmark: landmark || null, note: note || null } };
}

/** Rupees as the catalogue gives them (paisa / 100) → whole paisa. */
export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Cart lines → order lines, sorted by SKU. */
export function orderLinesFromCart(lines: { sku: string; quantity: number; price: number }[]): OrderLine[] {
  return lines
    .map((line) => ({ sku: line.sku, quantity: line.quantity, unit_price_paisa: rupeesToPaisa(line.price) }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

/** A short description of the cart's contents (no personal details). */
export function cartDigest(lines: OrderLine[]): string {
  return [...lines]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((l) => `${l.sku}:${l.quantity}:${l.unit_price_paisa}`)
    .join("|");
}

/** Server side: order lines from untrusted JSON, or null. */
export function parseOrderLines(value: unknown): OrderLine[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ORDER_LINES) return null;
  const lines: OrderLine[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const { sku, quantity, unit_price_paisa } = raw as Record<string, unknown>;
    if (typeof sku !== "string" || sku.length < 1 || sku.length > 64) return null;
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 9999) return null;
    if (!Number.isInteger(unit_price_paisa) || (unit_price_paisa as number) < 0 || (unit_price_paisa as number) > 999_999_999) return null;
    if (lines.some((l) => l.sku === sku)) return null;
    lines.push({ sku, quantity: quantity as number, unit_price_paisa: unit_price_paisa as number });
  }
  return lines.sort((a, b) => a.sku.localeCompare(b.sku));
}

export function isPaisa(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 999_999_999_999;
}
