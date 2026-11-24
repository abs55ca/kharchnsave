import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";

/*
 * Reordering a product's photos by dragging (components/admin/product-editor.tsx):
 * mouse, Escape to cancel, and touch (only from the ⠿ handle, so swiping over
 * a photo still scrolls), and flipping an uploaded photo. Against a real
 * PostgreSQL database through the local stand-in for Supabase's HTTP API and
 * Storage (scripts/e2e-checkout-local.mjs); skipped otherwise.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");
test.describe.configure({ mode: "serial" });

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const code = `E2E-PHO-${randomBytes(3).toString("hex").toUpperCase()}`;
let productId = "";

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function adminToken(ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: ADMIN_ID, email: "e2e-admin@test.invalid", role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID(), iat: now - 60, exp: now + ttl });
  return `${header}.${payload}.${createHmac("sha256", process.env.E2E_AUTH_SECRET!).update(`${header}.${payload}`).digest("base64url")}`;
}

/** Whether the stand-in's Storage holds a product photo (asked as the admin). */
async function storedFile(path: string) {
  const res = await fetch(`${process.env.E2E_SUPABASE_URL}/storage/v1/object/product-photos/${path}`, { headers: { authorization: `Bearer ${adminToken()}` } });
  return res.ok;
}

/** Red on the left half, blue on the right. */
async function redBluePng() {
  const half = (r: number, b: number) => sharp({ create: { width: 400, height: 500, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  return sharp({ create: { width: 800, height: 500, channels: 3, background: "#000" } })
    .composite([{ input: await half(255, 0), left: 0, top: 0 }, { input: await half(0, 255), left: 400, top: 0 }])
    .png()
    .toBuffer();
}

async function leftColour(image: Buffer) {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 8)) * info.channels;
  return data[i] > 200 && data[i + 2] < 60 ? "red" : data[i + 2] > 200 && data[i] < 60 ? "blue" : "other";
}

async function signInAdmin(context: BrowserContext, base: string, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: ADMIN_ID, email: "e2e-admin@test.invalid", role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID(), iat: now - 60, exp: now + ttl });
  const token = `${header}.${payload}.${createHmac("sha256", process.env.E2E_AUTH_SECRET!).update(`${header}.${payload}`).digest("base64url")}`;
  const session = { access_token: token, token_type: "bearer", expires_in: ttl, expires_at: now + ttl, refresh_token: "none", user: { id: ADMIN_ID, email: "e2e-admin@test.invalid" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64url(session)}`, url: `${base}/admin`, httpOnly: true, sameSite: "Lax" }]);
}

/** The visible photo grid (the page also streams a hidden copy, as e2e/referrals-local.spec.ts notes). */
const grid = (page: Page) => page.locator("ol").filter({ has: page.getByText("Main photo") }).filter({ visible: true }).first();
/** The photos' descriptions, in the order shown. */
const shown = (page: Page) => grid(page).getByLabel("Description for screen readers").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
const stored = async () =>
  (await db!.query<{ alt: string }>("select alt from public.product_images where product_id = $1 order by sort_order", [productId])).rows.map((r) => r.alt);
const photo = (page: Page, n: number) => grid(page).locator("> li").nth(n).locator("div.aspect-square");

async function centre(page: Page, n: number) {
  const box = (await photo(page, n).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.beforeAll(async () => {
  if (!db) return;
  const image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  await db.query(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status)
    values ($1, lower($1), 'Photo Order Sneakers', 'Testbrand', 'kids', '{sneakers}', 'new', 'new', 'Pink', 'Test', 150000, 'draft')`, [code]);
  productId = (await db.query<{ id: string }>("select id from public.products where item_code = $1", [code])).rows[0].id;
  await db.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock) values ($1, 'new', $2 || '-30', 30, 1)`, [productId, code]);
  for (const [i, alt] of ["Photo A", "Photo B", "Photo C", "Photo D"].entries()) {
    await db.query("insert into public.product_images (product_id, src, alt, width, height, sort_order) values ($1, $2, $3, 800, 800, $4)", [productId, image, alt, i]);
  }
});
test.afterAll(async () => {
  await db?.end();
});

test("a mouse drags a photo into place, Escape cancels a drag, and the order is saved", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  await page.goto(`/admin/products/${productId}`);
  await expect(page.getByText(/Drag a photo to change the order/).filter({ visible: true }).first()).toBeVisible();
  expect(await shown(page)).toEqual(["Photo A", "Photo B", "Photo C", "Photo D"]);

  // Photo C onto the main photo's place.
  await photo(page, 2).scrollIntoViewIfNeeded();
  const from = await centre(page, 2);
  const to = await centre(page, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo B", "Photo D"]);
  await expect(grid(page).locator("> li").first().getByText("Main photo")).toBeVisible();

  // A drag cancelled with Escape puts it back.
  const a = await centre(page, 1);
  const d = await centre(page, 3);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(d.x, d.y, { steps: 12 });
  expect(await shown(page)).toEqual(["Photo C", "Photo B", "Photo D", "Photo A"]);
  await page.keyboard.press("Escape");
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo B", "Photo D"]);
  await page.mouse.up();
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo B", "Photo D"]);

  // A plain click on a photo isn't a drag.
  await page.mouse.click(a.x, a.y);
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo B", "Photo D"]);

  // The buttons still work too.
  await grid(page).getByRole("button", { name: "Move photo 4 earlier" }).click();
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo D", "Photo B"]);

  expect(await stored()).toEqual(["Photo A", "Photo B", "Photo C", "Photo D"]);
  await page.getByRole("button", { name: "Save changes" }).filter({ visible: true }).first().click();
  await expect(page.getByText("Saved.", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect.poll(stored).toEqual(["Photo C", "Photo A", "Photo D", "Photo B"]);
  await context.close();
});

test("on a phone, swiping over a photo scrolls; dragging its handle moves it", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  await page.goto(`/admin/products/${productId}`);
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo D", "Photo B"]);
  const cdp = await context.newCDPSession(page);
  const touch = async (points: { x: number; y: number }[]) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]] });
    for (const p of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const path = (a: { x: number; y: number }, b: { x: number; y: number }, steps = 15) =>
    Array.from({ length: steps + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }));

  // Swipe up over the second photo: the page scrolls, nothing moves.
  await photo(page, 1).scrollIntoViewIfNeeded();
  const body = await centre(page, 1);
  const scrolled = await page.evaluate(() => window.scrollY);
  await touch(path(body, { x: body.x, y: body.y - 250 }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled);
  expect(await shown(page)).toEqual(["Photo C", "Photo A", "Photo D", "Photo B"]);

  // Drag the second photo's handle (scrolled to mid-screen, clear of the fixed save bar) up onto the first photo's card.
  const before = (await photo(page, 1).locator("[data-drag-handle]").boundingBox())!;
  await page.evaluate((dy) => window.scrollBy(0, dy), before.y - 350);
  const handle = (await photo(page, 1).locator("[data-drag-handle]").boundingBox())!;
  const first = (await grid(page).locator("> li").first().boundingBox())!;
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const target = { x: first.x + first.width / 2, y: first.y + first.height - 30 };
  expect(target.y).toBeGreaterThan(80); // in view, and away from the top edge (which scrolls)
  await touch(path(start, target, 25));
  expect(await shown(page)).toEqual(["Photo A", "Photo C", "Photo D", "Photo B"]);
  await context.close();
});

test("an uploaded photo is flipped left to right; saving keeps the flipped copy and removes the original", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  await page.goto(`/admin/products/${productId}`);
  // Site images have nothing stored to mirror.
  await expect(grid(page).getByRole("button", { name: /^Flip photo/ })).toHaveCount(0);

  await page.getByLabel("Add photos").filter({ visible: true }).first().setInputFiles({ name: "red-blue.png", mimeType: "image/png", buffer: await redBluePng() });
  await expect(page.getByText("1 photo added.", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  expect(await shown(page)).toHaveLength(5);
  const fifth = grid(page).locator("> li").nth(4);
  const originalSrc = (await fifth.locator("img").getAttribute("src"))!;
  const originalId = /photos\/([0-9a-f-]{36})/.exec(originalSrc)![1];
  expect(await leftColour(await (await page.request.get(originalSrc)).body())).toBe("red");
  await fifth.getByLabel("Description for screen readers").fill("Red and blue test photo");

  await fifth.getByRole("button", { name: "Flip photo 5 left to right" }).click();
  await expect(page.getByText("Photo 5 flipped.", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  const flippedSrc = (await grid(page).locator("> li").nth(4).locator("img").getAttribute("src"))!;
  const flippedId = /photos\/([0-9a-f-]{36})/.exec(flippedSrc)![1];
  expect(flippedId).not.toBe(originalId);
  expect(await leftColour(await (await page.request.get(flippedSrc)).body())).toBe("blue");
  // Same place, and what was typed is kept.
  expect((await shown(page))[4]).toBe("Red and blue test photo");

  // Until saved, both are stored; saving drops the original (row and file).
  expect(await storedFile(`${productId}/${originalId}.webp`)).toBe(true);
  await page.getByRole("button", { name: "Save changes" }).filter({ visible: true }).first().click();
  await expect(page.getByText("Saved.", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const rows = (await db!.query<{ id: string; alt: string }>("select id, alt from public.product_images where product_id = $1 order by sort_order", [productId])).rows;
  expect(rows).toHaveLength(5);
  expect(rows[4]).toEqual({ id: flippedId, alt: "Red and blue test photo" });
  expect(rows.some((r) => r.id === originalId)).toBe(false);
  expect(await storedFile(`${productId}/${flippedId}.webp`)).toBe(true);
  expect(await storedFile(`${productId}/${originalId}.webp`)).toBe(false);
  await context.close();
});

test("light-up soles: choosing Yes and saving records both shoes working (no extra fields)", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  await page.goto(`/admin/products/${productId}`);
  const section = page.locator("fieldset").filter({ hasText: "Light-up soles?" }).filter({ visible: true }).first();
  await expect(section.getByText("choose Yes only after checking that both shoes light up", { exact: false })).toBeVisible();
  await section.getByLabel("Yes").check();
  await expect(page.getByText("Do the lights work?")).toHaveCount(0);
  await expect(page.getByText("How the lights activate")).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes" }).filter({ visible: true }).first().click();
  await expect(page.getByText("Saved.", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const row = (await db!.query("select light_up, light_up_condition, light_up_activation from public.products where id = $1", [productId])).rows[0];
  expect(row).toEqual({ light_up: true, light_up_condition: "both_work", light_up_activation: null });
  await context.close();
});
