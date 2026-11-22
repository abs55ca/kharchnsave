import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * Score pricing and sales end to end: the real admin Pricing and Sales pages
 * and the shop's product page, against a real PostgreSQL database with every
 * migration applied, through the local stand-in for Supabase's HTTP API
 * (scripts/e2e-checkout-local.mjs). Skipped otherwise.
 *
 * Not tested here: real Supabase (PostgREST, Auth, pg_cron) or a hosted
 * cache/CDN. The admin is signed in with a stand-in aal2 session.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");
test.describe.configure({ mode: "serial" });

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const suffix = randomBytes(3).toString("hex").toUpperCase();
const GROUP = `E2E group ${suffix}`;
const SALE = `E2E sale ${suffix}`;
const shoe = { code: `E2E-PRC-${suffix}`, id: "", slug: "" };
const fresh = { code: `E2E-NEW-${suffix}`, slug: "" };
let image = "";
let adminPage: Page;

/** The page streams a hidden copy of some content; tests use the visible one (as e2e/referrals-local.spec.ts does). */
const vis = (l: Locator) => l.filter({ visible: true }).first();

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function signInAdmin(context: BrowserContext, base: string, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: ADMIN_ID, email: "e2e-admin@test.invalid", role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID(), iat: now - 60, exp: now + ttl });
  const token = `${header}.${payload}.${createHmac("sha256", process.env.E2E_AUTH_SECRET!).update(`${header}.${payload}`).digest("base64url")}`;
  const session = { access_token: token, token_type: "bearer", expires_in: ttl, expires_at: now + ttl, refresh_token: "none", user: { id: ADMIN_ID, email: "e2e-admin@test.invalid" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64url(session)}`, url: `${base}/admin`, httpOnly: true, sameSite: "Lax" }]);
}

async function insertProduct(code: string, price: number, sale: number | null) {
  await db!.query(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, sale_price_paisa, publication_status, listed_at)
    values ($1, lower($1), 'Pricing Sneakers ' || $1, 'Testbrand', 'women', '{sneakers}', 'new', 'new', 'Red', 'Test', $2, $3, 'draft', current_date)`, [code, price, sale]);
  await db!.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, $1 || '-38', 38, 4 from public.products where item_code = $1`, [code]);
  await db!.query(`insert into public.product_images (product_id, src, alt, width, height)
    select id, $2, 'Test', 800, 800 from public.products where item_code = $1`, [code, image]);
  await db!.query("update public.products set publication_status = 'published' where item_code = $1", [code]);
  return (await db!.query<{ id: string; slug: string }>("select id, slug from public.products where item_code = $1", [code])).rows[0];
}

const prices = async () =>
  (await db!.query<{ price_paisa: number; sale_price_paisa: number | null; reference_price_paisa: number | null }>(
    "select price_paisa, sale_price_paisa, reference_price_paisa from public.products where id = $1", [shoe.id])).rows[0];

/** Loses the answer to the next form submission on these pages, after the server applied it. */
async function loseNextAnswer(page: Page, pattern: string) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.fetch();
      await route.abort("connectionreset");
    } else {
      await route.continue();
    }
  });
}

/**
 * Loads a shop page until it shows `text` (and not `gone`), at most 5 times, 1 s apart.
 * Returns how many loads it took; fails if the shop never catches up.
 */
async function loadsUntil(page: Page, url: string, text: string, gone?: string) {
  for (let load = 1; load <= 5; load++) {
    await page.goto(url);
    const shown = await page.getByText(text).filter({ visible: true }).count();
    const stale = gone ? await page.getByText(gone).filter({ visible: true }).count() : 0;
    if (shown > 0 && stale === 0) return load;
    await page.waitForTimeout(1000);
  }
  throw new Error(`${url} never showed "${text}"${gone ? ` without "${gone}"` : ""}`);
}

test.beforeAll(async () => {
  if (!db) return;
  image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  Object.assign(shoe, await insertProduct(shoe.code, 300000, null));
  // A new listing that arrives already on sale: no price history, so no "was" price.
  Object.assign(fresh, await insertProduct(fresh.code, 250000, 199500));
  // Any open-ended sale left running by an earlier run of this file.
  await db.query("update private.sale_campaigns set ends_at = now() - interval '1 second' where status = 'active' and ends_at is null");
  await db.query("select private.run_sale_schedule()");
});
test.afterAll(async () => {
  await db?.end();
});

test("an admin scores products in bulk, previews and confirms; a lost answer is retried once; a new maximum reprices", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } }); // a phone
  await signInAdmin(context, baseURL!);
  adminPage = await context.newPage();
  adminPage.on("dialog", (dialog) => void dialog.accept());
  await adminPage.goto("/admin/pricing");
  await expect(vis(adminPage.getByRole("heading", { name: "Pricing", exact: true }))).toBeVisible();

  await vis(adminPage.getByLabel("New group name")).fill(GROUP);
  await vis(adminPage.getByLabel("Maximum (Rs.)")).fill("5000");
  await vis(adminPage.getByRole("button", { name: "Create", exact: true })).click();
  await expect(vis(adminPage.getByText("Group created."))).toBeVisible();

  await adminPage.goto(`/admin/pricing?q=${encodeURIComponent(shoe.code)}`);
  await vis(adminPage.getByRole("checkbox", { name: new RegExp(shoe.code) })).check();
  await vis(adminPage.getByLabel("Pricing group")).selectOption({ label: `${GROUP} (max Rs. 5,000)` });
  await vis(adminPage.locator("#bulk-score")).fill("50");
  // The instant estimate, before anything is saved.
  await expect(vis(adminPage.getByText("Rs. 2,495", { exact: true }))).toBeVisible();
  await vis(adminPage.getByRole("button", { name: "Preview", exact: true })).click();
  const preview = vis(adminPage.getByRole("region", { name: "Pricing preview" }));
  await expect(vis(preview.getByText("Price changes"))).toBeVisible();
  expect((await prices()).price_paisa).toBe(300000);

  // The answer to the confirmation is lost after the database applied it.
  await loseNextAnswer(adminPage, "**/admin/pricing**");
  await vis(preview.getByRole("button", { name: "Confirm and apply" })).click();
  await expect(vis(preview.getByText(/No answer, so we can’t tell whether this was saved/))).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  await vis(preview.getByRole("button", { name: "Retry unconfirmed save" })).click();
  await expect(vis(preview.getByText("Already done earlier. Applied to 1 product(s)."))).toBeVisible();
  expect((await prices()).price_paisa).toBe(249500);
  const applied = await db!.query("select count(*)::int n from private.price_history where product_id = $1 and reason = 'score_pricing'", [shoe.id]);
  expect(applied.rows[0].n).toBe(1);

  // A new maximum: previewed, then confirmed.
  await adminPage.goto(`/admin/pricing?q=${encodeURIComponent(shoe.code)}`);
  const row = vis(adminPage.locator("li").filter({ hasText: GROUP }).filter({ has: adminPage.getByLabel("New maximum (Rs.)") }));
  await vis(row.getByLabel("New maximum (Rs.)")).fill("4000");
  await vis(adminPage.getByRole("button", { name: "Preview new maximums" })).click();
  const reprice = vis(adminPage.getByRole("region", { name: "Repricing preview" }));
  await expect(vis(reprice.getByText(`${GROUP}: Rs. 5,000 → Rs. 4,000`))).toBeVisible();
  await vis(reprice.getByRole("button", { name: "Confirm and reprice" })).click();
  await expect(vis(reprice.getByText("Repriced 1 product(s)."))).toBeVisible();
  expect((await prices()).price_paisa).toBe(199500);
});

test("a sale is created, its products chosen, previewed and started; the shop shows only supported discounts; ending restores prices", async ({ page }) => {
  await adminPage.goto("/admin/sales");
  await expect(vis(adminPage.getByRole("heading", { name: "Sales", exact: true }))).toBeVisible();
  await vis(adminPage.getByLabel("Name", { exact: true })).fill(SALE);
  await vis(adminPage.getByLabel("Discount (%)")).fill("20");
  await vis(adminPage.getByRole("button", { name: "Create draft sale" })).click();
  await adminPage.waitForURL(/\/admin\/sales\/[0-9a-f-]{36}$/);

  const item = vis(adminPage.locator("li").filter({ hasText: shoe.code }).filter({ has: adminPage.getByRole("radio", { name: "On sale" }) }));
  await vis(item.getByRole("radio", { name: "On sale" })).check();
  await vis(adminPage.getByRole("button", { name: "Save selection (1 change)" })).click();
  await expect(vis(adminPage.getByText(/Selection saved/))).toBeVisible();
  // The preview: Rs. 1,995 at 20% = Rs. 1,596 → Rs. 1,595, with an honest "was" price (it was offered at Rs. 1,995).
  await expect(vis(adminPage.getByText("Shoppers see: was Rs. 1,995, save Rs. 400 (20% off)."))).toBeVisible();
  expect((await prices()).sale_price_paisa).toBeNull();
  await vis(adminPage.getByRole("button", { name: "Confirm and start the sale now" })).click();
  await expect(vis(adminPage.getByText(/1 put on sale/))).toBeVisible();
  expect(await prices()).toMatchObject({ price_paisa: 199500, sale_price_paisa: 159500, reference_price_paisa: 199500 });

  // The shop: the final price first, the supported was-price and the saving nearby. (Measured: the
  // first shop request after an admin change can still be served from the previous catalogue
  // cache, the next is fresh; checkout always charges the database's price.)
  console.log(`shop showed the sale after ${await loadsUntil(page, `/products/${shoe.slug}`, "Rs. 1,595")} page load(s)`);
  await expect(vis(page.locator("s", { hasText: "Rs. 1,995" }))).toBeVisible();
  await expect(vis(page.getByText("Save Rs. 400 (20%)"))).toBeVisible();
  await expect(vis(page.getByText("20% OFF"))).toBeVisible();
  // On sale without price history: the selling price only, no badge or crossed-out price.
  await loadsUntil(page, `/products/${fresh.slug}`, "Rs. 1,995");
  // (The related-products grid on this page may show other, genuinely discounted pairs with a badge.)
  await expect(page.locator("s", { hasText: "Rs. 2,500" })).toHaveCount(0);
  await expect(page.getByText(/Save Rs\./)).toHaveCount(0);

  // The product form can't type over automatic or running-sale prices.
  await adminPage.goto(`/admin/products/${shoe.id}`);
  await expect(vis(adminPage.getByText(/Priced automatically from its score/))).toBeVisible();
  await expect(vis(adminPage.getByRole("textbox", { name: "Regular price (Rs.)" }))).toHaveAttribute("readonly", "");

  // End it.
  await adminPage.goBack();
  await vis(adminPage.getByRole("button", { name: "End the sale now" })).click();
  await expect(vis(adminPage.getByText(/Sale ended: 1 product\(s\) back at their regular price/))).toBeVisible();
  expect(await prices()).toMatchObject({ price_paisa: 199500, sale_price_paisa: null, reference_price_paisa: null });
  console.log(`shop showed the end of the sale after ${await loadsUntil(page, `/products/${shoe.slug}`, "Rs. 1,995", "Save Rs.")} page load(s)`);
  await expect(page.getByText(/Save Rs\./)).toHaveCount(0);
});
