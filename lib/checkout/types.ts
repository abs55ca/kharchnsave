/* Shapes returned by the checkout database functions (see
   supabase/migrations/20261031130000_guest_orders.sql and
   20261118120100_referral_checkout.sql). */

export type QuoteLine = {
  sku: string;
  status: "ok" | "reduced" | "sold_out" | "unavailable";
  name: string | null;
  brand: string | null;
  size_eu: number | null;
  item_status: "new" | "preloved" | null;
  quantity: number;
  allowed_quantity: number;
  available: number;
  /** What the customer pays: the sale price while on sale. */
  unit_price_paisa: number | null;
  /** The regular price (higher than unit_price_paisa while on sale). Not shown as a "was" price: see reference_price_paisa. */
  regular_price_paisa?: number | null;
  /** The supported "was" price while on sale (genuine price history); null or absent: show no crossed-out price. */
  reference_price_paisa?: number | null;
  /** True for a clearance item whose sale excludes referral-code discounts. */
  referral_excluded?: boolean;
  price_changed: boolean;
  seen_price_paisa: number;
  /** While a referral code applies: whether this line qualifies for its discount; otherwise null. */
  referral_eligible: boolean | null;
  /** This line's share of the referral discount (0 without one). */
  discount_paisa: number;
};

/**
 * The referral code on a quote. Only the code and its customer-facing terms:
 * never who the agent is or what they earn.
 *   ok                 applies (at least one line qualifies)
 *   invalid            no such code (or malformed)
 *   disabled           the code isn't accepted at the moment
 *   no_eligible_items  nothing in this cart qualifies (e.g. sale items)
 */
export type QuoteReferral = {
  code: string;
  status: "ok" | "invalid" | "disabled" | "no_eligible_items";
  discount_bp?: number;
  applies_to_sale_items?: boolean;
};

export type Quote = {
  lines: QuoteLine[];
  subtotal_paisa: number;
  /** Referral discount (0 without a code). */
  discount_paisa: number;
  /** subtotal - discount: what free delivery is judged on. */
  merchandise_paisa: number;
  referral: QuoteReferral | null;
  delivery_status: "ok" | "not_configured" | "city_required" | "not_served";
  delivery_paisa: number;
  total_paisa: number;
  free_delivery_min_paisa: number | null;
  orders_open: boolean;
  exact: boolean;
};

export type OrderStatus =
  | "awaiting_confirmation"
  | "confirmed"
  | "dispatched"
  | "delivery_failed"
  | "delivered"
  | "returned"
  | "cancelled"
  | "completed";

export type PaymentStatus = "pending" | "collected" | "settled" | "refund_due" | "refunded" | "void";

export type CustomerOrderView = {
  order_number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  placed_at: string;
  hold_expires_at: string | null;
  first_name: string;
  phone_last_digits: string;
  city: string;
  courier: string | null;
  tracking_number: string | null;
  subtotal_paisa: number;
  discount_paisa: number;
  referral_code: string | null;
  delivery_paisa: number;
  total_paisa: number;
  items: {
    name: string;
    brand: string;
    size_eu: number;
    item_status: "new" | "preloved";
    condition: string;
    quantity: number;
    unit_price_paisa: number;
    line_total_paisa: number;
    discount_paisa: number;
  }[];
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_confirmation: "Waiting for us to confirm",
  confirmed: "Confirmed",
  dispatched: "With the courier",
  delivery_failed: "Delivery attempt failed",
  delivered: "Delivered",
  returned: "Returned",
  cancelled: "Cancelled",
  completed: "Completed",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Cash on delivery",
  collected: "Paid",
  settled: "Paid",
  refund_due: "Refund due",
  refunded: "Refunded",
  void: "Nothing to pay",
};
