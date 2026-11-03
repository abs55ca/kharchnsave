import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbRetry, type DbResult } from "@/lib/db/retry";
import { asRole, createDatabase, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Races on real PostgreSQL: many connections, released at the same moment
 * (see simultaneously()), calling the database functions the way Supabase's
 * API does (as anon or as a verified admin, one transaction per call). After
 * every test the stock ledger must still reconcile.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000001";
const ADMIN = "e0e0e0e0-0000-4000-8000-00000000000e";
const ADMIN_CLAIMS: Claims = { sub: ADMIN, role: "authenticated", aal: "aal2" };
const PRICE = 245000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createDatabase("concurrency");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'race-admin@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    -- TEST VALUES ONLY: generous limits so the races, not the limits, decide.
    update public.shop_settings set delivery_area_mode = 'nationwide', free_delivery_enabled = false,
      max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20, max_open_orders_per_phone = 20,
      place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000, lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000,
      orders_per_minute_global = 10000, orders_open = true;
  `);
});

afterAll(async () => {
  await db?.close();
});

const checkoutKey = () => randomBytes(32).toString("base64url");
let productCount = 0;

/** A published product with the given sizes; returns its SKUs. */
async function product(itemStatus: "new" | "preloved", sizes: { size: number; stock: number }[], price = PRICE) {
  const code = `RACE-${++productCount}`;
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, publication_status, listed_at)
    values ('${code}', 'race-${productCount}', 'Race test', 'Testbrand', 'men', '{sneakers}', '${itemStatus}',
      '${itemStatus === "new" ? "new" : "good"}', 'Black', 'Test', ${price}, 'published', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select p.id, p.item_status, '${code}-' || s.size, s.size, s.stock
    from public.products p, (values ${sizes.map((s) => `(${s.size}, ${s.stock})`).join(", ")}) s(size, stock)
    where p.item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
  `);
  return { code, skus: sizes.map((s) => `${code}-${s.size}`) };
}

type Line = { sku: string; quantity: number; unit_price_paisa: number };

function order(lines: Line[], delivery = 30000, phone = `+92300${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`) {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_price_paisa, 0);
  return {
    lines,
    delivery_paisa: delivery,
    total_paisa: subtotal + delivery,
    customer: { name: "Race Customer", phone, city: "Lahore", address: "House 1, Street 2, Test Town" },
  };
}

async function call<T = unknown>(
  client: pg.PoolClient,
  role: "anon" | "authenticated",
  sql: string,
  params: unknown[],
  before?: () => Promise<void>,
): Promise<DbResult<T>> {
  try {
    const result = await asRole<{ r: T }>(client, role, role === "anon" ? null : ADMIN_CLAIMS, sql, params, before);
    return { data: result.rows[0]?.r ?? null, error: null };
  } catch (error) {
    const e = error as { code?: string; message?: string; hint?: string };
    return { data: null, error: { code: e.code, message: e.message, hint: e.hint } };
  }
}

const place = (client: pg.PoolClient, key: string, body: object, before?: () => Promise<void>) =>
  call<{ result: string; order?: { order_number: string } }>(
    client, "anon", "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, key, body], before);

async function stockOf(sku: string) {
  const { rows } = await db.query<{ stock: number; reserved: number }>(
    "select stock, reserved from public.product_variants where sku = $1", [sku]);
  return rows[0];
}

async function ledgerProblems() {
  const { rows } = await db.query<{ sku: string }>(`
    select v.sku from public.product_variants v
    left join (select variant_id, sum(available_delta) a, sum(reserved_delta) r from public.stock_movements group by variant_id) m
      on m.variant_id = v.id
    where coalesce(m.a, 0) <> v.stock or coalesce(m.r, 0) <> v.reserved
       or v.reserved <> coalesce((select sum(oi.quantity) from public.order_items oi join public.orders o on o.id = oi.order_id
                                  where oi.variant_id = v.id and o.status in ('awaiting_confirmation', 'confirmed')), 0)`);
  return rows.map((r) => r.sku);
}

const results = <T>(settled: PromiseSettledResult<DbResult<T>>[]) =>
  settled.map((s) => {
    if (s.status === "rejected") throw s.reason;
    return s.value;
  });

describe("the last pair", () => {
  it("20 buyers at once, 1 pre-loved pair: exactly one order", async () => {
    const { skus } = await product("preloved", [{ size: 42, stock: 1 }]);
    const body = (i: number) => order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }], 30000, `+92300${String(1000000 + i)}`);
    const out = results(await simultaneously(db, 20, (client, i, wait) => place(client, checkoutKey(), body(i), wait)));

    expect(out.filter((r) => r.error)).toEqual([]);
    expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(1);
    expect(out.filter((r) => r.data?.result === "quote_changed")).toHaveLength(19);
    expect(await stockOf(skus[0])).toEqual({ stock: 0, reserved: 1 });
    expect(await ledgerProblems()).toEqual([]);
  });

  it("8 buyers at once, 5 in stock: exactly five orders", async () => {
    const { skus } = await product("new", [{ size: 20, stock: 5 }]);
    const out = results(await simultaneously(db, 8, (client, i, wait) =>
      place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }], 30000, `+92301${String(1000000 + i)}`), wait)));
    expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(5);
    expect(out.filter((r) => r.data?.result === "quote_changed")).toHaveLength(3);
    expect(await stockOf(skus[0])).toEqual({ stock: 0, reserved: 5 });
    expect(await ledgerProblems()).toEqual([]);
  });

  it("carts with the same sizes in opposite order: no deadlock, stock never oversold", async () => {
    const { skus } = await product("new", [{ size: 30, stock: 6 }, { size: 31, stock: 6 }]);
    const [a, b] = skus;
    const out = results(await simultaneously(db, 16, (client, i, wait) => {
      const lines = [{ sku: a, quantity: 1, unit_price_paisa: PRICE }, { sku: b, quantity: 1, unit_price_paisa: PRICE }];
      return place(client, checkoutKey(), order(i % 2 ? lines : [...lines].reverse(), 30000, `+92302${String(1000000 + i)}`), wait);
    }));
    expect(out.filter((r) => r.error)).toEqual([]);
    expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(6);
    expect(await stockOf(a)).toEqual({ stock: 0, reserved: 6 });
    expect(await stockOf(b)).toEqual({ stock: 0, reserved: 6 });
    expect(await ledgerProblems()).toEqual([]);
  });

  it("online order and in-store sale for the last pair at once: exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const { skus } = await product("preloved", [{ size: 41, stock: 1 }]);
      const line = { sku: skus[0], quantity: 1, unit_price_paisa: PRICE };
      const out = results(await simultaneously(db, 2, (client, i, wait) =>
        i === 0
          ? place(client, checkoutKey(), order([line]), wait)
          : call<{ result: string }>(client, "authenticated", "select public.admin_record_in_store_sale($1, $2) as r",
              [randomUUID(), JSON.stringify([line])], wait)));
      expect(out.filter((r) => r.error)).toEqual([]);
      expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(1);
      const after = await stockOf(skus[0]);
      expect(after.stock).toBe(0);
    }
    expect(await ledgerProblems()).toEqual([]);
  });
});

describe("retries and request keys", () => {
  it("the same key sent 10 times at once: one order, the rest get it back", async () => {
    const { skus } = await product("new", [{ size: 22, stock: 9 }]);
    const key = checkoutKey();
    const body = order([{ sku: skus[0], quantity: 2, unit_price_paisa: PRICE }]);
    const out = results(await simultaneously(db, 10, (client, _i, wait) =>
      withDbRetry(() => place(client, key, body, wait), { delays: [50, 100, 200, 400] })));
    expect(out.filter((r) => r.error)).toEqual([]);
    expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(1);
    expect(out.filter((r) => r.data?.result === "existing")).toHaveLength(9);
    expect(await stockOf(skus[0])).toEqual({ stock: 7, reserved: 2 });
    expect(await ledgerProblems()).toEqual([]);
  });

  it("the same key with different contents at once: one order, the others refused as reused", async () => {
    const { skus } = await product("new", [{ size: 23, stock: 9 }]);
    const key = checkoutKey();
    const out = results(await simultaneously(db, 6, (client, i, wait) =>
      withDbRetry(() => place(client, key, order([{ sku: skus[0], quantity: 1 + i, unit_price_paisa: PRICE }]), wait))));
    expect(out.filter((r) => r.data?.result === "placed")).toHaveLength(1);
    expect(out.filter((r) => r.data?.result === "mismatch")).toHaveLength(5);
    const placedQuantity = out.findIndex((r) => r.data?.result === "placed") + 1;
    expect(await stockOf(skus[0])).toEqual({ stock: 9 - placedQuantity, reserved: placedQuantity });
  });

  it("abandoning a key while its order is being placed: either the order exists or it never will", async () => {
    for (let round = 0; round < 10; round++) {
      const { skus } = await product("new", [{ size: 24, stock: 3 }]);
      const key = checkoutKey();
      const body = order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]);
      const [placed, resolved] = results(await simultaneously<DbResult<unknown>>(db, 2, (client, i, wait) =>
        i === 0
          ? place(client, key, body, wait)
          : call<{ state: string }>(client, "anon", "select public.checkout_resolve($1, $2, null, true) as r", [GATEWAY, key], wait)));
      const state = (resolved.data as { state: string }).state;
      const result = (placed.data as { result: string }).result;
      expect([["placed", "placed"], ["abandoned", "abandoned"]]).toContainEqual([result, state]);
      // A late retry can never create an order for an abandoned key.
      const client = await db.pool.connect();
      try {
        const retry = await place(client, key, body);
        expect((retry.data as { result: string }).result).toBe(state === "placed" ? "existing" : "abandoned");
      } finally {
        client.release();
      }
    }
  });

  it("a lock held elsewhere: the call times out (55P03) and the retry helper recovers", async () => {
    const { skus } = await product("new", [{ size: 25, stock: 2 }]);
    const holder = await db.pool.connect();
    const client = await db.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.product_variants where sku = $1 for update", [skus[0]]);
      const release = setTimeout(() => void holder.query("commit"), 2600);
      const started = Date.now();
      const attempts: (string | undefined)[] = [];
      const result = await withDbRetry(async () => {
        const r = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]));
        attempts.push(r.error?.code ?? (r.data as { result: string } | null)?.result);
        return r;
      }, { delays: [400, 400, 400], budgetMs: 6000 });
      clearTimeout(release);
      expect(attempts[0]).toBe("55P03");
      expect(result.data && (result.data as { result: string }).result).toBe("placed");
      expect(Date.now() - started).toBeGreaterThan(2000);
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
      client.release();
    }
    expect(await ledgerProblems()).toEqual([]);
  });
});

describe("orders against admin changes", () => {
  const productRow = async (code: string) =>
    (await db.query<{ id: string; version: number }>("select id, version from public.products where item_code = $1", [code])).rows[0];
  const sizeRow = async (sku: string) =>
    (await db.query<{ id: string; stock: number; inventory_version: string }>(
      "select id, stock, inventory_version from public.product_variants where sku = $1", [sku])).rows[0];
  const fields = (code: string, price: number, description = "Test") => ({
    item_code: code, slug: `race-${code.split("-")[1]}`, name: "Race test", brand: "Testbrand", department: "men",
    styles: ["sneakers"], item_status: "new", condition: "new", condition_notes: [], colour: "Black", description, price_paisa: price,
  });
  const images = async (id: string) =>
    (await db.query<{ id: string; alt: string }>("select id, alt from public.product_images where product_id = $1", [id])).rows;

  it("a stale admin stock edit never overwrites orders placed meanwhile", async () => {
    for (let round = 0; round < 5; round++) {
      const { skus } = await product("new", [{ size: 26, stock: 6 }]);
      const before = await sizeRow(skus[0]);
      const out = results(await simultaneously(db, 5, (client, i, wait) =>
        i === 0
          ? call(client, "authenticated", "select public.admin_adjust_stock($1, $2, $3, $4) as r",
              [before.id, before.inventory_version, 10, randomUUID()], wait)
          : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]), wait)));
      const orders = out.slice(1).filter((r) => (r.data as { result: string } | null)?.result === "placed").length;
      const after = await stockOf(skus[0]);
      if (out[0].error) {
        expect(out[0].error.code).toBe("PT409");
        expect(after.stock + after.reserved).toBe(6);
      } else {
        expect(after.stock + after.reserved).toBe(10);
      }
      expect(after.reserved).toBe(orders);
    }
    expect(await ledgerProblems()).toEqual([]);
  });

  it("saving only the description during orders never changes stock", async () => {
    const { code, skus } = await product("new", [{ size: 27, stock: 8 }]);
    const p = await productRow(code);
    const size = await sizeRow(skus[0]);
    const form = [{ size: 27, stock: size.stock, stock_was: size.stock, inventory_version: Number(size.inventory_version) }];
    const imgs = await images(p.id);
    const out = results(await simultaneously(db, 6, (client, i, wait) =>
      i === 0
        ? call(client, "authenticated", "select public.admin_save_product($1, $2, $3, $4, $5) as r",
            [p.id, p.version, fields(code, PRICE, "New words"), JSON.stringify(form), JSON.stringify(imgs)], wait)
        : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]), wait)));
    expect(out[0].error).toBeNull();
    const after = await stockOf(skus[0]);
    expect(after).toEqual({ stock: 3, reserved: 5 });
    expect(await ledgerProblems()).toEqual([]);
  });

  it("a price change during orders: every order is at the price that was current when it locked", async () => {
    for (let round = 0; round < 3; round++) {
      const { code, skus } = await product("new", [{ size: 28, stock: 20 }]);
      const p = await productRow(code);
      const size = await sizeRow(skus[0]);
      const form = [{ size: 28, stock: size.stock, stock_was: size.stock, inventory_version: Number(size.inventory_version) }];
      const imgs = await images(p.id);
      const NEW_PRICE = PRICE + 10000;
      const out = results(await simultaneously(db, 9, (client, i, wait) =>
        i === 0
          ? call(client, "authenticated", "select public.admin_save_product($1, $2, $3, $4, $5) as r",
              [p.id, p.version, fields(code, NEW_PRICE), JSON.stringify(form), JSON.stringify(imgs)], wait)
          : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: i % 2 ? PRICE : NEW_PRICE }]), wait)));
      expect(out[0].error).toBeNull();
      // Every caller either got an order at exactly the price it saw (the
      // price current when its order locked the product), or no order.
      out.slice(1).forEach((r, index) => {
        const seen = (index + 1) % 2 ? PRICE : NEW_PRICE;
        const data = r.data as { result: string; order?: { items: { unit_price_paisa: number }[] } };
        expect(r.error).toBeNull();
        expect(["placed", "quote_changed"]).toContain(data.result);
        if (data.result === "placed") expect(data.order?.items[0].unit_price_paisa).toBe(seen);
      });
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.order_items where sku = $1", [skus[0]]);
      expect(rows[0].n).toBe(out.filter((r) => (r.data as { result: string } | null)?.result === "placed").length);
      // Once the change has committed, only the new price is accepted.
      const client = await db.pool.connect();
      try {
        const late = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]));
        expect((late.data as { result: string }).result).toBe("quote_changed");
      } finally {
        client.release();
      }
    }
    expect(await ledgerProblems()).toEqual([]);
  });

  it("a sale starting during orders: every order is at the price that was current when it locked", async () => {
    const { code, skus } = await product("new", [{ size: 29, stock: 20 }]);
    const p = await productRow(code);
    const size = await sizeRow(skus[0]);
    const form = [{ size: 29, stock: size.stock, stock_was: size.stock, inventory_version: Number(size.inventory_version) }];
    const imgs = await images(p.id);
    const SALE = PRICE - 45000;
    const out = results(await simultaneously(db, 9, (client, i, wait) =>
      i === 0
        ? call(client, "authenticated", "select public.admin_save_product($1, $2, $3, $4, $5) as r",
            [p.id, p.version, { ...fields(code, PRICE), sale_price_paisa: SALE }, JSON.stringify(form), JSON.stringify(imgs)], wait)
        : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: i % 2 ? PRICE : SALE }]), wait)));
    expect(out[0].error).toBeNull();
    out.slice(1).forEach((r, index) => {
      const seen = (index + 1) % 2 ? PRICE : SALE;
      const data = r.data as { result: string; order?: { items: { unit_price_paisa: number }[] } };
      expect(r.error).toBeNull();
      expect(["placed", "quote_changed"]).toContain(data.result);
      if (data.result === "placed") expect(data.order?.items[0].unit_price_paisa).toBe(seen);
    });
    // After the sale has started, the regular price is never charged; the sale price is.
    const client = await db.pool.connect();
    try {
      const late = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]));
      expect((late.data as { result: string }).result).toBe("quote_changed");
      const onSale = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: SALE }]));
      expect((onSale.data as { result: string }).result).toBe("placed");
    } finally {
      client.release();
    }
    expect(await ledgerProblems()).toEqual([]);
  });

  it("unpublishing during orders: no order after the change", async () => {
    const { code, skus } = await product("new", [{ size: 29, stock: 20 }]);
    const p = await productRow(code);
    const out = results(await simultaneously(db, 8, (client, i, wait) =>
      i === 0
        ? call(client, "authenticated", "select public.admin_set_publication_status($1, $2, 'draft') as r", [p.id, p.version], wait)
        : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]), wait)));
    expect(out[0].error).toBeNull();
    for (const r of out.slice(1)) {
      expect(r.error).toBeNull();
      expect(["placed", "quote_changed"]).toContain((r.data as { result: string }).result);
    }
    // Once unpublished, nobody can order it.
    const client = await db.pool.connect();
    try {
      const after = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }]));
      expect((after.data as { result: string }).result).toBe("quote_changed");
    } finally {
      client.release();
    }
  });

  it("a delivery-fee change during orders: every order charged the fee its customer saw", async () => {
    const { skus } = await product("new", [{ size: 32, stock: 20 }]);
    const settings = (await db.query<{ version: number; s: Record<string, unknown> }>(
      "select version, to_jsonb(s) as s from public.shop_settings s")).rows[0];
    const out = results(await simultaneously(db, 9, (client, i, wait) =>
      i === 0
        ? call(client, "authenticated", "select public.admin_update_shop_settings($1, $2) as r",
            [settings.version, { ...settings.s, standard_delivery_fee_paisa: 35000 }], wait)
        : place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }], i % 2 ? 30000 : 35000), wait)));
    expect(out[0].error).toBeNull();
    out.slice(1).forEach((r, index) => {
      const seen = (index + 1) % 2 ? 30000 : 35000;
      const data = r.data as { result: string; order?: { delivery_paisa: number } };
      expect(r.error).toBeNull();
      expect(["placed", "quote_changed"]).toContain(data.result);
      if (data.result === "placed") expect(data.order?.delivery_paisa).toBe(seen);
    });
    // After the change, the old fee is refused.
    const client = await db.pool.connect();
    try {
      const late = await place(client, checkoutKey(), order([{ sku: skus[0], quantity: 1, unit_price_paisa: PRICE }], 30000));
      expect((late.data as { result: string }).result).toBe("quote_changed");
    } finally {
      client.release();
    }
    await db.exec("update public.shop_settings set standard_delivery_fee_paisa = 30000");
  });
});

describe("expiry, cancellation and returns", () => {
  async function heldOrder(stock = 3, quantity = 1) {
    const { skus } = await product("new", [{ size: 33, stock }, { size: 34, stock }]);
    const key = checkoutKey();
    const client = await db.pool.connect();
    try {
      const r = await place(client, key, order(skus.map((sku) => ({ sku, quantity, unit_price_paisa: PRICE }))));
      expect((r.data as { result: string }).result).toBe("placed");
    } finally {
      client.release();
    }
    const id = (await db.query<{ id: string }>(
      "select id from public.orders where request_key_hash = sha256(convert_to($1, 'UTF8'))", [key])).rows[0].id;
    return { id, skus };
  }
  const expire = (id: string) => db.exec(`update public.orders set hold_expires_at = now() - interval '1 second' where id = '${id}'`);
  const releases = async (id: string) =>
    Number((await db.query<{ n: string }>("select count(*) as n from public.stock_movements where order_id = $1 and reason = 'order_release'", [id])).rows[0].n);
  const version = async (id: string) => (await db.query<{ version: number }>("select version from public.orders where id = $1", [id])).rows[0].version;

  it("expiry job, a second job run, an admin confirm and a new order at once: released once, whole order", async () => {
    for (let round = 0; round < 5; round++) {
      const { id, skus } = await heldOrder(1, 1);
      await expire(id);
      const v = await version(id);
      const out = results(await simultaneously(db, 4, (client, i, wait) => {
        if (i < 2) return call(client, "authenticated", "select public.admin_expire_holds_now() as r", [], wait);
        if (i === 2) return call(client, "authenticated", "select public.admin_confirm_order($1, $2, $3) as r", [id, v, randomUUID()], wait);
        return place(client, checkoutKey(), order(skus.map((sku) => ({ sku, quantity: 1, unit_price_paisa: PRICE }))), wait);
      }));
      // The confirm can't win against an expired hold: it reports expired or a conflict.
      const confirm = out[2];
      expect(confirm.error?.code ?? (confirm.data as { result: string }).result).toMatch(/expired|PT409/);
      expect(await releases(id)).toBe(2);
      const status = (await db.query<{ status: string }>("select status from public.orders where id = $1", [id])).rows[0].status;
      expect(status).toBe("cancelled");
      // The new order waits for whoever is releasing the old one, then gets the pairs.
      expect(out[3].error).toBeNull();
      expect((out[3].data as { result: string }).result).toBe("placed");
      for (const sku of skus) expect(await stockOf(sku)).toEqual({ stock: 0, reserved: 1 });
    }
    expect(await ledgerProblems()).toEqual([]);
  });

  it("an expiry run that fails as a whole (a lock it can't get) is still recorded, and changes nothing", async () => {
    const { id, skus } = await heldOrder(2, 1);
    await expire(id);
    const before = (await db.query<{ consecutive_failures: number }>(
      "select consecutive_failures from private.job_heartbeats where job = 'expire_order_holds'")).rows[0]?.consecutive_failures ?? 0;
    const holder = await db.pool.connect();
    try {
      // Another transaction holds the order's product for longer than the job's 5 s lock timeout.
      await holder.query("begin");
      await holder.query(
        "select 1 from public.products p join public.product_variants v on v.product_id = p.id where v.sku = $1 for update of p", [skus[0]]);
      const run = await db.query<{ r: { released: number; failed: number } }>("select private.expire_order_holds() as r");
      expect(run.rows[0].r).toEqual({ released: 0, failed: 1 });
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    const beat = (await db.query<{ consecutive_failures: number; last_error: string }>(
      "select consecutive_failures, last_error from private.job_heartbeats where job = 'expire_order_holds'")).rows[0];
    expect(beat.consecutive_failures).toBe(before + 1);
    expect(beat.last_error).toMatch(/^55P03/);
    expect((await db.query<{ status: string }>("select status from public.orders where id = $1", [id])).rows[0].status).toBe("awaiting_confirmation");
    // The next run, with the lock gone, releases it and clears the count.
    const next = await db.query<{ r: { released: number; failed: number } }>("select private.expire_order_holds() as r");
    expect(next.rows[0].r.failed).toBe(0);
    expect(await releases(id)).toBe(2);
    expect(await ledgerProblems()).toEqual([]);
  });

  it("two cancels, cancel against expiry, cancel against dispatch: one outcome each, stock released once", async () => {
    // Two cancels with different request ids.
    let { id } = await heldOrder();
    let v = await version(id);
    let out = results(await simultaneously(db, 2, (client, _i, wait) =>
      call(client, "authenticated", "select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [id, v, randomUUID()], wait)));
    expect(out.filter((r) => !r.error)).toHaveLength(1);
    expect(out.filter((r) => r.error?.code === "PT409")).toHaveLength(1);
    expect(await releases(id)).toBe(2);

    // Cancel against the expiry job.
    ({ id } = await heldOrder());
    await expire(id);
    v = await version(id);
    out = results(await simultaneously(db, 2, (client, i, wait) =>
      i === 0
        ? call(client, "authenticated", "select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [id, v, randomUUID()], wait)
        : call(client, "authenticated", "select public.admin_expire_holds_now() as r", [], wait)));
    expect(await releases(id)).toBe(2);

    // Cancel against dispatch, on a confirmed order.
    const held = await heldOrder();
    id = held.id;
    const client = await db.pool.connect();
    try {
      await call(client, "authenticated", "select public.admin_confirm_order($1, $2, $3) as r", [id, await version(id), randomUUID()]);
    } finally {
      client.release();
    }
    v = await version(id);
    out = results(await simultaneously(db, 2, (c, i, wait) =>
      i === 0
        ? call(c, "authenticated", "select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [id, v, randomUUID()], wait)
        : call(c, "authenticated", "select public.admin_dispatch_order($1, $2, $3, 'TCS', null) as r", [id, v, randomUUID()], wait)));
    expect(out.filter((r) => !r.error)).toHaveLength(1);
    const status = (await db.query<{ status: string }>("select status from public.orders where id = $1", [id])).rows[0].status;
    const moves = await db.query<{ reason: string; n: string }>(
      "select reason, count(*) as n from public.stock_movements where order_id = $1 and reason <> 'order_reserve' group by reason", [id]);
    expect(moves.rows).toEqual([{ reason: status === "cancelled" ? "order_release" : "order_dispatch", n: "2" }]);
    for (const sku of held.skus) expect((await stockOf(sku)).reserved).toBe(0);
    expect(await ledgerProblems()).toEqual([]);
  });

  it("a failed delivery dispatched again twice at once: one retry, no second stock movement", async () => {
    const { id, skus } = await heldOrder(3, 2);
    const c = await db.pool.connect();
    try {
      for (const step of [
        "select public.admin_confirm_order($1, $2, $3) as r",
        "select public.admin_dispatch_order($1, $2, $3, 'TCS', 'FIRST') as r",
        "select public.admin_mark_delivery_failed($1, $2, $3) as r",
      ]) {
        expect((await call(c, "authenticated", step, [id, await version(id), randomUUID()])).error).toBeNull();
      }
    } finally {
      c.release();
    }
    const afterFirst = await Promise.all(skus.map(stockOf));
    expect(afterFirst).toEqual([{ stock: 1, reserved: 0 }, { stock: 1, reserved: 0 }]);
    const v = await version(id);
    const out = results(await simultaneously(db, 3, (client, i, wait) =>
      call(client, "authenticated", "select public.admin_dispatch_order($1, $2, $3, 'TCS', $4) as r", [id, v, randomUUID(), `RETRY-${i}`], wait)));
    expect(out.filter((r) => !r.error)).toHaveLength(1);
    expect(out.filter((r) => r.error?.code === "PT409")).toHaveLength(2);
    expect(await Promise.all(skus.map(stockOf))).toEqual(afterFirst);
    const dispatches = await db.query<{ n: string }>(
      "select count(*) as n from public.stock_movements where order_id = $1 and reason = 'order_dispatch'", [id]);
    expect(dispatches.rows[0].n).toBe("2"); // one per item, from the first dispatch only
    const c2 = await db.pool.connect();
    try {
      const delivered = await call<{ status: string; payment_status: string }>(c2, "authenticated",
        "select public.admin_mark_delivered($1, $2, $3, true) as r", [id, await version(id), randomUUID()]);
      expect(delivered.data).toMatchObject({ status: "delivered", payment_status: "collected" });
    } finally {
      c2.release();
    }
    expect(await Promise.all(skus.map(stockOf))).toEqual(afterFirst);
    expect(await ledgerProblems()).toEqual([]);
  });

  it("the same return recorded twice at once: restocked once", async () => {
    const { id, skus } = await heldOrder(3, 1);
    const c = await db.pool.connect();
    try {
      for (const step of [
        "select public.admin_confirm_order($1, $2, $3) as r",
        "select public.admin_dispatch_order($1, $2, $3, 'TCS', null) as r",
        "select public.admin_mark_delivery_failed($1, $2, $3) as r",
      ]) {
        const r = await call(c, "authenticated", step, [id, await version(id), randomUUID()]);
        expect(r.error).toBeNull();
      }
    } finally {
      c.release();
    }
    const items = (await db.query<{ id: string }>("select id from public.order_items where order_id = $1", [id])).rows;
    const lines = JSON.stringify(items.map((it) => ({ order_item_id: it.id, restock: 1, write_off: 0 })));
    const v = await version(id);
    const request = randomUUID();
    const out = results(await simultaneously(db, 4, (client, i, wait) =>
      call<{ result: string }>(client, "authenticated", "select public.admin_receive_return($1, $2, $3, $4) as r",
        [id, v, i < 2 ? request : randomUUID(), lines], wait)));
    expect(out.filter((r) => r.data?.result === "done")).toHaveLength(1);
    for (const sku of skus) expect(await stockOf(sku)).toEqual({ stock: 3, reserved: 0 });
    expect(await ledgerProblems()).toEqual([]);
  });
});

describe("automatic item codes", () => {
  const autoFields = (n: string) => ({
    auto_item_code: true, item_code: null, slug: `auto-race-${n}`, name: "Auto race", brand: "Testbrand", department: "kids",
    styles: ["sneakers"], item_status: "new", condition: "new", condition_notes: [], colour: "Black", description: "Test", price_paisa: PRICE,
  });
  const create = (client: pg.PoolClient, fields: object, wait?: () => Promise<void>) =>
    call<{ id: string; item_code: string }>(client, "authenticated", "select public.admin_create_product($1, $2) as r",
      [fields, JSON.stringify([{ size: 30, stock: 1 }])], wait);
  const nextCode = async () =>
    (await db.query<{ code: string }>(
      "select 'ITEM-' || lpad((case when is_called then last_value + 1 else last_value end)::text, 6, '0') as code from private.item_code_seq",
    )).rows[0].code;

  it("20 admins creating products at once: 20 different codes, each product's SKU follows its own", async () => {
    const out = results(await simultaneously(db, 20, (client, i, wait) => create(client, autoFields(`a${i}`), wait)));
    for (const r of out) expect(r.error).toBeNull();
    const codes = out.map((r) => r.data!.item_code);
    expect(new Set(codes).size).toBe(20);
    for (const code of codes) expect(code).toMatch(/^ITEM-\d{6}$/);
    const { rows } = await db.query<{ item_code: string; sku: string }>(
      "select p.item_code, v.sku from public.products p join public.product_variants v on v.product_id = p.id where p.item_code = any($1)",
      [codes]);
    expect(rows).toHaveLength(20);
    for (const row of rows) expect(row.sku).toBe(`${row.item_code}-30`);
  });

  it("a hand-typed code racing automatic ones for the same number: never a duplicate", async () => {
    const contested = await nextCode();
    const out = results(await simultaneously(db, 8, async (client, i, wait) => {
      if (i > 0) return create(client, autoFields(`b${i}`), wait);
      // The owner types the next automatic code by hand (no checks apply to the owner).
      await wait();
      try {
        await client.query(
          `insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
           values ($1, 'hand-typed-race', 'Hand typed', 'Testbrand', 'kids', 'new', 'new', 'Red', 100000)`, [contested]);
        return { data: { id: "", item_code: contested }, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code } };
      }
    }));
    // Each call either succeeded or was refused by the unique constraint; no other failure.
    for (const r of out) if (r.error) expect(r.error.code).toBe("23505");
    const { rows } = await db.query<{ item_code: string; n: number }>(
      "select item_code, count(*)::int as n from public.products group by item_code having count(*) > 1");
    expect(rows).toEqual([]);
    expect(out.filter((r) => !r.error).length).toBeGreaterThanOrEqual(7);
  });
});
