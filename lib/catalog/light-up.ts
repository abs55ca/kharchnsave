/*
 * Light-up soles: what the admin records and what the shop says about it.
 * Stored on products (supabase/migrations/20261101120000_label_names_and_light_up.sql):
 * light_up null = not recorded, false = no, true = yes with a condition.
 * The shop shows the "Light-up" badge only when both shoes were checked and
 * work; any other condition is stated plainly on the product page, and
 * nothing implies untested lights work.
 */

export type LightUpCondition = "not_checked" | "both_work" | "one_works" | "neither_works";

export const LIGHT_UP_CONDITIONS: { value: LightUpCondition; label: string }[] = [
  { value: "not_checked", label: "Not checked" },
  { value: "both_work", label: "Both shoes work" },
  { value: "one_works", label: "One shoe works" },
  { value: "neither_works", label: "Neither works" },
];

export const LIGHT_UP_CONDITION_VALUES = LIGHT_UP_CONDITIONS.map((c) => c.value);

/** Light-up soles on a shop product; null when it has none or it isn't recorded. */
export type LightUp = {
  condition: LightUpCondition;
  /** How the lights activate, as the admin wrote it, e.g. "Soles flash when walking." */
  activation: string | null;
};

export const ACTIVATION_MAX = 120;

/**
 * The shop's view of the database columns: only a recorded "yes" is shown
 * ("no" and "not recorded" show nothing). Undefined if the condition is
 * unknown (the database's constraints make that impossible).
 */
export function lightUpFromColumns(row: {
  light_up: boolean | null;
  light_up_condition: string | null;
  light_up_activation: string | null;
}): LightUp | null | undefined {
  if (row.light_up !== true) return null;
  const condition = LIGHT_UP_CONDITION_VALUES.find((value) => value === row.light_up_condition);
  if (!condition) return undefined;
  return { condition, activation: row.light_up_activation?.trim() || null };
}

/** The "Light-up" badge: only when both shoes were checked and their lights work. */
export function showsLightUpBadge(lightUp: LightUp | null) {
  return lightUp?.condition === "both_work";
}

/** What the product page says, for every light-up product. */
export function lightUpDisclosure(lightUp: LightUp) {
  switch (lightUp.condition) {
    case "both_work":
      return {
        short: "Lights work",
        text: "Light-up soles. We checked both shoes and the lights work.",
        activationLabel: "How the lights activate",
        warning: false,
      };
    case "one_works":
      return {
        short: "Lights work in one shoe only",
        text: "Light-up soles, but the lights work in only one shoe.",
        activationLabel: "How the lights are meant to activate",
        warning: true,
      };
    case "neither_works":
      return {
        short: "Lights don’t work",
        text: "Light-up soles, but the lights don’t work in either shoe.",
        activationLabel: "How the lights are meant to activate",
        warning: true,
      };
    case "not_checked":
      return {
        short: "Lights not tested",
        text: "Light-up soles. Lights not tested: we haven’t checked whether they work.",
        activationLabel: "How the lights are meant to activate",
        warning: true,
      };
  }
}
