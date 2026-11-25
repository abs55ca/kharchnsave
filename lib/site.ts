import { DEPARTMENTS } from "./catalog/labels";
import { catalogHref } from "./catalog/query";

export const SITE = {
  name: "Kharch n Save",
  tagline: "Style Zyada. Kharch Kam.",
  description:
    "Affordable pre-loved shoes for men and women, and brand-new shoes for kids, priced in Pakistani rupees.",
};

/** `soon`: shown with a "Soon" tag (nothing listed there yet). */
export type NavLink = { label: string; href: string; soon?: boolean };

/** Departments with nothing listed yet: "Soon" in the menus, a coming-soon page in the shop. */
export const SOON_DEPARTMENTS = ["men", "women"] as const;

export const MAIN_NAV: NavLink[] = [
  { label: "Men", href: DEPARTMENTS.men.href, soon: true },
  { label: "Women", href: DEPARTMENTS.women.href, soon: true },
  { label: "Kids", href: DEPARTMENTS.kids.href },
  // "newest" is the default sort; the explicit param titles the page "New Arrivals".
  { label: "New Arrivals", href: "/shop?sort=newest" },
  { label: "Coming Soon", href: "/coming-soon", soon: true },
];

export const STYLE_NAV: NavLink[] = [
  { label: "Sneakers", href: catalogHref({ styles: ["sneakers"] }) },
  { label: "Running", href: catalogHref({ styles: ["running"] }) },
  { label: "Casual", href: catalogHref({ styles: ["casual"] }) },
  { label: "Formal", href: catalogHref({ styles: ["formal"] }) },
  { label: "Heels", href: catalogHref({ styles: ["heels"] }) },
  { label: "Boots", href: catalogHref({ styles: ["boots"] }) },
];

export const HELP_NAV: NavLink[] = [
  { label: "Size Guide", href: "/size-guide" },
  { label: "Condition Guide", href: "/condition-guide" },
  { label: "Delivery & Returns", href: "/delivery-returns" },
];

export const COMPANY_NAV: NavLink[] = [
  { label: "About Kharch n Save", href: "/about" },
  { label: "Account", href: "/account" },
  { label: "Cart", href: "/cart" },
];
