import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/*
 * The real checkout UI and Server Action, end to end, against a real
 * PostgreSQL database with every migration applied. Run it through
 * scripts/e2e-checkout-local.mjs, which starts that database, a minimal
 * stand-in for Supabase's HTTP API, and servers configured with Cloudflare's
 * Turnstile testing keys. Skipped otherwise.
 *
 * What this is not: a test of real Supabase (PostgREST, Auth, Storage) or of
 * a real Turnstile widget on a real hostname.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const PRICE = 150000;
const ATTEMPT = "kharchnsave:checkout:v1";
const CART = "kharchnsave:cart:v1";
let image = "";

test.beforeAll(async () => {
  if (!db) return;
  image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
});

test.afterAll(async () => {
  await db?.end();
});

/** A new published product (one size, EU 40, stock 5) that no other test touches. */
async function freshSize() {
  const code = `E2E-CO-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`;
  await db!.query(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), 'Checkout Sneakers', 'Testbrand', 'kids', '{sneakers}', 'new', 'new',
      'Blue', 'Test', ${PRICE}, 'published', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, '${code}-40', 40, 5 from public.products where item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '${image}', 'Test', 800, 800 from public.products where item_code = '${code}';`);
  return { sku: `${code}-40`, size: 40 };
}

async function stock(sku: string) {
  const { rows } = await db!.query<{ stock: number; reserved: number }>(
    "select stock, reserved from public.product_variants where sku = $1", [sku]);
  return rows[0];
}

async function ordersFor(key: string) {
  const { rows } = await db!.query<{ order_number: string; customer_name: string }>(
    "select order_number, customer_name from public.orders where request_key_hash = sha256(convert_to($1, 'UTF8'))", [key]);
  return rows;
}

async function seedCart(page: Page, base: string, sku: string, size: number, quantity = 1) {
  await page.goto(`${base}/cart`);
  await page.evaluate(([key, line]) => localStorage.setItem(key as string, JSON.stringify([line])), [CART, {
    sku, productId: "x", slug: "e2e-checkout-sneakers", name: "Checkout Sneakers", brand: "Testbrand", size,
    price: PRICE / 100, status: "new", condition: "new", image: { src: image, alt: "Test" }, maxQuantity: 5, quantity,
  }] as const);
}

async function openCheckout(page: Page, base: string, name = "Ayesha Khan") {
  await page.goto(`${base}/checkout`);
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Mobile number").fill("0300 1234567");
  await page.getByLabel("City").fill("Lahore");
  await page.getByLabel("Full address").fill("House 12, Street 4, Model Town");
  // The quote is back and the Turnstile testing widget has produced a token.
  await expect(page.getByRole("button", { name: /Place order · pay/ })).toBeEnabled({ timeout: 30_000 });
}

const placeButton = (page: Page) => page.getByRole("button", { name: /Place order/ });
const attemptKey = (page: Page) =>
  page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "null") as { key: string } | null)?.key ?? null, ATTEMPT);

/** Lets Server Action calls reach the server but drops their responses. */
async function loseActionResponses(page: Page) {
  await page.route("**/checkout", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.fetch();
      await route.abort("connectionreset");
    } else {
      await route.continue();
    }
  });
}
const blockSettling = (page: Page) => page.route("**/api/checkout/order", (route) => route.abort("connectionreset"));

test("a successful order: stock held once, and the private order page", async ({ page }) => {
  const { sku, size } = await freshSize();
  await seedCart(page, "", sku, size, 2);
  await openCheckout(page, "");
  const key = await attemptKey(page);
  await placeButton(page).click();

  await expect(page).toHaveURL(new RegExp(`/order#k=${key}$`));
  await expect(page.getByRole("heading", { name: "Waiting for us to confirm" })).toBeVisible();
  await expect(page.getByText(/ending 567/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Model Town");
  expect(await ordersFor(key!)).toHaveLength(1);
  expect(await stock(sku)).toEqual({ stock: 3, reserved: 2 });
  expect(await page.evaluate((k) => localStorage.getItem(k), ATTEMPT)).toBeNull();
});

test("double submission: a double click and two tabs at once place one order", async ({ context, page }) => {
  const one = await freshSize();
  await seedCart(page, "", one.sku, one.size);
  await openCheckout(page, "");
  const key = await attemptKey(page);
  await placeButton(page).dblclick();
  await expect(page).toHaveURL(/\/order#k=/);
  expect(await ordersFor(key!)).toHaveLength(1);
  expect(await stock(one.sku)).toEqual({ stock: 4, reserved: 1 });

  // Two tabs share the browser's checkout key: both submit at the same moment.
  const two = await freshSize();
  await seedCart(page, "", two.sku, two.size);
  const other = await context.newPage();
  await openCheckout(page, "");
  await openCheckout(other, "");
  const sharedKey = await attemptKey(page);
  expect(await attemptKey(other)).toBe(sharedKey);
  await Promise.all([placeButton(page).click(), placeButton(other).click()]);
  await expect(page).toHaveURL(new RegExp(`/order#k=${sharedKey}$`));
  await expect(other).toHaveURL(new RegExp(`/order#k=${sharedKey}$`));
  expect(await ordersFor(sharedKey!)).toHaveLength(1);
  expect(await stock(two.sku)).toEqual({ stock: 4, reserved: 1 });
});

test("response lost after the order commits: retrying and refreshing never order twice", async ({ page }) => {
  // Retry: the answer is lost and the automatic check can't get through either.
  const a = await freshSize();
  await seedCart(page, "", a.sku, a.size);
  await openCheckout(page, "");
  const key = await attemptKey(page);
  await loseActionResponses(page);
  await blockSettling(page);
  await placeButton(page).click();
  await expect(page.getByText(/couldn’t check on your earlier attempt|couldn’t confirm whether your order went through/)).toBeVisible();
  expect(await ordersFor(key!)).toHaveLength(1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(placeButton(page)).toBeEnabled({ timeout: 30_000 });
  await placeButton(page).click();
  await expect(page).toHaveURL(new RegExp(`/order#k=${key}$`));
  expect(await ordersFor(key!)).toHaveLength(1);
  expect(await stock(a.sku)).toEqual({ stock: 4, reserved: 1 });

  // Refresh: the page settles the earlier attempt on load and shows the order.
  const b = await freshSize();
  await seedCart(page, "", b.sku, b.size);
  await openCheckout(page, "");
  const key2 = await attemptKey(page);
  await loseActionResponses(page);
  await blockSettling(page);
  await placeButton(page).click();
  await expect(page.getByText(/couldn’t check on your earlier attempt|couldn’t confirm whether/)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  // The earlier attempt is found on load and the customer is taken to the order.
  await expect(page).toHaveURL(new RegExp(`/order#k=${key2}$`));
  await expect(page.getByRole("heading", { name: "Waiting for us to confirm" })).toBeVisible();
  expect(await ordersFor(key2!)).toHaveLength(1);
  expect(await stock(b.sku)).toEqual({ stock: 4, reserved: 1 });
});

test("changed details under the same key are refused; the original order stands", async ({ page }) => {
  const { sku, size } = await freshSize();
  await seedCart(page, "", sku, size);
  await openCheckout(page, "", "First Name");
  const key = await attemptKey(page);
  await loseActionResponses(page);
  await blockSettling(page);
  await placeButton(page).click();
  await expect(page.getByText(/couldn’t check on your earlier attempt|couldn’t confirm whether/)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await page.getByLabel("Full name").fill("Different Name");
  await expect(placeButton(page)).toBeEnabled({ timeout: 30_000 });
  await placeButton(page).click();
  // Refused as a different order under the same key; the original is shown instead.
  await expect(page).toHaveURL(new RegExp(`/order#k=${key}$`));
  await expect(page.getByText(/Thank you, First\./)).toBeVisible();
  expect(await ordersFor(key!)).toEqual([expect.objectContaining({ customer_name: "First Name" })]);
  expect(await stock(sku)).toEqual({ stock: 4, reserved: 1 });
});

test("bot verification already spent or failed: nothing is ordered", async ({ page }) => {
  for (const [base, message] of [
    [process.env.E2E_BASE_URL_SPENT!, "The security check expired"],
    [process.env.E2E_BASE_URL_FAIL!, "The security check didn’t pass"],
  ]) {
    const { sku, size } = await freshSize();
    await seedCart(page, base, sku, size);
    await openCheckout(page, base);
    const key = await attemptKey(page);
    await placeButton(page).click();
    await expect(page.getByText(message)).toBeVisible();
    expect(await ordersFor(key!)).toHaveLength(0);
    expect(await stock(sku)).toEqual({ stock: 5, reserved: 0 });
  }
});

test("abandoning a key while its order is in flight: either no order ever, or the order is shown", async ({ context, page }) => {
  // The key is abandoned before the order request reaches the server.
  const a = await freshSize();
  await seedCart(page, "", a.sku, a.size);
  await openCheckout(page, "");
  const key = await attemptKey(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/checkout", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) await held;
    await route.continue();
  });
  await placeButton(page).click();
  // Another tab changes the cart: this tab gives the sent key up.
  const other = await context.newPage();
  await other.goto("/cart");
  const abandoned = page.waitForResponse((r) => r.url().endsWith("/api/checkout/order") && r.request().postData()?.includes("abandon") === true);
  await other.evaluate((k) => {
    const lines = JSON.parse(localStorage.getItem(k)!);
    lines[0].quantity = 2;
    localStorage.setItem(k, JSON.stringify(lines));
  }, CART);
  expect(await (await abandoned).json()).toEqual({ state: "abandoned" });
  release();
  await expect(page.getByText("This checkout was closed")).toBeVisible();
  expect(await ordersFor(key!)).toHaveLength(0);
  expect(await stock(a.sku)).toEqual({ stock: 5, reserved: 0 });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // The order commits first; the later attempt to abandon finds it instead.
  const b = await freshSize();
  await seedCart(page, "", b.sku, b.size);
  await openCheckout(page, "");
  const key2 = await attemptKey(page);
  await loseActionResponses(page);
  await blockSettling(page);
  await placeButton(page).click();
  await expect(page.getByText(/couldn’t check on your earlier attempt|couldn’t confirm whether/)).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await other.evaluate((k) => {
    const lines = JSON.parse(localStorage.getItem(k)!);
    lines[0].quantity = 2;
    localStorage.setItem(k, JSON.stringify(lines));
  }, CART);
  await expect(page.getByRole("heading", { name: /^Your order KO-\d+ was placed$/ })).toBeVisible();
  expect(await ordersFor(key2!)).toHaveLength(1);
  const { rows } = await db!.query("select 1 from private.checkout_abandoned_keys where key_hash = sha256(convert_to($1, 'UTF8'))", [key2]);
  expect(rows).toHaveLength(0);
});
