import { cacheLife, cacheTag } from "next/cache";
import { CATALOGUE_TAG } from "@/lib/catalog/supabase-catalog";
import { parsePhotoPath, PRODUCT_PHOTOS_BUCKET } from "@/lib/catalog/photos";
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
 */

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
      // Short, so an unpublished listing's photos stop being served soon
      // (next/image keeps its optimised copies for longer; see README).
      "Cache-Control": "public, max-age=60, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
