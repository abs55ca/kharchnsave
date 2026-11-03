/*
 * Sale prices. products.price_paisa is the regular price; sale_price_paisa,
 * when set, is what customers pay (the database charges it at checkout:
 * supabase/migrations/20261101130000_item_codes_and_sale_prices.sql). The
 * discount is always calculated from the two prices, never stored.
 */

/** Rupees → whole paisa (prices come from integer paisa, so this is exact). */
const toPaisa = (rupees: number) => Math.round(rupees * 100);

/**
 * The discount as a whole percentage, rounded down so it never claims more
 * than the real saving: Rs. 2,000 → Rs. 1,599 is 20%, not 21%.
 */
export function discountPercent(regularPrice: number, salePrice: number) {
  const regular = toPaisa(regularPrice);
  const sale = toPaisa(salePrice);
  if (regular <= 0 || sale <= 0 || sale >= regular) return 0;
  return Math.floor(((regular - sale) * 100) / regular);
}

/** The badge text: "20% OFF", or "Sale" when the discount is under 1%. */
export function saleBadgeText(regularPrice: number, salePrice: number) {
  const percent = discountPercent(regularPrice, salePrice);
  return percent >= 1 ? `${percent}% OFF` : "Sale";
}

/** Whether a product is on sale: a regular price above what it costs now. */
export function isOnSale(product: { price: number; regularPrice: number | null }) {
  return product.regularPrice !== null && product.regularPrice > product.price;
}

/**
 * The shop's prices from the database columns (paisa): `price` is what a
 * shopper pays now, `regularPrice` the regular price while on sale (else
 * null). A sale price that isn't below the regular price (impossible under
 * the database's constraint) is ignored.
 */
export function pricesFromColumns(row: { price_paisa: number; sale_price_paisa?: number | null }) {
  const sale = row.sale_price_paisa;
  const onSale = typeof sale === "number" && sale > 0 && sale < row.price_paisa;
  return {
    price: (onSale ? sale : row.price_paisa) / 100,
    regularPrice: onSale ? row.price_paisa / 100 : null,
  };
}
