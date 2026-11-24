import type { OrderStatus } from "@/lib/checkout/types";

/*
 * Permanent product deletion: what it would remove, from
 * public.admin_product_deletion_preview
 * (supabase/migrations/20261122150000_product_deletion.sql). The token stands
 * for exactly this state: the delete is refused as "stale" if anything in it
 * has changed since (an edit, a new order, an order's status).
 * Types and texts only (also used by the client panel); the read is
 * getDeletionPreview in lib/admin/products.ts.
 */

export type DeletionBlocker = "open" | "refund_due" | "commission_paid" | "commission_adjusted";

export type DeletionOrder = {
  id: string;
  order_number: string;
  channel: "online" | "in_store";
  status: OrderStatus;
  payment_status: string;
  total_paisa: number;
  created_at: string;
  /** "ITEMCODE Brand Name" of the order's other products (deleted from the order with it). */
  other_products: string[];
  has_referral: boolean;
  blockers: DeletionBlocker[];
};

export type DeletionPreview = {
  product: { id: string; item_code: string; name: string; brand: string; publication_status: string; version: number };
  sizes: number;
  photos: number;
  orders: DeletionOrder[];
  blocked: boolean;
  token: string;
};

export const BLOCKER_TEXT: Record<DeletionBlocker, string> = {
  open: "isn’t finished yet: deliver, return or cancel it first",
  refund_due: "has a refund due: record the refund first",
  commission_paid: "its agent commission has already been paid out",
  commission_adjusted: "its agent commission was adjusted after a payout",
};
