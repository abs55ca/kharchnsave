import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * Permanent product deletion end to end: the real admin product page against
 * a real PostgreSQL database with every migration applied, through the local
 * stand-in for Supabase's HTTP API (scripts/e2e-checkout-local.mjs). Skipped
 * otherwise.
 *
 * Not tested here: real Supabase (PostgREST, Auth) or Storage, and the admin
 * product list (the stand-in only answers the shop's catalogue query). The
 * products here use site images, so no photo files are removed.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");
test.describe.configure({ mode: "serial" });

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const suffix = randomBytes(3).toString("hex").toUpperCase();
const target = { code: `E2E-DEL-${suffix}`, id: "", slug: "" };
const other = { code: `E2E-KEEP-${suffix}`, id: "", slug: "" };
const lonely = { code: `E2E-SOLO-${suffix}`, id: "", slug: "" };
let image = "";
let order = { id: "", number: "" };

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

async function insertProduct(code: string) {
  await db!.query(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, publication_status, listed_at)
    values ($1, lower($1), 'Delete Sneakers ' || $1, 'Testbrand', 'men', '{sneakers}', 'new', 'new', 'Blue', 'Test', 200000, 'draft', current_date)`, [code]);
  await db!.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, $1 || '-41', 41, 5 from public.products where item_code = $1`, [code]);
  await db!.query(`insert into public.product_images (product_id, src, alt, width, height)
    select id, $2, 'Test', 800, 800 from public.products where item_code = $1`, [code, image]);
  await db!.query("update public.products set publication_status = 'published' where item_code = $1", [code]);
  return (await db!.query<{ id: string; slug: string }>("select id, slug from public.products where item_code = $1", [code])).rows[0];
}

/** Runs one call the way the API does for a verified admin. */
async function asAdmin<T>(sql: string, params: unknown[]): Promise<T> {
  const c = await db!.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_ID, role: "authenticated", aal: "aal2" })]);
    const { rows } = await c.query<{ r: T }>(sql, params);
    await c.query("commit");
    return rows[0].r;
  } catch (error) {
    await c.query("rollback").catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}

async function placeOrder(codes: string[]) {
  const lines = codes.map((code) => ({ sku: `${code}-41`, quantity: 1, unit_price_paisa: 200000 }));
  const secret = process.env.E2E_GATEWAY_SECRET!;
  const q = (await db!.query("select public.quote_order($1, $2, 'Lahore', null) as r", [secret, JSON.stringify(lines)])).rows[0].r;
  const placed = (await db!.query("select public.place_cod_order($1, $2, $3) as r", [secret, randomBytes(32).toString("base64url"), JSON.stringify({
    lines, delivery_paisa: q.delivery_paisa, total_paisa: q.total_paisa,
    customer: { name: "Deletion Test", phone: `+92304${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, city: "Lahore", address: "House 5, Street 5, Test Town" },
  })])).rows[0].r;
  if (placed.result !== "placed") throw new Error(JSON.stringify(placed));
  const { rows } = await db!.query<{ id: string }>("select id from public.orders where order_number = $1", [placed.order.order_number]);
  return { id: rows[0].id, number: placed.order.order_number as string };
}

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

const exists = async (sql: string, params: unknown[]) => ((await db!.query(sql, params)).rowCount ?? 0) > 0;

test.beforeAll(async () => {
  if (!db) return;
  image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  Object.assign(target, await insertProduct(target.code));
  Object.assign(other, await insertProduct(other.code));
  Object.assign(lonely, await insertProduct(lonely.code));
  order = await placeOrder([target.code, other.code]);
});
test.afterAll(async () => {
  await db?.end();
});

test("an open order blocks the delete; once it's cancelled, the product and that order are deleted after typing the item code", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } }); // a phone
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });

  await page.goto(`/admin/products/${target.id}`);
  const panel = vis(page.getByRole("region", { name: "Delete permanently" }));
  await expect(panel).toBeVisible();
  await expect(vis(panel.getByRole("link", { name: order.number }))).toBeVisible();
  await expect(vis(panel.getByText(`Also contains: ${other.code} Testbrand Delete Sneakers ${other.code}`))).toBeVisible();
  await expect(vis(panel.getByText(/Blocks the delete: this order isn’t finished yet/))).toBeVisible();
  await expect(panel.getByLabel(/to confirm/)).toHaveCount(0);

  const v = (await db!.query<{ version: number }>("select version from public.orders where id = $1", [order.id])).rows[0].version;
  await asAdmin("select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [order.id, v, randomUUID()]);
  await page.reload();
  const ready = vis(page.getByRole("region", { name: "Delete permanently" }));
  await expect(vis(ready.getByText(/Blocks the delete/))).toHaveCount(0);
  const button = vis(ready.getByRole("button", { name: "Delete product and 1 order" }));
  await expect(button).toBeDisabled();
  await vis(ready.getByLabel(/to confirm/)).fill("WRONG");
  await expect(button).toBeDisabled();
  await vis(ready.getByLabel(/to confirm/)).fill(target.code.toLowerCase());
  await expect(button).toBeEnabled();
  await button.click();

  // To the product list with a notice. (The list itself can't render on this stand-in, which only
  // answers the shop's catalogue query, so only the address is checked here.)
  await page.waitForURL(`**/admin/products?deleted=${target.code}`);
  expect(dialogs.at(-1)).toContain(`Permanently delete ${target.code}?`);
  expect(dialogs.at(-1)).toContain(order.number);
  expect(await exists("select 1 from public.products where id = $1", [target.id])).toBe(false);
  expect(await exists("select 1 from public.orders where id = $1", [order.id])).toBe(false);
  expect(await exists("select 1 from public.order_items where sku like $1", [`${target.code}-%`])).toBe(false);
  // The other product in that order stays, with its stock back from the cancellation.
  expect((await db!.query("select stock, reserved from public.product_variants where sku = $1", [`${other.code}-41`])).rows[0]).toEqual({ stock: 5, reserved: 0 });

  // The shop stops showing it (the catalogue cache may serve one more stale load).
  let status = 0;
  for (let load = 1; load <= 5 && status !== 404; load++) {
    status = (await page.goto(`/products/${target.slug}`))?.status() ?? 0;
    if (status !== 404) await page.waitForTimeout(1000);
  }
  expect(status).toBe(404);
  await context.close();
});

test("a lost answer is retried with the same request and recognised as already deleted", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`/admin/products/${lonely.id}`);
  const panel = vis(page.getByRole("region", { name: "Delete permanently" }));
  await expect(vis(panel.getByText("It isn’t in any orders."))).toBeVisible();
  await vis(panel.getByLabel(/to confirm/)).fill(lonely.code);

  await loseNextAnswer(page, `**/admin/products/${lonely.id}`);
  await vis(panel.getByRole("button", { name: "Delete product" })).click();
  await expect(vis(panel.getByText(/No answer, so we can’t tell whether this was saved/))).toBeVisible();
  expect(await exists("select 1 from public.products where id = $1", [lonely.id])).toBe(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await vis(panel.getByRole("button", { name: "Retry unconfirmed save" })).click();
  await page.waitForURL(`**/admin/products?deleted=${lonely.code}`);
  const log = await db!.query("select count(*)::int as n from private.product_deletions where product_id = $1", [lonely.id]);
  expect(log.rows[0].n).toBe(1);
  await context.close();
});
