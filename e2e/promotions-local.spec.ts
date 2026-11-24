import { expect, test, type BrowserContext, type Locator } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * The promotion planner (/admin/pricing/promotions) end to end on the local
 * stack (scripts/e2e-checkout-local.mjs; skipped otherwise): preview, save,
 * stable on reload, and nothing a shopper or checkout sees changes.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const suffix = randomBytes(3).toString("hex").toUpperCase();
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

// Kids' shoes priced by score in a Rs. 4,000 group (like the real catalogue).
const shoes = [
  { name: "Planner Star Sneakers — Lilac", size: 22, score: 45 },
  { name: "Planner Star Sneakers — Lilac", size: 30, score: 76 }, // another size of the same model
  { name: "Planner Runner — Navy", size: 35, score: 96 },
  { name: "Planner Court — White", size: 33, score: 88 },
  { name: "Planner High-Top — Pink", size: 36, score: 100 },
  { name: "Planner Sandal — Peach", size: 27, score: 65 },
].map((s, i) => ({ ...s, code: `E2E-PRM-${suffix}-${i + 1}`, id: "", slug: "" }));

const snapshot = async () =>
  (await db!.query("select json_agg(json_build_object('id', p.id, 'price', p.price_paisa, 'sale', p.sale_price_paisa, 'ref', p.reference_price_paisa, 'v', p.version) order by p.id)::text as s, (select count(*) from private.price_history) as h from public.products p")).rows[0];

test.beforeAll(async () => {
  if (!db) return;
  const image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  for (const s of shoes) {
    await db.query(`insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status, listed_at)
      values ($1, lower($1), $2, 'Unbranded', 'kids', '{sneakers}', 'new', 'new', 'Mixed', 'Test', 100000, 'draft', current_date)`, [s.code, s.name]);
    await db.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, 'new', $1 || '-' || $2, $2::numeric, 3 from public.products where item_code = $1`, [s.code, String(s.size)]);
    await db.query(`insert into public.product_images (product_id, src, alt, width, height) select id, $2, 'Test', 800, 800 from public.products where item_code = $1`, [s.code, image]);
    await db.query("update public.products set publication_status = 'published' where item_code = $1", [s.code]);
    Object.assign(s, (await db.query<{ id: string; slug: string }>("select id, slug from public.products where item_code = $1", [s.code])).rows[0]);
  }
  const group = await asAdmin<{ id: string }>("select public.admin_create_pricing_group($1, $2, 400000) as r", [randomUUID(), `E2E Kids ${suffix}`]);
  const items = shoes.map((s) => ({ product_id: s.id, mode: "auto", group_id: group.id, score: s.score }));
  const plan = await asAdmin<{ token: string }>("select public.admin_preview_product_pricing($1) as r", [JSON.stringify(items)]);
  const applied = await asAdmin<{ result: string }>("select public.admin_apply_product_pricing($1, $2, $3) as r", [randomUUID(), JSON.stringify(items), plan.token]);
  expect(applied.result).toBe("applied");
});
test.afterAll(async () => {
  await db?.end();
});

test("the planner previews and saves discount proposals without changing any price", async ({ browser, baseURL }) => {
  const runner = shoes[2];
  expect((await db!.query("select price_paisa from public.products where id = $1", [runner.id])).rows[0].price_paisa).toBe(379500);
  const before = await snapshot();
  const quote = async () =>
    (await db!.query("select public.quote_order($1, $2, 'Lahore', null) as r", [process.env.E2E_GATEWAY_SECRET,
      JSON.stringify(shoes.slice(1, 4).map((s) => ({ sku: `${s.code}-${s.size}`, quantity: 1, unit_price_paisa: 0 })))])).rows[0].r;
  const quoteBefore = await quote();

  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  await page.goto("/admin/pricing/promotions");
  await expect(vis(page.getByRole("heading", { name: "Promotion planner" }))).toBeVisible();
  const row = (code: string) => vis(page.locator("tr").filter({ hasText: code }));
  const assigned = async () => Object.fromEntries(await Promise.all(shoes.map(async (s) => [s.code, (await row(s.code).locator("td").nth(3).innerText()).split("\n")[0]])));

  await expect(row(runner.code).getByText("not saved yet", { exact: true })).toBeVisible();
  const planned = await assigned();
  // Two sizes of one model: one percentage.
  expect(planned[shoes[0].code]).toBe(planned[shoes[1].code]);

  // The sample preview (printed for the report).
  for (const s of shoes) console.log((await row(s.code).innerText()).replace(/\s*\n\s*/g, " | "));
  // The true saving, rounded (not truncated) to two decimals, is exactly the assigned percentage.
  for (const s of shoes) {
    await expect(row(s.code).locator("td").nth(5)).toContainText(`(${planned[s.code].replace("%", "")}.00%)`);
  }

  await vis(page.getByRole("button", { name: "Save assignments" })).click();
  await expect(vis(page.getByText(/Saved: \d+ new assignment\(s\)/))).toBeVisible();
  await page.reload();
  await expect(row(runner.code).getByText("not saved yet", { exact: true })).toHaveCount(0);
  expect(await assigned()).toEqual(planned);
  await page.reload();
  expect(await assigned()).toEqual(planned);

  // Every proposal is the selling price worked backwards, and none is verified (never offered at that price).
  const saved = (await db!.query("select product_id, discount_bp, proposed_regular_paisa, based_on_selling_paisa from private.promotion_assignments where product_id = any($1)", [shoes.map((s) => s.id)])).rows;
  expect(saved).toHaveLength(shoes.length);
  for (const r of saved) {
    expect(r.proposed_regular_paisa).toBe(String(Math.floor((r.based_on_selling_paisa * 20000 + (10000 - r.discount_bp)) / (2 * (10000 - r.discount_bp)))));
  }
  await expect(row(runner.code).getByText("Proposal only: never offered at this price")).toBeVisible();

  // Nothing a shopper or checkout sees changed.
  expect(await snapshot()).toEqual(before);
  expect(await quote()).toEqual(quoteBefore);
  // The shop's cached catalogue was never told about these directly-inserted shoes: refresh it the
  // way an admin change does (unpublish another one in the editor), then load until it catches up.
  const helper = shoes[5];
  page.on("dialog", (d) => void d.accept());
  await page.goto(`/admin/products/${helper.id}`);
  await vis(page.getByRole("button", { name: "Unpublish" })).click();
  await expect(vis(page.getByRole("button", { name: "Publish" }))).toBeVisible();
  const shop = await context.newPage();
  let shown = false;
  for (let load = 1; load <= 5 && !shown; load++) {
    await shop.goto(`/products/${runner.slug}`);
    shown = (await shop.getByText("Rs. 3,795").filter({ visible: true }).count()) > 0;
    if (!shown) await shop.waitForTimeout(1000);
  }
  expect(shown).toBe(true);
  expect((await db!.query("select price_paisa, sale_price_paisa, reference_price_paisa from public.products where id = $1", [runner.id])).rows[0])
    .toEqual({ price_paisa: 379500, sale_price_paisa: null, reference_price_paisa: null });
  await expect(shop.locator("s")).toHaveCount(0);
  await expect(shop.getByText(/Save Rs\./)).toHaveCount(0);
  await context.close();
});
