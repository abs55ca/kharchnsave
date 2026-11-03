import { describe, expect, it } from "vitest";
import {
  LABEL_NAME_MAX_CHARS,
  labelNameFor,
  measureLabelName,
  NAME_BOX_DOTS,
  NAME_MAX_DOTS,
  printedText,
  tidyLabelName,
} from "./name-fit";

const WEBSITE_NAME = "Kids’ Navy and Grey Double-Strap Sports Trainers";

describe("which name is printed", () => {
  it("uses the full product name when the label name is blank, if it fits", () => {
    for (const labelName of [null, undefined, "", "   "]) {
      expect(labelNameFor({ labelName, name: "Canvas Sneakers" })).toMatchObject({
        source: "product-name",
        text: "Canvas Sneakers",
        fits: true,
        problem: null,
      });
    }
  });

  it("never prints the brand: only the label name or the product name", () => {
    expect(labelNameFor({ labelName: null, name: "Air Max 90" }).text).toBe("Air Max 90");
  });

  it("asks for a shorter label name when the product name doesn't fit, instead of cutting it", () => {
    const name = labelNameFor({ labelName: "", name: WEBSITE_NAME });
    expect(name.source).toBe("product-name");
    expect(name.fits).toBe(false);
    expect(name.text).toBe("Kids' Navy and Grey Double-Strap Sports Trainers");
    expect(name.problem).toMatch(/^The product name is too wide for the label \(about \d+ dots; there’s room for 224\)\. Add a shorter label name before printing\.$/);
  });

  it("uses the label name instead, when there is one", () => {
    expect(labelNameFor({ labelName: "Navy/Grey Trainers", name: WEBSITE_NAME })).toMatchObject({
      source: "label-name",
      text: "Navy/Grey Trainers",
      fits: true,
      problem: null,
    });
  });

  it("refuses a label name that's too wide, saying by how much", () => {
    // The example from the brief measures about 256 dots: too wide.
    const name = labelNameFor({ labelName: "Navy/Grey Strap Trainers", name: WEBSITE_NAME });
    expect(name).toMatchObject({ source: "label-name", fits: false, widthDots: 256 });
    expect(name.problem).toBe("Too wide for the label: about 256 dots, and there’s room for 224. Shorten the label name.");
  });

  it("lets the owner put Light-up in the label name, and never adds it", () => {
    expect(labelNameFor({ labelName: "Light-up Trainers", name: WEBSITE_NAME })).toMatchObject({ text: "Light-up Trainers", fits: true });
    expect(labelNameFor({ labelName: null, name: "Pink Trainers" }).text).toBe("Pink Trainers");
  });
});

describe("rendered width, not character count", () => {
  it("measures the reference that printed on one line at about 213 dots", () => {
    expect(measureLabelName("New Balance 574 Wh")).toMatchObject({ widthDots: 213, fits: true });
  });

  it("fits more narrow characters than wide ones", () => {
    expect(measureLabelName("W".repeat(11))).toMatchObject({ widthDots: 222, fits: true });
    expect(measureLabelName("W".repeat(12)).fits).toBe(false);
    expect(measureLabelName("i".repeat(37)).fits).toBe(true);
    expect(measureLabelName("i".repeat(38)).fits).toBe(false);
    // Same length, very different widths.
    expect(measureLabelName("MMMMMMMM").widthDots).toBeGreaterThan(2.5 * measureLabelName("iiiiiiii").widthDots);
  });

  it("keeps a margin inside the 228-dot box", () => {
    expect(NAME_BOX_DOTS).toBe(228);
    expect(NAME_MAX_DOTS).toBe(224);
    expect(measureLabelName("Écru Navy Trainers 31")).toMatchObject({ widthDots: 224, fits: true });
    expect(measureLabelName("Écru Kids' Trainers 31")).toMatchObject({ widthDots: 225, fits: false });
  });

  it("measures accented letters as letters", () => {
    expect(measureLabelName("Café Crème").widthDots).toBe(measureLabelName("Cafe Creme").widthDots);
  });

  it(`can never be longer than ${LABEL_NAME_MAX_CHARS} characters and still fit`, () => {
    expect(measureLabelName("i".repeat(LABEL_NAME_MAX_CHARS)).fits).toBe(false);
  });
});

describe("characters", () => {
  it("prints typographic punctuation as the plain character, and says so through the printed text", () => {
    expect(printedText("Kids’ “Star” Trainers – Navy…")).toBe(`Kids' "Star" Trainers - Navy...`);
  });

  it("tidies spaces, tabs and line breaks into single spaces", () => {
    expect(tidyLabelName("  Navy \t Grey\n Trainers ")).toBe("Navy Grey Trainers");
    expect(printedText("Navy Grey")).toBe("Navy Grey");
  });

  it("names characters the printer can't print, rather than dropping them", () => {
    expect(labelNameFor({ labelName: "Shoe 👟", name: "x" }).problem).toBe(
      "The label printer can’t print “👟”. Remove it from the label name.",
    );
    expect(labelNameFor({ labelName: "Ω × 2", name: "x" }).problem).toBe(
      "The label printer can’t print “Ω” and “×”. Remove them from the label name.",
    );
    expect(labelNameFor({ labelName: null, name: "Trainers ✓" }).problem).toBe(
      "The label printer can’t print “✓” in the product name. Add a label name without it.",
    );
  });

  it("names control characters by their code", () => {
    const name = labelNameFor({ labelName: "Shoe\u0007\u001b", name: "x" });
    expect(name.fits).toBe(false);
    expect(name.unsupported).toEqual(["U+0007", "U+001B"]);
    expect(name.problem).toContain("U+0007 and U+001B");
  });

  it("accepts ZPL's own command characters (they're escaped when printed)", () => {
    expect(measureLabelName("A^B~C\\D_E").fits).toBe(true);
  });
});
