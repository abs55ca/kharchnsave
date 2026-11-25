import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";

export const metadata: Metadata = {
  title: "Delivery & Returns",
  description: "How delivery, payment and returns work at Kharch n Save.",
};

export default function DeliveryReturnsPage() {
  return (
    <div className="container-page py-6 md:py-8">
      <PageHeader title="Delivery & Returns" intro="How your order reaches you, and how you pay for it." />
      <div className="max-w-3xl space-y-8 text-sm leading-relaxed text-ink/85">
        <section aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="text-base font-bold text-ink">
            Payment: cash on delivery
          </h2>
          <p className="mt-2">
            You pay the courier in cash when your order arrives. Nothing is paid online.
          </p>
        </section>

        <section aria-labelledby="confirm-heading">
          <h2 id="confirm-heading" className="text-base font-bold text-ink">
            We confirm every order
          </h2>
          <p className="mt-2">
            After you place an order, we contact you by phone or WhatsApp to confirm it before it&apos;s dispatched.
            Your items are held for you until then.
          </p>
        </section>

        <section aria-labelledby="delivery-heading">
          <h2 id="delivery-heading" className="text-base font-bold text-ink">
            Delivery charges
          </h2>
          <p className="mt-2">
            The delivery charge for your city, and the order total that gets free delivery, are shown at checkout
            before you place your order.
          </p>
        </section>

        <section aria-labelledby="returns-heading">
          <h2 id="returns-heading" className="text-base font-bold text-ink">
            Returns and exchanges
          </h2>
          <p className="mt-2">
            Questions about a return or an exchange? Ask us when we contact you to confirm your order, or reply to that
            message at any time.
          </p>
        </section>

        <p className="text-muted">
          Not sure about fit? Check the{" "}
          <Link href="/size-guide" className="link-underline">
            size guide
          </Link>{" "}
          and the{" "}
          <Link href="/condition-guide" className="link-underline">
            condition guide
          </Link>{" "}
          before you order.
        </p>
      </div>
    </div>
  );
}
