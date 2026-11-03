import { getAdminClient } from "@/lib/auth/admin";
import { calibrationLabels } from "@/lib/labels/zpl";

/**
 * GET /admin/labels/calibration
 *
 * Four test labels (no product data) for checking on the shop's printer
 * that names at the width limit fit on one line: the widest characters, the
 * reference name, the narrowest characters, and accents with digits
 * (CALIBRATION_NAMES in lib/labels/zpl.ts). See README, "Barcodes and labels".
 */
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET() {
  const { access, supabase } = await getAdminClient();
  if (!supabase) {
    const status = access.status === "signed-out" ? 401 : access.status === "unavailable" ? 503 : 403;
    return new Response("Admin access required", { status, headers: PRIVATE });
  }
  return new Response(calibrationLabels(), {
    headers: {
      ...PRIVATE,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="calibration.zpl"',
    },
  });
}
