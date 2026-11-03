import { describe, expect, it } from "vitest";
import { LIGHT_UP_CONDITION_VALUES, lightUpDisclosure, lightUpFromColumns, showsLightUpBadge, type LightUp } from "./light-up";

const columns = (light_up: boolean | null, light_up_condition: string | null = null, light_up_activation: string | null = null) => ({
  light_up,
  light_up_condition,
  light_up_activation,
});

describe("the Light-up badge", () => {
  it("shows only when both shoes were checked and work", () => {
    const shown = LIGHT_UP_CONDITION_VALUES.filter((condition) => showsLightUpBadge({ condition, activation: null }));
    expect(shown).toEqual(["both_work"]);
  });

  it("never shows for products without light-up soles, or not recorded", () => {
    expect(showsLightUpBadge(null)).toBe(false);
    expect(showsLightUpBadge(lightUpFromColumns(columns(false)) ?? null)).toBe(false);
    expect(showsLightUpBadge(lightUpFromColumns(columns(null)) ?? null)).toBe(false);
  });
});

describe("what the product page says", () => {
  const say = (lightUp: LightUp) => lightUpDisclosure(lightUp);

  it("says plainly when the lights work in one shoe, or neither", () => {
    expect(say({ condition: "one_works", activation: null })).toMatchObject({
      short: "Lights work in one shoe only",
      text: "Light-up soles, but the lights work in only one shoe.",
      warning: true,
    });
    expect(say({ condition: "neither_works", activation: null })).toMatchObject({
      short: "Lights don’t work",
      text: "Light-up soles, but the lights don’t work in either shoe.",
      warning: true,
    });
  });

  it("says “Lights not tested” for untested lights, without implying they work", () => {
    const untested = say({ condition: "not_checked", activation: "Soles flash when walking." });
    expect(untested.short).toBe("Lights not tested");
    expect(untested.text).toContain("Lights not tested");
    expect(untested.text).toBe("Light-up soles. Lights not tested: we haven’t checked whether they work.");
    expect(untested.text).not.toContain("lights work");
    expect(untested.warning).toBe(true);
    // An activation description is introduced as what's intended, not as a promise.
    expect(untested.activationLabel).toBe("How the lights are meant to activate");
  });

  it("confirms working lights, and introduces the activation description as fact only then", () => {
    expect(say({ condition: "both_work", activation: null })).toMatchObject({
      text: "Light-up soles. We checked both shoes and the lights work.",
      activationLabel: "How the lights activate",
      warning: false,
    });
  });
});

describe("reading the database columns", () => {
  it("keeps existing products (not recorded) and a confirmed No out of the shop", () => {
    expect(lightUpFromColumns(columns(null))).toBeNull();
    expect(lightUpFromColumns(columns(false))).toBeNull();
  });

  it("passes on the condition and the admin's own activation text, never inventing one", () => {
    expect(lightUpFromColumns(columns(true, "both_work", "Soles flash when walking."))).toEqual({
      condition: "both_work",
      activation: "Soles flash when walking.",
    });
    expect(lightUpFromColumns(columns(true, "one_works"))).toEqual({ condition: "one_works", activation: null });
    expect(lightUpFromColumns(columns(true, "not_checked", "  "))).toEqual({ condition: "not_checked", activation: null });
  });

  it("flags an unknown condition instead of guessing", () => {
    expect(lightUpFromColumns(columns(true, "mostly"))).toBeUndefined();
    expect(lightUpFromColumns(columns(true, null))).toBeUndefined();
  });

  it("works the same for new and pre-loved products (it doesn't depend on either)", () => {
    expect(lightUpFromColumns({ ...columns(true, "both_work"), item_status: "preloved" } as never)).toEqual({
      condition: "both_work",
      activation: null,
    });
  });
});
