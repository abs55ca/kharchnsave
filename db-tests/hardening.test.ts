import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createDatabase, migrationSteps, read, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Regression tests for the checkout, permission and photo-registration
 * hardening (supabase/migrations/2026111712*.sql), on real PostgreSQL with
 * every migration applied. Calls are made the way Supabase's API makes them:
 * one transaction per call, as anon or authenticated with JWT claims.
 * NOT Supabase: Auth, Storage's HTTP layer and PostgREST are not simulated.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000002";
const ADMIN = "a1a1a1a1-0000-4000-8000-00000000000a";
const USER = "b2b2b2b2-0000-4000-8000-00000000000b";
const ROLES = {
  anon: null,
  "non-admin aal1": { sub: USER, role: "authenticated", aal: "aal1" },
  "non-admin aal2": { sub: USER, role: "authenticated", aal: "aal2" },
  "admin aal1": { sub: ADMIN, role: "authenticated", aal: "aal1" },
  "admin aal2": { sub: ADMIN, role: "authenticated", aal: "aal2" },
} satisfies Record<string, Claims>;
type RoleName = keyof typeof ROLES;
const ADMIN_CLAIMS = ROLES["admin aal2"];
const PRICE = 245000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createDatabase("hardening");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'h-admin@test.invalid'), ('${USER}', 'h-user@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    -- TEST VALUES ONLY.
    update public.shop_settings set delivery_area_mode = 'nationwide', free_delivery_enabled = false,
      max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20, max_open_orders_per_phone = 20,
      place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000, lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000,
      orders_per_minute_global = 10000, in_store_sells_unpublished = true, orders_open = true;
  `);
});

afterAll(async () => {
  await db?.close();
});

const checkoutKey = () => randomBytes(32).toString("base64url");
const client = (n: number) => `ip:${String(n).padStart(64, "0")}`;
let productCount = 0;

async function product(
  itemStatus: "new" | "preloved",
  sizes: { size: number; stock: number }[],
  { price = PRICE, sale = null as number | null, status = "published" as "published" | "draft" | "archived" } = {},
) {
  const code = `HZ-${++productCount}`;
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, sale_price_paisa, publication_status, listed_at, label_name)
    values ('${code}', 'hz-${productCount}', 'Secret ${code}', 'Hiddenbrand', 'men', '{sneakers}', '${itemStatus}',
      '${itemStatus === "new" ? "new" : "good"}', 'Black', 'Test', ${price}, ${sale ?? "null"}, 'draft', current_date, 'Label ${code}');
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select p.id, p.item_status, '${code}-' || s.size, s.size, s.stock
    from public.products p, (values ${sizes.map((s) => `(${s.size}, ${s.stock})`).join(", ")}) s(size, stock)
    where p.item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    update public.products set publication_status = '${status}' where item_code = '${code}';
  `);
  const { rows } = await db.query<{ id: string; version: number }>("select id, version from public.products where item_code = $1", [code]);
  return { code, id: rows[0].id, version: rows[0].version, skus: sizes.map((s) => `${code}-${s.size}`) };
}

type Line = { sku: string; quantity: number; unit_price_paisa: number };
const randomPhone = () => `+92300${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

function order(lines: Line[], phone = randomPhone(), delivery = 30000) {
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unit_price_paisa, 0);
  return {
    lines,
    delivery_paisa: delivery,
    total_paisa: subtotal + delivery,
    customer: { name: "Hardening Customer", phone, city: "Lahore", address: "House 1, Street 2, Test Town" },
  };
}

type Result<T> = { data: T | null; error: { code?: string; message?: string; hint?: string } | null };

async function call<T = unknown>(
  c: pg.PoolClient,
  claims: Claims,
  sql: string,
  params: unknown[] = [],
  before?: () => Promise<void>,
): Promise<Result<T>> {
  try {
    const result = await asRole<{ r: T }>(c, claims ? "authenticated" : "anon", claims, sql, params, before);
    return { data: result.rows[0]?.r ?? null, error: null };
  } catch (error) {
    const e = error as { code?: string; message?: string; hint?: string };
    return { data: null, error: { code: e.code, message: e.message, hint: e.hint } };
  }
}

/** One call on its own connection. */
async function once<T = unknown>(claims: Claims, sql: string, params: unknown[] = []) {
  const c = await db.pool.connect();
  try {
    return await call<T>(c, claims, sql, params);
  } finally {
    c.release();
  }
}

type Placed = { result: string; order?: { order_number: string }; quote?: { lines: Record<string, unknown>[] } };
const place = (key: string, body: object) => once<Placed>(null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, key, body]);
const attempt = (bucket: string | null, kind = "place") =>
  once<{ allowed: boolean; reason: string }>(null, "select public.checkout_register_attempt($1, $2, $3) as r", [GATEWAY, bucket, kind]);

async function settings(sql: string) {
  await db.exec(`update public.shop_settings set ${sql}`);
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

/**
 * Rate-limit windows are fixed minutes (date_bin). Start each quota test at
 * least 15 seconds before a minute ends, so the whole test runs in one window.
 */
async function freshWindow() {
  const seconds = new Date().getSeconds();
  if (seconds >= 45) await new Promise((r) => setTimeout(r, (61 - seconds) * 1000));
  await db.exec("delete from private.rate_limit_buckets");
}

// ---------------------------------------------------------------------------

describe("1. the global order quota", () => {
  const generous = "place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000, orders_per_minute_global = 10000";
  beforeEach(async () => {
    await freshWindow();
    await settings(generous);
  });
  afterAll(async () => {
    await settings(generous);
    await db.exec("delete from private.rate_limit_buckets");
  });

  it("a visitor's individually rejected attempts don't use up the global quota", async () => {
    await settings("place_attempts_per_ip_10min = 1, orders_per_minute_global = 2");
    expect((await attempt(client(1))).data?.allowed).toBe(true);
    const rejected = await attempt(client(1));
    expect(rejected.data).toEqual({ allowed: false, reason: "rate_limited" });
    // A different visitor is not affected by the first one's refusals.
    expect((await attempt(client(2))).data?.allowed).toBe(true);
    expect((await attempt(client(3))).data?.allowed).toBe(true);
  });

  it("an individually rejected attempt stops at the first limit (the daily bucket isn't charged)", async () => {
    await settings("place_attempts_per_ip_10min = 1, place_attempts_per_ip_day = 3");
    for (let i = 0; i < 5; i++) await attempt(client(4));
    const { rows } = await db.query<{ bucket: string; hits: number }>(
      "select bucket, hits from private.rate_limit_buckets where bucket like '%' || $1 order by bucket", [client(4)]);
    expect(rows).toEqual([
      { bucket: `place:10m:${client(4)}`, hits: 5 },
      { bucket: `place:1d:${client(4)}`, hits: 1 },
    ]);
  });

  it("attempts that never place an order (failed Turnstile) don't use up the global quota", async () => {
    await settings("orders_per_minute_global = 2");
    // Ten visitors pass the per-visitor limit, then fail the security check: place_cod_order is never called.
    for (let i = 10; i < 20; i++) expect((await attempt(client(i))).data?.allowed).toBe(true);
    const p = await product("new", [{ size: 40, stock: 5 }]);
    const first = await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]));
    const second = await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]));
    expect([first.data?.result, second.data?.result]).toEqual(["placed", "placed"]);
  });

  it("retries of a placed order return it without charging the quota; only new orders count", async () => {
    await settings("orders_per_minute_global = 2");
    const p = await product("new", [{ size: 40, stock: 5 }]);
    const key = checkoutKey();
    const body = order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]);
    expect((await place(key, body)).data?.result).toBe("placed");
    for (let i = 0; i < 5; i++) expect((await place(key, body)).data?.result).toBe("existing");
    expect((await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]))).data?.result).toBe("placed");
    const third = await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]));
    expect(third.data?.result).toBe("busy");
    expect((await place(key, body)).data?.result).toBe("existing");
    // A refused order (quote changed) doesn't count either: still busy, nothing else placed.
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int n from public.order_items where sku = $1", [p.skus[0]]);
    expect(rows[0].n).toBe(2);
  });

  it("orders refused for other reasons (price changed, phone limit) don't use up the quota", async () => {
    await settings("orders_per_minute_global = 1");
    const p = await product("new", [{ size: 40, stock: 5 }]);
    const stale = await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE - 1 }]));
    expect(stale.data?.result).toBe("quote_changed");
    expect((await place(checkoutKey(), order([{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }]))).data?.result).toBe("placed");
  });

  it("8 legitimate orders at once with a global limit of 3: exactly 3 placed, 5 told to retry", async () => {
    await settings("orders_per_minute_global = 3");
    const products = await Promise.all(Array.from({ length: 8 }, () => product("new", [{ size: 41, stock: 2 }])));
    const settled = await simultaneously(db, 8, (c, i, before) =>
      call<Placed>(c, null, "select public.place_cod_order($1, $2, $3) as r",
        [GATEWAY, checkoutKey(), order([{ sku: products[i].skus[0], quantity: 1, unit_price_paisa: PRICE }])], before));
    const outcomes = settled.map((s) => (s.status === "fulfilled" ? (s.value.data?.result ?? s.value.error?.code) : "rejected"));
    expect(outcomes.filter((o) => o === "placed")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "busy")).toHaveLength(5);
    expect(await ledgerProblems()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("2. online quotes reveal nothing about unpublished products", () => {
  const masked = (sku: string, quantity = 1, seen = PRICE) => ({
    sku, status: "unavailable", name: null, brand: null, size_eu: null, item_status: null, condition: null,
    quantity, allowed_quantity: 0, available: 0, unit_price_paisa: null, regular_price_paisa: null,
    price_changed: false, seen_price_paisa: seen,
    // Since 20261118120100_referral_checkout.sql: no code applies, nothing discounted.
    referral_eligible: null, discount_paisa: 0,
  });

  it("draft, archived and nonexistent SKUs look the same; published ones show their (sale) price", async () => {
    const pub = await product("new", [{ size: 40, stock: 3 }], { price: 300000, sale: 240000 });
    const draft = await product("new", [{ size: 41, stock: 3 }], { sale: 200000, status: "draft" });
    const archived = await product("preloved", [{ size: 42, stock: 1 }], { status: "archived" });
    const lines = [
      { sku: pub.skus[0], quantity: 1, unit_price_paisa: 240000 },
      { sku: draft.skus[0], quantity: 1, unit_price_paisa: PRICE },
      { sku: archived.skus[0], quantity: 1, unit_price_paisa: PRICE },
      { sku: "HZ-NOPE-40", quantity: 1, unit_price_paisa: PRICE },
    ];
    const quote = await once<{ lines: Record<string, unknown>[] }>(null, "select public.quote_order($1, $2, $3) as r", [GATEWAY, JSON.stringify(lines), "Lahore"]);
    expect(quote.error).toBeNull();
    const bySku = Object.fromEntries(quote.data!.lines.map((l) => [l.sku as string, l]));
    expect(bySku[pub.skus[0]]).toMatchObject({ status: "ok", name: `Secret ${pub.code}`, unit_price_paisa: 240000, regular_price_paisa: 300000, available: 3 });
    expect(bySku[draft.skus[0]]).toEqual(masked(draft.skus[0]));
    expect(bySku[archived.skus[0]]).toEqual(masked(archived.skus[0]));
    expect(bySku["HZ-NOPE-40"]).toEqual(masked("HZ-NOPE-40"));
    for (const hidden of [draft, archived]) expect(JSON.stringify(quote.data)).not.toContain(`Secret ${hidden.code}"`);
  });

  it("quote_changed while placing an order is masked the same way", async () => {
    const draft = await product("new", [{ size: 41, stock: 3 }], { status: "draft" });
    const placed = await place(checkoutKey(), order([{ sku: draft.skus[0], quantity: 1, unit_price_paisa: PRICE }]));
    expect(placed.data?.result).toBe("quote_changed");
    expect(placed.data?.quote?.lines[0]).toEqual(masked(draft.skus[0]));
    expect(JSON.stringify(placed.data)).not.toContain(`Secret ${draft.code}"`);
  });

  it("in-store sales still see unpublished products (verified admin, when allowed)", async () => {
    const draft = await product("new", [{ size: 41, stock: 3 }], { status: "draft" });
    const changed = await once<{ result: string; quote: { lines: Record<string, unknown>[] } }>(ADMIN_CLAIMS,
      "select public.admin_record_in_store_sale($1, $2) as r", [randomUUID(), JSON.stringify([{ sku: draft.skus[0], quantity: 1, unit_price_paisa: PRICE - 1 }])]);
    expect(changed.data?.result).toBe("quote_changed");
    expect(changed.data?.quote.lines[0]).toMatchObject({ status: "ok", name: `Secret ${draft.code}`, unit_price_paisa: PRICE, price_changed: true });
    const sold = await once<{ result: string }>(ADMIN_CLAIMS,
      "select public.admin_record_in_store_sale($1, $2) as r", [randomUUID(), JSON.stringify([{ sku: draft.skus[0], quantity: 1, unit_price_paisa: PRICE }])]);
    expect(sold.data?.result).toBe("placed");
  });
});

// ---------------------------------------------------------------------------

describe("3. internal columns: the permission matrix", () => {
  let pub: Awaited<ReturnType<typeof product>>;
  let draft: Awaited<ReturnType<typeof product>>;
  beforeAll(async () => {
    pub = await product("new", [{ size: 40, stock: 3 }]);
    draft = await product("new", [{ size: 41, stock: 2 }], { status: "draft" });
    // One pair held for an order: stock 2, reserved 1.
    const held = await place(checkoutKey(), order([{ sku: pub.skus[0], quantity: 1, unit_price_paisa: PRICE }]));
    expect(held.data?.result).toBe("placed");
  });

  const outcome = (r: Result<unknown>) => (r.error ? `refused ${r.error.code}` : JSON.stringify(r.data));

  async function matrix(sql: string, params: unknown[] = []) {
    const out: Record<string, string> = {};
    for (const [name, claims] of Object.entries(ROLES)) out[name] = outcome(await once(claims, sql, params));
    return out as Record<RoleName, string>;
  }

  it("everyone reads the published catalogue's public columns, and nothing more", async () => {
    const shop = await matrix(
      `select json_agg(json_build_object('name', p.name, 'price', p.price_paisa, 'stock', v.stock) order by p.item_code) as r
       from public.products p join public.product_variants v on v.product_id = p.id where p.item_code = $1`, [pub.code]);
    for (const value of Object.values(shop)) expect(value).toBe(`[{"name":"Secret ${pub.code}","price":245000,"stock":2}]`);
  });

  it("nobody reads label_name or reserved directly, not even a verified admin", async () => {
    for (const [sql, label] of [
      ["select label_name as r from public.products limit 1", "label_name"],
      ["select reserved as r from public.product_variants limit 1", "reserved"],
      ["select inventory_version as r from public.product_variants limit 1", "inventory_version"],
    ]) {
      const result = await matrix(sql);
      for (const [role, value] of Object.entries(result)) expect(value, `${role} ${label}`).toBe("refused 42501");
    }
  });

  it("API roles have the same, public, column list on products and sizes", async () => {
    const { rows } = await db.query<{ grantee: string; table_name: string; columns: string }>(`
      select grantee, table_name, string_agg(column_name, ',' order by column_name) as columns
      from information_schema.column_privileges
      where table_schema = 'public' and table_name in ('products', 'product_variants') and privilege_type = 'SELECT'
        and grantee in ('anon', 'authenticated')
      group by 1, 2 order by 2, 1`);
    const byTable = (t: string) => rows.filter((r) => r.table_name === t);
    for (const t of ["products", "product_variants"]) {
      const [anon, authenticated] = byTable(t);
      expect(authenticated.columns, t).toBe(anon.columns);
      expect(anon.columns).not.toMatch(/label_name|reserved|inventory_version/);
    }
  });

  it("drafts: only a verified admin sees them", async () => {
    const drafts = await matrix("select count(*)::int as r from public.products where item_code = $1", [draft.code]);
    expect(drafts).toEqual({ anon: "0", "non-admin aal1": "0", "non-admin aal2": "0", "admin aal1": "0", "admin aal2": "1" });
  });

  it("orders and settings: only a verified admin reads them", async () => {
    const orders = await matrix("select (count(*) > 0)::text as r from public.orders");
    expect(orders).toEqual({ anon: "refused 42501", "non-admin aal1": '"false"', "non-admin aal2": '"false"', "admin aal1": '"false"', "admin aal2": '"true"' });
    const s = await matrix("select count(*)::int as r from public.shop_settings");
    expect(s).toEqual({ anon: "refused 42501", "non-admin aal1": "0", "non-admin aal2": "0", "admin aal1": "0", "admin aal2": "1" });
  });

  it("labels and reserved stock: only through the admin functions, only for a verified admin", async () => {
    const details = await matrix(
      `select (x -> 0 ->> 'label_name') || ' reserved=' || (x -> 0 -> 'product_variants' -> 0 ->> 'reserved') as r
       from (select public.admin_get_products(array[$1::uuid]) as x) y`, [pub.id]);
    expect(details).toEqual({
      anon: "refused 42501", "non-admin aal1": "refused 42501", "non-admin aal2": "refused 42501",
      "admin aal1": "refused 42501", "admin aal2": `"Label ${pub.code} reserved=1"`,
    });
    const scan = await matrix("select public.admin_scan_product($1, null) ->> 'label_name' as r", [pub.id]);
    expect(scan).toEqual({ anon: "refused 42501", "non-admin aal1": "null", "non-admin aal2": "null", "admin aal1": "null", "admin aal2": `"Label ${pub.code}"` });
    const lookup = await matrix("select public.admin_scan_lookup($1) -> 'product' ->> 'label_name' as r", [pub.code]);
    expect(lookup).toEqual({
      anon: "refused 42501", "non-admin aal1": "refused 42501", "non-admin aal2": "refused 42501",
      "admin aal1": "refused 42501", "admin aal2": `"Label ${pub.code}"`,
    });
  });

  it("admin_get_products: the editor's whole row, drafts included, in one snapshot", async () => {
    const { data, error } = await once<Record<string, unknown>[]>(ADMIN_CLAIMS,
      "select public.admin_get_products(array[$1::uuid, $2::uuid, gen_random_uuid()]) as r", [pub.id, draft.id]);
    expect(error).toBeNull();
    expect(data!.map((p) => p.item_code).sort()).toEqual([pub.code, draft.code].sort());
    const row = data!.find((p) => p.id === draft.id)!;
    expect(Object.keys(row).sort()).toEqual([
      "brand", "colour", "condition", "condition_notes", "department", "description", "id", "item_code", "item_status",
      "label_name", "light_up", "light_up_activation", "light_up_condition", "listed_at", "name", "price_paisa",
      "product_images", "product_variants", "publication_status", "sale_price_paisa", "slug", "styles", "updated_at", "version",
    ]);
    expect(row.product_variants).toEqual([
      expect.objectContaining({ sku: draft.skus[0], size_eu: 41, stock: 2, reserved: 0, inventory_version: expect.any(Number) }),
    ]);
    const tooMany = await once(ADMIN_CLAIMS, "select public.admin_get_products(array(select gen_random_uuid() from generate_series(1, 101))) as r");
    expect(tooMany.error?.code).toBe("PT400");
  });
});

// ---------------------------------------------------------------------------

describe("4. one open order per phone, even at the same moment", () => {
  beforeEach(async () => {
    await settings("max_open_orders_per_phone = 1");
  });
  afterAll(async () => {
    await settings("max_open_orders_per_phone = 20");
  });

  it("two orders from one phone with different keys: the second waits for the first, then is refused", async () => {
    const a = await product("new", [{ size: 40, stock: 3 }]);
    const b = await product("new", [{ size: 40, stock: 3 }]);
    const phone = randomPhone();
    const first = await db.pool.connect();
    const second = await db.pool.connect();
    try {
      // The first order is placed but not yet committed.
      await first.query("begin");
      await first.query("set local role anon");
      const placedFirst = await first.query("select public.place_cod_order($1, $2, $3) as r",
        [GATEWAY, checkoutKey(), order([{ sku: a.skus[0], quantity: 1, unit_price_paisa: PRICE }], phone)]);
      expect(placedFirst.rows[0].r.result).toBe("placed");
      let settledSecond = false;
      const pending = call<Placed>(second, null, "select public.place_cod_order($1, $2, $3) as r",
        [GATEWAY, checkoutKey(), order([{ sku: b.skus[0], quantity: 1, unit_price_paisa: PRICE }], phone)]).finally(() => (settledSecond = true));
      await new Promise((r) => setTimeout(r, 400));
      expect(settledSecond, "the second order must wait for the first").toBe(false);
      await first.query("commit");
      expect((await pending).data?.result).toBe("phone_limit");
    } finally {
      await first.query("rollback").catch(() => {});
      first.release();
      second.release();
    }
    const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.orders where customer_phone = $1", [phone]);
    expect(rows[0].n).toBe(1);
    expect(await ledgerProblems()).toEqual([]);
  });

  it("10 orders from one phone at once (and retries of each): exactly one order", async () => {
    const products = await Promise.all(Array.from({ length: 10 }, () => product("new", [{ size: 40, stock: 3 }])));
    const phone = randomPhone();
    const keys = products.map(() => checkoutKey());
    const settled = await simultaneously(db, 20, (c, i, before) =>
      call<Placed>(c, null, "select public.place_cod_order($1, $2, $3) as r",
        [GATEWAY, keys[i % 10], order([{ sku: products[i % 10].skus[0], quantity: 1, unit_price_paisa: PRICE }], phone)], before));
    const outcomes = settled.map((s) => (s.status === "fulfilled" ? (s.value.data?.result ?? s.value.error?.code) : "rejected"));
    const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.orders where customer_phone = $1", [phone]);
    expect(rows[0].n).toBe(1);
    // The winner's retry (same key) gets its order back; everyone else is refused.
    expect(outcomes.filter((o) => o === "placed")).toHaveLength(1);
    expect(outcomes.every((o) => ["placed", "existing", "phone_limit"].includes(o as string)), outcomes.join()).toBe(true);
    expect(await ledgerProblems()).toEqual([]);
  });

  it("different phones are not held up by each other", async () => {
    const products = await Promise.all(Array.from({ length: 6 }, () => product("new", [{ size: 40, stock: 3 }])));
    const settled = await simultaneously(db, 6, (c, i, before) =>
      call<Placed>(c, null, "select public.place_cod_order($1, $2, $3) as r",
        [GATEWAY, checkoutKey(), order([{ sku: products[i].skus[0], quantity: 1, unit_price_paisa: PRICE }])], before));
    expect(settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result : "rejected"))).toEqual(Array(6).fill("placed"));
  });

  it("a cancelled order, or one whose hold has expired, frees the phone", async () => {
    const p = await product("new", [{ size: 40, stock: 5 }]);
    const phone = randomPhone();
    const line = [{ sku: p.skus[0], quantity: 1, unit_price_paisa: PRICE }];
    const first = await place(checkoutKey(), order(line, phone));
    expect(first.data?.result).toBe("placed");
    expect((await place(checkoutKey(), order(line, phone))).data?.result).toBe("phone_limit");

    const { rows: [o] } = await db.query<{ id: string; version: number }>(
      "select id, version from public.orders where customer_phone = $1 and status = 'awaiting_confirmation'", [phone]);
    const cancelled = await once<{ result: string }>(ADMIN_CLAIMS, "select public.admin_cancel_order($1, $2, $3, 'customer_request') as r",
      [o.id, o.version, randomUUID()]);
    expect(cancelled.error).toBeNull();
    expect((await place(checkoutKey(), order(line, phone))).data?.result).toBe("placed");

    // The new order's hold expires (the job hasn't run yet): it no longer counts against the phone,
    // and placing the next order releases it first, as for any expired hold on these sizes.
    await db.exec(`update public.orders set hold_expires_at = now() - interval '1 minute'
                   where customer_phone = '${phone}' and status = 'awaiting_confirmation'`);
    expect((await place(checkoutKey(), order(line, phone))).data?.result).toBe("placed");
    const { rows } = await db.query<{ status: string; n: number }>(
      "select status, count(*)::int n from public.orders where customer_phone = $1 group by status order by status", [phone]);
    expect(rows).toEqual([{ status: "awaiting_confirmation", n: 1 }, { status: "cancelled", n: 2 }]);
    expect(await ledgerProblems()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("5. new functions are not callable by API roles unless granted", () => {
  it("public and private functions created by the migration owner: no anon/authenticated EXECUTE", async () => {
    const c = await db.pool.connect();
    try {
      await c.query("begin");
      await c.query("create function public.hz_probe() returns int language sql as 'select 1'");
      await c.query("create function private.hz_probe() returns int language sql as 'select 1'");
      const { rows } = await c.query(`
        select f, r, has_function_privilege(r, f, 'execute') as can
        from (values ('public.hz_probe()'), ('private.hz_probe()')) a(f), (values ('anon'), ('authenticated')) b(r)
        order by f, r`);
      await c.query("rollback");
      expect(rows.filter((row) => row.can).map((row) => `${row.r} → ${row.f}`)).toEqual([]);
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
  });

  it("existing intended grants still work", async () => {
    const { rows } = await db.query(`
      select has_function_privilege('anon', 'public.place_cod_order(text, text, jsonb)', 'execute') as anon_place,
             has_function_privilege('anon', 'public.quote_order(text, jsonb, text, text)', 'execute') as anon_quote,
             has_function_privilege('authenticated', 'public.admin_save_product(uuid, integer, jsonb, jsonb, jsonb)', 'execute') as auth_save,
             has_function_privilege('authenticated', 'public.is_catalogue_admin()', 'execute') as auth_is_admin,
             has_function_privilege('anon', 'public.admin_save_product(uuid, integer, jsonb, jsonb, jsonb)', 'execute') as anon_save,
             has_function_privilege('authenticated', 'private.require_gateway(text)', 'execute') as auth_private`);
    expect(rows[0]).toEqual({ anon_place: true, anon_quote: true, auth_save: true, auth_is_admin: true, anon_save: false, auth_private: false });
  });
});

// ---------------------------------------------------------------------------

describe("6. photo registration survives a lost response", () => {
  type Request = { productId: string; version: number; imageId: string; path?: string; width?: number; height?: number; alt?: string };
  const args = (r: Request) => [r.productId, r.version, r.imageId, r.path ?? `${r.productId}/${r.imageId}.webp`, r.width ?? 1500, r.height ?? 2000, r.alt ?? "Photo"];
  const SQL = "select public.admin_add_product_image($1, $2, $3, $4, $5, $6, $7) as r";
  const register = (r: Request, c?: pg.PoolClient) => (c ? call<number>(c, ADMIN_CLAIMS, SQL, args(r)) : once<number>(ADMIN_CLAIMS, SQL, args(r)));
  const photoRows = async (imageId: string) =>
    (await db.query<{ n: number }>("select count(*)::int n from public.product_images where id = $1", [imageId])).rows[0].n;

  /** The product form as an admin's editor loads it now (fields, sizes as loaded, photos). */
  async function openEditor(productId: string) {
    const { rows: [p] } = await db.query("select * from public.products where id = $1", [productId]);
    const sizes = (await db.query("select size_eu, stock, inventory_version from public.product_variants where product_id = $1 order by size_eu", [productId]))
      .rows.map((v) => ({ size: Number(v.size_eu), stock: v.stock, stock_was: v.stock, inventory_version: Number(v.inventory_version) }));
    const photos = (await db.query("select id, alt, shows_defect from public.product_images where product_id = $1 order by sort_order", [productId]))
      .rows.map((i) => ({ id: i.id, alt: i.alt, shows_defect: i.shows_defect }));
    const fields = {
      item_code: p.item_code, slug: p.slug, name: p.name, brand: p.brand, department: p.department, styles: p.styles,
      item_status: p.item_status, condition: p.condition, condition_notes: p.condition_notes, colour: p.colour,
      description: p.description, price_paisa: p.price_paisa,
    };
    return { productId, version: p.version as number, fields, sizes, photos };
  }
  type Editor = Awaited<ReturnType<typeof openEditor>>;
  const save = (e: Editor, changes: Record<string, unknown> = {}) =>
    once<{ version: number }>(ADMIN_CLAIMS, "select public.admin_save_product($1, $2, $3, $4, $5) as r",
      [e.productId, e.version, JSON.stringify({ ...e.fields, ...changes }), JSON.stringify(e.sizes), JSON.stringify(e.photos)]);
  const description = async (productId: string) =>
    (await db.query<{ description: string }>("select description from public.products where id = $1", [productId])).rows[0].description;

  it("lost response, another admin saves, retry, stale save: the other admin's change survives and the stale save is refused", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    // Admin A opens the product at version V.
    const a = await openEditor(p.id);
    const V = a.version;
    // A uploads a photo; the database records it (V+1), but A never gets the answer.
    const imageId = randomUUID();
    const lost = await register({ productId: p.id, version: V, imageId });
    expect(lost).toEqual({ data: V + 1, error: null });
    // Admin B opens the product (now with the photo), changes a field and saves: V+2.
    const b = await openEditor(p.id);
    const savedB = await save(b, { description: "B's description" });
    expect(savedB.data?.version).toBe(V + 2);
    // A's upload is retried: it gets the answer the first call produced (V+1), NOT the
    // product's current version (V+2), so A's editor is still known to be behind.
    const retry = await register({ productId: p.id, version: V, imageId });
    expect(retry).toEqual({ data: V + 1, error: null });
    expect(await photoRows(imageId)).toBe(1);
    // A's editor adopts that version and the photo, then saves its (stale) fields.
    const staleSave = await save({ ...a, version: retry.data!, photos: [{ id: imageId, alt: "Photo", shows_defect: false }] },
      { description: "A's stale description" });
    expect(staleSave.error).toMatchObject({ code: "PT409", hint: "version_conflict" });
    // B's change survives.
    expect(await description(p.id)).toBe("B's description");
  });

  it("the registration's identity is its original request: any differing field is refused", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    const other = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    const imageId = randomUUID();
    const original: Request = { productId: p.id, version: p.version, imageId };
    expect((await register(original)).error).toBeNull();
    const variants: [string, Request][] = [
      ["another product", { ...original, productId: other.id, version: other.version, path: `${other.id}/${imageId}.webp` }],
      ["another expected version", { ...original, version: p.version + 1 }],
      ["another storage path", { ...original, path: `${p.id}/${randomUUID()}.webp` }],
      ["another width", { ...original, width: 1200 }],
      ["another height", { ...original, height: 1600 }],
      ["another alt text", { ...original, alt: "Something else" }],
    ];
    for (const [label, request] of variants) {
      expect((await register(request)).error, label).toMatchObject({ code: "PT409", hint: "image_conflict" });
    }
    expect(await photoRows(imageId)).toBe(1);
    expect((await register(original)).data).toBe(p.version + 1);
  });

  it("the photo's alt text edited (or the photo removed) since: a retry still matches the original request", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    const imageId = randomUUID();
    const request: Request = { productId: p.id, version: p.version, imageId };
    expect((await register(request)).data).toBe(p.version + 1);
    const editor = await openEditor(p.id);
    expect((await save({ ...editor, photos: [{ id: imageId, alt: "Edited description", shows_defect: true }] })).error).toBeNull();
    expect((await register(request)).data).toBe(p.version + 1);
    // Removed by a later save: the retry still gets the original answer (and the editor's next save conflicts).
    const later = await openEditor(p.id);
    expect((await save({ ...later, photos: [] })).error).toBeNull();
    expect(await photoRows(imageId)).toBe(0);
    expect((await register(request)).data).toBe(p.version + 1);
    expect(await photoRows(imageId)).toBe(0);
  });

  it("a photo without a registration record (recorded before this migration) is a conflict, not a replay", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    const imageId = randomUUID();
    await db.exec(`insert into public.product_images (id, product_id, storage_path, alt, width, height, sort_order)
                   values ('${imageId}', '${p.id}', '${p.id}/${imageId}.webp', 'Photo', 1500, 2000, 5)`);
    const { rows: [{ version }] } = await db.query("select version from public.products where id = $1", [p.id]);
    expect((await register({ productId: p.id, version, imageId })).error).toMatchObject({ code: "PT409", hint: "image_conflict" });
  });

  it("a new photo with a stale version is still refused", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    expect((await register({ productId: p.id, version: p.version, imageId: randomUUID() })).error).toBeNull();
    expect((await register({ productId: p.id, version: p.version, imageId: randomUUID() })).error).toMatchObject({ code: "PT409", hint: "version_conflict" });
  });

  it("the registration record can't be read or written through the API", async () => {
    for (const claims of [null, ADMIN_CLAIMS]) {
      expect((await once(claims, "select count(*) as r from private.photo_registrations")).error?.code).toBe("42501");
    }
  });

  for (const outcome of ["commit", "rollback"] as const) {
    it(`a retry while the first registration is still in flight waits for it (first ${outcome}s)`, async () => {
      const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
      const imageId = randomUUID();
      const request: Request = { productId: p.id, version: p.version, imageId };
      const first = await db.pool.connect();
      const second = await db.pool.connect();
      try {
        await first.query("begin");
        await first.query("set local role authenticated");
        await first.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN_CLAIMS)]);
        const { rows } = await first.query(SQL, args(request));
        let done = false;
        const retry = register(request, second).finally(() => (done = true));
        await new Promise((r) => setTimeout(r, 400));
        expect(done, "the retry must wait for the first registration").toBe(false);
        await first.query(outcome);
        const result = await retry;
        expect(result.error).toBeNull();
        // Committed: the retry returns the same version. Rolled back: the retry registers it itself.
        expect(result.data).toBe(rows[0].r);
      } finally {
        await first.query("rollback").catch(() => {});
        first.release();
        second.release();
      }
      expect(await photoRows(imageId)).toBe(1);
    });
  }
});


// ---------------------------------------------------------------------------

describe("7. product writes only through the admin functions", () => {
  it("API roles hold no INSERT/UPDATE/DELETE on products or product_images, table- or column-level", async () => {
    const { rows } = await db.query(`
      select r, t, p from (values ('anon'), ('authenticated')) a(r), (values ('public.products'), ('public.product_images')) b(t),
        (values ('INSERT'), ('UPDATE'), ('DELETE')) c(p)
      where has_table_privilege(r, t, p)
         or (p <> 'DELETE' and has_any_column_privilege(r, t, p))`);
    expect(rows).toEqual([]);
  });

  it("admin_add_product_image and admin_set_publication_status refuse non-admins and aal1 before doing anything", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    for (const role of ["anon", "non-admin aal1", "non-admin aal2", "admin aal1"] as RoleName[]) {
      const add = await once(ROLES[role], "select public.admin_add_product_image($1, $2, $3, $4, 1500, 2000, 'x') as r",
        [p.id, p.version, randomUUID(), `${p.id}/${randomUUID()}.webp`]);
      expect(add.error?.code, `${role} add photo`).toBe("42501");
      const publish = await once(ROLES[role], "select public.admin_set_publication_status($1, $2, 'published') as r", [p.id, p.version]);
      expect(publish.error?.code, `${role} publish`).toBe("42501");
      // Even for a product that doesn't exist: the access check comes first.
      const missing = await once(ROLES[role], "select public.admin_set_publication_status(gen_random_uuid(), 1, 'published') as r");
      expect(missing.error?.code, `${role} publish missing`).toBe("42501");
    }
    const { rows } = await db.query("select version, publication_status from public.products where id = $1", [p.id]);
    expect(rows[0]).toEqual({ version: p.version, publication_status: "draft" });
  });

  it("verified admins publish through the function, with the version check", async () => {
    const p = await product("new", [{ size: 40, stock: 1 }], { status: "draft" });
    expect((await once(ADMIN_CLAIMS, "select public.admin_set_publication_status($1, $2, 'published') as r", [p.id, p.version - 1])).error)
      .toMatchObject({ code: "PT409", hint: "version_conflict" });
    const published = await once<number>(ADMIN_CLAIMS, "select public.admin_set_publication_status($1, $2, 'published') as r", [p.id, p.version]);
    expect(published).toEqual({ data: p.version + 1, error: null });
  });

  it("every SECURITY DEFINER function in public and private has an empty search_path", async () => {
    const { rows } = await db.query(`
      select n.nspname || '.' || p.proname as f, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef and p.proname <> 'rls_auto_enable'
        and not coalesce('search_path=""' = any(p.proconfig), false)`);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("8. staged rollout of the column restriction (README, stage D)", () => {
  const STAGE_1_LAST = "supabase/migrations/20261117120300_idempotent_photo_registration.sql";
  const STAGE_2 = "supabase/migrations/20261117120400_restrict_internal_columns.sql";
  let staged: TestDatabase;
  let productId: string;

  beforeAll(async () => {
    staged = await createDatabase("stages", migrationSteps(STAGE_1_LAST));
    await staged.exec(`
      insert into auth.users (id, email) values ('${ADMIN}', 'h-admin@test.invalid'), ('${USER}', 'h-user@test.invalid');
      insert into public.admin_members (user_id) values ('${ADMIN}');
      insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour,
        description, price_paisa, publication_status, listed_at, label_name)
      values ('STAGE-1', 'stage-1', 'Stage test', 'Testbrand', 'men', '{sneakers}', 'new', 'new', 'Black', 'Test', 245000,
        'draft', current_date, 'Stage label');
      insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, 'new', 'STAGE-1-40', 40, 2 from public.products where item_code = 'STAGE-1';
      insert into public.product_images (product_id, src, alt, width, height)
      select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = 'STAGE-1';
      update public.products set publication_status = 'published' where item_code = 'STAGE-1';
    `);
    productId = (await staged.query<{ id: string }>("select id from public.products where item_code = 'STAGE-1'")).rows[0].id;
  });
  afterAll(async () => {
    await staged?.close();
  });

  async function as(claims: Claims, sql: string, params: unknown[] = []) {
    const c = await staged.pool.connect();
    try {
      const r = await asRole(c, claims ? "authenticated" : "anon", claims, sql, params);
      return JSON.stringify(r.rows[0]?.r ?? null);
    } catch (error) {
      return `refused ${(error as { code?: string }).code}`;
    } finally {
      c.release();
    }
  }
  // The previous version's product editor (direct select), and this version's (the admin function).
  const OLD_READ = "select json_build_object('label', p.label_name, 'reserved', v.reserved, 'inv', v.inventory_version > 0) as r from public.products p join public.product_variants v on v.product_id = p.id where p.id = $1";
  const NEW_READ = "select json_build_object('label', x -> 0 ->> 'label_name', 'reserved', (x -> 0 -> 'product_variants' -> 0 ->> 'reserved')::int) as r from (select public.admin_get_products(array[$1::uuid]) x) y";
  const SCAN = "select public.admin_scan_product($1, null) ->> 'label_name' as r";

  it("stage 1 (expand, before 20261117120400): the previous version's admin reads and this version's both work", async () => {
    expect(await as(ADMIN_CLAIMS, OLD_READ, [productId])).toBe('{"label":"Stage label","reserved":0,"inv":true}');
    expect(await as(ADMIN_CLAIMS, NEW_READ, [productId])).toBe('{"label":"Stage label","reserved":0}');
    expect(await as(ADMIN_CLAIMS, SCAN, [productId])).toBe('"Stage label"');
    // The new admin function refuses everyone else from the start.
    expect(await as(ROLES["non-admin aal2"], NEW_READ, [productId])).toBe("refused 42501");
    expect(await as(ROLES["admin aal1"], NEW_READ, [productId])).toBe("refused 42501");
  });

  it("stage 2 (contract, 20261117120400): direct reads refused for every signed-in session; this version's reads still work", async () => {
    await staged.exec(read(STAGE_2));
    for (const claims of [ROLES["non-admin aal1"], ROLES["non-admin aal2"], ROLES["admin aal1"], ADMIN_CLAIMS]) {
      expect(await as(claims, OLD_READ, [productId])).toBe("refused 42501");
    }
    expect(await as(ADMIN_CLAIMS, NEW_READ, [productId])).toBe('{"label":"Stage label","reserved":0}');
    expect(await as(ADMIN_CLAIMS, SCAN, [productId])).toBe('"Stage label"');
    // The storefront's columns are unchanged for everyone.
    for (const claims of [null, ROLES["non-admin aal2"], ADMIN_CLAIMS]) {
      expect(await as(claims, "select p.name || ' ' || v.stock as r from public.products p join public.product_variants v on v.product_id = p.id where p.id = $1", [productId]))
        .toBe('"Stage test 2"');
    }
  });
});
