"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { MenuIcon } from "@/components/icons";
import { Drawer } from "@/components/ui/drawer";
import { HELP_NAV, MAIN_NAV, STYLE_NAV, type NavLink } from "@/lib/site";

function LinkGroup({
  title,
  links,
  onNavigate,
}: {
  title: string;
  links: NavLink[];
  onNavigate: () => void;
}) {
  const headingId = useId();
  return (
    <nav aria-labelledby={headingId} className="px-5 py-4">
      <h3 id={headingId} className="eyebrow mb-2 text-muted">
        {title}
      </h3>
      <ul className="space-y-0.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={onNavigate}
              className="-mx-2 flex items-center gap-1.5 rounded-md px-2 py-2 text-[15px] font-medium hover:bg-cream"
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
    </nav>
  );
}

export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const close = () => setOpen(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="-ml-2 inline-flex rounded-md p-2 text-ink hover:bg-cream lg:hidden"
        aria-label="Open menu"
      >
        <MenuIcon width={22} height={22} />
      </button>
      <Drawer open={open} onClose={close} side="left" title="Menu" titleId={titleId}>
        <div className="divide-y divide-line">
          <LinkGroup title="Shop" links={MAIN_NAV} onNavigate={close} />
          <LinkGroup title="Shop by style" links={STYLE_NAV} onNavigate={close} />
          <LinkGroup
            title="Help"
            links={[...HELP_NAV, { label: "Account", href: "/account" }]}
            onNavigate={close}
          />
        </div>
      </Drawer>
    </>
  );
}
