"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExpandIcon } from "@/components/icons";
import { largestLoadedCopy, loadedDirectly } from "@/lib/catalog/loaded-photo";
import type { ProductImage } from "@/lib/catalog/types";

/*
 * The product photos: a row of photos that scrolls sideways (swipe on phones,
 * the arrows, the thumbnails or the arrow keys), snapping one photo at a time.
 * A tap on a photo, or the expand button, opens them full screen.
 *
 * The scroll position is the one source of truth: the buttons only scroll the
 * row, and the shown photo's number is read back from where it lands.
 */

const noSubscription = () => () => {};

/**
 * A copy of `src` this page already downloaded (the catalogue card's, or a
 * thumbnail's), shown behind the photo until it loads. Read while rendering:
 * after a tap on a catalogue card, the first render already has it. Null on
 * the server and for the first photo of a page loaded directly.
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

/** Which photo a scrolling row is showing, updated as it scrolls. */
function useShownIndex(track: RefObject<HTMLElement | null>, count: number, initial = 0) {
  const [index, setIndex] = useState(initial);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el.clientWidth) setIndex(Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / el.clientWidth))));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [track, count]);
  return index;
}

function scrollToPhoto(track: HTMLElement | null, i: number, smooth = true) {
  if (!track) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  track.scrollTo({ left: i * track.clientWidth, behavior: smooth && !reduced ? "smooth" : "instant" });
}

/** Arrow keys move one photo. */
function onArrowKey(e: React.KeyboardEvent, index: number, count: number, go: (i: number) => void) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const next = index + (e.key === "ArrowRight" ? 1 : -1);
  if (next >= 0 && next < count) go(next);
}

/** Keeps the shown photo's thumbnail scrolled into its strip (only the strip moves, never the page). */
function useThumbInView(strip: RefObject<HTMLElement | null>, index: number) {
  useEffect(() => {
    const el = strip.current;
    const thumb = el?.children[index] as HTMLElement | undefined;
    if (!el || !thumb) return;
    const left = thumb.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft) el.scrollTo({ left: left - 8, behavior: "smooth" });
    else if (left + thumb.offsetWidth > el.scrollLeft + el.clientWidth)
      el.scrollTo({ left: left + thumb.offsetWidth - el.clientWidth + 8, behavior: "smooth" });
  }, [strip, index]);
}

const ROW =
  "flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function Photo({
  image,
  first,
  near,
  sizes,
  contain,
}: {
  image: ProductImage;
  first: boolean;
  near: boolean;
  sizes: string;
  contain?: boolean;
}) {
  const loadedCopy = useLoadedCopy(image.src, first);
  const fit = contain ? "object-contain" : "object-cover";
  const position = image.focus && !contain ? { objectPosition: image.focus } : undefined;
  return (
    <>
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
          className={`absolute inset-0 size-full ${fit}`}
          style={position}
        />
      ) : null}
      <Image
        src={image.src}
        alt={image.alt}
        fill
        draggable={false}
        {...(first ? { preload: true } : { loading: near ? "eager" : "lazy" })}
        sizes={sizes}
        className={fit}
        style={position}
      />
    </>
  );
}

function ArrowButton({
  side,
  onClick,
  disabled,
  dark,
}: {
  side: "prev" | "next";
  onClick: () => void;
  disabled: boolean;
  dark?: boolean;
}) {
  const Icon = side === "prev" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === "prev" ? "Previous photo" : "Next photo"}
      className={`absolute top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full shadow-md transition disabled:invisible md:size-11 ${
        side === "prev" ? "left-2 md:left-3" : "right-2 md:right-3"
      } ${dark ? "bg-black/55 text-white ring-1 ring-white/25 hover:bg-black/75" : "bg-white/90 text-ink hover:bg-white"}`}
    >
      <Icon width={22} height={22} strokeWidth={2} />
    </button>
  );
}

function Thumbnails({
  images,
  index,
  onPick,
  name,
  dark,
}: {
  images: ProductImage[];
  index: number;
  onPick: (i: number) => void;
  name: string;
  dark?: boolean;
}) {
  const strip = useRef<HTMLUListElement>(null);
  useThumbInView(strip, index);
  return (
    <ul
      ref={strip}
      className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label={`${name} photos`}
    >
      {images.map((image, i) => (
        <li key={image.src} className="shrink-0">
          <button
            type="button"
            onClick={() => onPick(i)}
            aria-label={`Show photo ${i + 1} of ${images.length}`}
            aria-current={i === index ? "true" : undefined}
            className={`relative block size-16 overflow-hidden rounded-md bg-cream transition sm:size-20 ${
              dark ? "ring-offset-0" : "ring-offset-2"
            } ${
              i === index
                ? dark
                  ? "ring-2 ring-lime"
                  : "ring-2 ring-forest"
                : dark
                  ? "opacity-60 ring-1 ring-white/20 hover:opacity-100"
                  : "ring-1 ring-line hover:ring-forest"
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
  );
}

export function ProductGallery({ images, name }: { images: ProductImage[]; name: string }) {
  const track = useRef<HTMLUListElement>(null);
  const index = useShownIndex(track, images.length);
  const [viewerFrom, setViewerFrom] = useState<number | null>(null);
  const many = images.length > 1;
  const go = (i: number) => scrollToPhoto(track.current, i);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative" role="region" aria-roledescription="carousel" aria-label={`${name} photos`}>
        <ul
          ref={track}
          tabIndex={many ? 0 : undefined}
          onKeyDown={(e) => onArrowKey(e, index, images.length, go)}
          aria-label={many ? "Swipe or use the arrow keys for more photos" : undefined}
          className={`${ROW} aspect-square rounded-lg bg-cream`}
        >
          {images.map((image, i) => (
            <li
              key={image.src}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${images.length}`}
              onClick={() => setViewerFrom(i)}
              className="relative h-full w-full shrink-0 cursor-zoom-in snap-center snap-always"
            >
              <Photo
                image={image}
                first={i === 0}
                near={Math.abs(i - index) <= 1}
                // Full width minus the page's gutters (.container-page) below the
                // two-column layout: on a 390 px phone the photo is 358 px wide.
                sizes="(min-width: 1320px) 680px, (min-width: 1024px) 52vw, (min-width: 768px) calc(100vw - 48px), calc(100vw - 32px)"
              />
            </li>
          ))}
        </ul>

        {many ? (
          <>
            <ArrowButton side="prev" onClick={() => go(index - 1)} disabled={index === 0} />
            <ArrowButton side="next" onClick={() => go(index + 1)} disabled={index === images.length - 1} />
            <p
              className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink/70 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-white"
              aria-live="polite"
            >
              <span className="sr-only">Photo </span>
              {index + 1} / {images.length}
            </p>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => setViewerFrom(index)}
          aria-label="View photos full screen"
          className="absolute right-2 top-2 z-10 inline-flex size-10 items-center justify-center rounded-full bg-white/90 text-ink shadow-md transition hover:bg-white md:right-3 md:top-3"
        >
          <ExpandIcon width={18} height={18} strokeWidth={2} />
        </button>
      </div>

      {many ? <Thumbnails images={images} index={index} onPick={go} name={name} /> : null}

      {viewerFrom !== null ? (
        <PhotoViewer
          images={images}
          name={name}
          start={viewerFrom}
          onClose={(last) => {
            setViewerFrom(null);
            // Come back to the photo they were looking at.
            scrollToPhoto(track.current, last, false);
          }}
        />
      ) : null}
    </div>
  );
}

/** The photos full screen: swipe, arrows, arrow keys, thumbnails; Esc or × closes. */
function PhotoViewer({
  images,
  name,
  start,
  onClose,
}: {
  images: ProductImage[];
  name: string;
  start: number;
  onClose: (last: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLUListElement>(null);
  const index = useShownIndex(track, images.length, start);
  const many = images.length > 1;
  const go = (i: number) => scrollToPhoto(track.current, i);

  // Open on the photo that was tapped, before the first paint.
  useLayoutEffect(() => {
    dialog.current?.showModal();
    scrollToPhoto(track.current, start, false);
    // The page behind stays still while this is open.
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = before;
    };
  }, [start]);

  return (
    <dialog
      ref={dialog}
      aria-label={`${name} photos`}
      onClose={() => onClose(index)}
      onKeyDown={(e) => onArrowKey(e, index, images.length, go)}
      className="surface-dark m-0 h-dvh max-h-none w-full max-w-none bg-ink p-0 text-white backdrop:bg-ink"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-4 px-4 py-2">
          <p className="text-sm font-semibold tabular-nums" aria-live="polite">
            {many ? `${index + 1} / ${images.length}` : null}
          </p>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close"
            className="inline-flex size-11 items-center justify-center rounded-full hover:bg-white/10"
          >
            <CloseIcon width={24} height={24} strokeWidth={2} />
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          <ul ref={track} className={`${ROW} h-full`}>
            {images.map((image, i) => (
              <li
                key={image.src}
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${images.length}`}
                className="relative h-full w-full shrink-0 snap-center snap-always"
              >
                <Photo image={image} first={false} near={Math.abs(i - index) <= 1} sizes="100vw" contain />
              </li>
            ))}
          </ul>
          {many ? (
            <>
              <ArrowButton side="prev" onClick={() => go(index - 1)} disabled={index === 0} dark />
              <ArrowButton side="next" onClick={() => go(index + 1)} disabled={index === images.length - 1} dark />
            </>
          ) : null}
        </div>
        {many ? (
          <div className="flex justify-center px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <Thumbnails images={images} index={index} onPick={go} name={name} dark />
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
