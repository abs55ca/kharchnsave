"use client";

import { useState } from "react";
import {
  buildLabels,
  chooseLabelName,
  defaultQuantity,
  LABEL_NAME_MAX,
  LABEL_QUANTITY_MAX,
  labelSize,
  parseQuantity,
  type LabelSpec,
} from "@/lib/labels/zpl";

type Unit = { size: number; stock: number; barcode: string };

const INPUT =
  "rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-forest aria-[invalid=true]:border-danger";

/**
 * Label options, a live ZPL preview, Copy ZPL and Download .zpl. The
 * download is a GET to the label route, which reads the sizes and barcodes
 * from the database again; only the short name and quantities come from
 * here. Nothing is sent to the printer directly: the file goes through
 * Zebra Setup Utilities.
 */
export function LabelPrinter({
  productId,
  defaultName,
  itemStatus,
  units,
  single,
}: {
  productId: string;
  defaultName: string;
  itemStatus: "new" | "preloved";
  units: Unit[];
  /** One size only (quantity at least 1), rather than every size (0 skips one). */
  single: boolean;
}) {
  const [name, setName] = useState(defaultName);
  const [quantities, setQuantities] = useState(() => units.map((unit) => String(defaultQuantity(itemStatus, unit.stock))));
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  const parsed = quantities.map((value) => parseQuantity(value, { allowZero: !single }));
  const invalid = parsed.some((quantity) => quantity === null);
  const specs: LabelSpec[] = units.flatMap((unit, index) => {
    const quantity = parsed[index];
    return quantity ? [{ name: chooseLabelName(name, defaultName), size: unit.size, barcode: unit.barcode, quantity }] : [];
  });
  const total = specs.reduce((sum, spec) => sum + spec.quantity, 0);

  const zpl = invalid || specs.length === 0 ? "" : buildLabels(specs);

  const problem = invalid
    ? `Quantities are whole numbers from ${single ? 1 : 0} to ${LABEL_QUANTITY_MAX}.`
    : specs.length === 0
      ? "Choose at least one label."
      : null;

  return (
    <form method="get" action={`/admin/products/${productId}/labels/download`} className="space-y-6">
      <div>
        <label htmlFor="label-name" className="mb-1.5 block text-sm font-semibold">
          Name on the label
        </label>
        <input
          id="label-name"
          name="name"
          value={name}
          maxLength={LABEL_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value);
            setCopied("idle");
          }}
          aria-describedby="label-name-hint"
          className={`${INPUT} h-10 w-full max-w-sm`}
        />
        <p id="label-name-hint" className="mt-1 text-xs text-muted">
          Up to {LABEL_NAME_MAX} characters ({name.length} used). Only for this print; the product isn’t changed. Left
          empty, it’s “{defaultName}”.
        </p>
      </div>

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
