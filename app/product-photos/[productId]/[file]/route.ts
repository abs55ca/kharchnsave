import { cacheLife, cacheTag } from "next/cache";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";
import { parsePhotoPath, photoCacheTag, PRODUCT_PHOTOS_BUCKET } from "@/lib/catalog/photos";
import { getSupabase } from "@/lib/supabase/server";

/**
 * GET /product-photos/<product id>/<image id>.webp
 *
 * Shoppers' view of an uploaded product photo. It is read from the private
 * Storage bucket with the public key, so Storage's access rules decide: the
 * photo is returned only while it belongs to a published product, and drafts,
 * archived listings and unused uploads are 404. The bytes are cached with the
 * catalogue (same tag, same lifetime), so publishing or unpublishing refreshes
 * them together. next/image optimises these like any other local image.
 * CDN and browser caching: PHOTO_CACHE_HEADERS below.
 */

/*
 * Caching, bounded. A photo's address never changes what it shows (every
 * upload gets a new image id; uploads never overwrite), so caching is safe
 * while the product is public; the bounds limit how long a copy can outlive
 * an unpublish if a purge doesn't happen:
 *   - Netlify's shared ("durable") CDN cache: at most 4 hours (s-maxage=14400),
 *     no stale serving. Netlify's image CDN fetches this route for each photo
 *     size an edge node hasn't made yet; a shared-cache hit avoids a function
 *     run (measured 1.7 to 2 seconds per photo on 2026-11-17). Netlify's
 *     Next.js runtime keeps an app-set Netlify-CDN-Cache-Control as it is
 *     (from its source; not yet observed on the host).
 *   - Browsers: at most 1 hour.
 *   - Netlify-Cache-Tag: the admin actions call updateTag(photoCacheTag(id))
 *     on unpublish, archive or photo removal; Netlify's runtime source passes
 *     it to Netlify's purge API (not yet observed on the host). A deploy
 *     clears the cache too.
 * These headers do NOT bound Netlify's RESIZED copies (/_next/image): Netlify
 * documents that source headers don't control its own image cache, and
 * resized copies were measured stored for about a year per edge node. Their
 * retention and invalidation are unverified until tested on the host
 * (README, "Product photos").
 */
const PHOTO_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=14400",
} as const;

// "Not found" is cached too (as null) and refreshed with the catalogue.
async function readPublishedPhoto(path: string): Promise<Uint8Array | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(CATALOGUE_TAG);

  const { data, error } = await getSupabase().storage.from(PRODUCT_PHOTOS_BUCKET).download(path);
  if (error || !data) {
    // Storage answers 400/404 for objects the public may not read.
    const status = (error as { status?: number; statusCode?: string } | null)?.status;
    if (status && status >= 500) throw new Error(`Couldn't read a product photo from Storage (${status}).`);
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
}

export async function GET(_request: Request, { params }: RouteContext<"/product-photos/[productId]/[file]">) {
  const { productId, file } = await params;
  const photo = parsePhotoPath(productId, file);
  if (!photo) return new Response("Not found", { status: 404 });

  let bytes: Uint8Array | null;
  try {
    bytes = await readPublishedPhoto(photo.path);
  } catch (error) {
    console.error(error);
    return new Response("Photo unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!bytes) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "image/webp",
      ...PHOTO_CACHE_HEADERS,
      "Netlify-Cache-Tag": photoCacheTag(photo.productId),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
