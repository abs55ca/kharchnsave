import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createDatabase, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Permanent product deletion (supabase/migrations/20261122150000_product_deletion.sql)
 * on real PostgreSQL with every migration applied. Orders go through the same
 * admin functions the site uses. Calls are made the way Supabase's API makes
 * them: one transaction per call, as anon or authenticated with JWT claims.
 * NOT Supabase: no PostgREST, no Storage (file removal is the website's job).
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000011";
const ADMIN = "a1100000-0000-4000-8000-0000000000a1";
const USER = "b1100000-0000-4000-8000-0000000000b1";
const claims = (sub: string, aal: "aal1" | "aal2" = "aal1"): Claims => ({ sub, role: "authenticated", aal });
const ADMIN2 = claims(ADMIN, "aal2");

let db: TestDatabase;
type DbError = { code?: string; message?: string; hint?: string };
type Result<T> = { data: T | null; error: DbError | null };

async function call<T = unknown>(c: pg.PoolClient, who: Claims, sql: string, params: unknown[] = [], before?: () => Promise<void>): Promise<Result<T>> {
  try {
    const result = await asRole<{ r: T }>(c, who ? "authenticated" : "anon", who, sql, params, before);
    return { data: result.rows[0]?.r ?? null, error: null };
  } catch (error) {
    const e = error as DbError;
    return { data: null, error: { code: e.code, message: e.message, hint: e.hint } };
  }
}

async function once<T = unknown>(who: Claims, sql: string, params: unknown[] = []) {
  const c = await db.pool.connect();
  try {
    return await call<T>(c, who, sql, params);
  } finally {
    c.release();
  }
}

async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { data, error } = await once<T>(ADMIN2, sql, params);
  if (error) throw new Error(`${sql}: ${error.code} ${error.hint ?? ""} ${error.message}`);
  return data as T;
}

let productCount = 0;
type Product = { id: string; code: string; sku: string; price: number };
async function product(stock = 5, { storagePhoto = false } = {}): Promise<Product> {
  const code = `PD-${++productCount}-${randomBytes(2).toString("hex").toUpperCase()}`;
  const price = 250000;
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), 'Delete ${code}', 'Testbrand', 'men', '{sneakers}', 'new', 'new',
      'Black', 'Test', ${price}, 'draft', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, '${code}-40', 40, ${stock} from public.products where item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    ${storagePhoto ? `insert into public.product_images (product_id, storage_path, alt, width, height, sort_order)
    select id, id::text || '/' || gen_random_uuid()::text || '.webp', 'Stored', 800, 800, 1 from public.products where item_code = '${code}';` : ""}
    update public.products set publication_status = 'published' where item_code = '${code}';`);
  const { rows } = await db.query<{ id: string }>("select id from public.products where item_code = $1", [code]);
  return { id: rows[0].id, code, sku: `${code}-40`, price };
}

type Line = { sku: string; quantity: number; unit_price_paisa: number };
const line = (p: Product, quantity = 1): Line => ({ sku: p.sku, quantity, unit_price_paisa: p.price });
type Quote = { delivery_paisa: number; total_paisa: number; discount_paisa: number };

async function placeOrder(lines: Line[], code: string | null = null) {
  const q = await once<Quote>(null, "select public.quote_order($1, $2, 'Lahore', $3) as r", [GATEWAY, JSON.stringify(lines), code]);
  if (q.error) throw new Error(JSON.stringify(q.error));
  const placed = await once<{ result: string; order?: { order_number: string } }>(null, "select public.place_cod_order($1, $2, $3) as r", [
    GATEWAY, randomBytes(32).toString("base64url"), JSON.stringify({
      lines, delivery_paisa: q.data!.delivery_paisa, total_paisa: q.data!.total_paisa,
      ...(code ? { referral_code: code, discount_paisa: q.data!.discount_paisa } : {}),
      customer: { name: "Deletion Customer", phone: `+92303${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, city: "Lahore", address: "House 3, Street 3, Test Town" },
    })]);
  if (placed.error || placed.data?.result !== "placed") throw new Error(JSON.stringify(placed));
  const { rows } = await db.query<{ id: string }>("select id from public.orders where order_number = $1", [placed.data.order!.order_number]);
  return { id: rows[0].id, number: placed.data.order!.order_number };
}

const orderVersion = async (id: string) => (await db.query<{ version: number }>("select version from public.orders where id = $1", [id])).rows[0].version;

type Step = "confirm" | "dispatch" | "deliver" | "settle" | "cancel" | "return" | "refund";
async function step(orderId: string, s: Step) {
  const v = await orderVersion(orderId);
  const r = randomUUID();
  const calls: Record<Step, [string, unknown[]]> = {
    confirm: ["select public.admin_confirm_order($1, $2, $3) as r", [orderId, v, r]],
    dispatch: ["select public.admin_dispatch_order($1, $2, $3, 'TCS', 'T1') as r", [orderId, v, r]],
    deliver: ["select public.admin_mark_delivered($1, $2, $3, true) as r", [orderId, v, r]],
    settle: ["select public.admin_record_payment($1, $2, $3, 'settled', null, 'REMIT-1') as r", [orderId, v, r]],
    refund: ["select public.admin_record_payment($1, $2, $3, 'refunded', (select collected_paisa from public.orders where id = $1), 'REFUND-1') as r", [orderId, v, r]],
    cancel: ["select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [orderId, v, r]],
    return: ["select public.admin_receive_return($1, $2, $3, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'restock', quantity, 'write_off', 0)) from public.order_items where order_id = $1)) as r", [orderId, v, r]],
  };
  const [sql, params] = calls[s];
  return admin<{ result: string }>(sql, params);
}
async function steps(orderId: string, list: Step[]) {
  for (const s of list) await step(orderId, s);
}

type Preview = {
  product: { id: string; item_code: string; version: number };
  sizes: number;
  photos: number;
  orders: { id: string; order_number: string; status: string; other_products: string[]; blockers: string[]; has_referral: boolean }[];
  blocked: boolean;
  token: string;
};
type Deleted = { result: string; item_code?: string; orders_deleted?: string[]; storage_paths?: string[]; replayed?: boolean; preview?: Preview };

const preview = (id: string) => admin<Preview>("select public.admin_product_deletion_preview($1) as r", [id]);
const del = (id: string, token: string, confirm: string, request = randomUUID(), who: Claims = ADMIN2) =>
  once<Deleted>(who, "select public.admin_delete_product($1, $2, $3, $4) as r", [id, token, confirm, request]);

async function stockOf(sku: string) {
  return (await db.query<{ stock: number; reserved: number }>("select stock, reserved from public.product_variants where sku = $1", [sku])).rows[0];
}

/** Every uuid, uuid[], text and jsonb column in public and private that still mentions any of `needles`. */
async function mentions(needles: string[]) {
  const { rows: cols } = await db.query<{ tbl: string; col: string; type: string }>(`
    select format('%I.%I', n.nspname, c.relname) as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and format_type(a.atttypid, a.atttypmod) in ('uuid', 'uuid[]', 'text', 'text[]', 'jsonb')
      and c.relname <> 'product_deletions'`);
  const found: string[] = [];
  for (const { tbl, col } of cols) {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from ${tbl} where ${col}::text ~ $1`, [needles.map((s) => s.replace(/[-]/g, "\\-")).join("|")]);
    if (rows[0].n > 0) found.push(`${tbl}.${col} (${rows[0].n})`);
  }
  return found;
}

async function ledgerAddsUp(sku: string) {
  const { rows } = await db.query<{ ok: boolean }>(`
    select coalesce(sum(m.available_delta), 0) = v.stock and coalesce(sum(m.reserved_delta), 0) = v.reserved
      and (select m2.available_after = v.stock and m2.reserved_after = v.reserved from public.stock_movements m2 where m2.variant_id = v.id order by m2.id desc limit 1) as ok
    from public.product_variants v left join public.stock_movements m on m.variant_id = v.id
    where v.sku = $1 group by v.id, v.stock, v.reserved`, [sku]);
  return rows[0].ok;
}

beforeAll(async () => {
  db = await createDatabase("product_deletion");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'd-admin@test.invalid'), ('${USER}', 'd-user@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    -- TEST VALUES ONLY.
    update public.shop_settings set delivery_area_mode = 'nationwide', standard_delivery_fee_paisa = 30000,
      free_delivery_enabled = false, max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20,
      max_open_orders_per_phone = 20, place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000,
      lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000, orders_per_minute_global = 10000, orders_open = true;`);
});

afterAll(async () => {
  await db?.close();
});

describe("access", () => {
  it("only a verified admin can preview or delete; anon can't even call them", async () => {
    const p = await product();
    const token = (await preview(p.id)).token;
    for (const who of [null, claims(USER), claims(USER, "aal2"), claims(ADMIN)] as Claims[]) {
      const pr = await once(who, "select public.admin_product_deletion_preview($1) as r", [p.id]);
      expect(pr.error?.code, JSON.stringify(who)).toBe("42501");
      const d = await del(p.id, token, p.code, randomUUID(), who);
      expect(d.error?.code).toBe("42501");
    }
    const { rows } = await db.query(`select
      has_function_privilege('anon', 'public.admin_delete_product(uuid, text, text, uuid)', 'execute') as anon_delete,
      has_function_privilege('anon', 'public.admin_product_deletion_preview(uuid)', 'execute') as anon_preview,
      has_function_privilege('authenticated', 'private.product_deletion_plan(uuid)', 'execute') as auth_plan,
      has_table_privilege('authenticated', 'private.product_deletions', 'select') as auth_log`);
    expect(rows[0]).toEqual({ anon_delete: false, anon_preview: false, auth_plan: false, auth_log: false });
    expect((await db.query("select 1 from public.products where id = $1", [p.id])).rowCount).toBe(1);
  });
});

describe("deleting a product", () => {
  it("with no orders: the product, sizes, photos, pricing and its own history go; other products are untouched", async () => {
    const p = await product(3, { storagePhoto: true });
    const keep = await product(2);
    await db.exec(`insert into private.product_reference_prices (product_id, unsupported_reason) values ('${p.id}', 'test');`);
    const pv = await preview(p.id);
    expect(pv).toMatchObject({ sizes: 1, photos: 2, orders: [], blocked: false });
    const d = await del(p.id, pv.token, p.code.toLowerCase());
    expect(d.error).toBeNull();
    expect(d.data).toMatchObject({ result: "deleted", item_code: p.code, orders_deleted: [] });
    expect(d.data!.storage_paths).toHaveLength(1);
    expect(d.data!.storage_paths![0].startsWith(`${p.id}/`)).toBe(true);
    expect(await mentions([p.id, p.code])).toEqual(["public.variant_barcodes.sku_at_issue (1)"]);
    const barcode = (await db.query("select variant_id, product_id from public.variant_barcodes where sku_at_issue = $1", [p.sku])).rows[0];
    expect(barcode).toEqual({ variant_id: null, product_id: null });
    expect(await stockOf(keep.sku)).toEqual({ stock: 2, reserved: 0 });
    expect(await ledgerAddsUp(keep.sku)).toBe(true);
    const log = (await db.query("select item_code, order_numbers, actor_user_id from private.product_deletions where product_id = $1", [p.id])).rows;
    expect(log).toEqual([{ item_code: p.code, order_numbers: [], actor_user_id: ADMIN }]);
  });

  it("with finished orders: deletes those orders whole (with their other products' lines), and other products' stock still adds up", async () => {
    const p = await product(5);
    const other = await product(5);
    const untouched = await product(5);
    const delivered = await placeOrder([line(p), line(other, 2)]);
    await steps(delivered.id, ["confirm", "dispatch", "deliver", "settle"]);
    const cancelled = await placeOrder([line(p)]);
    await step(cancelled.id, "cancel");
    const returned = await placeOrder([line(p), line(other)]);
    await steps(returned.id, ["confirm", "dispatch", "deliver"]);
    await step(returned.id, "return");
    await step(returned.id, "refund");
    const unrelated = await placeOrder([line(untouched)]);
    const stockBefore = await stockOf(other.sku);

    const pv = await preview(p.id);
    expect(pv.blocked).toBe(false);
    expect(pv.orders.map((o) => [o.order_number, o.status])).toEqual([
      [delivered.number, "delivered"], [cancelled.number, "cancelled"], [returned.number, "returned"]]);
    expect(pv.orders[0].other_products).toEqual([`${other.code} Testbrand Delete ${other.code}`]);

    const d = await del(p.id, pv.token, p.code);
    expect(d.error).toBeNull();
    expect(d.data!.orders_deleted!.sort()).toEqual([delivered.number, cancelled.number, returned.number].sort());

    const ids = [delivered.id, cancelled.id, returned.id];
    expect(await mentions([...ids, ...[delivered, cancelled, returned].map((o) => o.number), p.id])).toEqual([]);
    expect((await db.query("select 1 from public.orders where id = $1", [unrelated.id])).rowCount).toBe(1);
    // The other product kept its stock and its ledger (links to the deleted orders removed).
    expect(await stockOf(other.sku)).toEqual(stockBefore);
    expect(await ledgerAddsUp(other.sku)).toBe(true);
    expect(await ledgerAddsUp(untouched.sku)).toBe(true);
    expect(await stockOf(untouched.sku)).toEqual({ stock: 4, reserved: 1 });
  });

  it("deletes the referral record and commission holds of a referred order", async () => {
    const created = await admin<{ result: string; agent: { id: string } }>("select public.admin_create_agent($1, $2) as r", [randomUUID(), JSON.stringify({
      username: `delagent${randomBytes(2).toString("hex")}`, display_name: "Deletion Agent", email: `del${randomBytes(3).toString("hex")}@test.invalid`,
      code: `DEL${randomBytes(3).toString("hex")}`.toUpperCase(), discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true })]);
    const agent = (await db.query<{ code: string; id: string }>("select code, id from public.sales_agents where id = $1", [created.agent.id])).rows[0];
    const p = await product(3);
    const o = await placeOrder([line(p)], agent.code);
    await steps(o.id, ["confirm", "dispatch", "deliver"]);
    await admin("select public.admin_set_commission_hold($1, null, $2, true, 'Customer reported a fault; checking') as r", [o.id, randomUUID()]);
    expect((await db.query("select count(*)::int n from public.commission_hold_events where order_id = $1", [o.id])).rows[0].n).toBe(1);

    const pv = await preview(p.id);
    expect(pv.orders[0]).toMatchObject({ has_referral: true, blockers: [] });
    const d = await del(p.id, pv.token, p.code);
    expect(d.error).toBeNull();
    expect(await mentions([o.id, o.number])).toEqual([]);
    expect((await db.query("select 1 from public.sales_agents where id = $1", [agent.id])).rowCount).toBe(1);
  });
});

describe("refusals (nothing deleted)", () => {
  const unchanged = async (p: Product) => {
    expect((await db.query("select 1 from public.products where id = $1", [p.id])).rowCount).toBe(1);
    expect((await db.query("select 1 from private.product_deletions where product_id = $1", [p.id])).rowCount).toBe(0);
  };

  it("an unfinished order blocks it, at every unfinished status; finishing the order unblocks it", async () => {
    const p = await product(5);
    const o = await placeOrder([line(p)]);
    for (const next of [null, "confirm", "dispatch"] as const) {
      if (next) await step(o.id, next);
      const pv = await preview(p.id);
      expect(pv.blocked).toBe(true);
      expect(pv.orders[0].blockers).toEqual(["open"]);
      const d = await del(p.id, pv.token, p.code);
      expect(d.error).toMatchObject({ code: "PT409", hint: "delete_blocked" });
    }
    await unchanged(p);
    await step(o.id, "deliver");
    const pv = await preview(p.id);
    expect(pv.blocked).toBe(false);
    expect((await del(p.id, pv.token, p.code)).data?.result).toBe("deleted");
  });

  it("a refund due blocks it", async () => {
    const p = await product(5);
    const o = await placeOrder([line(p)]);
    await steps(o.id, ["confirm", "dispatch", "deliver", "return"]);
    const status = (await db.query("select status, payment_status from public.orders where id = $1", [o.id])).rows[0];
    expect(status).toEqual({ status: "returned", payment_status: "refund_due" });
    const pv = await preview(p.id);
    expect(pv.orders[0].blockers).toEqual(["refund_due"]);
    expect((await del(p.id, pv.token, p.code)).error?.hint).toBe("delete_blocked");
    await unchanged(p);
  });

  it("paid-out agent commission blocks it", async () => {
    const created = await admin<{ agent: { id: string } }>("select public.admin_create_agent($1, $2) as r", [randomUUID(), JSON.stringify({
      username: `payagent${randomBytes(2).toString("hex")}`, display_name: "Paid Agent", email: `pay${randomBytes(3).toString("hex")}@test.invalid`,
      code: `PAY${randomBytes(3).toString("hex")}`.toUpperCase(), discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true })]);
    const agent = (await db.query<{ code: string; id: string }>("select code, id from public.sales_agents where id = $1", [created.agent.id])).rows[0];
    const p = await product(3);
    const o = await placeOrder([line(p)], agent.code);
    await steps(o.id, ["confirm", "dispatch", "deliver", "settle"]);
    await db.exec(`set local session_replication_role = replica;
      update public.orders set delivered_at = now() - interval '40 days' where id = '${o.id}';`);
    const commission = (await db.query<{ commission_paisa: string }>("select commission_paisa from public.order_referrals where order_id = $1", [o.id])).rows[0].commission_paisa;
    const paid = await admin<{ result: string }>("select public.admin_record_agent_payout($1, $2, $3, '{}', $4, current_date, 'cash') as r",
      [agent.id, randomUUID(), [o.id], Number(commission)]);
    expect(paid.result).toBe("done");
    const pv = await preview(p.id);
    expect(pv.orders[0].blockers).toEqual(["commission_paid"]);
    expect((await del(p.id, pv.token, p.code)).error?.hint).toBe("delete_blocked");
    await unchanged(p);
  });

  it("a wrong item code, a stale token, a missing product and malformed input are refused", async () => {
    const p = await product(5);
    const pv = await preview(p.id);
    expect((await del(p.id, pv.token, "PD-WRONG")).error).toMatchObject({ code: "PT400", hint: "confirm_mismatch" });
    expect((await del(p.id, "not-a-token", p.code)).error?.code).toBe("PT400");
    expect((await del(randomUUID(), pv.token, p.code)).error).toMatchObject({ code: "PT404", hint: "not_found" });

    // An order placed after the preview: stale, with the new preview.
    const o = await placeOrder([line(p)]);
    const stale = await del(p.id, pv.token, p.code);
    expect(stale.error).toBeNull();
    expect(stale.data!.result).toBe("stale");
    expect(stale.data!.preview!.orders.map((x) => x.order_number)).toEqual([o.number]);
    expect(stale.data!.preview!.blocked).toBe(true);
    // A product edit after the preview: stale too.
    await step(o.id, "cancel");
    const pv2 = await preview(p.id);
    await db.exec(`update public.products set colour = 'Red' where id = '${p.id}';`);
    expect((await del(p.id, pv2.token, p.code)).data?.result).toBe("stale");
    await unchanged(p);
  });
});

describe("requests", () => {
  it("a retry of the same request gets the original answer; reusing its id for something else is refused", async () => {
    const p = await product(5);
    const pv = await preview(p.id);
    const request = randomUUID();
    const first = await del(p.id, pv.token, p.code, request);
    expect(first.data?.result).toBe("deleted");
    const again = await del(p.id, pv.token, p.code, request);
    expect(again.data).toEqual({ ...first.data, replayed: true });
    const other = await product(5);
    const mismatch = await del(other.id, (await preview(other.id)).token, other.code, request);
    expect(mismatch.error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
  });

  it("a delete racing a checkout for the same product: either the order is refused or the delete is (never both through)", async () => {
    const p = await product(5);
    const pv = await preview(p.id);
    const lines = [line(p)];
    const q = await once<Quote>(null, "select public.quote_order($1, $2, 'Lahore', null) as r", [GATEWAY, JSON.stringify(lines)]);
    const results = await simultaneously(db, 2, (c, i, wait) =>
      i === 0
        ? call<Deleted>(c, ADMIN2, "select public.admin_delete_product($1, $2, $3, $4) as r", [p.id, pv.token, p.code, randomUUID()], wait)
        : call<{ result: string }>(c, null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, randomBytes(32).toString("base64url"), JSON.stringify({
            lines, delivery_paisa: q.data!.delivery_paisa, total_paisa: q.data!.total_paisa,
            customer: { name: "Race Customer", phone: "+923039999999", city: "Lahore", address: "House 4, Street 4, Test Town" } })], wait));
    const [d, placed] = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    const deleted = d?.data?.result === "deleted";
    const orderPlaced = (placed?.data as { result?: string } | null)?.result === "placed";
    expect(deleted && orderPlaced).toBe(false);
    if (deleted) {
      expect((await db.query("select count(*)::int n from public.order_items where sku = $1", [p.sku])).rows[0].n).toBe(0);
    } else {
      expect(d?.data?.result).toBe("stale");
      expect((await db.query("select 1 from public.products where id = $1", [p.id])).rowCount).toBe(1);
    }
  });
});

describe("the append-only guards still hold outside a deletion", () => {
  it("orders, order lines, events and the stock ledger can't be deleted directly, even by the owner", async () => {
    const p = await product(5);
    const o = await placeOrder([line(p)]);
    for (const sql of [
      `delete from public.orders where id = '${o.id}'`,
      `delete from public.order_items where order_id = '${o.id}'`,
      `delete from public.order_events where order_id = '${o.id}'`,
      `delete from public.stock_movements where order_id = '${o.id}'`,
      `update public.stock_movements set order_id = null, order_item_id = null where order_id = '${o.id}'`,
      `delete from private.price_history where product_id = '${p.id}'`,
      `delete from private.product_deletions`,
    ]) {
      await expect(db.exec(sql), sql).rejects.toThrow(/can't be changed or removed|never deleted/);
    }
  });

  it("the purge setting is cleared before the deletion returns", async () => {
    const p = await product(5);
    const pv = await preview(p.id);
    const c = await db.pool.connect();
    try {
      await asRole(c, "authenticated", ADMIN2, "select public.admin_delete_product($1, $2, $3, $4) as r", [p.id, pv.token, p.code, randomUUID()]);
      // Same session, new transaction: and inside a transaction that ran a deletion.
      expect((await c.query("select coalesce(current_setting('kns.product_purge', true), '') as v")).rows[0].v).toBe("");
      const q = await product(5);
      const pq = await preview(q.id);
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN2)]);
      await c.query("select public.admin_delete_product($1, $2, $3, $4)", [q.id, pq.token, q.code, randomUUID()]);
      await c.query("reset role");
      await expect(c.query("delete from public.stock_movements where id = (select min(id) from public.stock_movements)")).rejects.toThrow(/can't be changed/);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});
