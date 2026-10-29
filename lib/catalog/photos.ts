/*
 * Product photos uploaded by admins live in the PRIVATE Supabase Storage
 * bucket below, at "<product id>/<image id>.webp". The database stores that
 * object path (product_images.storage_path), never a URL.
 *
 * Shoppers load them through app/product-photos/[productId]/[file]/route.ts,
 * which reads them with the public key: Storage's access rules only allow
 * that while the photo belongs to a published product. Admins preview drafts
 * through a separate, signed-in route under /admin.
 */

export const PRODUCT_PHOTOS_BUCKET = "product-photos";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UUID_PATTERN = new RegExp(`^${UUID}$`);
const PHOTO_FILE_PATTERN = new RegExp(`^(${UUID})\\.webp$`);

/** The Storage object path for a new photo of a product. */
export function photoObjectPath(productId: string, imageId: string) {
  return `${productId}/${imageId}.webp`;
}

/** Splits "<product id>/<image id>.webp", or returns null if it isn't one. */
export function parsePhotoPath(productId: string, file: string) {
  const match = PHOTO_FILE_PATTERN.exec(file);
  if (!UUID_PATTERN.test(productId) || !match) return null;
  return { productId, imageId: match[1], path: photoObjectPath(productId, match[1]) };
}

/** Public URL path for a published product's photo (optimised by next/image). */
export function productPhotoSrc(storagePath: string) {
  return `/product-photos/${storagePath}`;
}
