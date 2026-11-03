import Link from "next/link";
import { SignOutButton } from "./sign-out-button";

const LINKS = [
  { key: "home", href: "/admin", label: "Dashboard" },
  { key: "products", href: "/admin/products", label: "Products" },
  { key: "new", href: "/admin/products/new", label: "Add product" },
  { key: "scan", href: "/admin/scan", label: "Scan" },
  { key: "orders", href: "/admin/orders", label: "Orders" },
  { key: "settings", href: "/admin/settings", label: "Settings" },
] as const;

/** Navigation for verified admins, shown above every admin page. */
export function AdminNav({ current, email }: { current: (typeof LINKS)[number]["key"]; email: string | null }) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <nav aria-label="Admin">
        <ul className="flex flex-wrap gap-1">
          {LINKS.map((link) => (
            <li key={link.key}>
              <Link
                href={link.href}
                aria-current={link.key === current ? "page" : undefined}
                className={`inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold ${
                  link.key === current ? "bg-forest text-white" : "text-ink hover:bg-cream"
                }`}
              >
                {link.label}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/" className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-ink hover:bg-cream">
              View shop
            </Link>
          </li>
        </ul>
      </nav>
      <div className="flex items-center gap-3">
        {email ? <span className="hidden text-xs text-muted sm:inline">{email}</span> : null}
        <SignOutButton />
      </div>
    </div>
  );
}
