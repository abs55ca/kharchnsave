"use client";

import Image from "next/image";
import { useState } from "react";
import type { ProductImage } from "@/lib/catalog/types";

export function ProductGallery({ images, name }: { images: ProductImage[]; name: string }) {
  const [index, setIndex] = useState(0);
  const current = images[index];

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square overflow-hidden rounded-lg bg-cream">
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
