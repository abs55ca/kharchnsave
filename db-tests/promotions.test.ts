import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proposedRegular } from "../lib/promotions/plan";
import { asRole, createDatabase, type Claims, type TestDatabase } from "./lib/db";

/*
 * Promotion planner (supabase/migrations/20261123120000_promotion_planner.sql)
 * on real PostgreSQL with every migration. The point of these tests: proposals
 * are stored on their own, and selling prices, the catalogue, price history,
 * checkout quotes and orders don't change at all.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000023";
const ADMIN = "a2300000-0000-4000-8000-0000000000a3";
const USER = "b2300000-0000-4000-8000-0000000000b3";
const claims = (sub: string, aal: "aal1" | "aal2" = "aal1"): Claims => ({ sub, role: "authenticated", aal });
const ADMIN2 = claims(ADMIN, "aal2");
let db: TestDatabase;

type Result<T> = { data: T | null; error: { code?: string; hint?: string; message?: string } | null };
async function once<T>(who: Claims, sql: string, params: unknown[] = []): Promise<Result<T>> {
  const c = await db.pool.connect();
  try {
    const r = await asRole<{ r: T }>(c as pg.PoolClient, who ? "authenticated" : "anon", who, sql, params);
    return { data: r.rows[0]?.r ?? null, error: null };
  } catch (e) {
    const err = e as { code?: string; hint?: string; message?: string };
    return { data: null, error: { code: err.code, hint: err.hint, message: err.message } };
  } finally {
    c.release();
  }
}
async function admin<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await once<T>(ADMIN2, sql, params);
  if (r.error) throw new Error(`${sql}: ${JSON.stringify(r.error)}`);
  return r.data as T;
}

type Item = {
  product_id: string; item_code: string; group_key: string; score: number | null; selling_price_paisa: number;
  assignment: null | { discount_bp: number; basis: string; proposed_regular_paisa: number; based_on_selling_paisa: number; outdated: boolean };
  verification: null | { supported: boolean; reason?: string };
};
const overview = () => admin<{ items: Item[] }>("select public.admin_promotion_overview() as r");
const save = (items: unknown[]) => admin<{ assigned: number; refreshed: number; unchanged: number }>("select public.admin_save_promotion_assignments($1) as r", [JSON.stringify(items)]);

let n = 0;
async function product(name: string, price: number, size = 30, status: "published" | "draft" = "published") {
  const code = `PRM-${++n}-${randomBytes(2).toString("hex").toUpperCase()}`;
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), '${name}', 'Unbranded', 'kids', '{sneakers}', 'new', 'new', 'Pink', 'Test', ${price}, 'draft', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock) select id, item_status, '${code}-${size}', ${size}, 3 from public.products where item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height) select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    ${status === "published" ? `update public.products set publication_status = 'published' where item_code = '${code}';` : ""}`);
  const { rows } = await db.query<{ id: string }>("select id from public.products where item_code = $1", [code]);
  return { id: rows[0].id, code, sku: `${code}-${size}` };
}

/** Everything a shopper, checkout or order can see or use, as text. */
async function snapshot() {
  const { rows } = await db.query(`select
    (select json_agg(p order by p.id)::text from public.products p) as products,
    (select json_agg(v order by v.id)::text from public.product_variants v) as variants,
    (select count(*) from private.price_history) as history,
    (select json_agg(pp order by pp.product_id)::text from private.product_pricing pp) as pricing,
    (select count(*) from public.orders) as orders`);
  return rows[0];
}

beforeAll(async () => {
  db = await createDatabase("promotions");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'pr-admin@test.invalid'), ('${USER}', 'pr-user@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    update public.shop_settings set delivery_area_mode = 'nationwide', standard_delivery_fee_paisa = 30000,
      free_delivery_enabled = false, max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20,
      max_open_orders_per_phone = 20, place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000,
      lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000, orders_per_minute_global = 10000, orders_open = true;`);
});
afterAll(async () => {
  await db?.close();
});

describe("access", () => {
  it("only a verified admin can read or save the planner; nobody else can read the proposals", async () => {
    for (const who of [null, claims(USER), claims(USER, "aal2"), claims(ADMIN)] as Claims[]) {
      expect((await once(who, "select public.admin_promotion_overview() as r")).error?.code).toBe("42501");
      expect((await once(who, "select public.admin_save_promotion_assignments('[]') as r")).error?.code).toBe("42501");
    }
    const { rows } = await db.query(`select
      has_table_privilege('anon', 'private.promotion_assignments', 'select') as anon_reads,
      has_table_privilege('authenticated', 'private.promotion_assignments', 'select') as signed_in_reads`);
    expect(rows[0]).toEqual({ anon_reads: false, signed_in_reads: false });
  });
});

describe("planning", () => {
  it("stores proposals worked out by the database, and changes no price, history, catalogue or checkout", async () => {
    const a = await product("Promo Runner — Pink", 379500, 35);
    const b = await product("Promo Runner — Pink", 299500, 30); // another size of the same model
    const c = await product("Promo Court — White", 179500, 22, "draft");
    const before = await snapshot();
    const quoteLines = [{ sku: a.sku, quantity: 1, unit_price_paisa: 379500 }, { sku: b.sku, quantity: 2, unit_price_paisa: 299500 }];
    const quote = async () => (await once(null, "select public.quote_order($1, $2, 'Lahore', null) as r", [GATEWAY, JSON.stringify(quoteLines)])).data;
    const quoteBefore = await quote();

    // The request asks for nonsense prices; only the percentage is used.
    const saved = await save([
      { product_id: a.id, discount_bp: 3500, basis: "default_distribution", proposed_regular_paisa: 1 },
      { product_id: b.id, discount_bp: 2000, basis: "default_distribution" }, // same model as a: gets 35% too
      { product_id: c.id, discount_bp: 2000, basis: "default_distribution" },
    ]);
    expect(saved).toEqual({ result: "saved", assigned: 3, refreshed: 0, unchanged: 0 });

    const items = Object.fromEntries((await overview()).items.map((i) => [i.product_id, i]));
    expect(items[a.id].assignment).toMatchObject({ discount_bp: 3500, proposed_regular_paisa: 583846, based_on_selling_paisa: 379500, outdated: false });
    expect(items[b.id].assignment).toMatchObject({ discount_bp: 3500, basis: "model_group", proposed_regular_paisa: proposedRegular(299500, 3500) });
    expect(items[c.id].assignment).toMatchObject({ discount_bp: 2000, proposed_regular_paisa: 224375 });
    // The existing reference check, applied to proposals: none of them was ever the price.
    expect(items[a.id].verification).toEqual({ supported: false, reason: "not_offered_at_price" });
    expect(items[c.id].verification).toEqual({ supported: false, reason: "not_published" });

    expect(await snapshot()).toEqual(before);
    expect(await quote()).toEqual(quoteBefore);
    const shopper = (await db.query("select price_paisa, sale_price_paisa, reference_price_paisa from public.products where id = $1", [a.id])).rows[0];
    expect(shopper).toEqual({ price_paisa: 379500, sale_price_paisa: null, reference_price_paisa: null });
  });

  it("a saved percentage never changes; a changed selling price only refreshes the proposal", async () => {
    const p = await product("Promo Stable — Blue", 259500);
    await save([{ product_id: p.id, discount_bp: 2500, basis: "default_distribution" }]);
    expect(await save([{ product_id: p.id, discount_bp: 3500, basis: "default_distribution" }])).toMatchObject({ assigned: 0, unchanged: 1 });
    await db.exec(`update public.products set price_paisa = 279500 where id = '${p.id}'`);
    const stale = (await overview()).items.find((i) => i.product_id === p.id)!;
    expect(stale.assignment).toMatchObject({ discount_bp: 2500, outdated: true });
    expect(await save([{ product_id: p.id, discount_bp: 3500, basis: "default_distribution" }])).toMatchObject({ refreshed: 1 });
    const fresh = (await overview()).items.find((i) => i.product_id === p.id)!;
    expect(fresh.assignment).toMatchObject({ discount_bp: 2500, proposed_regular_paisa: proposedRegular(279500, 2500), outdated: false });
  });

  it("a proposal passes the existing check only when the product really was offered at that price", async () => {
    const p = await product("Promo Verified — Red", 500000);
    // Its real price was Rs. 5,000 (history records it); now on a sale at Rs. 3,750.
    await db.exec(`update public.products set sale_price_paisa = 375000 where id = '${p.id}'`);
    await save([{ product_id: p.id, discount_bp: 2500, basis: "default_distribution" }]); // 3750 / 0.75 = 5000
    const item = (await overview()).items.find((i) => i.product_id === p.id)!;
    expect(item.selling_price_paisa).toBe(375000);
    expect(item.assignment?.proposed_regular_paisa).toBe(500000);
    // The run at Rs. 5,000 ended when the sale started, so the existing rule still says no:
    // a "was" price is set only by a sale campaign from the price at the moment it starts.
    expect(item.verification?.supported).toBe(false);
  });

  it("refuses other percentages and malformed requests; skips unpriced and archived products", async () => {
    const p = await product("Promo Odd — Black", 199500);
    for (const bad of [[{ product_id: p.id, discount_bp: 4000, basis: "default_distribution" }], [{ product_id: "x", discount_bp: 2000, basis: "default_distribution" }], {}]) {
      const r = await once(ADMIN2, "select public.admin_save_promotion_assignments($1) as r", [JSON.stringify(bad)]);
      expect(r.error).toMatchObject({ code: "PT400" });
    }
    const unpriced = await product("Promo Free — Grey", 0, 30, "draft");
    expect(await save([{ product_id: unpriced.id, discount_bp: 2000, basis: "default_distribution" }])).toMatchObject({ assigned: 0 });
    expect((await overview()).items.some((i) => i.product_id === unpriced.id)).toBe(false);
    expect(await save([{ product_id: randomUUID(), discount_bp: 2000, basis: "default_distribution" }])).toMatchObject({ assigned: 0 });
  });
});
