import { ProductGrid } from "@/components/product/product-card";
import { getNewestProducts } from "@/lib/catalog/catalog";
import { DEPARTMENTS, DEPARTMENT_ORDER } from "@/lib/catalog/labels";
import type { Product } from "@/lib/catalog/types";
import { FreshFindsTabs } from "./fresh-finds-tabs";
import { SectionHeading } from "./section-heading";

const PER_TAB = 8;

function Panel({ products }: { products: Product[] }) {
  if (products.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-muted">
        Nothing listed here yet. New pairs are added regularly, so check back soon.
      </p>
    );
  }
  return <ProductGrid products={products} />;
}

export async function FreshFinds() {
  const [all, ...byDepartment] = await Promise.all([
    getNewestProducts(PER_TAB),
    ...DEPARTMENT_ORDER.map((dept) => getNewestProducts(PER_TAB, dept)),
  ]);

  const tabs = [
    {
      key: "all",
      label: "All",
      viewAllHref: "/shop",
      viewAllLabel: "View all",
      bottomLabel: "View all shoes",
      panel: <Panel products={all} />,
    },
    ...DEPARTMENT_ORDER.map((dept, i) => ({
      key: dept,
      label: DEPARTMENTS[dept].label,
      viewAllHref: DEPARTMENTS[dept].href,
      viewAllLabel: `View all ${DEPARTMENTS[dept].label.toLowerCase()}`,
      bottomLabel: `View all ${DEPARTMENTS[dept].possessive.toLowerCase()} shoes`,
      panel: <Panel products={byDepartment[i]} />,
    })),
  ];

  return (
    <section aria-labelledby="fresh-finds-heading" className="container-page pt-10 md:pt-14">
      <SectionHeading
        id="fresh-finds-heading"
        title="Fresh Finds"
        description="The latest pre-loved pairs and new kids' styles."
      />
      <FreshFindsTabs tabs={tabs} headingId="fresh-finds-heading" />
    </section>
  );
}
