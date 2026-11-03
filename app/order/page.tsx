import type { Metadata } from "next";
import { OrderStatus } from "@/components/checkout/order-status";

export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};

// A static page: the order is fetched in the browser with the private key
// from the link's fragment, which never reaches the server in a URL.
export default function OrderPage() {
  return (
    <div className="container-page py-8 md:py-10">
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight md:text-3xl">Your order</h1>
      <OrderStatus />
    </div>
  );
}
