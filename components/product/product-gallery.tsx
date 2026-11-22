"use client";

import Image from "next/image";
import { useState, useSyncExternalStore } from "react";
import { largestLoadedCopy, loadedDirectly } from "@/lib/catalog/loaded-photo";
import type { ProductImage } from "@/lib/catalog/types";

const noSubscription = () => () => {};

/**
 * A copy of `src` this page already downloaded (the catalogue card's, or a
 * thumbnail's), shown behind the main photo until it loads. Read while
 * rendering: after a tap on a catalogue card, the first render already has
 * it. Null on the server and for the first photo of a page loaded directly.
 */
function useLoadedCopy(src: string, first: boolean) {
  return useSyncExternalStore(
    noSubscription,
    () => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (first && loadedDirectly(location.pathname, navigation?.name, location.origin)) return null;
      return largestLoadedCopy(src, performance.getEntriesByType("resource") as PerformanceResourceTiming[], location.origin);
    },
    () => null,
  );
}

export function ProductGallery({ images, name }: { images: ProductImage[]; name: string }) {
  const [index, setIndex] = useState(0);
  const current = images[index];
  const loadedCopy = useLoadedCopy(current.src, index === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-cream">
        {loadedCopy ? (
          // A plain <img> on purpose: this exact URL is already in the
          // browser's cache; next/image would ask for a different size.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={loadedCopy}
            src={loadedCopy}
            alt=""
            aria-hidden="true"
            decoding="sync"
            className="absolute inset-0 size-full object-cover"
            style={current.focus ? { objectPosition: current.focus } : undefined}
          />
        ) : null}
        <Image
          key={current.src}
          src={current.src}
          alt={current.alt}
          fill
          preload={index === 0}
          // Full width minus the page's gutters (.container-page) below the
          // two-column layout: on a 390 px phone the photo is 358 px wide.
          sizes="(min-width: 1320px) 680px, (min-width: 1024px) 52vw, (min-width: 768px) calc(100vw - 48px), calc(100vw - 32px)"
          className="object-cover"
          style={current.focus ? { objectPosition: current.focus } : undefined}
        />
      </div>
      {images.length > 1 ? (
        <ul className="flex gap-2" aria-label={`${name} photos`}>
          {images.map((image, i) => (
            <li key={image.src}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show photo ${i + 1} of ${images.length}`}
                aria-current={i === index ? "true" : undefined}
                className={`relative block size-16 overflow-hidden rounded-md bg-cream ring-offset-2 sm:size-20 ${
                  i === index ? "ring-2 ring-forest" : "ring-1 ring-line hover:ring-forest"
                }`}
              >
                <Image
                  src={image.src}
                  alt=""
                  fill
                  sizes="80px"
                  className="object-cover"
                  style={image.focus ? { objectPosition: image.focus } : undefined}
                />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
