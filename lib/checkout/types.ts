/* Shapes returned by the checkout database functions (see
   supabase/migrations/20261031130000_guest_orders.sql). */

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
  /** The regular price, for display (higher than unit_price_paisa while on sale). */
  regular_price_paisa?: number | null;
  price_changed: boolean;
  seen_price_paisa: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotal_paisa: number;
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
