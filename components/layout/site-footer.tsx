import Link from "next/link";
import { COMPANY_NAV, HELP_NAV, MAIN_NAV, SITE, type NavLink } from "@/lib/site";
import { Logo } from "./logo";

function FooterColumn({ title, links }: { title: string; links: NavLink[] }) {
  return (
    <div>
      <h2 className="eyebrow mb-3 font-sans text-lime">{title}</h2>
      <ul className="space-y-2 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-white/85 hover:text-white hover:underline">
              {link.label}
              {link.soon && !/soon/i.test(link.label) ? <span className="ml-1.5 text-xs text-white/60">(soon)</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="surface-dark mt-16 bg-forest text-white">
      <div className="container-page grid gap-10 py-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="max-w-xs">
          <Logo reverse className="h-10 w-auto" />
          <p className="mt-4 text-sm leading-relaxed text-white/80">{SITE.description}</p>
        </div>
        <FooterColumn title="Shop" links={MAIN_NAV} />
        <FooterColumn title="Help" links={HELP_NAV} />
        <FooterColumn title="Company" links={COMPANY_NAV} />
      </div>
      <div className="border-t border-white/15">
        <div className="container-page flex flex-col gap-2 py-5 text-xs text-white/70 md:flex-row md:items-center md:justify-between">
          <p>© Kharch n Save. Prices shown in Pakistani rupees (Rs.).</p>
        </div>
      </div>
    </footer>
  );
}
