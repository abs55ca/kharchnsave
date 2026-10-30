import type { Metadata } from "next";
import Link from "next/link";
import { KMark } from "@/components/brand/k-mark";
import { LINKS, SITE_ORIGIN, type LinkIcon, type SiteLink } from "@/lib/links";
import { SITE } from "@/lib/site";

/*
 * /links: where the merchandise QR code (/qr) leads. A standalone page
 * (no shop header or footer; see components/layout/site-chrome.tsx), built
 * entirely from LINKS in lib/links.ts.
 */

const TITLE = `${SITE.name}: Instagram, Facebook and the shop`;
const DESCRIPTION =
  "Pre-loved shoes for men and women and brand-new shoes for kids, in Pakistani rupees. Follow Kharch n Save on Instagram and Facebook, or shop online.";

// metadataBase (https://kharchnsave.pk) comes from the root layout.
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/links" },
  openGraph: {
    type: "website",
    url: "/links",
    siteName: SITE.name,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_PK",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const ICON_PATHS: Record<LinkIcon, React.ReactNode> = {
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  facebook: <path d="M14.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4a21 21 0 0 0-2.3-.1c-2.3 0-3.8 1.4-3.8 4v2.2H9v3h2.5V21" />,
  shop: (
    <>
      <path d="M5 8h14l-1 12H6L5 8Z" />
      <path d="M9 8a3 3 0 0 1 6 0" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-6 9 6" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
};

function Icon({ name, className }: { name: LinkIcon; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

const BUTTON =
  "relative flex min-h-14 w-full items-center justify-center rounded-full px-14 py-3 text-base font-semibold transition-colors";
const STYLES: Record<SiteLink["style"], string> = {
  social: "bg-lime text-forest hover:bg-lime-hover",
  shop: "bg-white text-forest hover:bg-cream",
};

function LinkButton({ link }: { link: SiteLink }) {
  const content = (
    <>
      <Icon name={link.icon} className="absolute left-5 size-6" />
      <span>{link.label}</span>
      {link.external ? (
        <>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="absolute right-5 size-4 opacity-70"
          >
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
          <span className="sr-only"> (opens in a new tab)</span>
        </>
      ) : null}
    </>
  );
  const className = `${BUTTON} ${STYLES[link.style]}`;
  return link.external ? (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={className} data-link={link.id}>
      {content}
    </a>
  ) : (
    <Link href={link.href} className={className} data-link={link.id}>
      {content}
    </Link>
  );
}

export default function LinksPage() {
  return (
    <div className="surface-dark min-h-dvh bg-forest px-4 pt-12 pb-10 text-white">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <div className="flex size-24 items-center justify-center rounded-3xl bg-white p-4 shadow-lg shadow-black/20">
          <KMark className="size-full" />
        </div>
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight">{SITE.name}</h1>
        <p className="mt-2 text-lg font-semibold text-lime">{SITE.tagline}</p>
        <p className="mt-1 text-sm text-white/80">Pre-loved shoes for men and women. Brand-new shoes for kids.</p>

        <nav aria-label={`${SITE.name} links`} className="mt-8 w-full">
          <ul className="flex flex-col gap-3">
            {LINKS.map((link) => (
              <li key={link.id}>
                <LinkButton link={link} />
              </li>
            ))}
          </ul>
        </nav>

        <p className="mt-10 text-xs text-white/60">{new URL(SITE_ORIGIN).host}</p>
      </div>
    </div>
  );
}
