import { describe, expect, it } from "vitest";
import { kidsAgeLabel } from "./sizes";

describe("kidsAgeLabel", () => {
  it("gives a typical age for one kids' size", () => {
    expect(kidsAgeLabel([30])).toBe("Age 5");
    expect(kidsAgeLabel([27])).toBe("Age 3–4");
    expect(kidsAgeLabel([35])).toBe("Age 9–10");
    expect(kidsAgeLabel([22])).toBe("18–24 months");
    expect(kidsAgeLabel([18])).toBe("6–12 months");
  });

  it("spans several sizes, smallest to largest", () => {
    expect(kidsAgeLabel([28, 30])).toBe("Age 4–5");
    expect(kidsAgeLabel([21, 25])).toBe("18 months–3 yrs");
  });

  it("treats a half size as the whole size below, and gives null off the table", () => {
    expect(kidsAgeLabel([30.5])).toBe("Age 5");
    expect(kidsAgeLabel([42])).toBeNull();
    expect(kidsAgeLabel([])).toBeNull();
  });
});
