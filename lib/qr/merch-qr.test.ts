import { readFile } from "node:fs/promises";
import { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { QR_CODE_URL } from "@/lib/links";
import {
  blockOfCodeword,
  buildMerchQr,
  dataBitPositions,
  darkModulesPath,
  MERCH_QR,
  MERCH_QR_FILES,
  renderMerchQrSvg,
  tileRect,
  type MerchQr,
} from "./merch-qr";

/*
 * Decodes the merchandise QR code with two real decoders, jsQR and ZXing
 * (the decoder behind many phone scanners): the files in merch/qr/ as
 * committed, and damaged copies (two white scratches; blur). Damaged copies
 * are read at 1000 px, about what a phone camera sees of a printed code.
 * Run `npm run qr` after changing the code's settings.
 */

const EXPECTED = "https://kharchnsave.pk/qr";
const TOTAL = 41 + 2 * MERCH_QR.border; // modules per side, border included
const SCAN_PIXELS = 1000;

type Pixels = { rgba: Uint8ClampedArray; width: number; height: number };

async function pixelsOf(image: Buffer, width?: number): Promise<Pixels> {
  const { data, info } = await sharp(image)
    .resize(width ? { width } : undefined)
    .flatten({ background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

function decodeWithJsQr({ rgba, width, height }: Pixels) {
  return jsQR(rgba, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

function decodeWithZxing({ rgba, width, height }: Pixels) {
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
  }
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)));
    return new QRCodeReader().decode(bitmap, new Map([[DecodeHintType.TRY_HARDER, true]])).getText();
  } catch {
    return null;
  }
}

/** What both decoders read from an image (scaled to `width` px first, if given). */
async function decode(image: Buffer, width?: number) {
  const pixels = await pixelsOf(image, width);
  return { jsQR: decodeWithJsQr(pixels), zxing: decodeWithZxing(pixels) };
}

const BOTH = { jsQR: EXPECTED, zxing: EXPECTED };

/** The vector SVG rendered at `pixels` wide (instead of its printed 50 mm). */
function rasterSvg(svgFile: Buffer, pixels: number) {
  const sized = svgFile.toString().replace(/width="[^"]+" height="[^"]+"/, `width="${pixels}" height="${pixels}"`);
  return sharp(Buffer.from(sized)).flatten({ background: "#ffffff" }).png().toBuffer();
}

/**
 * Two white "scratches", 0.4 modules wide, across the data area: one nearly
 * horizontal under the logo, one nearly vertical left of it. They miss the
 * three finder patterns and the alignment pattern, which a scanner needs to
 * find the code at all.
 */
async function scratched(png: Buffer) {
  const { width = 0 } = await sharp(png).metadata();
  const lines =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${TOTAL} ${TOTAL}">` +
    `<line x1="0" y1="33.5" x2="${TOTAL}" y2="36.5" stroke="#fff" stroke-width="0.4"/>` +
    `<line x1="13.5" y1="0" x2="15.5" y2="${TOTAL}" stroke="#fff" stroke-width="0.4"/>` +
    "</svg>";
  return sharp(png).composite([{ input: Buffer.from(lines) }]).png().toBuffer();
}

/** Gaussian blur with a radius of 0.3 modules. */
async function blurred(png: Buffer) {
  const { width = 0 } = await sharp(png).metadata();
  return sharp(png).blur((width / TOTAL) * 0.3).png().toBuffer();
}

let qr: MerchQr;
let svg: Buffer;
let png: Buffer;
let pdf: Buffer;

beforeAll(async () => {
  qr = await buildMerchQr();
  [svg, png, pdf] = await Promise.all([
    readFile(MERCH_QR_FILES.svg),
    readFile(MERCH_QR_FILES.png),
    readFile(MERCH_QR_FILES.pdf),
  ]);
});

describe("what the code says", () => {
  it("is always the production address, from the config", () => {
    expect(QR_CODE_URL).toBe(EXPECTED);
    expect(MERCH_QR.url).toBe(EXPECTED);
    expect(qr.url).toBe(EXPECTED);
  });
});

describe("symbol and logo tile", () => {
  it("is version 6 (41 × 41) at error correction H, with a 4-module border", () => {
    expect(qr.size).toBe(41);
    expect(MERCH_QR.version).toBe(6);
    expect(MERCH_QR.errorCorrectionLevel).toBe("H");
    expect(MERCH_QR.border).toBe(4);
    expect(svg.toString()).toContain(`viewBox="0 0 ${TOTAL} ${TOTAL}"`);
  });

  it("has a tile of exactly 15 × 15 modules, centred, never larger", () => {
    expect(MERCH_QR.tileModules).toBe(15);
    expect(qr.tile).toEqual({ start: 13, size: 15 });
    expect(tileRect(qr)).toMatchObject({ x: 17, y: 17, size: 15 });
    // 225 of 2401 modules of the whole image: about 9.4%.
    expect(qr.tile.size ** 2 / TOTAL ** 2).toBeLessThanOrEqual(0.1);
  });

  it("clears whole modules under the tile, and draws none there", () => {
    for (let row = 13; row < 28; row++) {
      for (let col = 13; col < 28; col++) expect(qr.modules[row][col], `${row},${col}`).toBe(false);
    }
    const tile = tileRect(qr);
    for (const [, x, y, run] of darkModulesPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [left, top, right] = [Number(x), Number(y), Number(x) + Number(run)];
      const overlaps = top >= tile.y && top < tile.y + tile.size && right > tile.x && left < tile.x + tile.size;
      expect(overlaps, `run at ${x},${y}`).toBe(false);
    }
    expect(darkModulesPath(qr)).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/); // whole-module coordinates only
  });

  it("leaves error correction to spare in every block (at least 4 codewords)", () => {
    expect(qr.correctablePerBlock).toBe(14);
    for (const damaged of qr.misreadCodewordsPerBlock.worstCase) {
      expect(damaged).toBeLessThanOrEqual(qr.correctablePerBlock - 4);
    }
  });

  it("predicts the decoders: every block decodes with up to 14 errors in the worst case, and fails with 15 certain ones", async () => {
    const positions = dataBitPositions(qr);
    const inTile = ([row, col]: [number, number]) => row >= 13 && row < 28 && col >= 13 && col < 28;
    const untouched = (codeword: number) => positions.slice(codeword * 8, codeword * 8 + 8).every((p) => !inTile(p));
    const withFlipped = async (codewords: number[]) => {
      const modules = qr.modules.map((row) => [...row]);
      for (const codeword of codewords) {
        for (const [row, col] of positions.slice(codeword * 8, codeword * 8 + 8)) modules[row][col] = !modules[row][col];
      }
      return decode(await sharp(Buffer.from(renderMerchQrSvg({ ...qr, modules }, "800"))).png().toBuffer());
    };
    const { certain, worstCase } = qr.misreadCodewordsPerBlock;
    for (let block = 0; block < 4; block++) {
      const extra = Array.from({ length: 172 }, (_, i) => i).filter((i) => blockOfCodeword(i) === block && untouched(i));
      // At most 14 errors in this block, however the mark's edges are read.
      const safe = qr.correctablePerBlock - worstCase[block];
      expect(await withFlipped(extra.slice(0, safe)), `block ${block}, ≤ 14 errors`).toEqual(BOTH);
      // At least 15 errors, whatever happens at the edges.
      const tooMany = qr.correctablePerBlock + 1 - certain[block];
      expect(await withFlipped(extra.slice(0, tooMany)), `block ${block}, ≥ 15 errors`).toEqual({ jsQR: null, zxing: null });
    }
  });
});

describe("the files in merch/qr/", () => {
  it("are up to date (run `npm run qr` after changing the settings)", () => {
    expect(svg.toString()).toBe(renderMerchQrSvg(qr));
  });

  it("PNG: 2000 × 2000 px", async () => {
    expect(await sharp(png).metadata()).toMatchObject({ width: 2000, height: 2000, format: "png" });
  });

  it("PDF: one 50 mm page, vector only (no images)", async () => {
    const document = await PDFDocument.load(pdf);
    expect(document.getPageCount()).toBe(1);
    const { width, height } = document.getPage(0).getSize();
    expect([width, height].map((pt) => Math.round((pt / 72) * 25.4))).toEqual([50, 50]);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it("SVG: vector, forest green on white, with the K mark", () => {
    const text = svg.toString();
    expect(text).toContain('fill="#163a2c"');
    expect(text).toContain('fill="#ffffff"');
    expect(text).toContain('fill="#c3e604"');
    expect(text).not.toMatch(/<image|data:/);
  });
});

describe("decoding with real QR decoders (jsQR and ZXing)", () => {
  it("PNG decodes to exactly the address, at full size and at scanning size", async () => {
    expect(await decode(png)).toEqual(BOTH);
    expect(await decode(png, SCAN_PIXELS)).toEqual(BOTH);
  });

  it("SVG decodes to exactly the address", async () => {
    expect(await decode(await rasterSvg(svg, SCAN_PIXELS))).toEqual(BOTH);
  });

  it("PNG still decodes with two white scratches across it", async () => {
    expect(await decode(await scratched(png), SCAN_PIXELS)).toEqual(BOTH);
  });

  it("SVG still decodes with two white scratches across it", async () => {
    expect(await decode(await scratched(await rasterSvg(svg, SCAN_PIXELS)))).toEqual(BOTH);
  });

  it("PNG still decodes when blurred", async () => {
    expect(await decode(await blurred(png), SCAN_PIXELS)).toEqual(BOTH);
  });

  it("SVG still decodes when blurred", async () => {
    expect(await decode(await blurred(await rasterSvg(svg, SCAN_PIXELS)))).toEqual(BOTH);
  });

  it("the damaged copies really are damaged (the test isn't a no-op)", async () => {
    const [clean, scratches, blur] = await Promise.all([
      sharp(png).raw().toBuffer(),
      scratched(png).then((image) => sharp(image).raw().toBuffer()),
      blurred(png).then((image) => sharp(image).raw().toBuffer()),
    ]);
    expect(scratches.equals(clean)).toBe(false);
    expect(blur.equals(clean)).toBe(false);
  });
});
