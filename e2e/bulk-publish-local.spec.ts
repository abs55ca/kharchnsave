import { expect, test, type BrowserContext, type Locator } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * Publishing several drafts from /admin/products, on the local stack
 * (scripts/e2e-checkout-local.mjs; skipped otherwise): tick boxes on drafts,
 * select a page or the whole list (across pages), publish in batches with the
 * product page's own checks, and a reason for every product not published.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const tag = `E2E-BP-${randomBytes(3).toString("hex").toUpperCase()}`;
/** The page streams a hidden copy of some content; tests use the visible one. */
const vis = (l: Locator) => l.filter({ visible: true });
const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function signInAdmin(context: BrowserContext, base: string, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: ADMIN_ID, email: "e2e-admin@test.invalid", role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID(), iat: now - 60, exp: now + ttl });
  const token = `${header}.${payload}.${createHmac("sha256", process.env.E2E_AUTH_SECRET!).update(`${header}.${payload}`).digest("base64url")}`;
  const session = { access_token: token, token_type: "bearer", expires_in: ttl, expires_at: now + ttl, refresh_token: "none", user: { id: ADMIN_ID, email: "e2e-admin@test.invalid" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64url(session)}`, url: `${base}/admin`, httpOnly: true, sameSite: "Lax" }]);
}

const code = (n: number) => `${tag}-${String(n).padStart(2, "0")}`;
const statuses = async () =>
  Object.fromEntries((await db!.query<{ item_code: string; publication_status: string }>(
    "select item_code, publication_status from public.products where item_code like $1", [`${tag}-%`])).rows.map((r) => [r.item_code, r.publication_status]));

test.beforeAll(async () => {
  if (!db) return;
  const image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  // 1-21: ready drafts; 22: a draft without a photo; 23: already published.
  for (let n = 1; n <= 23; n++) {
    await db.query(`insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status)
      values ($1, lower($1), 'Bulk Sneakers ' || $2, 'Unbranded', 'kids', '{sneakers}', 'new', 'new', 'Blue', 'Test', 199500, 'draft')`, [code(n), n]);
    await db.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, 'new', $1 || '-30', 30, 1 from public.products where item_code = $1`, [code(n)]);
    if (n !== 22) await db.query(`insert into public.product_images (product_id, src, alt, width, height) select id, $2, 'Test', 800, 800 from public.products where item_code = $1`, [code(n), image]);
    if (n === 23) await db.query("update public.products set publication_status = 'published', listed_at = current_date where item_code = $1", [code(n)]);
  }
});
test.afterAll(async () => {
  await db?.end();
});

test("tick drafts, select the page or the whole list, and publish in batches; every product not published gets a reason", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/admin/products?q=${encodeURIComponent(tag)}`);
  await expect(vis(page.getByText("23 products", { exact: false })).first()).toBeVisible();

  // Tick boxes on drafts only (20 rows on page 1: the published one may or may not be among them).
  const boxes = vis(page.getByRole("checkbox", { name: /^Select E2E-BP-/ }));
  const published = vis(page.getByRole("checkbox", { name: `Select ${code(23)} Bulk Sneakers 23` }));
  await expect(published).toHaveCount(0);
  const onPage = await boxes.count();
  expect(onPage).toBeGreaterThanOrEqual(19);

  // One by one, then the whole page, then clear.
  await boxes.first().check();
  await expect(vis(page.getByText("1 selected")).first()).toBeVisible();
  await vis(page.getByLabel("Select all drafts on this page")).first().check();
  await expect(vis(page.getByText(`${onPage} selected`)).first()).toBeVisible();
  await vis(page.getByRole("button", { name: "Clear" })).first().click();
  await expect(vis(page.getByText("0 selected")).first()).toBeVisible();

  // The whole list, across both pages: all 22 drafts.
  await vis(page.getByRole("button", { name: "Select all drafts in this list" })).first().click();
  await expect(vis(page.getByText("22 selected")).first()).toBeVisible();
  await vis(page.getByRole("button", { name: "Publish selected (22)" })).first().click();
  await expect(vis(page.getByText("Published 21.", { exact: false })).first()).toBeVisible({ timeout: 30_000 });
  await expect(vis(page.getByText("1 not published (still selected):", { exact: false })).first()).toBeVisible();
  await expect(vis(page.locator("li").filter({ hasText: code(22) }).filter({ hasText: "Add at least one photo first." })).first()).toBeVisible();
  await expect(vis(page.getByText("1 selected")).first()).toBeVisible();

  const after = await statuses();
  for (let n = 1; n <= 21; n++) expect(after[code(n)], code(n)).toBe("published");
  expect(after[code(22)]).toBe("draft");
  expect(after[code(23)]).toBe("published");

  // Publishing the remaining one again: still skipped, with the same reason; nothing else changes.
  await vis(page.getByRole("button", { name: "Publish selected (1)" })).first().click();
  await expect(vis(page.getByText("Published 0.", { exact: false })).first()).toBeVisible();
  expect((await statuses())[code(22)]).toBe("draft");

  // The list shows them as published now (refreshed), with tick boxes only on the remaining draft.
  await page.goto(`/admin/products?q=${encodeURIComponent(tag)}&status=draft`);
  await expect(vis(page.getByText("1 product", { exact: false })).first()).toBeVisible();
  await expect(vis(page.getByRole("checkbox", { name: /^Select E2E-BP-/ }))).toHaveCount(1);
  await context.close();
});
