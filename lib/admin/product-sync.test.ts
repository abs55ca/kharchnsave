import { describe, expect, it } from "vitest";
import { onServerCopy, productFingerprint } from "./product-sync";

const sizes = [
  { size: "41", sku: "KNS-1-41", stock: "1", stockWas: "1", inventoryVersion: "3" },
  { size: "42", sku: "KNS-1-42", stock: "2", stockWas: "2", inventoryVersion: "5" },
];
const opened = productFingerprint(7, sizes);

describe("product edit page: a newer server copy", () => {
  it("an order elsewhere changed a size's stock (inventory version): shown when there are no unsaved changes", () => {
    const afterReturn = productFingerprint(7, [sizes[0], { ...sizes[1], stockWas: "3", inventoryVersion: "6" }]);
    expect(afterReturn).not.toBe(opened);
    expect(onServerCopy({ server: afterReturn, baseline: opened, dirty: false, saving: false })).toBe("adopt");
  });

  it("with unsaved changes or a save in flight, the edits and their original baseline are kept", () => {
    const afterOrder = productFingerprint(7, [{ ...sizes[0], inventoryVersion: "4" }, sizes[1]]);
    expect(onServerCopy({ server: afterOrder, baseline: opened, dirty: true, saving: false })).toBe("hold");
    expect(onServerCopy({ server: afterOrder, baseline: opened, dirty: false, saving: true })).toBe("hold");
  });

  it("a product edit elsewhere (version) counts too", () => {
    expect(onServerCopy({ server: productFingerprint(8, sizes), baseline: opened, dirty: true, saving: false })).toBe("hold");
  });

  it("the copy the editor already has (its own save or photo upload) changes nothing, even with new edits", () => {
    const ownSave = productFingerprint(8, sizes);
    expect(onServerCopy({ server: ownSave, baseline: productFingerprint(8, sizes), dirty: true, saving: false })).toBe("in-sync");
  });

  it("ignores stock typed into the form: only the server's versions count", () => {
    expect(productFingerprint(7, [{ ...sizes[0], stock: "0" }, sizes[1]])).toBe(opened);
  });
});
