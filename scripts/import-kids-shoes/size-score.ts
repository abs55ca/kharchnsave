/*
 * Kids' shoes are priced by size (2026-11-23): automatic pricing in the
 * "Kids Sneakers" group (maximum Rs. 4,000), with a score that rises in a
 * straight line from 45 at the smallest size in this batch (EU 22) to 100 at
 * the largest (EU 36), rounded to a whole score. Never below 45.
 */

export const GROUP_NAME = "Kids Sneakers";
export const GROUP_MAX_PAISA = 400_000;
export const MIN_SCORE = 45;
export const SMALLEST = 22;
export const LARGEST = 36;

export function sizeScore(size: number): number {
  if (!Number.isFinite(size)) throw new RangeError("Size must be a number.");
  const clamped = Math.min(LARGEST, Math.max(SMALLEST, size));
  return Math.round(MIN_SCORE + ((clamped - SMALLEST) * (100 - MIN_SCORE)) / (LARGEST - SMALLEST));
}
