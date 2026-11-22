/*
 * A copy of a photo the browser has already downloaded on this page, to show
 * at once while the sharper copy loads (components/product/product-gallery.tsx).
 *
 * Coming from the catalogue, the product's first photo is already loaded at
 * card size (e.g. 640 px wide); the product page asks next/image for a larger
 * copy (e.g. 1080 px), which can take about a second the first time an edge
 * node makes it. The card's copy is in the browser's cache: shown behind the
 * new one, the photo appears immediately and sharpens when the new one lands.
 *
 * Only copies listed in the page's resource timing are used (requests that
 * finished), so this never starts a download of its own.
 */

export type LoadedResource = { name: string; responseStatus?: number };

const IMAGE_ENDPOINT = "/_next/image";

/** The widest finished next/image copy of `src` among `entries`, or null. */
export function largestLoadedCopy(src: string, entries: readonly LoadedResource[], origin: string): string | null {
  let best: { url: string; width: number } | null = null;
  for (const entry of entries) {
    // 0 or missing: not reported by this browser (same-origin requests report it where supported).
    if (entry.responseStatus && (entry.responseStatus < 200 || entry.responseStatus >= 300)) continue;
    let url: URL;
    try {
      url = new URL(entry.name, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.pathname !== IMAGE_ENDPOINT || url.searchParams.get("url") !== src) continue;
    const width = Number(url.searchParams.get("w"));
    if (!Number.isFinite(width) || width <= 0) continue;
    if (!best || width > best.width) best = { url: entry.name, width };
  }
  return best?.url ?? null;
}

/**
 * The page this document was loaded on. A product page loaded directly shows
 * its first photo from the server-rendered HTML (preloaded), so there is no
 * earlier copy worth showing; any "loaded copy" would be that same photo.
 */
export function loadedDirectly(pathname: string, navigationUrl: string | undefined, origin: string): boolean {
  if (!navigationUrl) return true;
  try {
    return new URL(navigationUrl, origin).pathname === pathname;
  } catch {
    return true;
  }
}
