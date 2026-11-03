import { AdminDataError } from "@/lib/admin/products";
import { getScanProduct } from "@/lib/admin/scan";
import { getAdminClient } from "@/lib/auth/admin";
import { UUID_PATTERN } from "@/lib/catalog/photos";
import { labelNameFor } from "@/lib/labels/name-fit";
import { buildLabels, parseQuantity, type LabelSpec } from "@/lib/labels/zpl";

/**
 * GET /admin/products/<product id>/labels/download?q_<size>=<quantity>
 *
 * A .zpl file for the shop's label printer. Every request checks the
 * verified admin and reads the product, its label name, sizes and barcodes
 * with their own session; the request only chooses how many labels per size
 * (0 or absent skips a size). The name is the product's saved label name, or
 * its full name: the same check as the label page (lib/labels/name-fit.ts),
 * and a name that doesn't fit is refused, never cut short. Reading only: nothing is changed. Private
 * and never cached (proxy.ts also marks /admin responses no-store).
 */
const PRIVATE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(request: Request, { params }: RouteContext<"/admin/products/[id]/labels/download">) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return text("Not found", 404);

  const { access, supabase } = await getAdminClient();
  if (!supabase) {
    const status = access.status === "signed-out" ? 401 : access.status === "unavailable" ? 503 : 403;
    return text("Admin access required", status);
  }

  let product;
  try {
    product = await getScanProduct(supabase, id);
  } catch (error) {
    console.error("[admin] Label lookup failed:", error instanceof AdminDataError ? error.message : "unknown");
    return text("The product couldn't be loaded right now. Go back and try again.", 503);
  }
  if (!product) return text("Not found", 404);

  const name = labelNameFor(product);
  if (name.problem) return text(`${name.problem} Change it on the product page, then print again.`, 409);

  const search = new URL(request.url).searchParams;
  const specs: LabelSpec[] = [];
  for (const unit of product.units) {
    const raw = search.get(`q_${unit.size}`);
    if (raw === null || !unit.barcode) continue;
    const quantity = parseQuantity(raw, { allowZero: true });
    if (quantity === null) return text("Label quantities are whole numbers from 0 to 100. Go back and correct them.", 400);
    if (quantity > 0) specs.push({ name: name.text, size: unit.size, barcode: unit.barcode, quantity });
  }
  if (specs.length === 0) return text("Choose at least one label. Go back and enter a quantity.", 400);

  const filename =
    specs.length === 1 ? `${specs[0].barcode}-x${specs[0].quantity}.zpl` : `${product.itemCode}-labels.zpl`;
  return new Response(buildLabels(specs), {
    headers: {
      ...PRIVATE,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
