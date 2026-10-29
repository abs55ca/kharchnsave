import { getAdminClient } from "@/lib/auth/admin";
import { PRODUCT_PHOTOS_BUCKET, UUID_PATTERN } from "@/lib/catalog/photos";

/**
 * GET /admin/products/<product id>/photos/<image id>
 *
 * Admin preview of an uploaded photo, including drafts. Every request checks
 * the verified admin (identity, membership, aal2) and reads the photo with
 * their own session, so Storage's rules apply too. No signed URLs: access
 * ends as soon as the admin's access does. The response is private and never
 * stored by any cache (proxy.ts also marks /admin responses no-store).
 */
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, { params }: RouteContext<"/admin/products/[id]/photos/[imageId]">) {
  const { id, imageId } = await params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(imageId)) {
    return new Response("Not found", { status: 404, headers: PRIVATE });
  }

  const { access, supabase } = await getAdminClient();
  if (!supabase) {
    const status = access.status === "signed-out" ? 401 : access.status === "unavailable" ? 503 : 403;
    return new Response("Admin access required", { status, headers: PRIVATE });
  }

  const { data: image, error } = await supabase
    .from("product_images")
    .select("storage_path")
    .eq("id", imageId)
    .eq("product_id", id)
    .maybeSingle();
  if (error) {
    console.error("[admin] Photo preview lookup failed:", error.code);
    return new Response("Photo unavailable", { status: 503, headers: PRIVATE });
  }
  if (!image?.storage_path) return new Response("Not found", { status: 404, headers: PRIVATE });

  const { data, error: downloadError } = await supabase.storage.from(PRODUCT_PHOTOS_BUCKET).download(image.storage_path);
  if (downloadError || !data) {
    console.error("[admin] Photo preview download failed:", downloadError?.name ?? "no data");
    return new Response("Photo unavailable", { status: 404, headers: PRIVATE });
  }
  return new Response(data, { headers: { ...PRIVATE, "Content-Type": "image/webp" } });
}
