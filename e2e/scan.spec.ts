import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { totp } from "./totp";

/*
 * The admin Scan page and label download, as the shop uses them. Read-only:
 * these tests sign in and look things up, and change no data. Needs the local
 * set-up described in playwright.config.ts (dev fixtures + e2e/fixtures.sql).
 */

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";
const TOTP_SECRET = process.env.E2E_ADMIN_TOTP_SECRET ?? "";

test.skip(!EMAIL || !PASSWORD || !TOTP_SECRET, "Set E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET (local Supabase only).");

const BOX = "Barcode, item code or SKU";

/** Types like the barcode scanner in keyboard mode: fast keystrokes, then Enter. */
async function scan(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

async function scanAndWait(page: Page, text: string, expected: string | RegExp) {
  await scan(page, text);
  await expect(page.getByLabel(BOX)).toHaveValue("");
  // This scan's own result, not the previous one still on screen.
  await page.waitForURL((url) => url.searchParams.get("code") === text);
  await expect(page.locator("main")).toContainText(expected);
}

async function barcodeOf(page: Page, itemCode: string, size: string) {
  await scanAndWait(page, itemCode, "Found by item code");
  const row = page.getByRole("row").filter({ hasText: `EU ${size}` }).first();
  const barcode = (await row.textContent())?.match(/U\d{8}/)?.[0];
  expect(barcode, `barcode of ${itemCode} EU ${size}`).toBeTruthy();
  return barcode!;
}

test.describe("signed out", () => {
  test("the scan page and label files need an admin", async ({ page, request }) => {
    await page.goto("/admin/scan?code=U00000013");
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fscan/);

    const file = await request.get("/admin/labels/calibration", { maxRedirects: 0 });
    expect([302, 303, 307, 401]).toContain(file.status());
    expect(await file.text()).not.toContain("^XA");
  });
});

test.describe.serial("verified admin", () => {
  let page: Page;
  const codes: Record<string, string> = {};

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto("/admin/login?next=%2Fadmin%2Fscan");
    await page.getByLabel("Email address").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/mfa/);

    // A password-only session can't scan.
    await page.goto("/admin/scan");
    await expect(page).toHaveURL(/\/admin\/mfa/);

    await page.getByLabel("6-digit code").fill(totp(TOTP_SECRET));
    await page.getByLabel("6-digit code").press("Enter");
    await expect(page).toHaveURL(/\/admin\/scan$/);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("the scan box is ready as soon as the page opens", async () => {
    await expect(page.getByLabel(BOX)).toBeFocused();
  });

  test("an item code lists every size with its barcode", async () => {
    await scanAndWait(page, "dev-nw-k-3001", "Found by item code");
    const rows = page.getByRole("row").filter({ hasText: /EU \d+/ });
    await expect(rows).toHaveCount(4);
    for (const size of ["18", "19"]) codes[size] = await barcodeOf(page, "DEV-NW-K-3001", size);
    expect(codes["18"]).not.toBe(codes["19"]);
    await expect(page.getByLabel(BOX)).toBeFocused();
  });

  test("a barcode shows the size, price, stock and status", async () => {
    await scanAndWait(page, codes["18"], "EU 18");
    const result = page.getByRole("article", { name: "Scan result" });
    await expect(result).toContainText("Rs. 2,450");
    await expect(result).toContainText(codes["18"]);
    await expect(result).toContainText("Published and in stock.");
    await expect(result.getByText("3", { exact: true })).toBeVisible();
    await expect(page.getByLabel(BOX)).toBeFocused();
  });

  test("out of stock, sold, draft and archived are spelled out", async () => {
    await scanAndWait(page, codes["19"], "Out of stock.");

    const preloved = await barcodeOf(page, "DEV-PL-M-1001", "43");
    await scanAndWait(page, preloved, "Published and in stock.");
    await expect(page.getByRole("article", { name: "Scan result" })).toContainText("1 (for sale)");

    const draft = await barcodeOf(page, "DEV-PL-M-1002", "42");
    await scanAndWait(page, draft, "Draft.");

    const archived = await barcodeOf(page, "E2E-ARCHIVED", "41");
    await scanAndWait(page, archived, "Archived.");
  });

  test("typos, unknown codes and odd text get clear messages", async () => {
    const typo = `${codes["18"].slice(0, 8)}${(Number(codes["18"][8]) + 1) % 10}`;
    await scanAndWait(page, typo, "Check that code");
    await scanAndWait(page, "U99999992", "Nothing found");
    await scanAndWait(page, "4006381333931", "manufacturer’s barcode");
    await scanAndWait(page, "NO-SUCH-CODE", "Search products for");
    await scanAndWait(page, "PL_M'1001", "That isn’t a code we use");
  });

  test("lowercase and spaces are ignored; an SKU works too", async () => {
    await scanAndWait(page, ` ${codes["18"].toLowerCase().slice(0, 5)} ${codes["18"].slice(5)} `, "EU 18");
    await scanAndWait(page, "DEV-NW-K-3001-20", "Found by");
  });

  test("two quick scans: the second one wins", async () => {
    await scan(page, codes["19"]);
    await scan(page, codes["18"]);
    const result = page.getByRole("article", { name: "Scan result" });
    await expect(result).toContainText("EU 18");
    await expect(page).toHaveURL(new RegExp(`code=${codes["18"]}$`));
  });

  test("scanning never changes stock", async () => {
    for (let i = 0; i < 3; i++) await scanAndWait(page, codes["18"], "EU 18");
    await scanAndWait(page, "DEV-NW-K-3001", "Found by item code");
    const row = page.getByRole("row").filter({ hasText: "EU 18" }).first();
    await expect(row.getByRole("cell").nth(1)).toHaveText("3");
  });

  test("Print label: quantity defaults to the stock, and the file is right", async () => {
    await scanAndWait(page, codes["18"], "EU 18");
    await page.getByRole("link", { name: "Print label" }).click();
    await expect(page).toHaveURL(/\/labels\?size=18$/);
    await expect(page.getByLabel("EU 18")).toHaveValue("3");
    await expect(page.getByLabel("ZPL")).toHaveValue(/\^LT20\n\^PR4[\s\S]*\^FD>:U>5\d{8}\^FS[\s\S]*\^PQ3,0,1,N/);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .zpl" }).click()]);
    expect(download.suggestedFilename()).toBe(`${codes["18"]}-x3.zpl`);
    const zpl = readFileSync((await download.path())!, "utf8");
    expect(zpl).toContain(`^FD${codes["18"]}^FS`);
    expect(zpl).not.toMatch(/kharch|Rs\./i);

    const response = await page.request.get(new URL(download.url()).pathname + new URL(download.url()).search);
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("the shop never shows barcodes", async () => {
    const response = await page.request.get("/products/dev-baby-canvas-sneakers-teal-print");
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain(codes["18"]);
  });
});
