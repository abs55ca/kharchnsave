import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { flipPhoto, preparePhoto } from "./photos";

/** An 800×500 photo: red on the left half, blue on the right. */
async function redBlue() {
  const half = (r: number, b: number) => sharp({ create: { width: 400, height: 500, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#000" } })
    .composite([{ input: await half(255, 0), left: 0, top: 0 }, { input: await half(0, 255), left: 400, top: 0 }])
    .png()
    .toBuffer();
  const prepared = await preparePhoto(new File([new Uint8Array(png)], "red-blue.png", { type: "image/png" }));
  if (!prepared.ok) throw new Error(prepared.error);
  return prepared.photo;
}

/** The colour at (x, y): "red", "blue" or something else. */
async function colourAt(webp: Buffer, x: number, y: number) {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  const [r, , b] = [data[i], data[i + 1], data[i + 2]];
  return r > 200 && b < 60 ? "red" : b > 200 && r < 60 ? "blue" : `rgb(${r},${b})`;
}

describe("flipPhoto", () => {
  it("mirrors a stored photo left to right, same size, stored as WebP", async () => {
    const stored = await redBlue();
    expect(await colourAt(stored.data, 100, 250)).toBe("red");
    const flipped = await flipPhoto(stored.data);
    expect({ width: flipped.width, height: flipped.height }).toEqual({ width: stored.width, height: stored.height });
    expect((await sharp(flipped.data).metadata()).format).toBe("webp");
    expect(await colourAt(flipped.data, 100, 250)).toBe("blue");
    expect(await colourAt(flipped.data, 700, 250)).toBe("red");
  });

  it("flipping twice gives the original orientation back", async () => {
    const stored = await redBlue();
    const twice = await flipPhoto((await flipPhoto(stored.data)).data);
    expect(await colourAt(twice.data, 100, 250)).toBe("red");
    expect(await colourAt(twice.data, 700, 250)).toBe("blue");
  });

  it("refuses something that isn't a photo", async () => {
    await expect(flipPhoto(new TextEncoder().encode("not an image"))).rejects.toThrow();
  });
});
