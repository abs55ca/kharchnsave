import { describe, expect, it } from "vitest";
import {
  basisPointsToInput,
  formatPercent,
  isReferralCode,
  isUsername,
  normalizeReferralCode,
  percentToBasisPoints,
  suggestCode,
} from "./code";

describe("referral codes", () => {
  it("normalise like the database: no spaces or hyphens, upper case", () => {
    expect(normalizeReferralCode(" ah-med ")).toBe("AHMED");
    expect(normalizeReferralCode("Ahmed 2 0")).toBe("AHMED20");
    expect(normalizeReferralCode("  ")).toBeNull();
    expect(normalizeReferralCode(null)).toBeNull();
  });

  it("are 3-16 letters and digits", () => {
    for (const ok of ["ABC", "AHMED", "A1B2C3", "X".repeat(16)]) expect(isReferralCode(ok), ok).toBe(true);
    for (const bad of ["AB", "X".repeat(17), "AH_MED", "ahmed", "ÄHMED", "", null]) expect(isReferralCode(bad), String(bad)).toBe(false);
  });

  it("are suggested from the username", () => {
    expect(suggestCode("ahmed")).toBe("AHMED");
    expect(suggestCode(" Ahmed.K_2 ")).toBe("AHMEDK2");
    expect(suggestCode("a-very-long-username-indeed")).toBe("AVERYLONGUSERNAM");
  });

  it("usernames: 3-30 lower-case letters, digits, dots, hyphens, underscores", () => {
    expect(isUsername("ahmed")).toBe(true);
    expect(isUsername("ahmed.k_2")).toBe(true);
    expect(isUsername("ab")).toBe(false);
    expect(isUsername("Ahmed")).toBe(false);
    expect(isUsername(".ahmed")).toBe(false);
  });
});

describe("percentages", () => {
  it("parse to whole basis points without floating point", () => {
    expect(percentToBasisPoints("10")).toBe(1000);
    expect(percentToBasisPoints("7.5")).toBe(750);
    expect(percentToBasisPoints("12.34%")).toBe(1234);
    expect(percentToBasisPoints("0.29")).toBe(29);
    expect(percentToBasisPoints("50")).toBe(5000);
    for (const bad of ["50.01", "", "-1", "1.234", "abc", "100"]) expect(percentToBasisPoints(bad), bad).toBeNull();
  });

  it("format back", () => {
    expect(formatPercent(1000)).toBe("10%");
    expect(formatPercent(750)).toBe("7.5%");
    expect(formatPercent(1234)).toBe("12.34%");
    expect(formatPercent(5)).toBe("0.05%");
    expect(basisPointsToInput(750)).toBe("7.5");
    expect(basisPointsToInput(null)).toBe("");
  });
});
