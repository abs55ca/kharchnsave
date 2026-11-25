import { getImageProps } from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { LongArrowIcon } from "@/components/icons";
import { getAllProducts } from "@/lib/catalog/catalog";
import { discountPercent, isOnSale } from "@/lib/catalog/pricing";

/**
 * Supplied campaign banners: kids' sneakers on a mint playground. Wide
 * (2172×724) from md up, with the copy over the empty left side; tall
 * (1086×1448) on phones, with the copy over the empty top. The background is
 * light, so the copy is dark green.
 */
export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="container-page">
      <div className="relative overflow-hidden rounded-lg bg-hero">
        {/* Phones and small tablets: a centred poster over the empty mint at the top. From md: left-aligned over the wide banner. */}
        <div className="absolute inset-x-0 top-0 z-10 flex flex-col items-center px-6 pt-6 text-center min-[380px]:pt-7 sm:pt-10 md:inset-y-0 md:right-auto md:w-[42%] md:items-start md:justify-center md:p-0 md:pl-[5%] md:text-left">
          <Suspense fallback={null}>
            <SaleTag />
          </Suspense>
          <h1
            id="hero-heading"
            className="text-[2.125rem] font-extrabold leading-[1.02] min-[380px]:text-[2.375rem] tracking-tight text-forest sm:text-[2.75rem] md:text-[clamp(1.75rem,3.7vw,3.4rem)]"
          >
            <span className="block">Style Zyada.</span>
            <span className="mt-[0.08em] block">
              {/* A lime marker stroke under the words. */}
              <span className="box-decoration-clone bg-[linear-gradient(transparent_58%,var(--color-lime)_58%,var(--color-lime)_92%,transparent_92%)] px-1">
                Kharch Kam.
              </span>
            </span>
          </h1>
          <p className="mt-2 text-sm font-medium text-forest/85 md:mt-[clamp(0.5rem,1vw,1rem)] md:text-[clamp(0.875rem,1.25vw,1.125rem)] md:text-forest">
            More brands. Less to spend.
          </p>
          <Link
            href="/shop"
            className="mt-4 inline-flex h-10 w-fit items-center gap-[10px] rounded-full bg-forest px-6 text-sm font-semibold text-white shadow-md hover:bg-forest-deep md:mt-[clamp(1rem,2vw,1.75rem)] md:h-10 md:rounded-md md:px-4 md:shadow-none"
          >
            Find Your Pair
            <LongArrowIcon />
          </Link>
        </div>
        <HeroPicture />
      </div>
    </section>
  );
}

const HERO_ALT =
  "Kids' sneakers on a mint-green playground: a navy pair with a lime lightning bolt, a pink and lilac pair, and a pastel pair with chalk stars";
const HERO_SIZES =
  "(min-width: 1320px) 1256px, (min-width: 1024px) calc(100vw - 4rem), (min-width: 768px) calc(100vw - 3rem), calc(100vw - 2rem)";

/**
 * Art direction: the wide banner from md up, the tall one (1086×1448, empty
 * mint at the top for the copy) on phones. Each screen downloads only its own.
 */
function HeroPicture() {
  const common = { alt: HERO_ALT, sizes: HERO_SIZES, fetchPriority: "high" as const, loading: "eager" as const };
  const {
    props: { srcSet: wide },
  } = getImageProps({ ...common, src: "/images/hero/kids-playground-hero.jpg", width: 2172, height: 724 });
  const {
    props: { srcSet: tall, ...img },
  } = getImageProps({ ...common, src: "/images/hero/kids-playground-hero-mobile.jpg", width: 1086, height: 1448 });
  return (
    <picture>
      <source media="(min-width: 768px)" srcSet={wide} width={2172} height={724} />
      <source media="(max-width: 767px)" srcSet={tall} width={1086} height={1448} />
      {/* Small tablets (sm, below md): the tall banner cropped a little from the top (4:5), so it isn't taller than the screen. */}
      <img {...img} alt={HERO_ALT} className="block h-auto w-full sm:aspect-[4/5] sm:object-cover sm:object-bottom md:aspect-auto" />
    </picture>
  );
}

/**
 * "Up to 35% off", from the shop's own prices: the largest saving on any
 * listing on sale with a verified "was" price (rounded down, like its tag).
 * Nothing on sale: no tag.
 */
async function SaleTag() {
  let best = 0;
  try {
    for (const p of await getAllProducts()) {
      if (isOnSale(p)) best = Math.max(best, discountPercent(p.regularPrice!, p.price));
    }
  } catch {
    return null;
  }
  if (best < 1) return null;
  return (
    <p className="mb-2.5 w-fit rounded-full bg-[#dc2626] px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-sm md:mb-[clamp(0.5rem,1.2vw,1rem)] md:text-[clamp(0.8rem,1.1vw,1rem)] md:normal-case md:tracking-wide">
      Up to {best}% off
    </p>
  );
}
