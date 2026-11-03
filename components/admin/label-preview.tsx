import { useId } from "react";
import { isValidBarcode } from "@/lib/barcodes/code";
import { NAME_BOX_DOTS, NAME_FONT_DOTS, NAME_MAX_DOTS, tidyLabelName, type LabelName } from "@/lib/labels/name-fit";
import { LABEL, labelSize, planCode128 } from "@/lib/labels/zpl";

/*
 * A drawing of one shelf label at its real layout (406 × 203 dots), with
 * the name's fit underneath. An approximation: the browser doesn't have the
 * printer's font, so the name is drawn in a condensed bold font stretched to
 * the width the fit check estimates (lib/labels/name-fit.ts), and the bars
 * only show the barcode's real width. Whether a name can be printed is
 * decided by the check, never by this drawing.
 */

// The same positions as lib/labels/zpl.ts; baselines sit about 80% down each text line.
const NAME_X = 28;
const TOP_Y = 14;
const SIZE_RIGHT = 378;
const BARCODE_Y = 46;
const ID_Y = 145;
const ID_FONT = 30;
const FONT = "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif";

function Bars({ x, width }: { x: number; width: number }) {
  // Illustrative bars, evenly spread: the real pattern comes from the printer.
  const bars: { x: number; w: number }[] = [];
  for (let at = 0, i = 0; at < width - 2; i++) {
    const w = i % 3 === 0 ? 4 : 2;
    bars.push({ x: x + at, w });
    at += w + (i % 2 === 0 ? 2 : 4);
  }
  return (
    <g aria-hidden="true">
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={BARCODE_Y} width={bar.w} height={LABEL.barcodeHeightDots} fill="currentColor" />
      ))}
    </g>
  );
}

export function LabelPreview({
  name,
  typed,
  size,
  barcode,
}: {
  name: LabelName;
  /** What the admin typed (or the product name), to say if it prints differently. */
  typed: string;
  size: number | null;
  barcode: string | null;
}) {
  const clipId = `label-name-clip${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const realBarcode = barcode && isValidBarcode(barcode) ? barcode : null;
  const plan = planCode128(realBarcode ?? "KNS00000013");
  const barcodeX = Math.floor((LABEL.widthDots - plan.dots) / 2);
  const shown = name.text;
  // Curly quotes, dashes and the like print as plain characters.
  const differs = shown !== "" && shown !== tidyLabelName(typed);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${LABEL.widthDots} ${LABEL.heightDots}`}
        role="img"
        aria-label={`Label preview: ${shown || "no name"}, ${size === null ? "size" : labelSize(size)}, ${realBarcode ?? "barcode issued when the size is saved"}.`}
        className="block w-full max-w-[22rem] rounded-md border border-line bg-white text-ink shadow-sm"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={NAME_X} y={0} width={NAME_BOX_DOTS} height={BARCODE_Y} />
          </clipPath>
        </defs>
        {!name.fits ? (
          <rect x={NAME_X} y={TOP_Y} width={NAME_BOX_DOTS} height={NAME_FONT_DOTS} fill="var(--color-danger)" fillOpacity={0.08} />
        ) : null}
        <rect
          x={NAME_X}
          y={TOP_Y}
          width={NAME_BOX_DOTS}
          height={NAME_FONT_DOTS}
          fill="none"
          stroke={name.fits ? "var(--color-line)" : "var(--color-danger)"}
          strokeDasharray={name.fits ? "4 3" : undefined}
          strokeWidth={name.fits ? 1 : 2}
        />
        {/* A name that doesn't fit is cut at its box here only to keep the size readable; it's never printed. */}
        {shown ? (
          <text
            x={NAME_X}
            y={TOP_Y + 21}
            fontFamily={FONT}
            fontWeight={700}
            fontSize={NAME_FONT_DOTS}
            textLength={Math.max(name.widthDots, 1)}
            lengthAdjust="spacingAndGlyphs"
            fill={name.fits ? "currentColor" : "var(--color-danger)"}
            clipPath={`url(#${clipId})`}
          >
            {shown}
          </text>
        ) : null}
        <text x={SIZE_RIGHT} y={TOP_Y + 21} textAnchor="end" fontFamily={FONT} fontWeight={700} fontSize={NAME_FONT_DOTS} fill="currentColor">
          {size === null ? "EU –" : labelSize(size)}
        </text>
        <g opacity={realBarcode ? 1 : 0.25}>
          <Bars x={barcodeX} width={plan.dots} />
        </g>
        <text x={LABEL.widthDots / 2} y={ID_Y + 24} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={ID_FONT} fill="currentColor">
          {realBarcode ?? "KNS········"}
        </text>
      </svg>
      <figcaption aria-live="polite" className="mt-2 max-w-[22rem] text-xs">
        {name.problem ? (
          <span className="font-medium text-danger">{name.problem}</span>
        ) : (
          <span className="text-forest">
            Fits on one line: about {name.widthDots} of {NAME_MAX_DOTS} dots
            {name.source === "product-name" ? ", using the product name" : ""}.
          </span>
        )}
        {differs ? <span className="mt-1 block text-muted">Prints as “{shown}”.</span> : null}
        <span className="mt-1 block text-muted">
          Preview only: the printer’s font differs slightly; the fit is estimated from its character widths.
        </span>
      </figcaption>
    </figure>
  );
}
