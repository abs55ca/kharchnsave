import { readFile } from "node:fs/promises";
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  InvertedLuminanceSource,
  QRCodeReader,
  RGBLuminanceSource,
  type LuminanceSource,
} from "@zxing/library";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { K_MARK, K_MARK_WHITE } from "@/lib/brand/k-mark";
import { QR_CODE_URL } from "@/lib/links";
import {
  blockOfCodeword,
  buildMerchQr,
  dataBitPositions,
  logoAreaRect,
  MERCH_QR,
  MERCH_QR_DESIGNS,
  modulesPath,
  renderMerchQrSvg,
  type MerchQr,
  type MerchQrDesign,
} from "./merch-qr";

/*
 * Decodes the merchandise QR codes with two real decoders, jsQR and ZXing
 * (the decoder behind many phone scanners): the files in merch/qr/ as
 * committed, and damaged copies (two scratches; blur). Damaged copies are
 * read at 1000 px, about what a phone camera sees of a printed code. The main
 * design is white on dark green, an inverted code, so it is read in each
 * decoder's inverted mode. Run `npm run qr` after changing the settings.
 */

const EXPECTED = "https://kharchnsave.pk/qr";
const TOTAL = 41 + 2 * MERCH_QR.border; // modules per side, quiet zone included
const SCAN_PIXELS = 1000;

type Mode = "normal" | "inverted";
type Pixels = { rgba: Uint8ClampedArray; width: number; height: number };

async function pixelsOf(image: Buffer, width?: number): Promise<Pixels> {
  const { data, info } = await sharp(image)
    .resize(width ? { width } : undefined)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/**
 * jsQR's "onlyInvert" crashes in 1.4.0 (it never builds the inverted image it
 * then scans), so inverted mode uses "invertFirst": the inverted image first,
 * then the normal one. A normal scan can't read the main design (tested
 * below), so a result for it always comes from the inverted scan.
 */
function decodeWithJsQr({ rgba, width, height }: Pixels, mode: Mode) {
  return jsQR(rgba, width, height, { inversionAttempts: mode === "inverted" ? "invertFirst" : "dontInvert" })?.data ?? null;
}

function decodeWithZxing({ rgba, width, height }: Pixels, mode: Mode) {
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < luminance.length; i++) {
    luminance[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
  }
  let source: LuminanceSource = new RGBLuminanceSource(luminance, width, height);
  if (mode === "inverted") source = new InvertedLuminanceSource(source);
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    return new QRCodeReader().decode(bitmap, new Map([[DecodeHintType.TRY_HARDER, true]])).getText();
  } catch {
    return null;
  }
}

/** What both decoders read from an image (scaled to `width` px first, if given). */
async function decode(image: Buffer, mode: Mode, width?: number) {
  const pixels = await pixelsOf(image, width);
  return { jsQR: decodeWithJsQr(pixels, mode), zxing: decodeWithZxing(pixels, mode) };
}

const BOTH = { jsQR: EXPECTED, zxing: EXPECTED };
const NEITHER = { jsQR: null, zxing: null };
const modeOf = (design: MerchQrDesign): Mode => (design.inverted ? "inverted" : "normal");

/** The vector SVG rendered at `pixels` wide (instead of its printed 50 mm). */
function rasterSvg(svgFile: Buffer, pixels: number) {
  const sized = svgFile.toString().replace(/width="[^"]+" height="[^"]+"/, `width="${pixels}" height="${pixels}"`);
  return sharp(Buffer.from(sized)).png().toBuffer();
}

/**
 * Two "scratches", 0.4 modules wide, across the data area: one nearly
 * horizontal under the logo, one nearly vertical left of it, in `color`
 * (the background colour, so they erase modules). They miss the three finder
 * patterns and the alignment pattern, which a scanner needs to find the code.
 */
async function scratched(png: Buffer, color: string) {
  const { width = 0 } = await sharp(png).metadata();
  const lines =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${TOTAL} ${TOTAL}">` +
    `<line x1="0" y1="33.5" x2="${TOTAL}" y2="36.5" stroke="${color}" stroke-width="0.4"/>` +
    `<line x1="13.5" y1="0" x2="15.5" y2="${TOTAL}" stroke="${color}" stroke-width="0.4"/>` +
    "</svg>";
  return sharp(png).composite([{ input: Buffer.from(lines) }]).png().toBuffer();
}

/** Gaussian blur with a radius of 0.3 modules. */
async function blurred(png: Buffer) {
  const { width = 0 } = await sharp(png).metadata();
  return sharp(png).blur((width / TOTAL) * 0.3).png().toBuffer();
}

describe("what the codes say", () => {
  it("is always the production address, from the config", () => {
    expect(QR_CODE_URL).toBe(EXPECTED);
    expect(MERCH_QR.url).toBe(EXPECTED);
  });
});

describe("the main design: white on forest green, inverted", () => {
  const design = MERCH_QR_DESIGNS.main;

  it("uses a forest-green background and quiet zone, white modules and the white K mark", () => {
    expect(design).toMatchObject({ background: "#163a2c", moduleColor: "#ffffff", inverted: true });
    expect(design.logo).toBe(K_MARK_WHITE);
    expect(K_MARK_WHITE.viewBox).toEqual({ x: 0, y: 0, width: 567.55, height: 508.21 });
    expect(K_MARK_WHITE.paths.map((path) => path.fill)).toEqual(["#fff", "#c3e604"]);
  });

  it("copies the logo's paths exactly from public/brand/logo-white.svg", async () => {
    const source = await readFile("public/brand/logo-white.svg", "utf8");
    expect(source).toContain('viewBox="0 0 567.55 508.21"');
    for (const path of K_MARK_WHITE.paths) expect(source).toContain(`d="${path.d}"`);
  });
});

describe("the light design: forest green on white (fallback)", () => {
  it("uses white, forest-green modules and the green K mark", () => {
    expect(MERCH_QR_DESIGNS.light).toMatchObject({ background: "#ffffff", moduleColor: "#163a2c", inverted: false });
    expect(MERCH_QR_DESIGNS.light.logo).toBe(K_MARK);
  });
});

describe.each(Object.values(MERCH_QR_DESIGNS))("$id design", (design) => {
  const mode = modeOf(design);
  let qr: MerchQr;
  let svg: Buffer;
  let png: Buffer;
  let pdf: Buffer;

  beforeAll(async () => {
    qr = await buildMerchQr(design);
    [svg, png, pdf] = await Promise.all([readFile(design.files.svg), readFile(design.files.png), readFile(design.files.pdf)]);
  });

  describe("symbol and logo area", () => {
    it("is version 6 (41 × 41) at error correction H, with a 4-module quiet zone", () => {
      expect(qr.url).toBe(EXPECTED);
      expect(qr.size).toBe(41);
      expect(MERCH_QR.version).toBe(6);
      expect(MERCH_QR.errorCorrectionLevel).toBe("H");
      expect(MERCH_QR.border).toBe(4);
      expect(svg.toString()).toContain(`viewBox="0 0 ${TOTAL} ${TOTAL}"`);
      expect(svg.toString()).toContain(`<rect width="${TOTAL}" height="${TOTAL}" fill="${design.background}"/>`);
    });

    it("clears exactly 15 × 15 modules in the centre, never more", () => {
      expect(MERCH_QR.logoAreaModules).toBe(15);
      expect(qr.logoArea).toEqual({ start: 13, size: 15 });
      expect(logoAreaRect(qr)).toEqual({ x: 17, y: 17, size: 15 });
      // 225 of 2401 modules of the whole image: about 9.4%.
      expect(qr.logoArea.size ** 2 / TOTAL ** 2).toBeLessThanOrEqual(0.1);
    });

    it("clears whole modules in the logo area, draws none there, and puts no tile behind the logo", () => {
      for (let row = 13; row < 28; row++) {
        for (let col = 13; col < 28; col++) expect(qr.modules[row][col], `${row},${col}`).toBe(false);
      }
      const area = logoAreaRect(qr);
      for (const [, x, y, run] of modulesPath(qr).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
        const [left, top, right] = [Number(x), Number(y), Number(x) + Number(run)];
        const overlaps = top >= area.y && top < area.y + area.size && right > area.x && left < area.x + area.size;
        expect(overlaps, `run at ${x},${y}`).toBe(false);
      }
      expect(modulesPath(qr)).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/); // whole-module coordinates only
      // Background rect, modules, then the logo's own paths: nothing else.
      expect(svg.toString().match(/<(rect|path)\b/g)).toHaveLength(2 + design.logo.paths.length);
    });

    it("leaves error correction to spare in every block (at least 4 codewords)", () => {
      expect(qr.correctablePerBlock).toBe(14);
      for (const damaged of qr.misreadCodewordsPerBlock.worstCase) {
        expect(damaged).toBeLessThanOrEqual(qr.correctablePerBlock - 4);
      }
    });

    it("predicts the decoders: every block decodes with up to 14 errors in the worst case, and fails with 15 certain ones", async () => {
      const positions = dataBitPositions(qr);
      const inArea = ([row, col]: [number, number]) => row >= 13 && row < 28 && col >= 13 && col < 28;
      const untouched = (codeword: number) => positions.slice(codeword * 8, codeword * 8 + 8).every((p) => !inArea(p));
      const withFlipped = async (codewords: number[]) => {
        const modules = qr.modules.map((row) => [...row]);
        for (const codeword of codewords) {
          for (const [row, col] of positions.slice(codeword * 8, codeword * 8 + 8)) modules[row][col] = !modules[row][col];
        }
        return decode(await sharp(Buffer.from(renderMerchQrSvg({ ...qr, modules }, "800"))).png().toBuffer(), mode);
      };
      const { certain, worstCase } = qr.misreadCodewordsPerBlock;
      for (let block = 0; block < 4; block++) {
        const extra = Array.from({ length: 172 }, (_, i) => i).filter((i) => blockOfCodeword(i) === block && untouched(i));
        // At most 14 errors in this block, however the mark's edges and tag are read.
        const safe = qr.correctablePerBlock - worstCase[block];
        expect(await withFlipped(extra.slice(0, safe)), `block ${block}, ≤ 14 errors`).toEqual(BOTH);
        // At least 15 errors, whatever happens at the edges.
        const tooMany = qr.correctablePerBlock + 1 - certain[block];
        expect(await withFlipped(extra.slice(0, tooMany)), `block ${block}, ≥ 15 errors`).toEqual(NEITHER);
      }
    });
  });

  describe("the files", () => {
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

    it("SVG: vector, in the design's colours, with the K mark", () => {
      const text = svg.toString();
      expect(text).toContain(`fill="${design.background}"`);
      expect(text).toContain(`fill="${design.moduleColor}"`);
      for (const path of design.logo.paths) expect(text).toContain(`<path fill="${path.fill}" d="${path.d}"/>`);
      expect(text).not.toMatch(/<image|data:/);
    });
  });

  describe(`decoding (${mode} mode, jsQR and ZXing)`, () => {
    it("PNG decodes to exactly the address, at full size and at scanning size", async () => {
      expect(await decode(png, mode)).toEqual(BOTH);
      expect(await decode(png, mode, SCAN_PIXELS)).toEqual(BOTH);
    });

    it("SVG decodes to exactly the address", async () => {
      expect(await decode(await rasterSvg(svg, SCAN_PIXELS), mode)).toEqual(BOTH);
    });

    it("PNG still decodes with two scratches across it", async () => {
      expect(await decode(await scratched(png, design.background), mode, SCAN_PIXELS)).toEqual(BOTH);
    });

    it("SVG still decodes with two scratches across it", async () => {
      expect(await decode(await scratched(await rasterSvg(svg, SCAN_PIXELS), design.background), mode)).toEqual(BOTH);
    });

    it("PNG still decodes when blurred", async () => {
      expect(await decode(await blurred(png), mode, SCAN_PIXELS)).toEqual(BOTH);
    });

    it("SVG still decodes when blurred", async () => {
      expect(await decode(await blurred(await rasterSvg(svg, SCAN_PIXELS)), mode)).toEqual(BOTH);
    });

    it("the damaged copies really are damaged (the tests aren't no-ops)", async () => {
      const [clean, scratches, blur] = await Promise.all([
        sharp(png).raw().toBuffer(),
        scratched(png, design.background).then((image) => sharp(image).raw().toBuffer()),
        blurred(png).then((image) => sharp(image).raw().toBuffer()),
      ]);
      expect(scratches.equals(clean)).toBe(false);
      expect(blur.equals(clean)).toBe(false);
    });
  });
});

describe("the main design needs a scanner that reads inverted codes", () => {
  let png: Buffer;
  let svg: Buffer;

  beforeAll(async () => {
    [png, svg] = await Promise.all([
      readFile(MERCH_QR_DESIGNS.main.files.png),
      readFile(MERCH_QR_DESIGNS.main.files.svg),
    ]);
  });

  it("inverting the image gives an ordinary dark-on-light code that decodes normally", async () => {
    const negative = await sharp(png).negate({ alpha: false }).png().toBuffer();
    expect(await decode(negative, "normal")).toEqual(BOTH);
    expect(await decode(negative, "normal", SCAN_PIXELS)).toEqual(BOTH);
    const negativeSvg = await sharp(await rasterSvg(svg, SCAN_PIXELS)).negate({ alpha: false }).png().toBuffer();
    expect(await decode(negativeSvg, "normal")).toEqual(BOTH);
  });

  it("a decoder that only reads normal (dark-on-light) codes can't read it", async () => {
    expect(await decode(png, "normal", SCAN_PIXELS)).toEqual(NEITHER);
  });
});
