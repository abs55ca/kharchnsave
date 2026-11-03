import { describe, expect, it } from "vitest";
import { EMPTY_PRODUCT, readProductForm, validateProduct, type ProductFormValues } from "./product-input";

const LONG_NAME = "Kids’ Navy and Grey Double-Strap Sports Trainers";

const product = (change: Partial<ProductFormValues> = {}): ProductFormValues => ({
  ...EMPTY_PRODUCT,
  name: "Canvas Sneakers",
  brand: "Unbranded",
  colour: "Navy",
  department: "kids",
  itemStatus: "new",
  condition: "new",
  price: "2500",
  autoItemCode: false,
  itemCode: "KD-1001",
  sizes: [{ size: "30", stock: "2", stockWas: "2", inventoryVersion: "4" }],
  ...change,
});

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const fieldsOf = (values: ProductFormValues, options?: { savedLabelName?: string; savedItemCode?: string }) => {
  const checked = validateProduct(values, options);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.fields;
};
const errorsOf = (values: ProductFormValues, options?: { savedLabelName?: string; savedItemCode?: string }) => {
  const checked = validateProduct(values, options);
  return checked.ok ? {} : checked.errors;
};

describe("label name", () => {
  it("is optional: blank saves as null, so labels use the product name", () => {
    expect(fieldsOf(product()).label_name).toBeNull();
  });

  it("saves a label name that fits, with spaces tidied", () => {
    const values = readProductForm(form({ name: LONG_NAME, labelName: "  Navy/Grey   Trainers " }));
    expect(values.labelName).toBe("Navy/Grey Trainers");
    expect(fieldsOf(product({ name: LONG_NAME, labelName: values.labelName })).label_name).toBe("Navy/Grey Trainers");
  });

  it("refuses a new label name that's too wide, saying so (never shortening it)", () => {
    expect(errorsOf(product({ labelName: "Navy/Grey Strap Trainers" })).labelName).toMatch(/^Too wide for the label: about 256 dots/);
  });

  it("refuses characters the printer can't print, and control characters", () => {
    expect(errorsOf(product({ labelName: "Trainers 👟" })).labelName).toContain("“👟”");
    expect(errorsOf(product({ labelName: "Trainers\u0007" })).labelName).toContain("U+0007");
    // Even when unchanged: the database refuses control characters.
    expect(errorsOf(product({ labelName: "Trainers\u0007" }), { savedLabelName: "Trainers\u0007" }).labelName).toBeDefined();
  });

  it("doesn't block other edits when the product name is too wide for the label", () => {
    const fields = fieldsOf(product({ name: LONG_NAME, description: "Changed" }));
    expect(fields.label_name).toBeNull();
    expect(fields.name).toBe(LONG_NAME);
  });

  it("doesn't block other edits when an already-saved label name no longer fits", () => {
    const saved = "Navy/Grey Strap Trainers";
    expect(fieldsOf(product({ labelName: saved, colour: "Grey" }), { savedLabelName: saved }).label_name).toBe(saved);
    // Changing it means it has to fit.
    expect(errorsOf(product({ labelName: `${saved}s` }), { savedLabelName: saved }).labelName).toMatch(/Too wide/);
  });

  it("never changes the product name or adds “Light-up” to either name", () => {
    const fields = fieldsOf(product({ name: LONG_NAME, labelName: "Navy/Grey Trainers", lightUp: "yes", lightUpCondition: "both_work" }));
    expect(fields.name).toBe(LONG_NAME);
    expect(fields.label_name).toBe("Navy/Grey Trainers");
  });
});

describe("light-up soles", () => {
  it("keeps “not recorded” (every existing product) distinct from a confirmed No", () => {
    expect(fieldsOf(product({ lightUp: "" }))).toMatchObject({ light_up: null, light_up_condition: null, light_up_activation: null });
    expect(fieldsOf(product({ lightUp: "no" }))).toMatchObject({ light_up: false, light_up_condition: null, light_up_activation: null });
  });

  it("reads a form without light-up fields (an older page) as not recorded", () => {
    expect(readProductForm(form({ name: "x" }))).toMatchObject({ lightUp: "", labelName: "" });
  });

  it("saves Yes with its condition and the admin's own activation text", () => {
    const values = readProductForm(
      form({ lightUp: "yes", lightUpCondition: "one_works", lightUpActivation: " Soles  flash when walking. " }),
    );
    expect(fieldsOf(product({ lightUp: values.lightUp, lightUpCondition: values.lightUpCondition, lightUpActivation: values.lightUpActivation }))).toMatchObject({
      light_up: true,
      light_up_condition: "one_works",
      light_up_activation: "Soles flash when walking.",
    });
  });

  it("leaves the activation empty unless the admin typed one", () => {
    expect(fieldsOf(product({ lightUp: "yes", lightUpCondition: "not_checked" })).light_up_activation).toBeNull();
  });

  it("drops the condition and activation when the answer isn't Yes", () => {
    expect(fieldsOf(product({ lightUp: "no", lightUpCondition: "both_work", lightUpActivation: "Flashes" }))).toMatchObject({
      light_up: false,
      light_up_condition: null,
      light_up_activation: null,
    });
  });

  it("requires a known condition when the answer is Yes", () => {
    const values = readProductForm(form({ lightUp: "yes", lightUpCondition: "mostly" }));
    expect(errorsOf(product({ lightUp: "yes", lightUpCondition: values.lightUpCondition })).lightUpCondition).toBe(
      "Choose whether the lights work.",
    );
  });

  it("limits the activation text", () => {
    expect(errorsOf(product({ lightUp: "yes", lightUpCondition: "both_work", lightUpActivation: "x".repeat(121) })).lightUpActivation).toBeDefined();
  });

  it("works for pre-loved pairs as well as new shoes", () => {
    const preloved = product({
      itemStatus: "preloved",
      condition: "good",
      department: "women",
      sizes: [{ size: "38", stock: "1" }],
      lightUp: "yes",
      lightUpCondition: "neither_works",
    });
    expect(fieldsOf(preloved)).toMatchObject({ item_status: "preloved", light_up: true, light_up_condition: "neither_works" });
  });
});

describe("stock is untouched by metadata edits", () => {
  it("sends each size's loaded stock and inventory version unchanged", () => {
    const checked = validateProduct(product({ labelName: "Canvas Kids", lightUp: "yes", lightUpCondition: "both_work" }));
    expect(checked.ok && checked.sizes).toEqual([{ size: 30, stock: 2, stock_was: 2, inventory_version: 4 }]);
  });
});

describe("sale price", () => {
  it("is optional: blank means no sale", () => {
    expect(fieldsOf(product({ salePrice: "" })).sale_price_paisa).toBeNull();
  });

  it("is stored as whole paisa, below the regular price", () => {
    expect(fieldsOf(product({ price: "2,500", salePrice: "1,999.50" }))).toMatchObject({ price_paisa: 250000, sale_price_paisa: 199950 });
  });

  it("must be lower than the regular price, saying what the regular price is", () => {
    expect(errorsOf(product({ price: "2500", salePrice: "2500" })).salePrice).toBe(
      "The sale price must be lower than the regular price (Rs. 2,500). Lower it, or clear it to end the sale.",
    );
    expect(errorsOf(product({ price: "2500", salePrice: "3000" })).salePrice).toMatch(/lower than the regular price/);
  });

  it("must be above zero and a valid amount", () => {
    expect(errorsOf(product({ salePrice: "0" })).salePrice).toMatch(/above zero/);
    expect(errorsOf(product({ salePrice: "abc" })).salePrice).toMatch(/Enter the sale price/);
  });

  it("is reported when the regular price is lowered below it", () => {
    expect(errorsOf(product({ price: "1500", salePrice: "2000" })).salePrice).toMatch(/Rs\. 1,500/);
  });

  it("can be cleared to end the sale", () => {
    const values = readProductForm(form({ salePrice: "   " }));
    expect(values.salePrice).toBe("");
    expect(fieldsOf(product({ salePrice: values.salePrice })).sale_price_paisa).toBeNull();
  });

  it("leaves products without a sale as before (drafts may still have no price)", () => {
    expect(errorsOf(product({ price: "0" })).salePrice).toBeUndefined();
    expect(fieldsOf(product({ price: "0" })).price_paisa).toBe(0);
  });
});

describe("item codes", () => {
  it("are assigned by the database when the Add Product box is ticked (the default)", () => {
    expect(EMPTY_PRODUCT.autoItemCode).toBe(true);
    const fields = fieldsOf(product({ autoItemCode: true, itemCode: "" }));
    expect(fields).toMatchObject({ item_code: null, auto_item_code: true });
  });

  it("is read from the form's box; saves (no box) always send their code", () => {
    expect(readProductForm(form({ autoItemCode: "on", itemCode: "" })).autoItemCode).toBe(true);
    expect(readProductForm(form({ itemCode: "kd-1001" }))).toMatchObject({ autoItemCode: false, itemCode: "KD-1001" });
  });

  it("can be typed instead, with the usual rules", () => {
    expect(fieldsOf(product({ itemCode: "PL-M-1001" }))).toMatchObject({ item_code: "PL-M-1001", auto_item_code: false });
    expect(errorsOf(product({ itemCode: "" })).itemCode).toBe("Enter an item code, e.g. PL-M-1001.");
    expect(errorsOf(product({ itemCode: "KNS00000013" })).itemCode).toMatch(/look like a barcode/);
  });

  it("can't take the automatic form when typed", () => {
    expect(errorsOf(product({ itemCode: "ITEM-000123" })).itemCode).toMatch(/assigned automatically/);
  });

  it("keep their assigned automatic code on later saves", () => {
    expect(fieldsOf(product({ itemCode: "ITEM-000123" }), { savedItemCode: "ITEM-000123" }).item_code).toBe("ITEM-000123");
    expect(errorsOf(product({ itemCode: "ITEM-000124" }), { savedItemCode: "ITEM-000123" }).itemCode).toMatch(/assigned automatically/);
  });
});
