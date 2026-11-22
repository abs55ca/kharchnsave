import { describe, expect, it } from "vitest";
import { largestLoadedCopy, loadedDirectly } from "./loaded-photo";

const ORIGIN = "https://shop.example";
const SRC = "/product-photos/p1/img-1.webp";
const copy = (w: number, src = SRC, origin = ORIGIN) => `${origin}/_next/image?url=${encodeURIComponent(src)}&w=${w}&q=75`;

describe("largestLoadedCopy", () => {
  it("picks the widest finished copy of this photo", () => {
    const entries = [{ name: copy(256) }, { name: copy(640) }, { name: copy(384) }];
    expect(largestLoadedCopy(SRC, entries, ORIGIN)).toBe(copy(640));
  });

  it("ignores other photos, other origins, other paths and failed requests", () => {
    const entries = [
      { name: copy(1080, "/product-photos/p1/img-2.webp") },
      { name: copy(1080, SRC, "https://elsewhere.example") },
      { name: `${ORIGIN}/product-photos/p1/img-1.webp` },
      { name: copy(1200), responseStatus: 404 },
      { name: "not a url" },
      { name: `${ORIGIN}/_next/image?url=${encodeURIComponent(SRC)}&q=75` },
      { name: copy(256), responseStatus: 200 },
    ];
    expect(largestLoadedCopy(SRC, entries, ORIGIN)).toBe(copy(256));
  });

  it("nothing loaded yet: null (never starts a download of its own)", () => {
    expect(largestLoadedCopy(SRC, [], ORIGIN)).toBeNull();
  });

  it("returns the URL exactly as requested, so the browser's cached copy is used", () => {
    const name = `${ORIGIN}/_next/image?url=${encodeURIComponent(SRC)}&w=640&q=75&dpl=abc`;
    expect(largestLoadedCopy(SRC, [{ name }], ORIGIN)).toBe(name);
  });
});

describe("loadedDirectly", () => {
  it("is true when the document was loaded on this page, false after an in-app navigation", () => {
    expect(loadedDirectly("/products/a", `${ORIGIN}/products/a`, ORIGIN)).toBe(true);
    expect(loadedDirectly("/products/a", `${ORIGIN}/shop?sort=new`, ORIGIN)).toBe(false);
  });

  it("unknown: treated as loaded directly (no placeholder)", () => {
    expect(loadedDirectly("/products/a", undefined, ORIGIN)).toBe(true);
  });
});
