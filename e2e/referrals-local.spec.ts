import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

/*
 * Sales agents end to end: the real admin pages, agent area and checkout,
 * against a real PostgreSQL database with every migration applied. Run it
 * through scripts/e2e-checkout-local.mjs, which also starts a minimal
 * stand-in for Supabase's HTTP API and Auth (e2e/local-stack/postgrest-shim.mjs).
 * Skipped otherwise.
 *
 * What this is not: a test of real Supabase Auth (emails, invitation
 * templates, rate limits, MFA). The admin is signed in with a stand-in aal2
 * session instead of the sign-in and authenticator pages, and order delivery
 * and payment steps are made through the same database functions the admin
 * order page calls (that page reads tables the stand-in doesn't serve).
 */

const ON = process.env.E2E_LOCAL_STACK === "1";
test.skip(!ON, "Run with: node scripts/e2e-checkout-local.mjs");
test.describe.configure({ mode: "serial" });

const db = ON ? new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 4 }) : null;
const GATEWAY = process.env.E2E_GATEWAY_SECRET ?? "";
const ADMIN_ID = process.env.E2E_ADMIN_ID ?? "";
const PRICE = 150000;
const CART = "kharchnsave:cart:v1";
const suffix = randomBytes(3).toString("hex");
const agent = { username: `e2eagent${suffix}`, name: "E2E Agent", email: `e2e-agent-${suffix}@test.invalid`, password: "a-long-test-password-1", code: "", id: "" };
let image = "";

test.beforeAll(async () => {
  if (!db) return;
  image = (await db.query<{ src: string }>("select src from public.product_images where src is not null limit 1")).rows[0].src;
});
test.afterAll(async () => {
  await db?.end();
});

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** A stand-in aal2 admin session cookie (instead of the password + authenticator pages). */
async function signInAdmin(context: BrowserContext, base: string, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ sub: ADMIN_ID, email: "e2e-admin@test.invalid", role: "authenticated", aud: "authenticated", aal: "aal2", session_id: randomUUID(), iat: now + Math.min(ttl, 0) - 60, exp: now + ttl });
  const token = `${header}.${payload}.${createHmac("sha256", process.env.E2E_AUTH_SECRET!).update(`${header}.${payload}`).digest("base64url")}`;
  // ttl < 0: an expired session whose refresh token doesn't work (as after a long absence).
  const session = { access_token: token, token_type: "bearer", expires_in: ttl, expires_at: now + ttl, refresh_token: "none", user: { id: ADMIN_ID, email: "e2e-admin@test.invalid" } };
  await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64url(session)}`, url: `${base}/admin`, httpOnly: true, sameSite: "Lax" }]);
}

/** One call as the verified admin, the way the admin pages call the database. */
async function asAdmin<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const client = await db!.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_ID, role: "authenticated", aal: "aal2" })]);
    const { rows } = await client.query(sql, params);
    await client.query("commit");
    return rows[0]?.r as T;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function orderStep(orderId: string, step: string) {
  const v = (await db!.query("select version from public.orders where id = $1", [orderId])).rows[0].version;
  const sql: Record<string, string> = {
    confirm: "select public.admin_confirm_order($1, $2, $3) as r",
    dispatch: "select public.admin_dispatch_order($1, $2, $3, 'TCS', 'E2E1') as r",
    deliver: "select public.admin_mark_delivered($1, $2, $3, true) as r",
    settle: "select public.admin_record_payment($1, $2, $3, 'settled', null, 'REMIT-E2E') as r",
    cancel: "select public.admin_cancel_order($1, $2, $3, 'customer_request') as r",
    return: "select public.admin_receive_return($1, $2, $3, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'restock', quantity, 'write_off', 0)) from public.order_items where order_id = $1)) as r",
  };
  return asAdmin(sql[step], [orderId, v, randomUUID()]);
}

async function freshSize() {
  const code = `E2E-RF-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`;
  await db!.query(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), 'Referral Sneakers', 'Testbrand', 'kids', '{sneakers}', 'new', 'new',
      'Blue', 'Test', ${PRICE}, 'published', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, '${code}-40', 40, 5 from public.products where item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '${image}', 'Test', 800, 800 from public.products where item_code = '${code}';`);
  return `${code}-40`;
}

/** An order with a code, placed straight through the guest checkout function (as the website would). */
async function placeWithCode(sku: string, code: string, quantity = 1) {
  const lines = [{ sku, quantity, unit_price_paisa: PRICE }];
  const quote = (await db!.query("select public.quote_order($1, $2, 'Lahore', $3) as r", [GATEWAY, JSON.stringify(lines), code])).rows[0].r;
  const body = { lines, delivery_paisa: quote.delivery_paisa, total_paisa: quote.total_paisa, referral_code: code, discount_paisa: quote.discount_paisa,
    customer: { name: "Second Customer", phone: "+923001112223", city: "Lahore", address: "House 2, Street 3, Test Town" } };
  const placed = (await db!.query("select public.place_cod_order($1, $2, $3) as r", [GATEWAY, randomBytes(32).toString("base64url"), JSON.stringify(body)])).rows[0].r;
  expect(placed.result).toBe("placed");
  return (await db!.query<{ id: string; order_number: string }>("select id, order_number from public.orders where order_number = $1", [placed.order.order_number])).rows[0];
}

async function backdateDelivery(orderId: string, hours: number) {
  const client = await db!.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica"); // fixture only: the guard would refuse
    await client.query("update public.orders set delivered_at = now() - make_interval(hours => $2) where id = $1", [orderId, hours]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

let agentPage: Page;
let adminPage: Page;
let firstOrder: { id: string; order_number: string };

test("an admin creates an agent; the agent sets a password, signs in and sees only their own figures", async ({ browser, baseURL }) => {
  const adminContext = await browser.newContext({ baseURL });
  await signInAdmin(adminContext, baseURL!);
  adminPage = await adminContext.newPage();
  await adminPage.goto("/admin/agents");
  await expect(adminPage.getByRole("heading", { name: "Sales agents" }).filter({ visible: true }).first()).toBeVisible();

  await adminPage.getByLabel("Username").fill(agent.username);
  agent.code = agent.username.toUpperCase();
  await expect(adminPage.getByLabel("Referral code")).toHaveValue(agent.code);
  await expect(adminPage.getByText(`${agent.code} is available.`).filter({ visible: true }).first()).toBeVisible();
  await adminPage.getByLabel("Display name").fill(agent.name);
  await adminPage.getByLabel("Email (their login)").fill(agent.email);
  await adminPage.getByLabel("Agent commission (%)").fill("5");
  await adminPage.getByRole("radio", { name: /No: sale items/ }).check();
  await adminPage.getByRole("checkbox", { name: /Enable the code now/ }).check();
  await adminPage.getByRole("button", { name: "Create agent and password link" }).click();
  await expect(adminPage.getByText(/Password link \(shown once/).filter({ visible: true }).first()).toBeVisible();
  const link = (await adminPage.locator("p.font-mono").first().textContent())!.trim();
  expect(link).toMatch(/\/agent\/auth\/confirm\?token_hash=[0-9a-f]+&type=invite$/);
  agent.id = (await db!.query("select id from public.sales_agents where username = $1", [agent.username])).rows[0].id;

  // A different agent with an order of their own, made through the same functions.
  const other = `e2eother${suffix}`;
  const created = await asAdmin<{ agent: { id: string } }>("select public.admin_create_agent($1, $2) as r", [randomUUID(), JSON.stringify({
    username: other, display_name: "Other Agent", email: `${other}@test.invalid`, code: `OTHER${suffix}`.toUpperCase(),
    discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true })]);
  const otherOrder = await placeWithCode(await freshSize(), `OTHER${suffix}`);

  // The agent opens the link on their phone.
  const agentContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  agentPage = await agentContext.newPage();
  await agentPage.goto(link);
  await expect(agentPage).toHaveURL(/\/agent\/set-password$/);
  await agentPage.getByLabel("New password").fill(agent.password);
  await agentPage.getByLabel("Type it again").fill(agent.password);
  await agentPage.getByRole("button", { name: "Save password" }).click();
  await expect(agentPage).toHaveURL(/\/agent$/);
  await expect(agentPage.getByRole("heading", { name: `Hi, ${agent.name}` }).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText(agent.code, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText(/Customers get 10% off qualifying products \(not items already on sale\)/).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("No orders with your code yet.").filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.locator("main")).not.toContainText(otherOrder.order_number);
  expect(created.agent.id).not.toBe(agent.id);

  // The link works once; signing out and in again works with the new password.
  await agentPage.goto(link);
  await expect(agentPage).toHaveURL(/\/agent\/login\?link=expired$/);
  await agentPage.goto("/agent");
  await agentPage.getByRole("button", { name: "Sign out" }).click();
  await expect(agentPage).toHaveURL(/\/agent\/login$/);
  await agentPage.goto("/agent");
  await expect(agentPage).toHaveURL(/\/agent\/login/);
  // Next.js keeps a previously visited page hidden in the document: use the visible form.
  await agentPage.getByLabel("Email address").filter({ visible: true }).fill(agent.email);
  await agentPage.getByLabel("Password").filter({ visible: true }).fill(agent.password);
  await agentPage.getByRole("button", { name: "Sign in" }).filter({ visible: true }).click();
  await expect(agentPage.getByRole("heading", { name: `Hi, ${agent.name}` }).filter({ visible: true }).first()).toBeVisible();

  // The agent's session never reaches the admin area.
  await agentPage.goto("/admin/agents");
  await expect(agentPage).toHaveURL(/\/admin\/login/);
});

test("a shopper applies a wrong code, removes it, applies the agent's code and places the order", async ({ browser, baseURL }) => {
  const sku = await freshSize();
  const shopper = await (await browser.newContext({ baseURL })).newPage();
  await shopper.goto("/cart");
  await shopper.evaluate(([key, line]) => localStorage.setItem(key as string, JSON.stringify([line])), [CART, {
    sku, productId: "x", slug: "e2e-referral", name: "Referral Sneakers", brand: "Testbrand", size: 40,
    price: PRICE / 100, status: "new", condition: "new", image: { src: image, alt: "Test" }, maxQuantity: 5, quantity: 1,
  }] as const);
  await shopper.goto("/checkout");
  await shopper.getByLabel("Full name").fill("Referral Shopper");
  await shopper.getByLabel("Mobile number").fill("0300 7654321");
  await shopper.getByLabel("City").fill("Lahore");
  await shopper.getByLabel("Full address").fill("House 7, Street 7, Model Town");
  await expect(shopper.getByRole("button", { name: /Place order · pay Rs\. 1,800/ })).toBeEnabled({ timeout: 30_000 });

  await shopper.getByLabel("Referral code (optional)").fill("nope123");
  await shopper.getByRole("button", { name: "Apply" }).click();
  await expect(shopper.getByText("We don’t recognise this code.", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(shopper.getByRole("button", { name: /^Place order/ })).toBeDisabled();
  await shopper.getByRole("button", { name: "Remove" }).click();

  await shopper.getByLabel("Referral code (optional)").fill(` ${agent.code.toLowerCase()} `);
  await shopper.getByRole("button", { name: "Apply" }).click();
  await expect(shopper.getByText(`Referral discount (${agent.code}, 10%)`).filter({ visible: true }).first()).toBeVisible();
  await expect(shopper.getByText("−Rs. 150").filter({ visible: true }).first()).toBeVisible();
  // Rs. 1,500 - 150 + 300 delivery.
  await shopper.getByRole("button", { name: /Place order · pay Rs\. 1,650 on delivery/ }).click();
  await expect(shopper).toHaveURL(/\/order#k=/);
  await expect(shopper.getByText(`Referral discount (${agent.code})`).filter({ visible: true }).first()).toBeVisible();
  await expect(shopper.locator("main")).not.toContainText(/commission/i);

  firstOrder = (await db!.query("select o.id, o.order_number from public.orders o join public.order_referrals r on r.order_id = o.id where r.agent_id = $1", [agent.id])).rows[0];
  const snapshot = (await db!.query("select discount_paisa, commission_paisa, commission_bp from public.order_referrals where order_id = $1", [firstOrder.id])).rows[0];
  expect(snapshot).toEqual({ discount_paisa: "15000", commission_paisa: "6750", commission_bp: 500 });
});

test("delivery, the 30-day hold, courier payment and the admin's payout show up for the agent", async () => {
  await agentPage.goto("/agent");
  await expect(agentPage.getByText(firstOrder.order_number).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("Estimated: not delivered yet").filter({ visible: true }).first()).toBeVisible();

  for (const step of ["confirm", "dispatch", "deliver"]) await orderStep(firstOrder.id, step);
  await agentPage.reload();
  await expect(agentPage.getByText(/Held for 30 days after delivery until/).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByRole("heading", { name: "Next releases" }).filter({ visible: true }).first()).toBeVisible();

  await backdateDelivery(firstOrder.id, 721);
  await agentPage.reload();
  await expect(agentPage.getByText("Waiting for the courier to pay the shop", { exact: true }).filter({ visible: true }).first()).toBeVisible();

  await orderStep(firstOrder.id, "settle");
  await agentPage.reload();
  await expect(agentPage.getByText("Available: will be paid").filter({ visible: true }).first()).toBeVisible();

  await adminPage.goto(`/admin/agents/${agent.id}`);
  await expect(adminPage.getByText(`Order ${firstOrder.order_number}`).filter({ visible: true }).first()).toBeVisible();
  await expect(adminPage.getByText("Selected total: Rs. 67.50").filter({ visible: true }).first()).toBeVisible();
  await adminPage.getByLabel("Reference (optional)").filter({ visible: true }).fill("EP-123");
  await adminPage.getByRole("button", { name: "Record payout" }).filter({ visible: true }).click();
  await expect(adminPage.getByText("Payout recorded.").filter({ visible: true }).first()).toBeVisible();

  await agentPage.reload();
  await expect(agentPage.getByText("Paid", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("Ref. EP-123").filter({ visible: true }).first()).toBeVisible();
});

test("a return after payout is deducted; a cancelled order earns nothing", async () => {
  await orderStep(firstOrder.id, "return");
  const cancelled = await placeWithCode(await freshSize(), agent.code);
  await orderStep(cancelled.id, "cancel");

  await agentPage.reload();
  await expect(agentPage.getByText("Returned: no commission").filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("Cancelled: no commission").filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText(/was returned after its commission was paid/).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("applies to your next payout", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  await expect(agentPage.getByText("−Rs. 67.50").filter({ visible: true }).first()).toBeVisible();

  await adminPage.reload();
  await expect(adminPage.getByText(/Return after payout: Order .* was returned/).filter({ visible: true }).first()).toBeVisible();
});

test("admin edits without reloading: repeated saves, a retried lost answer, code off/on, suspend/restore", async () => {
  adminPage.on("dialog", (dialog) => void dialog.accept());
  await adminPage.goto(`/admin/agents/${agent.id}`);
  // Forms are found by a field: their button's label changes while a save is unconfirmed.
  const terms = adminPage.locator("form").filter({ visible: true }).filter({ has: adminPage.getByLabel("Customer discount (%)") });
  const discount = async () => (await db!.query("select discount_bp from public.sales_agents where id = $1", [agent.id])).rows[0].discount_bp;

  // Two saves of the same form in a row: both are applied (each gets a new request id).
  await terms.getByLabel("Customer discount (%)").fill("12");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect.poll(discount).toBe(1200);
  await terms.getByLabel("Customer discount (%)").fill("15");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect.poll(discount).toBe(1500);

  // The answer is lost after the change was applied; trying again is recognised, not applied twice.
  await adminPage.route("**/admin/agents/**", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.fetch();
      await route.abort("connectionreset");
    } else {
      await route.continue();
    }
  });
  await terms.getByLabel("Customer discount (%)").fill("17");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText(/No answer, so we can’t tell whether this was saved/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  await terms.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(terms.getByText("Already saved earlier.")).toBeVisible();
  expect(await discount()).toBe(1700);
  const changes = await db!.query("select count(*)::int n from public.sales_agent_events where agent_id = $1 and kind = 'terms_changed'", [agent.id]);
  expect(changes.rows[0].n).toBe(3);

  // Toggles without reloading: each new form carries the version the previous change produced.
  await adminPage.getByRole("button", { name: "Stop accepting the code" }).filter({ visible: true }).click();
  await adminPage.getByRole("button", { name: "Accept the code at checkout" }).filter({ visible: true }).click();
  await expect(adminPage.getByRole("button", { name: "Stop accepting the code" }).filter({ visible: true })).toBeVisible();
  await adminPage.getByRole("button", { name: "Suspend their access" }).filter({ visible: true }).click();
  await adminPage.getByRole("button", { name: "Restore their access" }).filter({ visible: true }).click();
  await expect(adminPage.getByRole("button", { name: "Suspend their access" }).filter({ visible: true })).toBeVisible();
  const { rows } = await db!.query("select code_enabled, access_status, discount_bp from public.sales_agents where id = $1", [agent.id]);
  expect(rows[0]).toEqual({ code_enabled: true, access_status: "active", discount_bp: 1700 });
});

/** Lets Server Action calls reach the server but drops their responses (the outcome is then unknown in the browser). */
async function dropActionAnswers(page: Page) {
  await page.route("**/admin/**", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await route.fetch();
      await route.abort("connectionreset");
    } else {
      await route.continue();
    }
  });
}

test("unconfirmed saves: the exact request is retried, other forms wait, newer changes aren't adopted, refusals can be corrected", async () => {
  // Forms are found by a field: their button's label changes while a save is unconfirmed.
  const visible = (field: string) => adminPage.locator("form").filter({ visible: true }).filter({ has: adminPage.getByLabel(field) });
  const row = async () => (await db!.query("select discount_bp, display_name, version from public.sales_agents where id = $1", [agent.id])).rows[0];
  const termsChanges = async () => (await db!.query("select count(*)::int n from public.sales_agent_events where agent_id = $1 and kind = 'terms_changed'", [agent.id])).rows[0].n;
  await adminPage.goto(`/admin/agents/${agent.id}`);
  let terms = visible("Customer discount (%)");
  const before = await termsChanges();

  // 1. Applied, answer dropped; a visible field is edited; the retry sends the ORIGINAL request.
  await dropActionAnswers(adminPage);
  await terms.getByLabel("Customer discount (%)").fill("21");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  await terms.getByLabel("Customer discount (%)").fill("25");
  await terms.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(terms.getByText("Already saved earlier.")).toBeVisible();
  expect((await row()).discount_bp).toBe(2100);
  expect(await termsChanges()).toBe(before + 1);

  // 2. Another form on the page waits while a save is unconfirmed.
  await dropActionAnswers(adminPage);
  await terms.getByLabel("Customer discount (%)").fill("26");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  const profile = visible("Display name");
  await expect(profile.getByText("Resolve the unconfirmed “Save terms” first", { exact: false })).toBeVisible();
  await expect(profile.getByRole("button", { name: "Save profile" })).toBeDisabled();
  await terms.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(terms.getByText("Already saved earlier.")).toBeVisible();
  await profile.getByLabel("Display name").fill("E2E Agent Renamed");
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect(profile.getByText("Saved.")).toBeVisible();
  expect(await row()).toMatchObject({ discount_bp: 2600, display_name: "E2E Agent Renamed" });

  // 3. Another admin changes the agent while a save is unconfirmed: the retry reports its own result,
  //    and the page doesn't adopt the other admin's version (its next edit is refused, their change stays).
  await dropActionAnswers(adminPage);
  await terms.getByLabel("Customer discount (%)").fill("27");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  const current = await row();
  await asAdmin("select public.admin_update_agent_profile($1, $2, $3, $4, 'Changed By Other Admin') as r", [agent.id, current.version, randomUUID(), agent.username]);
  await terms.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(terms.getByText("Already saved earlier.")).toBeVisible();
  await profile.getByLabel("Display name").fill("Stale Rename");
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect(profile.getByText(/changed since you opened the page/)).toBeVisible();
  expect(await row()).toMatchObject({ discount_bp: 2700, display_name: "Changed By Other Admin" });

  // 4. A confirmed refusal (invalid input) doesn't trap the form: correct it and save.
  await adminPage.goto(`/admin/agents/${agent.id}`);
  terms = visible("Customer discount (%)");
  await terms.getByLabel("Customer discount (%)").fill("60");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText(/percentages from 0 to 50/)).toBeVisible();
  await expect(terms.getByRole("button", { name: "Save terms" })).toBeEnabled();
  await terms.getByLabel("Customer discount (%)").fill("20");
  await terms.getByRole("button", { name: "Save terms" }).click();
  await expect(terms.getByText("Saved.")).toBeVisible();
  expect((await row()).discount_bp).toBe(2000);

  // 5. A payout whose answer is dropped: the retry is recognised; one payout.
  const order = await placeWithCode(await freshSize(), agent.code, 2);
  for (const step of ["confirm", "dispatch", "deliver", "settle"]) await orderStep(order.id, step);
  await backdateDelivery(order.id, 721);
  await adminPage.goto(`/admin/agents/${agent.id}`);
  const payouts = async () => (await db!.query("select count(*)::int n from public.agent_payouts where agent_id = $1", [agent.id])).rows[0].n;
  const paidBefore = await payouts();
  const payoutForm = visible("Payment date");
  await dropActionAnswers(adminPage);
  await payoutForm.getByRole("button", { name: "Record payout" }).click();
  await expect(payoutForm.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  await payoutForm.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(adminPage.getByText("Already recorded.").filter({ visible: true }).first()).toBeVisible();
  expect(await payouts()).toBe(paidBefore + 1);
  expect((await db!.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [order.id])).rows[0].n).toBe(1);
});

test("commission hold form: a release form opened in another tab can't release a newer hold", async ({ browser, baseURL }) => {
  const order = await placeWithCode(await freshSize(), agent.code);
  for (const step of ["confirm", "dispatch", "deliver", "settle"]) await orderStep(order.id, step);
  await backdateDelivery(order.id, 721);
  await asAdmin("select public.admin_set_commission_hold($1, null, $2, true, 'Hold 1: customer reported a fault') as r", [order.id, randomUUID()]);

  const context = await browser.newContext({ baseURL });
  await signInAdmin(context, baseURL!);
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto(`/admin/orders/${order.id}`);
  await expect(tabA.getByRole("button", { name: "Release the hold" }).filter({ visible: true })).toBeVisible();
  await tabB.goto(`/admin/orders/${order.id}`);

  // Tab B releases hold #1, then places hold #2 for a new dispute.
  await tabB.getByLabel("Why release it?").filter({ visible: true }).fill("First dispute settled");
  await tabB.getByRole("button", { name: "Release the hold" }).filter({ visible: true }).click();
  await expect(tabB.getByText("Hold released.").filter({ visible: true })).toBeVisible();
  await expect(tabB.getByRole("button", { name: "Put commission on hold" }).filter({ visible: true })).toBeVisible();
  await tabB.getByLabel(/Why hold it/).filter({ visible: true }).fill("Hold 2: a new dispute");
  await tabB.getByRole("button", { name: "Put commission on hold" }).filter({ visible: true }).click();
  await expect(tabB.getByText("Commission put on hold.").filter({ visible: true })).toBeVisible();

  // Tab A still shows the release form for hold #1.
  await tabA.getByLabel("Why release it?").filter({ visible: true }).fill("Releasing hold 1 from the old tab");
  await tabA.getByRole("button", { name: "Release the hold" }).filter({ visible: true }).click();
  await expect(tabA.getByText(/hold changed since you opened the page/).filter({ visible: true })).toBeVisible();

  const state = (await db!.query("select state from private.commission_rows($1) where order_id = $2", [agent.id, order.id])).rows[0].state;
  expect(state).toBe("on_hold");
  await expect(asAdmin("select public.admin_record_agent_payout($1, $2, $3, '{}', 1, current_date, 'cash') as r", [agent.id, randomUUID(), [order.id]]))
    .rejects.toMatchObject({ hint: "on_hold" });
  const { rows } = await db!.query("select reason from public.commission_hold_events where order_id = $1 order by id", [order.id]);
  expect(rows.map((r) => r.reason)).toEqual(["Hold 1: customer reported a fault", "First dispute settled", "Hold 2: a new dispute"]);
  await context.close();
});

test("an unconfirmed adjustment and payout survive an expired session; after signing in again, each retry is recorded once", async ({ baseURL }) => {
  const context = adminPage.context();
  const agentPath = `/admin/agents/${agent.id}`;
  const formWith = (field: string) => adminPage.locator("form").filter({ visible: true }).filter({ has: adminPage.getByLabel(field) });
  // The request ids actually sent, per form.
  const sent: { form: string; requestId: string }[] = [];
  const listener = (r: import("@playwright/test").Request) => {
    if (r.method() !== "POST" || !r.headers()["next-action"]) return;
    const body = r.postData() ?? "";
    // Next.js prefixes Server Action form fields (e.g. "_1_requestId").
    const field = (name: string) => new RegExp(`name="(?:_?\\d+_)?${name}"\r\n\r\n([^\r]*)`).exec(body)?.[1];
    const requestId = field("requestId");
    if (requestId && field("direction")) sent.push({ form: "adjustment", requestId });
    if (requestId && field("paidOn")) sent.push({ form: "payout", requestId });
  };
  adminPage.on("request", listener);
  /** The retry with an expired session: either the form says so, or (as Supabase clears the cookie) the page goes to sign-in. */
  async function retryWhileSignedOut(form: ReturnType<typeof formWith>) {
    await signInAdmin(context, baseURL!, -3600);
    await form.getByRole("button", { name: "Retry unconfirmed save" }).click();
    await Promise.race([
      adminPage.waitForURL(/\/admin\/login\?next=/),
      expect(form.getByText(/You’re signed out, so your earlier save couldn’t be checked/)).toBeVisible(),
    ]);
    // Sign in again (the stand-in session), and come back to the page.
    await signInAdmin(context, baseURL!);
    await adminPage.goto(agentPath);
  }
  const reason = `E2E bonus ${suffix} (session expiry test)`;
  const adjustments = async () => (await db!.query("select count(*)::int n from public.agent_adjustments where agent_id = $1 and reason = $2", [agent.id, reason])).rows[0].n;

  await adminPage.goto(agentPath);
  let adjust = formWith("Reason (required)");
  await adjust.getByLabel("Type").selectOption("add");
  await adjust.getByLabel("Reason (required)").fill(reason);

  // A confirmed refusal of a new request can be corrected.
  await adjust.getByLabel("Amount (Rs.)").fill("abc");
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adjust.getByText("Enter the amount in rupees", { exact: false })).toBeVisible();
  await adjust.getByLabel("Amount (Rs.)").fill("5");

  // Committed, answer dropped.
  await dropActionAnswers(adminPage);
  await adjust.getByRole("button", { name: "Record adjustment" }).click();
  await expect(adjust.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  expect(await adjustments()).toBe(1);

  // The session expires; the retry can't be checked. After signing in again the request is still unconfirmed.
  await retryWhileSignedOut(adjust);
  expect(await adjustments()).toBe(1);
  adjust = formWith("Reason (required)");
  await expect(adjust.getByText(/An earlier save from this form wasn’t confirmed/)).toBeVisible();
  await expect(formWith("Customer discount (%)").getByText("Resolve the unconfirmed “Record adjustment” first", { exact: false })).toBeVisible();
  await adjust.getByRole("button", { name: "Retry unconfirmed save" }).click();
  await expect(adjust.getByText("Already recorded.")).toBeVisible();
  expect(await adjustments()).toBe(1);
  const adjustmentIds = sent.filter((x) => x.form === "adjustment").map((x) => x.requestId);
  expect(adjustmentIds).toHaveLength(4); // refused, dropped, blocked, recognised
  expect(adjustmentIds[0]).not.toBe(adjustmentIds[1]); // a refusal of a new request is corrected as a new request
  expect(new Set(adjustmentIds.slice(1)).size).toBe(1); // the original id from the unconfirmed send onwards
  await expect(formWith("Customer discount (%)").getByRole("button", { name: "Save terms" })).toBeEnabled();

  // The same for a payout.
  const order = await placeWithCode(await freshSize(), agent.code, 2);
  for (const step of ["confirm", "dispatch", "deliver", "settle"]) await orderStep(order.id, step);
  await backdateDelivery(order.id, 721);
  const payouts = async () => (await db!.query("select count(*)::int n from public.agent_payouts where agent_id = $1", [agent.id])).rows[0].n;
  const paidBefore = await payouts();
  await adminPage.goto(agentPath);
  let payout = formWith("Payment date");
  await dropActionAnswers(adminPage);
  await payout.getByRole("button", { name: "Record payout" }).click();
  await expect(payout.getByText(/No answer, so we can’t tell/)).toBeVisible();
  await adminPage.unrouteAll({ behavior: "ignoreErrors" });
  expect(await payouts()).toBe(paidBefore + 1);
  await retryWhileSignedOut(payout);
  payout = formWith("Payment date");
  await expect(payout.getByText(/An earlier save from this form wasn’t confirmed/)).toBeVisible();
  await payout.getByRole("button", { name: "Retry unconfirmed save" }).click();
  // Recognised; with nothing left to pay the form gives way to "Nothing is available", keeping the result.
  await expect(adminPage.getByText("Already recorded.").filter({ visible: true }).first()).toBeVisible();
  expect(await payouts()).toBe(paidBefore + 1);
  expect((await db!.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [order.id])).rows[0].n).toBe(1);
  const payoutIds = sent.filter((x) => x.form === "payout").map((x) => x.requestId);
  expect(payoutIds).toHaveLength(3); // dropped, blocked, recognised
  expect(new Set(payoutIds).size).toBe(1);
  adminPage.off("request", listener);
});
