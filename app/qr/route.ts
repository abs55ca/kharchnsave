import { QR_REDIRECT_TARGET } from "@/lib/links";

/**
 * GET /qr: the permanent address printed on merchandise as a QR code.
 *
 * Always a TEMPORARY redirect (307), never a permanent one (308/301), and
 * marked no-store, so neither browsers nor caches remember where it pointed:
 * changing QR_REDIRECT_TARGET in lib/links.ts takes effect for every printed
 * code at the next deploy. It reads the request, so it runs on every request
 * and is never prerendered into a static, cacheable response.
 */
const HEADERS = { "Cache-Control": "no-store, max-age=0" };

export function GET(request: Request) {
  // A path is resolved against this site's own address; a full URL is kept as is.
  const location = new URL(QR_REDIRECT_TARGET, request.url);
  return new Response(null, { status: 307, headers: { ...HEADERS, Location: location.toString() } });
}

export function HEAD(request: Request) {
  return GET(request);
}
