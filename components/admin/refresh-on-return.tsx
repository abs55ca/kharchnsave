"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const MIN_AGE_MS = 5_000;

// When this browser last fetched each page instance from the server. A fresh
// (push or replace) navigation gets a new bfcacheId; Back/Forward and
// router.refresh() keep it.
const fetchedAt = new Map<string, number>();

/**
 * Re-renders the page from the server when it's shown again with data more
 * than a few seconds old: on returning to the tab or window, and on
 * Back/Forward (Next.js shows those pages as they were). Stock changed
 * elsewhere (orders, another tab) then shows without a manual refresh. Not
 * polling: nothing happens while the page is in use, and only the visible
 * page listens. The server checks access again as usual. Forms keep unsaved
 * input; the product editor decides what to do with a newer copy
 * (lib/admin/product-sync.ts).
 */
export function RefreshOnReturn() {
  const router = useRouter();
  const { bfcacheId } = router;
  useEffect(() => {
    if (!fetchedAt.has(bfcacheId)) fetchedAt.set(bfcacheId, Date.now());
    const refreshIfOld = () => {
      if (document.visibilityState !== "visible" || Date.now() - fetchedAt.get(bfcacheId)! < MIN_AGE_MS) return;
      fetchedAt.set(bfcacheId, Date.now());
      router.refresh();
    };
    refreshIfOld();
    document.addEventListener("visibilitychange", refreshIfOld);
    window.addEventListener("focus", refreshIfOld);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfOld);
      window.removeEventListener("focus", refreshIfOld);
    };
  }, [router, bfcacheId]);
  return null;
}
