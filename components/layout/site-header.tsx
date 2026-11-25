import Link from "next/link";
import { CartButton } from "@/components/cart/cart-button";
import { UserIcon } from "@/components/icons";
import { HELP_NAV, MAIN_NAV, SITE } from "@/lib/site";
import { Logo } from "./logo";
import { MobileMenu } from "./mobile-menu";
import { SearchForm } from "./search-form";

export function AnnouncementBar() {
  return (
    <div className="surface-dark bg-forest text-white">
      <p className="container-page flex h-8 items-center justify-center gap-2 text-center text-xs font-medium tracking-wide">
        <span>{SITE.tagline}</span>
        <span aria-hidden="true" className="hidden size-1 rounded-full bg-lime sm:inline-block" />
        <span className="hidden sm:inline">Pre-loved &amp; brand-new footwear</span>
      </p>
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-white">
      <div className="container-page">
        <div className="flex h-16 items-center gap-3 lg:h-[72px] lg:gap-8">
          <MobileMenu />
          <Logo className="h-8 w-auto sm:h-9 lg:h-10" />
          <SearchForm
            id="site-search-desktop"
            className="hidden flex-1 md:block lg:max-w-xl"
          />
          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/account"
              className="inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-cream"
            >
              <UserIcon width={22} height={22} />
              <span className="sr-only lg:not-sr-only">Account</span>
            </Link>
            <CartButton />
          </div>
        </div>
        <div className="pb-3 md:hidden">
          <SearchForm id="site-search-mobile" />
        </div>
      </div>
      <nav aria-label="Main" className="hidden border-t border-line lg:block">
        <div className="container-page flex h-11 items-center justify-between">
          <ul className="flex items-center gap-7">
            {MAIN_NAV.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="flex items-center gap-1.5 py-2 text-sm font-semibold text-ink hover:text-forest hover:underline hover:underline-offset-8 hover:decoration-lime hover:decoration-2"
                >
                  {link.label}
                  {link.soon ? (
                    <span className="rounded-sm bg-cream px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      Soon
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <ul className="flex items-center gap-5 text-[13px] text-muted">
            {HELP_NAV.slice(0, 2).map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="hover:text-forest hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </header>
  );
}
