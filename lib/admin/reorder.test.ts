import { describe, expect, it } from "vitest";
import { moveItem } from "./reorder";

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an item later or earlier, keeping the others in order", () => {
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns a new array and never changes the original", () => {
    const moved = moveItem(list, 0, 1);
    expect(moved).not.toBe(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a move to the same place or out of range", () => {
    expect(moveItem(list, 2, 2)).toEqual(list);
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 1, 4)).toEqual(list);
  });
});
