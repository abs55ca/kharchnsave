/**
 * Approximate size conversions. Fit varies by brand and model, so these are a
 * starting point rather than an exact match.
 */
export type AdultSize = {
  eu: number;
  uk: number;
  usMen: number;
  usWomen: number;
  footCm: number;
};

export type KidsSize = { eu: number; uk: number; us: number; footCm: number };

export const ADULT_SIZES: AdultSize[] = [
  { eu: 36, uk: 3.5, usMen: 4.5, usWomen: 5.5, footCm: 22.5 },
  { eu: 37, uk: 4, usMen: 5, usWomen: 6, footCm: 23 },
  { eu: 38, uk: 5, usMen: 6, usWomen: 7, footCm: 24 },
  { eu: 39, uk: 6, usMen: 6.5, usWomen: 8, footCm: 24.5 },
  { eu: 40, uk: 6.5, usMen: 7, usWomen: 8.5, footCm: 25 },
  { eu: 41, uk: 7.5, usMen: 8, usWomen: 9.5, footCm: 26 },
  { eu: 42, uk: 8, usMen: 8.5, usWomen: 10, footCm: 26.5 },
  { eu: 43, uk: 9, usMen: 9.5, usWomen: 11, footCm: 27.5 },
  { eu: 44, uk: 9.5, usMen: 10, usWomen: 11.5, footCm: 28 },
  { eu: 45, uk: 10.5, usMen: 11, usWomen: 12.5, footCm: 29 },
  { eu: 46, uk: 11, usMen: 12, usWomen: 13, footCm: 29.5 },
];

export const KIDS_SIZES: KidsSize[] = [
  { eu: 18, uk: 2, us: 3, footCm: 11 },
  { eu: 19, uk: 3, us: 4, footCm: 11.5 },
  { eu: 20, uk: 4, us: 5, footCm: 12.5 },
  { eu: 21, uk: 5, us: 6, footCm: 13 },
  { eu: 22, uk: 5.5, us: 6.5, footCm: 13.5 },
  { eu: 23, uk: 6, us: 7, footCm: 14 },
  { eu: 24, uk: 7, us: 8, footCm: 15 },
  { eu: 25, uk: 8, us: 9, footCm: 15.5 },
  { eu: 26, uk: 8.5, us: 9.5, footCm: 16 },
  { eu: 27, uk: 9, us: 10, footCm: 16.5 },
  { eu: 28, uk: 10, us: 11, footCm: 17 },
  { eu: 29, uk: 11, us: 12, footCm: 18 },
  { eu: 30, uk: 11.5, us: 12.5, footCm: 18.5 },
];

/**
 * Typical age for a kids' EU size, in months [from, to]. Approximate: feet
 * grow at different rates, so the size (and foot length) is what to go by.
 */
const KIDS_AGE_MONTHS: Record<number, [number, number]> = {
  18: [6, 12],
  19: [12, 15],
  20: [15, 18],
  21: [18, 21],
  22: [18, 24],
  23: [24, 24],
  24: [24, 36],
  25: [24, 36],
  26: [36, 36],
  27: [36, 48],
  28: [48, 48],
  29: [48, 60],
  30: [60, 60],
  31: [60, 72],
  32: [72, 84],
  33: [84, 96],
  34: [96, 108],
  35: [108, 120],
  36: [120, 132],
  37: [132, 144],
};

function formatAge(from: number, to: number) {
  const months = (m: number) => `${m}`;
  const years = (m: number) => `${Math.round(m / 12)}`;
  if (to < 24 || (to === 24 && from < 24)) {
    return from === to ? `${months(from)} months` : `${months(from)}–${months(to)} months`;
  }
  if (from < 24) return `${months(from)} months–${years(to)} yrs`;
  const a = years(from);
  const b = years(to);
  return a === b ? `Age ${a}` : `Age ${a}–${b}`;
}

/**
 * Typical age for kids' EU sizes, e.g. "Age 5", "Age 3–4" or "18–24 months";
 * for several sizes, from the smallest's youngest to the largest's oldest.
 * Half sizes count as the whole size below. Null when no size is in the table.
 */
export function kidsAgeLabel(sizes: number[]) {
  const ranges = sizes.map((s) => KIDS_AGE_MONTHS[Math.floor(s)]).filter((r): r is [number, number] => Boolean(r));
  if (ranges.length === 0) return null;
  return formatAge(Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1])));
}

/** Adult EU sizes offered as shortcuts on the homepage. */
export const ADULT_EU_SHORTCUTS = ADULT_SIZES.map((s) => s.eu);

/** Short conversion string, e.g. "UK 9 · US 9.5". */
export function sizeConversion(eu: number, department: "men" | "women" | "kids") {
  if (department === "kids") {
    const row = KIDS_SIZES.find((s) => s.eu === eu);
    return row ? `UK ${row.uk} · US ${row.us}` : null;
  }
  const row = ADULT_SIZES.find((s) => s.eu === eu);
  if (!row) return null;
  return `UK ${row.uk} · US ${department === "men" ? row.usMen : row.usWomen}`;
}
