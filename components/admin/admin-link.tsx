import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * Links in the admin area. Next.js prefetches every link that scrolls into
 * view, in production; admin pages are per-request and signed in, so each
 * prefetch is an authenticated request through the proxy and the access
 * checks, for pages the admin mostly won't open (every nav item and table
 * row, again after each save). Admin links don't prefetch unless they ask to
 * (`prefetch`); navigation itself is unchanged.
 */
export default function AdminLink({ prefetch = false, ...props }: ComponentProps<typeof Link>) {
  return <Link prefetch={prefetch} {...props} />;
}
