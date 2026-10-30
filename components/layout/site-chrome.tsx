"use client";

import { usePathname } from "next/navigation";
import { Suspense } from "react";

/**
 * Pages that stand on their own, without the shop's announcement bar,
 * header and footer (the footer carries the demo-store notice): the links
 * page reached from the merchandise QR code.
 */
export const STANDALONE_PATHS = new Set(["/links"]);

function HiddenOnStandalonePages({ children }: { children: React.ReactNode }) {
  return STANDALONE_PATHS.has(usePathname()) ? null : children;
}

/**
 * The shop's chrome, left out on standalone pages. Static pages (including
 * /links) know their path when they're prerendered. Dynamic pages only know
 * it per request, so their prerendered shell shows the chrome as usual (the
 * Suspense fallback) and the same chrome replaces it at request time.
 */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={children}>
      <HiddenOnStandalonePages>{children}</HiddenOnStandalonePages>
    </Suspense>
  );
}
