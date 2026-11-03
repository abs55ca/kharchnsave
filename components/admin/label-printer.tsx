"use client";

import Link from "next/link";
import { useState } from "react";
import type { LabelName } from "@/lib/labels/name-fit";
import { buildLabels, defaultQuantity, LABEL_QUANTITY_MAX, labelSize, parseQuantity, type LabelSpec } from "@/lib/labels/zpl";
import { LabelPreview } from "./label-preview";

type Unit = { size: number; stock: number; barcode: string };

const INPUT =
  "rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest aria-[invalid=true]:border-danger";

/**
 * Label quantities, a preview, the ZPL, Copy ZPL and Download .zpl. The name
 * is the product's own label name (or its full name), as saved: the same on
 * every print and reprint, and changed only on the product page. If it
 * doesn't fit, nothing can be printed until it's fixed there. The download
 * is a GET to the label route, which reads the name, sizes and barcodes
 * from the database again and checks the name the same way; only the
 * quantities come from here. Nothing is sent to the printer directly: the
 * file goes through Zebra Setup Utilities.
 */
export function LabelPrinter({
  productId,
  name,
  typedName,
  itemStatus,
  units,
  single,
}: {
  productId: string;
  /** labelNameFor(product) */
  name: LabelName;
  /** The label name as saved, or the product name: what the preview says it prints as. */
  typedName: string;
  itemStatus: "new" | "preloved";
  units: Unit[];
  /** One size only (quantity at least 1), rather than every size (0 skips one). */
  single: boolean;
}) {
  const [quantities, setQuantities] = useState(() => units.map((unit) => String(defaultQuantity(itemStatus, unit.stock))));
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const parsed = quantities.map((value) => parseQuantity(value, { allowZero: !single }));
  const invalid = parsed.some((quantity) => quantity === null);
  const specs: LabelSpec[] = units.flatMap((unit, index) => {
    const quantity = parsed[index];
    return quantity ? [{ name: name.text, size: unit.size, barcode: unit.barcode, quantity }] : [];
  });
  const total = specs.reduce((sum, spec) => sum + spec.quantity, 0);

  const zpl = name.problem || invalid || specs.length === 0 ? "" : buildLabels(specs);

  const problem = name.problem
    ? null
    : invalid
      ? `Quantities are whole numbers from ${single ? 1 : 0} to ${LABEL_QUANTITY_MAX}.`
      : specs.length === 0
        ? "Choose at least one label."
        : null;

  return (
    <form method="get" action={`/admin/products/${productId}/labels/download`} className="space-y-6">
      <section aria-labelledby="label-name-heading">
        <h2 id="label-name-heading" className="mb-1.5 text-sm font-semibold">
          Name on the label
        </h2>
        <LabelPreview name={name} typed={typedName} size={units[0]?.size ?? null} barcode={units[0]?.barcode ?? null} />
        {name.problem ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            Labels can’t be printed until the name fits.{" "}
            <Link href={`/admin/products/${productId}#label-name`} className="underline">
              {name.source === "label-name" ? "Change the label name" : "Add a label name"}
            </Link>
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            {name.source === "label-name" ? "The product’s label name." : "The product name (it has no label name)."}{" "}
            <Link href={`/admin/products/${productId}#label-name`} className="font-semibold text-forest underline">
              Change it on the product page
            </Link>
          </p>
        )}
      </section>

      <fieldset>
        <legend className="mb-1.5 block text-sm font-semibold">How many labels</legend>
        <p className="mb-2 text-xs text-muted">
          {itemStatus === "preloved"
            ? "A pre-loved pair needs one label; print more only to replace a damaged one."
            : "Starts at the number of pairs in stock for each size."}
          {single ? null : " 0 skips a size."}
        </p>
        <ul className="space-y-2">
          {units.map((unit, index) => (
            <li key={unit.barcode} className="flex flex-wrap items-center gap-3">
              <label htmlFor={`label-qty-${index}`} className="w-20 text-sm font-semibold">
                {labelSize(unit.size)}
              </label>
              <input
                id={`label-qty-${index}`}
                name={`q_${unit.size}`}
                type="number"
                inputMode="numeric"
                min={single ? 1 : 0}
                max={LABEL_QUANTITY_MAX}
                step={1}
                value={quantities[index]}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuantities((current) => current.map((q, i) => (i === index ? value : q)));
                  setCopied("idle");
                }}
                aria-invalid={parsed[index] === null ? true : undefined}
                className={`${INPUT} h-10 w-24`}
              />
              <span className="font-mono text-xs text-muted">
                {unit.barcode} · {unit.stock} in stock
              </span>
            </li>
          ))}
        </ul>
      </fieldset>

      {problem ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!zpl} className="btn btn-forest disabled:opacity-60">
          Download .zpl
        </button>
        <button
          type="button"
          disabled={!zpl}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(zpl);
              setCopied("copied");
            } catch {
              setCopied("failed");
            }
          }}
          className="btn btn-outline disabled:opacity-60"
        >
          Copy ZPL
        </button>
        <span aria-live="polite" className="text-sm">
          {copied === "copied" ? "Copied." : copied === "failed" ? "Couldn’t copy. Select the text below and copy it instead." : null}
        </span>
      </div>
      {zpl ? <p className="text-sm text-muted">{total === 1 ? "1 label." : `${total} labels.`}</p> : null}

      <div>
        <label htmlFor="label-zpl" className="mb-1.5 block text-sm font-semibold">
          ZPL
        </label>
        <textarea
          id="label-zpl"
          readOnly
          value={zpl}
          rows={12}
          onFocus={(event) => event.currentTarget.select()}
          className={`${INPUT} w-full py-2 font-mono text-xs`}
        />
      </div>
    </form>
  );
}
