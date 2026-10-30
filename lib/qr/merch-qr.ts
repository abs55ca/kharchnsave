import { PDFDocument, rgb } from "pdf-lib";
import QRCode from "qrcode";
import sharp from "sharp";
import { K_MARK_PATHS, K_MARK_VIEWBOX } from "@/lib/brand/k-mark";
import { QR_CODE_URL } from "@/lib/links";

/*
 * The permanent QR code printed on merchandise (`npm run qr` writes the files
 * in merch/qr/). It encodes exactly QR_CODE_URL (https://kharchnsave.pk/qr),
 * a fixed address that redirects to wherever lib/links.ts says, so the
 * artwork never needs reprinting.
 *
 * Version 6 (41 × 41 modules), error correction H (each of its 4 blocks can
 * correct 14 damaged codewords), a 4-module white border, forest-green
 * modules on white. The K mark sits on a white rounded tile of exactly 15 × 15
 * modules in the centre; every module under the tile is cleared as a whole
 * (no partial slivers). Of the 8 valid mask patterns, the one that leaves the
 * fewest damaged codewords in the worst block is used, so the most error
 * correction remains for scratches and blur.
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
  /** White border (quiet zone) on every side, in modules. */
  border: 4,
  dark: "#163a2c",
  light: "#ffffff",
  /** The logo tile: exactly this many modules square, centred. Never larger. */
  tileModules: 15,
  tileRadiusModules: 2,
  /** White space between the tile's edge and the K mark, in modules. */
  logoPaddingModules: 1.5,
  /** Printed size of the SVG and PDF, border included (any size can be printed; it's vector). */
  printSizeMm: 50,
  pngPixels: 2000,
} as const;

export const MERCH_QR_FILES = {
  svg: "merch/qr/kharchnsave-qr.svg",
  pdf: "merch/qr/kharchnsave-qr.pdf",
  png: "merch/qr/kharchnsave-qr.png",
} as const;

export type MerchQr = {
  url: string;
  /** Modules per side, without the border (41 for version 6). */
  size: number;
  mask: number;
  /** modules[row][col]: true = dark, after clearing the tile. */
  modules: boolean[][];
  /** The tile in module coordinates (without the border). */
  tile: { start: number; size: number };
  /** Dark modules removed under the tile. */
  clearedDarkModules: number;
  /**
   * Codewords a scanner misreads under the tile and mark, per error-correction
   * block: `certain` ones always, `worstCase` also counting codewords that
   * touch an edge of the mark (which scanners may read either way).
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

function tileRange(size: number) {
  const start = (size - MERCH_QR.tileModules) / 2;
  if (!Number.isInteger(start)) throw new Error("The tile must be centred on whole modules.");
  return { start, end: start + MERCH_QR.tileModules };
}

type Reading = "dark" | "light" | "either";

/**
 * What a scanner reads under the tile, found by rendering the mark at its
 * exact position and looking at the middle half of each module: "dark" where
 * the green K covers all of it, "light" where it is plain white, and
 * "either" otherwise. That covers edges of the mark (scanners sample slightly
 * different points) and the lime tag, which a scanner's local threshold can
 * read as dark when the only thing around it is white.
 */
async function logoReadings(size: number) {
  const pixelsPerModule = 16;
  const pixels = size * pixelsPerModule;
  const logo = logoPlacementFor(size, 0);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<g transform="translate(${logo.x} ${logo.y}) scale(${logo.scale}) translate(${-K_MARK_VIEWBOX.x} ${-K_MARK_VIEWBOX.y})">` +
    K_MARK_PATHS.map((path) => `<path fill="${path.fill}" d="${path.d}"/>`).join("") +
    "</g></svg>";
  const { data, info } = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer({ resolveWithObject: true });
  const quarter = pixelsPerModule / 4;
  return (row: number, col: number): Reading => {
    let dark = 0;
    let white = 0;
    let other = 0;
    for (let y = row * pixelsPerModule + quarter; y < (row + 1) * pixelsPerModule - quarter; y++) {
      for (let x = col * pixelsPerModule + quarter; x < (col + 1) * pixelsPerModule - quarter; x++) {
        const value = data[y * info.width + x];
        if (value < 128) dark++;
        else if (value >= 245) white++;
        else other++;
      }
    }
    if (dark > 0 && white === 0 && other === 0) return "dark";
    if (white > 0 && dark === 0 && other === 0) return "light";
    return "either";
  };
}

function analyse(symbol: Symbol, reading: (row: number, col: number) => Reading) {
  const { size } = symbol.modules;
  const { start, end } = tileRange(size);
  const inTile = (row: number, col: number) => row >= start && row < end && col >= start && col < end;
  const { count, dataCodewords, ecCodewords } = MERCH_QR.blocks;
  const totalCodewords = count * (dataCodewords + ecCodewords);

  const certain = new Set<number>();
  const possible = new Set<number>();
  let clearedDarkModules = 0;
  dataModulePositions(symbol).forEach(([row, col], bit) => {
    if (!inTile(row, col)) return;
    const dark = !!symbol.modules.get(row, col);
    if (dark) clearedDarkModules++;
    const codeword = Math.floor(bit / 8);
    if (codeword >= totalCodewords) return; // the last few bits are padding
    // A module is misread when the tile or the mark shows the opposite of its value.
    const seen = reading(row, col);
    if (seen === "either") possible.add(codeword);
    else if ((seen === "dark") !== dark) certain.add(codeword);
  });
  for (let row = start; row < end; row++) {
    for (let col = start; col < end; col++) {
      if (symbol.modules.isReserved(row, col)) throw new Error("The tile would cover a function pattern.");
    }
  }

  const certainPerBlock = Array.from({ length: count }, () => 0);
  const worstPerBlock = Array.from({ length: count }, () => 0);
  for (const codeword of certain) certainPerBlock[blockOfCodeword(codeword)]++;
  for (const codeword of new Set([...certain, ...possible])) worstPerBlock[blockOfCodeword(codeword)]++;
  return { clearedDarkModules, certainPerBlock, worstPerBlock, inTile };
}

/** Builds the code for MERCH_QR.url with the mask that leaves the most error correction to spare. */
export async function buildMerchQr(url: string = MERCH_QR.url): Promise<MerchQr> {
  const size = 17 + 4 * MERCH_QR.version;
  const reading = await logoReadings(size);
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
    Array.from({ length: size }, (_, col) => !best.inTile(row, col) && !!best.symbol.modules.get(row, col)),
  );
  return {
    url,
    size,
    mask: best.mask,
    modules,
    tile: { start: tileRange(size).start, size: MERCH_QR.tileModules },
    clearedDarkModules: best.clearedDarkModules,
    misreadCodewordsPerBlock: { certain: best.certainPerBlock, worstCase: best.worstPerBlock },
    correctablePerBlock: Math.floor(MERCH_QR.blocks.ecCodewords / 2),
  };
}

/* ---------- Drawing (module units, border included) ---------- */

/** Dark modules as one path: a rectangle per horizontal run, on whole-module coordinates. */
export function darkModulesPath(qr: MerchQr) {
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

/** The tile's square, in module units with the border: exactly the cleared modules. */
export function tileRect(qr: MerchQr) {
  return tileRectFor(qr.size, MERCH_QR.border);
}

function tileRectFor(size: number, border: number) {
  const start = tileRange(size).start + border;
  return { x: start, y: start, size: MERCH_QR.tileModules, radius: MERCH_QR.tileRadiusModules };
}

function roundedRectPath({ x, y, size, radius: r }: ReturnType<typeof tileRect>) {
  const s = size - 2 * r;
  return `M${x + r} ${y}h${s}a${r} ${r} 0 0 1 ${r} ${r}v${s}a${r} ${r} 0 0 1 -${r} ${r}h-${s}a${r} ${r} 0 0 1 -${r} -${r}v-${s}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

/** Where the K mark goes: scaled to fit inside the tile's padding, centred. */
export function logoPlacement(qr: MerchQr) {
  return logoPlacementFor(qr.size, MERCH_QR.border);
}

function logoPlacementFor(size: number, border: number) {
  const tile = tileRectFor(size, border);
  const box = tile.size - 2 * MERCH_QR.logoPaddingModules;
  const scale = Math.min(box / K_MARK_VIEWBOX.width, box / K_MARK_VIEWBOX.height);
  const width = K_MARK_VIEWBOX.width * scale;
  const height = K_MARK_VIEWBOX.height * scale;
  return {
    x: tile.x + (tile.size - width) / 2,
    y: tile.y + (tile.size - height) / 2,
    width,
    height,
    scale,
  };
}

const round = (n: number) => Number(n.toFixed(6));

/** The SVG (vector). `width`/`height` set its printed or rendered size, e.g. "50mm" or "2000". */
export function renderMerchQrSvg(qr: MerchQr, size: string = `${MERCH_QR.printSizeMm}mm`) {
  const total = qr.size + 2 * MERCH_QR.border;
  const logo = logoPlacement(qr);
  const transform = `translate(${round(logo.x)} ${round(logo.y)}) scale(${round(logo.scale)}) translate(${-K_MARK_VIEWBOX.x} ${-K_MARK_VIEWBOX.y})`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" role="img" aria-label="QR code: ${qr.url}">`,
    `  <title>Kharch n Save: ${qr.url}</title>`,
    `  <rect width="${total}" height="${total}" fill="${MERCH_QR.light}"/>`,
    `  <path d="${darkModulesPath(qr)}" fill="${MERCH_QR.dark}" shape-rendering="crispEdges"/>`,
    `  <path d="${roundedRectPath(tileRect(qr))}" fill="${MERCH_QR.light}"/>`,
    `  <g transform="${transform}">`,
    ...K_MARK_PATHS.map((path) => `    <path fill="${path.fill}" d="${path.d}"/>`),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

/** A square PNG, `pixels` wide (2000 by default), rendered from the same drawing. */
export async function renderMerchQrPng(qr: MerchQr, pixels: number = MERCH_QR.pngPixels) {
  return sharp(Buffer.from(renderMerchQrSvg(qr, String(pixels))))
    .resize(pixels, pixels)
    .flatten({ background: MERCH_QR.light })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function hexToRgb(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** A one-page vector PDF, MERCH_QR.printSizeMm square, from the same drawing. */
export async function renderMerchQrPdf(qr: MerchQr) {
  const total = qr.size + 2 * MERCH_QR.border;
  const pageSize = (MERCH_QR.printSizeMm / 25.4) * 72; // points
  const unit = pageSize / total; // points per module
  // No creation dates or producer: the same input always gives the same file.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Kharch n Save QR code: ${qr.url}`);
  const page = pdf.addPage([pageSize, pageSize]);

  // drawSvgPath puts the SVG origin at (x, y) and flips the y axis to SVG's.
  page.drawRectangle({ x: 0, y: 0, width: pageSize, height: pageSize, color: hexToRgb(MERCH_QR.light) });
  page.drawSvgPath(darkModulesPath(qr), { x: 0, y: pageSize, scale: unit, color: hexToRgb(MERCH_QR.dark) });
  page.drawSvgPath(roundedRectPath(tileRect(qr)), { x: 0, y: pageSize, scale: unit, color: hexToRgb(MERCH_QR.light) });
  const logo = logoPlacement(qr);
  for (const path of K_MARK_PATHS) {
    page.drawSvgPath(path.d, {
      x: (logo.x - K_MARK_VIEWBOX.x * logo.scale) * unit,
      y: pageSize - (logo.y - K_MARK_VIEWBOX.y * logo.scale) * unit,
      scale: logo.scale * unit,
      color: hexToRgb(path.fill),
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
