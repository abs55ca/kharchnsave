import Link from "next/link";
import type { ScanInput } from "@/lib/barcodes/code";
import type { ScanProduct, ScanResult, ScanUnit } from "@/lib/admin/scan";
import { labelSize } from "@/lib/labels/zpl";
import { fullName } from "@/lib/catalog/product-utils";
import { formatPrice } from "@/lib/format";
import { PublicationBadge } from "./publication-badge";

/*
 * What a scan found, with plain-language notes for anything that matters at
 * the counter: archived, draft, sold or out of stock, a retired label, or
 * nothing found. States are spelled out in words, not shown by colour alone.
 */

type Note = { tone: "ok" | "warn" | "stop"; title: string; text: string };

const NOTE_STYLES: Record<Note["tone"], string> = {
  ok: "border-forest bg-forest-soft",
  warn: "border-ink/40 bg-sand",
  stop: "border-danger bg-white",
};

function NoteBox({ note }: { note: Note }) {
  return (
    <p className={`rounded-md border-l-4 px-4 py-3 text-sm ${NOTE_STYLES[note.tone]}`}>
      <strong className={note.tone === "stop" ? "text-danger" : undefined}>{note.title}</strong> {note.text}
    </p>
  );
}

function productNotes(product: ScanProduct): Note[] {
  if (product.status === "archived") {
    return [{ tone: "stop", title: "Archived.", text: "Not for sale and not in the shop. Restore it as a draft on the product page if it’s back in stock." }];
  }
  if (product.status === "draft") return [{ tone: "warn", title: "Draft.", text: "Not in the shop yet." }];
  return [];
}

function unitNotes(product: ScanProduct, unit: ScanUnit): Note[] {
  const notes = productNotes(product);
  if (unit.stock === 0) {
    notes.push(
      product.itemStatus === "preloved"
        ? { tone: "stop", title: "Sold.", text: "The database shows this pair as sold (stock 0). If it’s here, check the product page." }
        : {
            tone: "stop",
            title: "Out of stock.",
            text: `The database shows 0 pairs in ${labelSize(unit.size)}. If this pair is here, update the stock on the product page.`,
          },
    );
  }
  if (notes.length === 0) notes.push({ tone: "ok", title: "Published and in stock.", text: "" });
  return notes;
}

function stockText(product: ScanProduct, stock: number) {
  if (product.itemStatus === "preloved") return stock > 0 ? "1 (for sale)" : "0 (sold)";
  return String(stock);
}

/** The price to charge: the sale price while on sale, with the regular price struck through. */
function ChargePrice({ product }: { product: ScanProduct }) {
  if (product.salePricePaisa === null) return <strong>{formatPrice(product.pricePaisa / 100)}</strong>;
  return (
    <>
      <strong>{formatPrice(product.salePricePaisa / 100)}</strong>{" "}
      <span className="text-sm font-normal text-muted">
        (regular <s className="decoration-danger">{formatPrice(product.pricePaisa / 100)}</s>)
      </span>
    </>
  );
}

function labelHref(product: ScanProduct, size?: number) {
  return `/admin/products/${product.id}/labels${size === undefined ? "" : `?size=${size}`}`;
}

function ProductHeading({ product }: { product: ScanProduct }) {
  return (
    <div className="flex gap-4">
      <div className="size-24 shrink-0 overflow-hidden rounded bg-cream">
        {product.photo ? (
          // Admin previews of private photos: never through next/image's shared cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.photo.src} alt={product.photo.alt} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-xs text-muted">No photo</span>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {product.brand} · <span className="font-mono normal-case">{product.itemCode}</span>
        </p>
        <h2 className="text-xl font-extrabold tracking-tight">{fullName(product)}</h2>
        <p className="mt-0.5 text-sm text-muted">
          {product.colour} · {product.itemStatus === "preloved" ? "Pre-loved" : "New"}
        </p>
        <div className="mt-1.5">
          <PublicationBadge status={product.status} />
        </div>
      </div>
    </div>
  );
}

function UnitCard({ product, unit, matchedBy }: { product: ScanProduct; unit: ScanUnit; matchedBy: "barcode" | "sku" }) {
  return (
    <article aria-label="Scan result" className="rounded-lg border border-line p-5">
      <ProductHeading product={product} />
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Size</dt>
          <dd className="text-lg font-bold">{labelSize(unit.size)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{product.salePricePaisa !== null ? "Sale price" : "Price"}</dt>
          <dd className="text-lg font-bold">
            <ChargePrice product={product} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Stock</dt>
          <dd className="text-lg font-bold">{stockText(product, unit.stock)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">SKU</dt>
          <dd className="font-mono">{unit.sku}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Barcode</dt>
          <dd className="font-mono">{unit.barcode ?? "–"}</dd>
        </div>
        {matchedBy === "sku" ? (
          <div>
            <dt className="text-xs text-muted">Found by</dt>
            <dd>SKU</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-5 space-y-2">
        {unitNotes(product, unit).map((note) => (
          <NoteBox key={note.title} note={note} />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href={`/admin/products/${product.id}`} className="btn btn-outline">
          Open product
        </Link>
        <Link href={labelHref(product, unit.size)} className="btn btn-outline">
          Print label
        </Link>
      </div>
    </article>
  );
}

function ProductCard({ product }: { product: ScanProduct }) {
  return (
    <article aria-label="Scan result" className="rounded-lg border border-line p-5">
      <ProductHeading product={product} />
      <p className="mt-4 text-sm">
        Found by item code. {product.salePricePaisa !== null ? "Sale price" : "Price"}: <ChargePrice product={product} />
      </p>
      <div className="mt-3 space-y-2">
        {productNotes(product).map((note) => (
          <NoteBox key={note.title} note={note} />
        ))}
      </div>
      <table className="mt-4 w-full text-left text-sm">
        <caption className="sr-only">Sizes, stock and barcodes</caption>
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th scope="col" className="py-2 font-semibold">Size</th>
            <th scope="col" className="py-2 font-semibold">Stock</th>
            <th scope="col" className="py-2 font-semibold">Barcode</th>
            <th scope="col" className="py-2 font-semibold">
              <span className="sr-only">Label</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {product.units.map((unit) => (
            <tr key={unit.variantId}>
              <td className="py-2 font-semibold">{labelSize(unit.size)}</td>
              <td className="py-2">
                {stockText(product, unit.stock)}
                {unit.stock === 0 && product.itemStatus === "new" ? " (out of stock)" : null}
              </td>
              <td className="py-2 font-mono">{unit.barcode ?? "–"}</td>
              <td className="py-2 text-right">
                <Link href={labelHref(product, unit.size)} className="font-semibold text-forest underline">
                  Print label<span className="sr-only"> for {labelSize(unit.size)}</span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {product.units.length === 0 ? <p className="mt-2 text-sm text-muted">This product has no sizes yet.</p> : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href={`/admin/products/${product.id}`} className="btn btn-outline">
          Open product
        </Link>
        {product.units.length > 1 ? (
          <Link href={labelHref(product)} className="btn btn-outline">
            Labels for all sizes
          </Link>
        ) : null}
      </div>
    </article>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line border-l-4 border-l-danger p-5">
      <h2 className="font-bold">{title}</h2>
      <div className="mt-1 space-y-2 text-sm">{children}</div>
    </div>
  );
}

export function ScanOutcome({ input, result, failed }: { input: ScanInput; result: ScanResult | null; failed: boolean }) {
  if (input.kind === "empty") return null;
  const code = <span className="font-mono">{input.code}</span>;

  if (failed) {
    return (
      <Problem title="The lookup didn’t work right now">
        <p>Nothing was changed. Scan {code} again in a moment.</p>
      </Problem>
    );
  }
  if (input.kind === "mistyped") {
    return (
      <Problem title="Check that code">
        <p>{code} looks like one of our barcodes, but a character is wrong (probably a typo). Check the label and try again.</p>
      </Problem>
    );
  }
  if (input.kind === "invalid") {
    return (
      <Problem title="That isn’t a code we use">
        <p>
          Barcodes, item codes and SKUs only contain letters, numbers, hyphens and full stops. {code} contains something
          else.
        </p>
      </Problem>
    );
  }
  if (!result || result.kind === "not_found") {
    return (
      <Problem title="Nothing found">
        <p>
          {input.kind === "barcode" ? <>No size has the barcode {code}.</> : <>No product has the item code or SKU {code}.</>}
          {/^[0-9]+$/.test(input.code) ? " If it’s the manufacturer’s barcode on a box, scan our label instead." : null}
        </p>
        {input.kind === "text" ? (
          <p>
            <Link href={`/admin/products?q=${encodeURIComponent(input.code)}`} className="font-semibold text-forest underline">
              Search products for “{input.code}”
            </Link>
          </p>
        ) : null}
      </Problem>
    );
  }
  if (result.kind === "retired") {
    return (
      <Problem title="This label is no longer in use">
        {result.currentBarcode ? (
          <p>
            Barcode {code} belonged to {labelSize(result.size)}
            {result.product ? <> of {fullName(result.product)}</> : null} (SKU{" "}
            <span className="font-mono">{result.sku}</span> at the time). That size’s barcode is now{" "}
            <span className="font-mono">{result.currentBarcode}</span>. Barcodes are never reused. Take this label off
            and print a new one.
          </p>
        ) : (
          <p>
            Barcode {code} belonged to {labelSize(result.size)}
            {result.product ? <> of {fullName(result.product)}</> : null} (SKU{" "}
            <span className="font-mono">{result.sku}</span> at the time), a size that was removed before the product was
            published. Barcodes are never reused. Take this label off and print a new one from the product page.
          </p>
        )}
        {result.product ? (
          <p className="flex flex-wrap gap-x-4">
            {result.currentBarcode ? (
              <Link href={labelHref(result.product, result.size)} className="font-semibold text-forest underline">
                Print the new label
              </Link>
            ) : null}
            <Link href={`/admin/products/${result.product.id}`} className="font-semibold text-forest underline">
              Open {result.product.itemCode}
            </Link>
          </p>
        ) : null}
      </Problem>
    );
  }
  if (result.kind === "product") return <ProductCard product={result.product} />;
  const unit = result.product.units[0];
  return unit ? <UnitCard product={result.product} unit={unit} matchedBy={result.matchedBy} /> : <ProductCard product={result.product} />;
}
