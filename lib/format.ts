const rupees = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const rupeesAndPaisa = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Formats Pakistani rupees, e.g. 8500 → "Rs. 8,500". Prices with paisa keep
 * them (8500.5 → "Rs. 8,500.50") rather than being rounded.
 */
export function formatPrice(amount: number) {
  const whole = Math.abs(amount * 100 - Math.round(amount) * 100) < 0.5;
  return `Rs. ${(whole ? rupees : rupeesAndPaisa).format(amount)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
