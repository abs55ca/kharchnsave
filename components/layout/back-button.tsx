"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

/*
 * A back arrow in the phone header (hidden on the home page and from lg up).
 * It goes back within the shop when there is somewhere to go back to (pages
 * visited in this tab, tracked below); otherwise, e.g. after opening a shared
 * product link, it goes up a level instead of leaving the site.
 */

// Paths visited in this tab, oldest first. A visit to the path before the
// current one is taken as going back.
const visited: string[] = [];

function parentOf(pathname: string) {
  if (pathname.startsWith("/products/")) return "/shop";
  if (pathname.startsWith("/account/")) return "/account";
  return "/";
}

export function BackButton() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (visited.at(-1) === pathname) return;
    if (visited.at(-2) === pathname) visited.pop();
    else visited.push(pathname);
  }, [pathname]);

  if (pathname === "/") return null;
  return (
    <button
      type="button"
      onClick={() => (visited.length > 1 ? router.back() : router.push(parentOf(pathname)))}
      aria-label="Go back"
      className="-ml-1 inline-flex size-10 shrink-0 items-center justify-center rounded-md text-ink hover:bg-cream lg:hidden"
    >
      <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}
