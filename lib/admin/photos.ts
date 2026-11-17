import "server-only";
import sharp, { type Metadata } from "sharp";
import { PHOTO_UPLOAD } from "./product-input";

/*
 * Checks an uploaded product photo by its actual contents (never its file
 * name or the browser's declared type), then re-encodes it as WebP. The
 * re-encode drops all metadata (camera details and GPS location), applies
 * the phone's rotation, and caps the stored size.
 */

export const PHOTO_LIMITS = {
  maxBytes: PHOTO_UPLOAD.maxBytes,
  minSide: 400,
  maxSide: 8000,
  /** Refuses decompression bombs before decoding (40 megapixels). */
  maxPixels: 40_000_000,
  /** Longest side of the stored copy. */
  storedMaxSide: 2000,
  /**
   * WebP quality of the stored copy. Chosen on 24 product photos (2026-11-17):
   * against 85, 80 is 20% smaller on average (201 KB vs 252 KB at 2,000 px)
   * with stitching, texture and wear still sharp at 2x zoom; 78 began to
   * smooth dark fabric. Shoppers get resized copies from next/image anyway.
   */
  storedQuality: 80,
} as const;

/** WebP quality of the admin previews made from the stored copy (never stored). */
const PREVIEW_QUALITY = { small: 70, large: 75 } as const;

type Format = "jpeg" | "png" | "webp";

/** The format named by the file's first bytes ("magic numbers"), if accepted. */
function sniffFormat(bytes: Uint8Array): Format | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return "jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

export type PreparedPhoto = { data: Buffer; width: number; height: number };

export async function preparePhoto(file: unknown): Promise<{ ok: true; photo: PreparedPhoto } | { ok: false; error: string }> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a photo to upload." };
  if (file.size > PHOTO_LIMITS.maxBytes) {
    return { ok: false, error: "That photo is over 4 MB. Use a smaller photo (most phones have a “medium” size option)." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffFormat(bytes);
  if (!format) return { ok: false, error: "Upload a JPEG, PNG or WebP photo. Other file types (including HEIC) aren’t accepted." };

  const options = { limitInputPixels: PHOTO_LIMITS.maxPixels, failOn: "warning" as const };
  let metadata: Metadata;
  try {
    // Reads only the header, so an oversized image is reported as such
    // below. The pixel limit still applies when the image is decoded.
    metadata = await sharp(bytes, { ...options, limitInputPixels: false }).metadata();
  } catch {
    return { ok: false, error: "That file couldn’t be read as a photo. It may be damaged; try exporting it again." };
  }
  if (metadata.format !== format) {
    return { ok: false, error: "That file couldn’t be read as a photo. It may be damaged; try exporting it again." };
  }
  if ((metadata.pages ?? 1) > 1) return { ok: false, error: "Animated images aren’t accepted. Upload a still photo." };

  // Orientation 5–8 means the phone stored it rotated by 90°.
  const rotated = (metadata.orientation ?? 1) >= 5;
  const width = rotated ? metadata.height : metadata.width;
  const height = rotated ? metadata.width : metadata.height;
  if (!width || !height) return { ok: false, error: "That file couldn’t be read as a photo." };
  if (Math.min(width, height) < PHOTO_LIMITS.minSide) {
    return { ok: false, error: `That photo is too small (${width}×${height}). Use one at least ${PHOTO_LIMITS.minSide} pixels on each side.` };
  }
  if (Math.max(width, height) > PHOTO_LIMITS.maxSide || width * height > PHOTO_LIMITS.maxPixels) {
    return { ok: false, error: `That photo is too large (${width}×${height}). Use one at most ${PHOTO_LIMITS.maxSide} pixels on its longest side.` };
  }

  try {
    // Decoding the whole image here is what proves the contents are a real
    // photo (a corrupt or truncated file fails). Metadata isn't copied.
    const { data, info } = await sharp(bytes, options)
      .rotate()
      .resize({ width: PHOTO_LIMITS.storedMaxSide, height: PHOTO_LIMITS.storedMaxSide, fit: "inside", withoutEnlargement: true })
      .webp({ quality: PHOTO_LIMITS.storedQuality })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, photo: { data, width: info.width, height: info.height } };
  } catch {
    return { ok: false, error: "That file couldn’t be read as a photo. It may be damaged; try exporting it again." };
  }
}

/**
 * A smaller WebP copy of a stored photo (already checked and re-encoded by
 * preparePhoto) for the admin previews, at most `maxSide` pixels on its
 * longest side. Made on request and never stored.
 */
export async function previewPhoto(stored: Uint8Array, maxSide: number): Promise<Buffer> {
  return sharp(stored, { limitInputPixels: PHOTO_LIMITS.maxPixels })
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .webp({ quality: maxSide <= 256 ? PREVIEW_QUALITY.small : PREVIEW_QUALITY.large })
    .toBuffer();
}
