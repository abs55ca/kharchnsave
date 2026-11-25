import Image from "next/image";
import Link from "next/link";
import { ChevronRightIcon } from "@/components/icons";
import { DEPARTMENTS } from "@/lib/catalog/labels";

// Supplied cut-outs (toes pointing left). Each upright/tilted pair is cropped
// to the same box so the two overlay exactly. `shoe` and `below` are the
// upright shoe's height and the space under it as fractions of that box;
// `tilt` is the angle between the pair, used to rotate one into the other.
const SHORTCUTS = [
  {
    label: "Men",
    href: DEPARTMENTS.men.href,
    image: "/images/departments/men",
    width: 800,
    height: 502,
    shoe: 0.74,
    below: 0.134,
    tilt: -20,
    soon: true,
  },
  {
    label: "Women",
    href: DEPARTMENTS.women.href,
    image: "/images/departments/women",
    width: 800,
    height: 518,
    shoe: 0.745,
    below: 0.084,
    tilt: -17,
    soon: true,
  },
  {
    label: "Kids",
    href: DEPARTMENTS.kids.href,
    image: "/images/departments/kids",
    width: 800,
    height: 514,
    shoe: 0.705,
    below: 0.079,
    tilt: -15,
    soon: false,
  },
];

// Upright shoe height and how far its sole sits above the card's bottom edge.
const SHOE_HEIGHT = 40; // cqw
const SOLE_OFFSET = 5; // cqw

// The photos swap instantly (no cross-fade, which reads as ghosting); the
// rotation alone carries the motion, as the tilted shoe starts at the
// upright angle and tips forward.
const imageClass =
  "object-contain drop-shadow-[0_8px_6px_rgb(15_42_32/0.2)] [transition:rotate_450ms_cubic-bezier(0.22,1,0.36,1)]";

export function CategoryShortcuts() {
  return (
    <nav aria-label="Shop by category" className="container-page pb-5 pt-2 md:pb-8 md:pt-4">
      <ul className="mx-auto grid max-w-3xl grid-cols-3 gap-3 sm:gap-6">
        {SHORTCUTS.map((item) => {
          const box = SHOE_HEIGHT / item.shoe;
          return (
            // Sizes are in cqw (percent of the card's width), so the
            // composition scales with the card.
            <li key={item.label} className="@container">
              <Link href={item.href} className="group block rounded-xl pt-[25cqw]">
                <span className="relative block h-[28cqw] rounded-xl bg-forest-soft transition-colors duration-300 group-hover:bg-lime/40 group-focus-visible:bg-lime/40">
                  <span
                    className="absolute left-1/2 -translate-x-1/2"
                    style={
                      {
                        height: `${box}cqw`,
                        bottom: `${SOLE_OFFSET - item.below * box}cqw`,
                        aspectRatio: `${item.width} / ${item.height}`,
                        "--tilt": `${item.tilt}deg`,
                      } as React.CSSProperties
                    }
                  >
                    {/* Hover swaps to the tilted photo; the rotation makes the
                        cross-fade read as one shoe tipping forward. */}
                    <Image
                      src={`${item.image}.png`}
                      alt=""
                      fill
                      loading="eager"
                      sizes="(min-width: 800px) 210px, 27vw"
                      className={`${imageClass} group-hover:opacity-0 group-focus-visible:opacity-0 motion-safe:group-hover:[rotate:var(--tilt)] motion-safe:group-focus-visible:[rotate:var(--tilt)]`}
                    />
                    <Image
                      src={`${item.image}-tilted.png`}
                      alt=""
                      fill
                      loading="eager"
                      sizes="(min-width: 800px) 210px, 27vw"
                      className={`${imageClass} opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-safe:[rotate:calc(var(--tilt)*-1)] motion-safe:group-hover:[rotate:0deg] motion-safe:group-focus-visible:[rotate:0deg]`}
                    />
                  </span>
                </span>
                <span className="mt-2 flex items-center justify-center gap-0.5 font-heading text-sm font-bold text-forest sm:mt-3 sm:text-lg">
                  {item.label}
                  <ChevronRightIcon className="size-4 transition-transform group-hover:translate-x-0.5 sm:size-5" />
                </span>
                {item.soon ? (
                  <span className="mt-0.5 block text-center text-[10px] font-semibold uppercase tracking-wide text-muted sm:text-xs">
                    Coming soon
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
