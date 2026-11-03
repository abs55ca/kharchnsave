import { PDFDocument, rgb } from "pdf-lib";
import QRCode from "qrcode";
import sharp from "sharp";
import { K_MARK, K_MARK_WHITE, type BrandMark } from "@/lib/brand/k-mark";
import { QR_CODE_URL } from "@/lib/links";

/*
 * The permanent QR code printed on merchandise (`npm run qr` writes the files
 * in merch/qr/). It encodes exactly QR_CODE_URL (https://kharchnsave.pk/qr),
 * a fixed address that redirects to wherever lib/links.ts says, so the
 * artwork never needs reprinting.
 *
 * Two designs, same structure: version 6 (41 × 41 modules), error correction
 * H (each of its 4 blocks can correct 14 damaged codewords), a 4-module quiet
 * zone, and the K mark in the centre on a cleared area of exactly 15 × 15
 * modules (whole modules cleared, no partial slivers, no tile behind the
 * mark).
 *
 * - main: white modules on forest green with the white K mark. This is an
 *   INVERTED code (light modules on a dark background): scanners must
 *   support inverted codes, which most phone camera apps do but not all.
 * - light: forest-green modules on white with the green K mark, a normal
 *   code, for merchandise where scanning reliability matters more than looks.
 *
 * For each design, of the 8 valid mask patterns the one that leaves the
 * fewest misread codewords in the worst block is used, so the most error
 * correction remains for scratches and blur.
 *
 * In QR terms a "dark" module is one that is set (drawn in the design's
 * module colour); the background is "light", whatever the actual colours.
 *
 * Node only (sharp, pdf-lib): used by scripts/generate-qr.ts and the tests,
 * never by the website.
 */

export const MERCH_QR = {
  url: QR_CODE_URL,
  version: 6,
  errorCorrectionLevel: "H",
  /** Version 6-H: 4 blocks of 15 data + 28 error-correction codewords. */
  blocks: { count: 4, dataCodewords: 15, ecCodewords: 28 },
  /** Quiet zone on every side, in modules (background colour). */
  border: 4,
  /** The cleared area for the logo: exactly this many modules square, centred. Never larger. */
  logoAreaModules: 15,
  /** Space between the cleared area's edge and the K mark, in modules. */
  logoPaddingModules: 1.5,
  /** Printed size of the SVG and PDF, quiet zone included (any size can be printed; it's vector). */
  printSizeMm: 50,
  pngPixels: 2000,
} as const;

export type MerchQrDesign = {
  id: "main" | "light";
  description: string;
  /** Background and quiet zone. */
  background: string;
  /** The modules ("dark" in QR terms). */
  moduleColor: string;
  logo: BrandMark;
  /** Light modules on a dark background: scanners must read it as an inverted code. */
  inverted: boolean;
  files: { svg: string; pdf: string; png: string };
};

export const MERCH_QR_DESIGNS: Record<MerchQrDesign["id"], MerchQrDesign> = {
  main: {
    id: "main",
    description: "white modules and K mark on forest green (inverted)",
    background: "#163a2c",
    moduleColor: "#ffffff",
    logo: K_MARK_WHITE,
    inverted: true,
    files: {
      svg: "merch/qr/kharchnsave-qr.svg",
      pdf: "merch/qr/kharchnsave-qr.pdf",
      png: "merch/qr/kharchnsave-qr.png",
    },
  },
  light: {
    id: "light",
    description: "forest-green modules and K mark on white (fallback)",
    background: "#ffffff",
    moduleColor: "#163a2c",
    logo: K_MARK,
    inverted: false,
    files: {
      svg: "merch/qr/light/kharchnsave-qr-light.svg",
      pdf: "merch/qr/light/kharchnsave-qr-light.pdf",
      png: "merch/qr/light/kharchnsave-qr-light.png",
    },
  },
};

export type MerchQr = {
  url: string;
  design: MerchQrDesign;
  /** Modules per side, without the quiet zone (41 for version 6). */
  size: number;
  mask: number;
  /** modules[row][col]: true = a set ("dark") module, drawn in the module colour; the logo area is cleared. */
  modules: boolean[][];
  /** The cleared logo area in module coordinates (without the quiet zone). */
  logoArea: { start: number; size: number };
  /** Set modules removed from the logo area. */
  clearedModules: number;
  /**
   * Codewords a scanner misreads in the logo area, per error-correction
   * block: `certain` ones always, `worstCase` also counting codewords that
   * touch an edge of the mark or the lime tag (which scanners may read
   * either way).
   */
  misreadCodewordsPerBlock: { certain: number[]; worstCase: number[] };
  /** Codewords each block can correct. */
  correctablePerBlock: number;
};

type Symbol = ReturnType<typeof QRCode.create>;

/**
 * The order data bits are placed in (ISO/IEC 18004 §7.7.3): two-module wide
 * columns, right to left, zigzagging up and down, skipping the vertical timing
 * column and every function module (finders, timing, alignment, format info).
 */
function dataModulePositions(symbol: Symbol) {
  const { size } = symbol.modules;
  const positions: [number, number][] = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (!symbol.modules.isReserved(row, col)) positions.push([row, col]);
      }
    }
    upward = !upward;
  }
  return positions;
}

/** Where each data bit of this code sits, in placement order (bit i belongs to codeword ⌊i / 8⌋). */
export function dataBitPositions(qr: MerchQr) {
  return dataModulePositions(
    QRCode.create(qr.url, {
      version: MERCH_QR.version,
      errorCorrectionLevel: MERCH_QR.errorCorrectionLevel,
      maskPattern: qr.mask as QRCode.QRCodeMaskPattern,
    }),
  );
}

/** The block a codeword (in transmission order) belongs to: data and EC codewords are interleaved. */
export function blockOfCodeword(index: number) {
  const { count, dataCodewords } = MERCH_QR.blocks;
  const dataTotal = count * dataCodewords;
  return index < dataTotal ? index % count : (index - dataTotal) % count;
}

function logoAreaRange(size: number) {
  const start = (size - MERCH_QR.logoAreaModules) / 2;
  if (!Number.isInteger(start)) throw new Error("The logo area must be centred on whole modules.");
  return { start, end: start + MERCH_QR.logoAreaModules };
}

type Reading = "module" | "background" | "either";

function hexToRgbBytes(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * What a scanner reads in the logo area, found by rendering the mark at its
 * exact position on the design's background and looking at the middle half
 * of each module: "module" where it is all module colour (e.g. the white K on
 * the main design), "background" where it is plain background, and "either"
 * otherwise. That covers edges of the mark (scanners sample slightly
 * different points) and the lime tag, which is neither colour and which a
 * scanner's local threshold can read either way.
 */
async function logoReadings(size: number, design: MerchQrDesign) {
  const pixelsPerModule = 16;
  const pixels = size * pixelsPerModule;
  const logo = logoPlacementFor(size, 0, design.logo);
  const { x, y } = design.logo.viewBox;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${design.background}"/>` +
    `<g transform="translate(${logo.x} ${logo.y}) scale(${logo.scale}) translate(${-x} ${-y})">` +
    design.logo.paths.map((path) => `<path fill="${path.fill}" d="${path.d}"/>`).join("") +
    "</g></svg>";
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const moduleRgb = hexToRgbBytes(design.moduleColor);
  const backgroundRgb = hexToRgbBytes(design.background);
  const near = (i: number, [r, g, b]: number[]) => Math.hypot(data[i] - r, data[i + 1] - g, data[i + 2] - b) < 24;
  const quarter = pixelsPerModule / 4;
  return (row: number, col: number): Reading => {
    let modulePixels = 0;
    let backgroundPixels = 0;
    let otherPixels = 0;
    for (let py = row * pixelsPerModule + quarter; py < (row + 1) * pixelsPerModule - quarter; py++) {
      for (let px = col * pixelsPerModule + quarter; px < (col + 1) * pixelsPerModule - quarter; px++) {
        const i = (py * info.width + px) * info.channels;
        if (near(i, moduleRgb)) modulePixels++;
        else if (near(i, backgroundRgb)) backgroundPixels++;
        else otherPixels++;
      }
    }
    if (modulePixels > 0 && backgroundPixels === 0 && otherPixels === 0) return "module";
    if (backgroundPixels > 0 && modulePixels === 0 && otherPixels === 0) return "background";
    return "either";
  };
}

function analyse(symbol: Symbol, reading: (row: number, col: number) => Reading) {
  const { size } = symbol.modules;
  const { start, end } = logoAreaRange(size);
  const inLogoArea = (row: number, col: number) => row >= start && row < end && col >= start && col < end;
  const { count, dataCodewords, ecCodewords } = MERCH_QR.blocks;
  const totalCodewords = count * (dataCodewords + ecCodewords);

  const certain = new Set<number>();
  const possible = new Set<number>();
  let clearedModules = 0;
  dataModulePositions(symbol).forEach(([row, col], bit) => {
    if (!inLogoArea(row, col)) return;
    const set = !!symbol.modules.get(row, col);
    if (set) clearedModules++;
    const codeword = Math.floor(bit / 8);
    if (codeword >= totalCodewords) return; // the last few bits are padding
    // A module is misread when the background or the mark shows the opposite of its value.
    const seen = reading(row, col);
    if (seen === "either") possible.add(codeword);
    else if ((seen === "module") !== set) certain.add(codeword);
  });
  for (let row = start; row < end; row++) {
    for (let col = start; col < end; col++) {
      if (symbol.modules.isReserved(row, col)) throw new Error("The logo area would cover a function pattern.");
    }
  }

  const certainPerBlock = Array.from({ length: count }, () => 0);
  const worstPerBlock = Array.from({ length: count }, () => 0);
  for (const codeword of certain) certainPerBlock[blockOfCodeword(codeword)]++;
  for (const codeword of new Set([...certain, ...possible])) worstPerBlock[blockOfCodeword(codeword)]++;
  return { clearedModules, certainPerBlock, worstPerBlock, inLogoArea };
}

/** Builds the code in `design` with the mask that leaves the most error correction to spare. */
export async function buildMerchQr(
  design: MerchQrDesign = MERCH_QR_DESIGNS.main,
  url: string = MERCH_QR.url,
): Promise<MerchQr> {
  const size = 17 + 4 * MERCH_QR.version;
  const reading = await logoReadings(size, design);
  const candidates = Array.from({ length: 8 }, (_, mask) => {
    const symbol = QRCode.create(url, {
      version: MERCH_QR.version,
      errorCorrectionLevel: MERCH_QR.errorCorrectionLevel,
      maskPattern: mask as QRCode.QRCodeMaskPattern,
    });
    if (symbol.version !== MERCH_QR.version) throw new Error(`Expected version ${MERCH_QR.version}, got ${symbol.version}.`);
    const result = analyse(symbol, reading);
    const worst = Math.max(...result.worstPerBlock);
    return { mask, symbol, ...result, worst, total: result.worstPerBlock.reduce((a, b) => a + b, 0) };
  });
  const best = [...candidates].sort((a, b) => a.worst - b.worst || a.total - b.total || a.mask - b.mask)[0];

  const modules = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => !best.inLogoArea(row, col) && !!best.symbol.modules.get(row, col)),
  );
  return {
    url,
    design,
    size,
    mask: best.mask,
    modules,
    logoArea: { start: logoAreaRange(size).start, size: MERCH_QR.logoAreaModules },
    clearedModules: best.clearedModules,
    misreadCodewordsPerBlock: { certain: best.certainPerBlock, worstCase: best.worstPerBlock },
    correctablePerBlock: Math.floor(MERCH_QR.blocks.ecCodewords / 2),
  };
}

/* ---------- Drawing (module units, quiet zone included) ---------- */

/** Set modules as one path: a rectangle per horizontal run, on whole-module coordinates. */
export function modulesPath(qr: MerchQr) {
  const b = MERCH_QR.border;
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let run = 1;
      while (row[x + run]) run++;
      parts.push(`M${x + b} ${y + b}h${run}v1h-${run}z`);
      x += run - 1;
    }
  });
  return parts.join("");
}

/** The cleared logo area, in module units with the quiet zone. */
export function logoAreaRect(qr: MerchQr) {
  return logoAreaRectFor(qr.size, MERCH_QR.border);
}

function logoAreaRectFor(size: number, border: number) {
  const start = logoAreaRange(size).start + border;
  return { x: start, y: start, size: MERCH_QR.logoAreaModules };
}

/** Where the K mark goes: scaled to fit inside the logo area's padding, centred. */
export function logoPlacement(qr: MerchQr) {
  return logoPlacementFor(qr.size, MERCH_QR.border, qr.design.logo);
}

function logoPlacementFor(size: number, border: number, mark: BrandMark) {
  const area = logoAreaRectFor(size, border);
  const box = area.size - 2 * MERCH_QR.logoPaddingModules;
  const scale = Math.min(box / mark.viewBox.width, box / mark.viewBox.height);
  const width = mark.viewBox.width * scale;
  const height = mark.viewBox.height * scale;
  return {
    x: area.x + (area.size - width) / 2,
    y: area.y + (area.size - height) / 2,
    width,
    height,
    scale,
  };
}

const round = (n: number) => Number(n.toFixed(6));

/** The SVG (vector). `width`/`height` set its printed or rendered size, e.g. "50mm" or "2000". */
export function renderMerchQrSvg(qr: MerchQr, size: string = `${MERCH_QR.printSizeMm}mm`) {
  const { design } = qr;
  const total = qr.size + 2 * MERCH_QR.border;
  const logo = logoPlacement(qr);
  const { x, y } = design.logo.viewBox;
  const transform = `translate(${round(logo.x)} ${round(logo.y)}) scale(${round(logo.scale)}) translate(${-x} ${-y})`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" role="img" aria-label="QR code: ${qr.url}">`,
    `  <title>Kharch n Save: ${qr.url}</title>`,
    `  <rect width="${total}" height="${total}" fill="${design.background}"/>`,
    `  <path d="${modulesPath(qr)}" fill="${design.moduleColor}" shape-rendering="crispEdges"/>`,
    `  <g transform="${transform}">`,
    ...design.logo.paths.map((path) => `    <path fill="${path.fill}" d="${path.d}"/>`),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

/** A square PNG, `pixels` wide (2000 by default), rendered from the same drawing. */
export async function renderMerchQrPng(qr: MerchQr, pixels: number = MERCH_QR.pngPixels) {
  return sharp(Buffer.from(renderMerchQrSvg(qr, String(pixels))))
    .resize(pixels, pixels)
    .flatten({ background: qr.design.background })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function hexToRgb(hex: string) {
  const [r, g, b] = hexToRgbBytes(hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex);
  return rgb(r / 255, g / 255, b / 255);
}

/** A one-page vector PDF, MERCH_QR.printSizeMm square, from the same drawing. */
export async function renderMerchQrPdf(qr: MerchQr) {
  const { design } = qr;
  const total = qr.size + 2 * MERCH_QR.border;
  const pageSize = (MERCH_QR.printSizeMm / 25.4) * 72; // points
  const unit = pageSize / total; // points per module
  // No creation dates or producer: the same input always gives the same file.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Kharch n Save QR code: ${qr.url}`);
  const page = pdf.addPage([pageSize, pageSize]);

  // drawSvgPath puts the SVG origin at (x, y) and flips the y axis to SVG's.
  page.drawRectangle({ x: 0, y: 0, width: pageSize, height: pageSize, color: hexToRgb(design.background) });
  page.drawSvgPath(modulesPath(qr), { x: 0, y: pageSize, scale: unit, color: hexToRgb(design.moduleColor) });
  const logo = logoPlacement(qr);
  for (const path of design.logo.paths) {
    page.drawSvgPath(path.d, {
      x: (logo.x - design.logo.viewBox.x * logo.scale) * unit,
      y: pageSize - (logo.y - design.logo.viewBox.y * logo.scale) * unit,
      scale: logo.scale * unit,
      color: hexToRgb(path.fill),
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
