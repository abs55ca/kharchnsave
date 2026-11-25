import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * "Sales by size" on /admin/pricing end to end, on the local stack
 * (scripts/e2e-checkout-local.mjs; skipped otherwise): rules, validation,
 * preview, apply, the shop's product page and card, the checkout quote, and
 * ending the sale. Not real Supabase or a hosted cache.
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");
test.describe.configure({ mode: "serial" });

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const suffix = randomBytes(3).toString("hex").toUpperCase();
const GROUP = `E2E Size ${suffix}`;
const vis = (l: Locator) => l.filter({ visible: true }).first();
const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
let groupId = "";

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
  } finally {
    c.release();
  }
}

// One product per size (like the kids' shoes), a two-size product, and a draft.
const shoes = [
  { label: "EU24", sizes: [24], price: 209500 },
  { label: "EU25", sizes: [25], price: 219500 },
  { label: "EU295", sizes: [29.5], price: 289500 },
  { label: "EU30", sizes: [30], price: 299500 },
  { label: "EU36", sizes: [36], price: 399500 },
  { label: "MIXED", sizes: [30, 31], price: 299500 },
  { label: "DRAFT", sizes: [28], price: 269500, draft: true },
].map((s) => ({ ...s, code: `E2E-SZ-${suffix}-${s.label}`, id: "", slug: "" }));
const shoe = (label: string) => shoes.find((s) => s.label === label)!;
const prices = async (id: string) =>
  (await db!.query("select price_paisa, sale_price_paisa, reference_price_paisa from public.products where id = $1", [id])).rows[0];

async function loadsUntil(page: Page, url: string, text: string, gone?: string) {
  for (let load = 1; load <= 6; load++) {
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
  const image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
  groupId = (await asAdmin<{ id: string }>("select public.admin_create_pricing_group($1, $2, 400000) as r", [randomUUID(), GROUP])).id;
  // No minimum days, so a product published at its price has a supported "was" price at once (the existing rule).
  const settings = (await asAdmin<{ settings: Record<string, unknown> & { version: number } }>("select public.admin_pricing_overview() as r", [])).settings;
  if (settings.reference_min_days !== null) {
    const { version, updated_at: _u, ...rest } = settings;
    void _u;
    await asAdmin("select public.admin_save_pricing_settings($1, $2, $3) as r", [version, randomUUID(), JSON.stringify({ ...rest, reference_min_days: null })]);
  }
  for (const s of shoes) {
    await db.query(`insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status, listed_at)
      values ($1, lower($1), 'Size Sneakers ' || $2, 'Unbranded', 'kids', '{sneakers}', 'new', 'new', 'Blue', 'Test', $3, 'draft', current_date)`, [s.code, s.label, s.price]);
    for (const size of s.sizes) {
      await db.query(`insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, 'new', $1 || '-' || $2, $2::numeric, 3 from public.products where item_code = $1`, [s.code, String(size)]);
    }
    await db.query(`insert into public.product_images (product_id, src, alt, width, height) select id, $2, 'Test', 800, 800 from public.products where item_code = $1`, [s.code, image]);
    if (!s.draft) await db.query("update public.products set publication_status = 'published' where item_code = $1", [s.code]);
    Object.assign(s, (await db.query<{ id: string; slug: string }>("select id, slug from public.products where item_code = $1", [s.code])).rows[0]);
    await db.query("insert into private.product_pricing (product_id, mode, group_id) values ($1, 'manual', $2)", [s.id, groupId]);
  }
});
test.afterAll(async () => {
  await db?.end();
});

test("rules are validated, previewed per product, applied to matching sizes only, shown in the shop, charged at checkout, and ended", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  await signInAdmin(context, baseURL!);
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  // A cost on two shoes: the group totals subtract it for those pairs only.
  await db!.query("update private.product_pricing set cost_paisa = 100000 where product_id in ($1, $2)", [shoe("EU24").id, shoe("EU25").id]);
  await page.goto("/admin/pricing");

  // Group totals: 6 pairs ×3 in stock + the two-size shoe's 6 = 24 pairs; Rs. 68,580 at their prices (no sales yet);
  // cost Rs. 6,000 for the 6 costed pairs, whose Rs. 12,870 less cost leaves Rs. 6,870.
  const totals = vis(page.locator("section").filter({ has: page.getByRole("heading", { name: "Group totals" }) }));
  const totalsRow = totals.getByRole("row").filter({ has: page.getByRole("rowheader", { name: GROUP }) });
  await expect(totalsRow).toContainText("24");
  await expect(totalsRow).toContainText("Rs. 68,580");
  await expect(totalsRow).toContainText("Rs. 2,857.50"); // average per pair
  await expect(totalsRow).toContainText("Rs. 6,000");
  await expect(totalsRow).toContainText("Rs. 6,870");
  await expect(totalsRow).toContainText("18 pair(s) without a cost left out");
  await db!.query("update private.product_pricing set cost_paisa = null where product_id in ($1, $2)", [shoe("EU24").id, shoe("EU25").id]);

  const panel = vis(page.locator("section").filter({ has: page.getByRole("heading", { name: "Sales by size" }) }));
  await expect(panel).toBeVisible();
  await panel.getByLabel("Pricing group").selectOption({ label: `${GROUP} (max Rs. 4,000)` });

  // The initial rules: EU 25–30 at 30%, EU 36 at 35%; then an overlapping range, which is refused.
  const addRule = async (from: string, to: string, pct: string) => {
    await panel.getByRole("button", { name: "Add a rule" }).click();
    const n = await panel.getByLabel(/EU size from$/).count();
    await panel.getByLabel(`Row ${n}: EU size from`).fill(from);
    await panel.getByLabel(`Row ${n}: EU size to`).fill(to);
    await panel.getByLabel(`Row ${n}: discount percent`).fill(pct);
  };
  // The group's sizes are listed beside the rules: every size, with how many listings have it.
  const sizes = panel.getByRole("region", { name: "Sizes in this group" });
  await expect(sizes.getByText("7 size(s) across 8 listing(s).", { exact: false })).toBeVisible();
  for (const size of ["24", "25", "28", "29.5", "30", "31", "36"]) await expect(sizes.locator(`li[data-size="${size}"]`)).toBeVisible();
  await expect(sizes.locator('li[data-size="30"]')).toContainText("EU 30 · 2 listings"); // the EU 30 shoe and the two-size one
  await addRule("25", "30", "30");
  await addRule("36", "", "35");
  // As the rules are typed, each size shows what it gets.
  await expect(sizes.locator('li[data-size="29.5"]')).toContainText("30% off · EU 25–30");
  await expect(sizes.locator('li[data-size="36"]')).toContainText("35% off · EU 36");
  await expect(sizes.locator('li[data-size="24"]')).toContainText("no sale");
  await expect(sizes.locator('li[data-size="31"]')).toContainText("no sale");
  await addRule("30", "32", "20");
  await panel.getByRole("button", { name: "Preview size sale" }).click();
  await expect(panel.getByText("Rows 1 and 3 overlap (EU 25–30 and EU 30–32).", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Remove row 3" }).click();
  await panel.getByRole("button", { name: "Preview size sale" }).click();

  const preview = panel.getByRole("region", { name: "Size sale preview" });
  await expect(preview.getByText(/4\s*eligible · 2\s*blocked · 1\s*unchanged/)).toBeVisible();
  await preview.getByLabel("Show").selectOption("all");
  const row = (label: string) => preview.locator(`tr[data-product="${shoe(label).code}"]`);
  await expect(row("EU30")).toContainText("EU 25–30 · 30%");
  await expect(row("EU30")).toContainText("Rs. 2,096.50");
  await expect(row("EU30")).toContainText("(30.00%)");
  await expect(row("EU30")).toContainText('Shop shows "Was Rs. 2,995"');
  await expect(row("EU30")).toContainText("Cost unknown");
  await expect(row("EU295")).toContainText("Rs. 2,026.50"); // 2,895 × 0.7, the half size included
  await expect(row("EU36")).toContainText("EU 36 · 35%");
  await expect(row("EU36")).toContainText("Rs. 2,596.75");
  await expect(row("EU24")).toContainText("No rule matches its size");
  await expect(row("MIXED")).toContainText("Its sizes fall under different rules");
  await expect(row("DRAFT")).toContainText("Not published");
  await panel.screenshot({ path: "test-results/size-sales-preview.png" });

  // Apply: only the four eligible products change.
  await panel.getByRole("button", { name: "Apply eligible sales (4)" }).click();
  await expect(panel.getByText(/Applied to 4 product\(s\)\. 4 show a verified "was" price/)).toBeVisible();
  expect(await prices(shoe("EU30").id)).toEqual({ price_paisa: 299500, sale_price_paisa: 209650, reference_price_paisa: 299500 });
  expect(await prices(shoe("EU36").id)).toEqual({ price_paisa: 399500, sale_price_paisa: 259675, reference_price_paisa: 399500 });
  for (const label of ["EU24", "MIXED", "DRAFT"]) expect((await prices(shoe(label).id)).sale_price_paisa, label).toBeNull();

  // The shop: product page and card show the sale price, the verified "Was" price and the saving.
  const shop = await context.newPage();
  await loadsUntil(shop, `/products/${shoe("EU30").slug}`, "Rs. 2,096.50");
  await expect(vis(shop.getByText("Was Rs. 2,995"))).toBeVisible();
  await expect(vis(shop.getByText("Save Rs. 898.50 (30%)"))).toBeVisible();
  await shop.goto("/shop?category=kids");
  const card = vis(shop.locator("a, article, li").filter({ hasText: "Size Sneakers EU36" }).filter({ hasText: "Rs. 2,596.75" }));
  await expect(card).toBeVisible();
  await expect(card).toContainText("Was Rs. 3,995");
  await expect(card).toContainText("35% OFF");

  // Checkout charges the same price, through the site's own quote API.
  const quote = await shop.request.post("/api/checkout/quote", { data: { lines: [{ sku: `${shoe("EU30").code}-30`, quantity: 1, unit_price_paisa: 209650 }], city: "Lahore" } });
  expect(quote.status()).toBe(200);
  const q = await quote.json();
  expect(q.subtotal_paisa ?? q.quote?.subtotal_paisa).toBe(209650);

  // One cost for every shoe in the group, while the size sale runs: costs set, no price changes.
  await page.reload();
  const costForm = vis(page.locator("form").filter({ hasText: "Same cost for every shoe in a group" }));
  await costForm.getByRole("combobox", { name: "Group", exact: true }).selectOption({ label: `${GROUP} (7 shoes)` });
  await costForm.getByLabel("Cost per pair (Rs.)").fill("1000");
  await costForm.getByRole("button", { name: "Set cost for all" }).click();
  await expect(costForm.getByText("Cost set to Rs. 1,000 for 7 shoe(s).")).toBeVisible();
  const costs = await db!.query<{ cost_paisa: number | null }>("select cost_paisa from private.product_pricing where group_id = $1", [groupId]);
  expect(costs.rows.map((r) => r.cost_paisa)).toEqual(Array(7).fill(100000));
  expect(await prices(shoe("EU30").id)).toEqual({ price_paisa: 299500, sale_price_paisa: 209650, reference_price_paisa: 299500 });
  expect(await prices(shoe("EU24").id)).toEqual({ price_paisa: 209500, sale_price_paisa: null, reference_price_paisa: null });
  // The totals use it: 24 pairs × Rs. 1,000.
  await page.reload();
  const totalsAfter = vis(page.locator("section").filter({ has: page.getByRole("heading", { name: "Group totals" }) }))
    .getByRole("row").filter({ has: page.getByRole("rowheader", { name: GROUP }) });
  await expect(totalsAfter).toContainText("Rs. 24,000");
  await expect(totalsAfter).not.toContainText("without a cost");
  // Again: nothing to change.
  await costForm.getByRole("combobox", { name: "Group", exact: true }).selectOption({ label: `${GROUP} (7 shoes)` });
  await costForm.getByLabel("Cost per pair (Rs.)").fill("1000");
  await costForm.getByRole("button", { name: "Set cost for all" }).click();
  await expect(costForm.getByText("Cost set to Rs. 1,000 for 0 shoe(s). 7 already had that cost.")).toBeVisible();

  // End: regular prices back, no "Was".
  await page.reload();
  await vis(page.getByLabel("Pricing group")).selectOption({ label: `${GROUP} (max Rs. 4,000)` });
  await vis(page.getByRole("button", { name: "End size-based sales" })).click();
  await expect(vis(page.getByText("Size sale ended: 4 product(s) back at their regular price."))).toBeVisible();
  expect(await prices(shoe("EU30").id)).toEqual({ price_paisa: 299500, sale_price_paisa: null, reference_price_paisa: null });
  await loadsUntil(shop, `/products/${shoe("EU30").slug}`, "Rs. 2,995", "Was Rs. 2,995");
  await context.close();
});
