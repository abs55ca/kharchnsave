import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchSize, sizeSalePrice, validateSizeRules, type SizeRule } from "../lib/pricing/size-rules";
import { asRole, createDatabase, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Sales by size (supabase/migrations/20261124120000_size_sales.sql) on real
 * PostgreSQL with every migration: rules, matching, rounding, eligibility,
 * applying, conflicts with campaigns, manual sales and repricing, ending, and
 * checkout charging the same prices. Calls are made as the API makes them.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000031";
const ADMIN = "a3100000-0000-4000-8000-0000000000a3";
const USER = "b3100000-0000-4000-8000-0000000000b3";
const claims = (sub: string, aal: "aal1" | "aal2" = "aal1"): Claims => ({ sub, role: "authenticated", aal });
const ADMIN2 = claims(ADMIN, "aal2");
const j = (v: unknown) => JSON.stringify(v);
let db: TestDatabase;
let group = "";

type Err = { code?: string; hint?: string; message?: string };
type Result<T> = { data: T | null; error: Err | null };
async function call<T>(c: pg.PoolClient, who: Claims, sql: string, params: unknown[] = [], before?: () => Promise<void>): Promise<Result<T>> {
  try {
    const r = await asRole<{ r: T }>(c, who ? "authenticated" : "anon", who, sql, params, before);
    return { data: r.rows[0]?.r ?? null, error: null };
  } catch (e) {
    const err = e as Err;
    return { data: null, error: { code: err.code, hint: err.hint, message: err.message } };
  }
}
async function once<T>(who: Claims, sql: string, params: unknown[] = []) {
  const c = await db.pool.connect();
  try {
    return await call<T>(c, who, sql, params);
  } finally {
    c.release();
  }
}
async function admin<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await once<T>(ADMIN2, sql, params);
  if (r.error) throw new Error(`${sql}: ${j(r.error)}`);
  return r.data as T;
}

type DbRule = { from: number; to: number; discount_bp: number };
const dbRules = (rules: SizeRule[]): DbRule[] => rules.map((r) => ({ from: r.from, to: r.to, discount_bp: r.discountBp }));
const KIDS: SizeRule[] = [{ from: 25, to: 30, discountBp: 3000 }, { from: 36, to: 36, discountBp: 3500 }];

type Line = {
  product_id: string; item_code: string; sizes: number[]; rule: string | null; discount_bp: number | null; regular_paisa: number; current_paisa: number;
  proposed_paisa: number | null; actual_hundredths: number | null; margin: string | null; status: string; reason: string | null; detail: string | null;
  was: null | { shown: boolean; price_paisa?: number; reason?: string };
};
type Plan = { lines: Line[]; counts: { eligible: number; blocked: number; unchanged: number }; token: string; active: null | { id: string; same_rules: boolean; live: number } };
const preview = (rules: SizeRule[], def: number | null = null) => admin<Plan>("select public.admin_preview_size_sale($1, $2, $3) as r", [group, j(dbRules(rules)), def]);
const apply = (rules: SizeRule[], def: number | null, token: string, request = randomUUID()) =>
  once<{ result: string; applied?: number; counts?: Plan["counts"]; preview?: Plan; replayed?: boolean; with_was_price?: number }>(ADMIN2,
    "select public.admin_apply_size_sale($1, $2, $3, $4, $5) as r", [request, group, j(dbRules(rules)), def, token]);
const end = (request = randomUUID()) => once<{ result: string; removed?: number; changed?: number }>(ADMIN2, "select public.admin_end_size_sale($1, $2) as r", [request, group]);
const lineFor = (plan: Plan, id: string) => plan.lines.find((l) => l.product_id === id)!;

let n = 0;
type P = { id: string; code: string; skus: string[] };
/** A product in the test group, published unless told otherwise. */
async function product(sizes: number[], price: number, { publish = true, sale = null as number | null, inGroup = true } = {}): Promise<P> {
  const code = `SZ-${++n}-${randomBytes(2).toString("hex").toUpperCase()}`;
  const status = "new";
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, sale_price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), 'Size ${code}', 'Unbranded', 'kids', '{sneakers}', '${status}', 'new', 'Pink', 'Test', ${price}, ${sale ?? "null"}, 'draft', ${publish ? "current_date" : "null"});
    ${sizes.map((s) => `insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, 'new', '${code}-${s}', ${s}, 3 from public.products where item_code = '${code}';`).join("\n")}
    insert into public.product_images (product_id, src, alt, width, height) select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    ${publish ? `update public.products set publication_status = 'published' where item_code = '${code}';` : ""}
    ${inGroup ? `insert into private.product_pricing (product_id, mode, group_id) select id, 'manual', '${group}' from public.products where item_code = '${code}';` : ""}`);
  const { rows } = await db.query<{ id: string }>("select id from public.products where item_code = $1", [code]);
  return { id: rows[0].id, code, skus: sizes.map((s) => `${code}-${s}`) };
}
const prices = async (id: string) =>
  (await db.query<{ price_paisa: number; sale_price_paisa: number | null; reference_price_paisa: number | null }>(
    "select price_paisa, sale_price_paisa, reference_price_paisa from public.products where id = $1", [id])).rows[0];
async function quote(sku: string, price: number) {
  const r = await once<{ subtotal_paisa: number; lines: { unit_price_paisa: number; reference_price_paisa: number | null }[] }>(null,
    "select public.quote_order($1, $2, 'Lahore', null) as r", [GATEWAY, j([{ sku, quantity: 1, unit_price_paisa: price }])]);
  if (r.error) throw new Error(j(r.error));
  return r.data!;
}
async function startCampaign(productId: string) {
  const c = await admin<{ id: string }>("select public.admin_create_campaign($1, $2) as r", [randomUUID(), j({
    name: `Other sale ${randomBytes(2).toString("hex")}`, discount_bp: 1000, starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: null })]);
  let view = await admin<{ campaign: { version: number } }>("select public.admin_get_campaign($1) as r", [c.id]);
  await admin("select public.admin_set_campaign_selection($1, $2, $3, $4) as r", [c.id, view.campaign.version, randomUUID(), j([{ product_id: productId, state: "included" }])]);
  const plan = await admin<{ campaign: { version: number }; token: string }>("select public.admin_get_campaign($1) as r", [c.id]);
  const r = await admin<{ result: string }>("select public.admin_apply_campaign($1, $2, $3, $4) as r", [c.id, plan.campaign.version, randomUUID(), plan.token]);
  view = await admin("select public.admin_get_campaign($1) as r", [c.id]);
  return { id: c.id, result: r.result };
}

beforeAll(async () => {
  db = await createDatabase("size_sales");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'sz-admin@test.invalid'), ('${USER}', 'sz-user@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    update public.shop_settings set delivery_area_mode = 'nationwide', standard_delivery_fee_paisa = 30000,
      free_delivery_enabled = false, max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20,
      max_open_orders_per_phone = 20, place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000,
      lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000, orders_per_minute_global = 10000, orders_open = true;`);
  group = (await admin<{ id: string }>("select public.admin_create_pricing_group($1, 'Kids Sneakers SZ', 400000) as r", [randomUUID()])).id;
});
afterAll(async () => {
  await db?.close();
});

describe("access", () => {
  it("only a verified admin can read, preview, apply or end; nobody reads the tables directly", async () => {
    for (const who of [null, claims(USER), claims(USER, "aal2"), claims(ADMIN)] as Claims[]) {
      expect((await once(who, "select public.admin_size_sale_overview($1) as r", [group])).error?.code).toBe("42501");
      expect((await once(who, "select public.admin_preview_size_sale($1, '[]', null) as r", [group])).error?.code).toBe("42501");
      expect((await once(who, "select public.admin_apply_size_sale($1, $2, '[]', null, $3) as r", [randomUUID(), group, "0".repeat(64)])).error?.code).toBe("42501");
      expect((await once(who, "select public.admin_end_size_sale($1, $2) as r", [randomUUID(), group])).error?.code).toBe("42501");
    }
    const { rows } = await db.query(`select has_table_privilege('authenticated', 'private.size_sale_lines', 'select') as lines,
      has_table_privilege('anon', 'private.size_sales', 'select') as sales`);
    expect(rows[0]).toEqual({ lines: false, sales: false });
  });
});

describe("rules (database and website agree)", () => {
  it("rejects overlaps, duplicate single sizes and bad input with the same messages as the form", async () => {
    const cases: [SizeRule[], number | null][] = [
      [[...KIDS, { from: 30, to: 32, discountBp: 2000 }], null],
      [[...KIDS, { from: 36, to: 36, discountBp: 2000 }], null],
      [[{ from: 31, to: 30, discountBp: 3000 }], null],
      [[{ from: 29.3, to: 30, discountBp: 3000 }], null],
      [[{ from: 25, to: 26, discountBp: 9500 }], 50],
    ];
    for (const [rules, def] of cases) {
      const r = await once(ADMIN2, "select public.admin_preview_size_sale($1, $2, $3) as r", [group, j(dbRules(rules)), def]);
      expect(r.error).toMatchObject({ code: "PT400", hint: "invalid_size_rules" });
      expect(r.error!.message).toBe(validateSizeRules(rules, def).join(" "));
    }
  });

  it("matches every half size from EU 15 to 50 exactly as the form does (ranges, overrides, defaults)", async () => {
    const sets: [SizeRule[], number | null][] = [
      [KIDS, null],
      [[...KIDS, { from: 28, to: 28, discountBp: 1000 }], 1500],
      [[{ from: 15, to: 50, discountBp: 2000 }, { from: 29.5, to: 29.5, discountBp: 4000 }], null],
    ];
    for (const [rules, def] of sets) {
      const { rows } = await db.query<{ size: string; m: { discount_bp: number; label: string } | null }>(
        "select s::text as size, private.size_rule_match($1, $2, s) as m from generate_series(15.0, 50.0, 0.5) s", [j(dbRules(rules)), def]);
      for (const r of rows) {
        const ts = matchSize(rules, def, Number(r.size));
        expect(r.m ? { discountBp: r.m.discount_bp, label: r.m.label } : null, `EU ${r.size}`).toEqual(ts);
      }
    }
  });

  it("rounds the sale price half up to the paisa, like the form", async () => {
    const regulars = [1, 2, 3, 99, 179500, 209500, 299500, 329500, 399500, 100001, 100003, 123457];
    for (const bp of [100, 1250, 2500, 3000, 3333, 3500, 9000]) {
      const { rows } = await db.query<{ p: number }>("select private.size_sale_price(r, $1) as p from unnest($2::int[]) r", [bp, regulars]);
      expect(rows.map((r) => r.p)).toEqual(regulars.map((r) => sizeSalePrice(r, bp)));
    }
  });
});

describe("previewing, applying and ending", () => {
  it("previews each product with its rule, prices, saving and a specific reason when blocked", async () => {
    const eu24 = await product([24], 209500);
    const eu25 = await product([25], 219500);
    const eu295 = await product([29.5], 289500);
    const eu30 = await product([30], 299500);
    const eu305 = await product([30.5], 299500);
    const eu36 = await product([36], 399500);
    const two = await product([26, 27], 259500); // two sizes, same rule
    const mixed = await product([30, 31], 299500); // two sizes, different rules
    const draft = await product([28], 269500, { publish: false });
    const manual = await product([27], 259500, { sale: 199500 });
    const outside = await product([28], 269500, { inGroup: false });

    const plan = await preview(KIDS);
    const at = (p: P) => lineFor(plan, p.id);
    expect(plan.lines.some((l) => l.product_id === outside.id)).toBe(false); // other groups' products aren't touched
    expect(at(eu24)).toMatchObject({ status: "unchanged", reason: "no_rule", rule: null, proposed_paisa: null });
    expect(at(eu25)).toMatchObject({ status: "eligible", rule: "EU 25–30", discount_bp: 3000, regular_paisa: 219500, current_paisa: 219500, proposed_paisa: 153650, actual_hundredths: 3000 });
    expect(at(eu295)).toMatchObject({ status: "eligible", rule: "EU 25–30", proposed_paisa: sizeSalePrice(289500, 3000) });
    expect(at(eu30)).toMatchObject({ status: "eligible", proposed_paisa: 209650 });
    expect(at(eu305)).toMatchObject({ status: "unchanged", reason: "no_rule" });
    expect(at(eu36)).toMatchObject({ status: "eligible", rule: "EU 36", discount_bp: 3500, proposed_paisa: 259675, actual_hundredths: 3500 });
    expect(at(two)).toMatchObject({ status: "eligible", rule: "EU 25–30" });
    expect(at(mixed)).toMatchObject({ status: "blocked", reason: "sizes_differ", detail: "EU 30: EU 25–30, EU 31: no rule" });
    expect(at(draft)).toMatchObject({ status: "blocked", reason: "not_published" });
    expect(at(manual)).toMatchObject({ status: "blocked", reason: "manual_sale", current_paisa: 199500, proposed_paisa: sizeSalePrice(259500, 3000) });
    expect(at(eu25).margin).toBe("not_configured");
    // Published at that price with no sale and no minimum days set: the history supports the "was" price.
    expect(at(eu25).was).toMatchObject({ shown: true, price_paisa: 219500 });
    expect(plan.counts).toEqual({
      eligible: plan.lines.filter((l) => l.status === "eligible").length,
      blocked: plan.lines.filter((l) => l.status === "blocked").length,
      unchanged: plan.lines.filter((l) => l.status === "unchanged").length,
    });

    // A single-size rule overrides the range; a default covers unmatched sizes.
    const override = await preview([...KIDS, { from: 30, to: 30, discountBp: 1000 }], 1500);
    expect(lineFor(override, eu30.id)).toMatchObject({ rule: "EU 30", discount_bp: 1000, proposed_paisa: 269550 });
    expect(lineFor(override, eu24.id)).toMatchObject({ status: "eligible", rule: "Default", discount_bp: 1500 });
    expect(lineFor(override, mixed.id)).toMatchObject({ status: "blocked", reason: "sizes_differ", detail: "EU 30: EU 30, EU 31: Default" });

    // Apply: only the eligible products, at exactly the previewed prices; blocked ones untouched.
    const before = { manual: await prices(manual.id), draft: await prices(draft.id), eu24: await prices(eu24.id), mixed: await prices(mixed.id) };
    const quoteBefore = (await quote(eu30.skus[0], 299500)).subtotal_paisa;
    const request = randomUUID();
    const applied = await apply(KIDS, null, plan.token, request);
    expect(applied.error).toBeNull();
    expect(applied.data).toMatchObject({ result: "applied", applied: plan.counts.eligible });
    for (const l of plan.lines.filter((x) => x.status === "eligible")) {
      expect(await prices(l.product_id), l.item_code).toEqual({ price_paisa: l.regular_paisa, sale_price_paisa: l.proposed_paisa, reference_price_paisa: l.regular_paisa });
    }
    expect({ manual: await prices(manual.id), draft: await prices(draft.id), eu24: await prices(eu24.id), mixed: await prices(mixed.id) }).toEqual(before);
    // Both sizes of the two-size product get the one product price (they share a rule).
    expect((await prices(two.id)).sale_price_paisa).toBe(sizeSalePrice(259500, 3000));
    // Checkout charges the sale price; the history records it.
    expect(quoteBefore).toBe(299500);
    const q = await quote(eu30.skus[0], 209650);
    expect(q.subtotal_paisa).toBe(209650);
    expect(q.lines[0]).toMatchObject({ unit_price_paisa: 209650, reference_price_paisa: 299500 });
    const reasons = (await db.query("select reason from private.price_history where product_id = $1 order by id desc limit 1", [eu30.id])).rows[0].reason;
    expect(reasons).toBe("size_sale_start");

    // Repeats: the same request gets its original answer; a new request changes nothing.
    expect((await apply(KIDS, null, plan.token, request)).data).toMatchObject({ result: "applied", replayed: true });
    const again = await preview(KIDS);
    expect(lineFor(again, eu30.id)).toMatchObject({ status: "unchanged", reason: "already_on_this_sale" });
    expect(again.counts.eligible).toBe(0);
    expect((await apply(KIDS, null, again.token)).data).toMatchObject({ result: "nothing" });
    // An out-of-date preview is refused with the current one.
    expect((await apply(KIDS, null, plan.token)).data).toMatchObject({ result: "stale" });
    // Different rules while it runs: end it first.
    const other = await preview([{ from: 25, to: 30, discountBp: 2000 }]);
    expect(lineFor(other, eu30.id)).toMatchObject({ status: "blocked", reason: "size_sale_running_other_rules" });
    expect((await apply([{ from: 25, to: 30, discountBp: 2000 }], null, other.token)).error).toMatchObject({ code: "PT409", hint: "size_sale_running" });

    // Locked while on sale: no manual price edit, campaigns skip it, repricing skips it.
    await expect(db.exec(`update public.products set sale_price_paisa = 150000 where id = '${eu30.id}'`)).rejects.toThrow(/running sale/);
    const reprice = await admin<{ lines: { product_id: string; action: string; reason: string }[] }>("select public.admin_preview_reprice($1) as r",
      [j([{ group_id: group, max_price_paisa: 500000 }])]);
    expect(reprice.lines.find((l) => l.product_id === eu30.id)).toBeUndefined(); // manual products aren't repriced at all
    const camp = await admin<{ id: string }>("select public.admin_create_campaign($1, $2) as r", [randomUUID(), j({
      name: "Clash", discount_bp: 1000, starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: null })]);
    const cview = await admin<{ campaign: { version: number } }>("select public.admin_get_campaign($1) as r", [camp.id]);
    await admin("select public.admin_set_campaign_selection($1, $2, $3, $4) as r", [camp.id, cview.campaign.version, randomUUID(), j([{ product_id: eu30.id, state: "included" }])]);
    const cplan = await admin<{ lines: { product_id: string; action: string; reason: string }[] }>("select public.admin_get_campaign($1) as r", [camp.id]);
    expect(cplan.lines.find((l) => l.product_id === eu30.id)).toMatchObject({ action: "skip", reason: "other_sale" });

    // End: only this sale's prices are removed; regular prices and other sales stay.
    const ended = await end();
    expect(ended.data).toMatchObject({ result: "ended", removed: plan.counts.eligible, changed: 0 });
    for (const l of plan.lines.filter((x) => x.status === "eligible")) {
      expect(await prices(l.product_id)).toEqual({ price_paisa: l.regular_paisa, sale_price_paisa: null, reference_price_paisa: null });
    }
    expect(await prices(manual.id)).toEqual(before.manual);
    expect((await quote(eu30.skus[0], 299500)).subtotal_paisa).toBe(299500);
    expect((await end()).data).toMatchObject({ result: "nothing" });
    await db.exec(`delete from private.sale_campaign_products where campaign_id = '${camp.id}'; update private.sale_campaigns set status = 'cancelled', ended_at = now() where id = '${camp.id}';`);
  });

  it("doesn't overwrite a product in another sale campaign; it's blocked, named", async () => {
    const p = await product([27], 259500);
    const c = await startCampaign(p.id);
    expect(c.result).toBe("activated");
    const onCampaign = await prices(p.id);
    const plan = await preview(KIDS);
    expect(lineFor(plan, p.id)).toMatchObject({ status: "blocked", reason: "in_campaign", detail: expect.stringMatching(/^Other sale/) });
    if (plan.counts.eligible > 0) {
      expect((await apply(KIDS, null, plan.token)).data?.result).toBe("applied");
      await end();
    }
    expect(await prices(p.id)).toEqual(onCampaign);
    const view = await admin<{ campaign: { version: number } }>("select public.admin_get_campaign($1) as r", [c.id]);
    await admin("select public.admin_end_campaign($1, $2, $3, 'end') as r", [c.id, view.campaign.version, randomUUID()]);
  });

  it("explains when nothing qualifies (e.g. every product a draft), and applying changes nothing", async () => {
    const drafts = await createDatabase("size_sales_drafts");
    try {
      await drafts.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'x@test.invalid'); insert into public.admin_members (user_id) values ('${ADMIN}');`);
      const c = await drafts.pool.connect();
      const run = async <T,>(sql: string, params: unknown[]) => (await asRole<{ r: T }>(c, "authenticated", ADMIN2, sql, params)).rows[0].r;
      try {
        const g = (await run<{ id: string }>("select public.admin_create_pricing_group($1, 'Kids Sneakers', 400000) as r", [randomUUID()])).id;
        // The migration seeds the initial rules only for a group that already exists; this group was created after it.
        await drafts.exec(`
          insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status)
          values ('SZ-D-1', 'sz-d-1', 'Draft', 'Unbranded', 'kids', '{sneakers}', 'new', 'new', 'Pink', 'Test', 299500, 'draft');
          insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, 'new', 'SZ-D-1-30', 30, 1 from public.products where item_code = 'SZ-D-1';
          insert into private.product_pricing (product_id, mode, group_id) select id, 'manual', '${g}' from public.products where item_code = 'SZ-D-1';`);
        const plan = await run<Plan>("select public.admin_preview_size_sale($1, $2, null) as r", [g, j(dbRules(KIDS))]);
        expect(plan.counts).toEqual({ eligible: 0, blocked: 1, unchanged: 0 });
        expect(plan.lines[0]).toMatchObject({ reason: "not_published", proposed_paisa: 209650 });
        const r = await run<{ result: string }>("select public.admin_apply_size_sale($1, $2, $3, null, $4) as r", [randomUUID(), g, j(dbRules(KIDS)), plan.token]);
        expect(r.result).toBe("nothing");
        expect((await drafts.query("select sale_price_paisa from public.products where item_code = 'SZ-D-1'")).rows[0].sale_price_paisa).toBeNull();
        expect((await drafts.query("select count(*)::int n from private.size_sales")).rows[0].n).toBe(0);
      } finally {
        c.release();
      }
    } finally {
      await drafts.close();
    }
  });

  it("two admins applying at once: one applies, the other is told the preview is stale", async () => {
    const p = await product([33], 349500);
    const rules: SizeRule[] = [{ from: 33, to: 33, discountBp: 2000 }];
    await end();
    const plan = await preview(rules);
    expect(lineFor(plan, p.id).status).toBe("eligible");
    const results = await simultaneously(db, 2, (c, _i, wait) =>
      call<{ result: string }>(c, ADMIN2, "select public.admin_apply_size_sale($1, $2, $3, null, $4) as r", [randomUUID(), group, j(dbRules(rules)), plan.token], wait));
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.data?.result ?? r.value.error?.hint : "rejected")).sort();
    expect(outcomes).toEqual(["applied", "stale"]);
    expect((await prices(p.id)).sale_price_paisa).toBe(sizeSalePrice(349500, 2000));
    expect((await db.query("select count(*)::int n from private.size_sale_lines where product_id = $1", [p.id])).rows[0].n).toBe(1);
    await end();
  });

  it("an automatically priced shoe in a size sale isn't moved by repricing its group (named, not silent)", async () => {
    const p = await product([30], 299500);
    await db.exec(`update private.product_pricing set mode = 'auto', score = 76 where product_id = '${p.id}'`);
    const plan = await preview(KIDS);
    expect(lineFor(plan, p.id)).toMatchObject({ status: "eligible", proposed_paisa: 209650 });
    expect((await apply(KIDS, null, plan.token)).data?.result).toBe("applied");
    const reprice = await admin<{ lines: { product_id: string; action: string; reason: string }[] }>("select public.admin_preview_reprice($1) as r",
      [j([{ group_id: group, max_price_paisa: 600000 }])]);
    expect(reprice.lines.find((l) => l.product_id === p.id)).toMatchObject({ action: "skip", reason: "size_sale_running" });
    expect(await prices(p.id)).toMatchObject({ price_paisa: 299500, sale_price_paisa: 209650 });
    await end();
    expect(await prices(p.id)).toMatchObject({ price_paisa: 299500, sale_price_paisa: null });
    // Once it has ended, repricing works as before.
    const after = await admin<{ lines: { product_id: string; action: string }[] }>("select public.admin_preview_reprice($1) as r", [j([{ group_id: group, max_price_paisa: 600000 }])]);
    expect(after.lines.find((l) => l.product_id === p.id)?.action).toBe("apply");
  });

  it("leaves the promotion planner's saved assignments alone", async () => {
    const before = (await db.query("select count(*)::int n, coalesce(sum(discount_bp), 0)::int s from private.promotion_assignments")).rows[0];
    const p = await product([26], 239500);
    await db.exec(`insert into private.promotion_assignments (product_id, group_key, discount_bp, basis, proposed_regular_paisa, based_on_selling_paisa)
      values ('${p.id}', 'k', 2000, 'default_distribution', 299375, 239500)`);
    const plan = await preview(KIDS);
    await apply(KIDS, null, plan.token);
    await end();
    const after = (await db.query("select count(*)::int n, coalesce(sum(discount_bp), 0)::int s from private.promotion_assignments")).rows[0];
    expect(after).toEqual({ n: before.n + 1, s: before.s + 2000 });
  });
});
