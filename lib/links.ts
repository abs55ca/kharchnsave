import { DEPARTMENTS } from "./catalog/labels";

/*
 * The links page (/links) and the permanent QR code on merchandise (/qr).
 * Everything that might change lives here: add a link (WhatsApp, TikTok…)
 * to LINKS, or point the printed QR codes somewhere else by changing
 * QR_REDIRECT_TARGET. No database, no secrets.
 */

/** The shop's public address. Used for the QR code and social previews, never the dev URL. */
export const SITE_ORIGIN = "https://kharchnsave.pk";

/**
 * Printed on merchandise as a QR code, so it must never change. Regenerate
 * the artwork with `npm run qr` (files in merch/qr/).
 */
export const QR_PATH = "/qr";
export const QR_CODE_URL = `${SITE_ORIGIN}${QR_PATH}`;

/**
 * Where /qr sends people, with a TEMPORARY redirect (307) that browsers
 * don't cache, so this can be changed at any time without reprinting. A path
 * on this site or a full https:// address.
 */
export const QR_REDIRECT_TARGET = "/links?utm_source=merch&utm_medium=qr";

export type LinkIcon = "instagram" | "facebook" | "shop" | "home";

export type SiteLink = {
  id: string;
  label: string;
  href: string;
  icon: LinkIcon;
  /** Opens in a new tab, with rel="noopener noreferrer". */
  external: boolean;
  /** Social links stand out (lime); the rest are the shop's own pages. */
  style: "social" | "shop";
};

export const LINKS: SiteLink[] = [
  { id: "instagram", label: "Instagram", href: "https://instagram.com/kharchnsave", icon: "instagram", external: true, style: "social" },
  { id: "facebook", label: "Facebook", href: "https://facebook.com/kharchnsave", icon: "facebook", external: true, style: "social" },
  { id: "shop-men", label: "Shop Men", href: DEPARTMENTS.men.href, icon: "shop", external: false, style: "shop" },
  { id: "shop-women", label: "Shop Women", href: DEPARTMENTS.women.href, icon: "shop", external: false, style: "shop" },
  { id: "shop-kids", label: "Shop Kids", href: DEPARTMENTS.kids.href, icon: "shop", external: false, style: "shop" },
  { id: "home", label: "Visit the shop", href: "/", icon: "home", external: false, style: "shop" },
];
