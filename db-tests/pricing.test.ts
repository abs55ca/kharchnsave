import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { priceWithEnding, salePrice, scorePrice, spreadOffsetBp } from "../lib/pricing/rules";
import { asRole, createDatabase, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Score pricing, sale campaigns and honest discounts
 * (supabase/migrations/20261121120000_score_pricing_and_sales.sql) on real
 * PostgreSQL with every migration applied. Calls are made the way Supabase's
 * API makes them: one transaction per call, as anon or authenticated with JWT
 * claims. NOT Supabase: no PostgREST, no pg_cron (the schedule job is called
 * directly), Auth users are rows in the stand-in auth.users.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000007";
const ADMIN = "a7a7a7a7-0000-4000-8000-0000000000a7";
const USER = "b7b7b7b7-0000-4000-8000-0000000000b7";
const claims = (sub: string, aal: "aal1" | "aal2" = "aal1"): Claims => ({ sub, role: "authenticated", aal });
const ADMIN2 = claims(ADMIN, "aal2");
const rs = (rupees: number) => rupees * 100;

let db: TestDatabase;
type Result<T> = { data: T | null; error: { code?: string; message?: string; hint?: string } | null };

async function call<T = unknown>(c: pg.PoolClient, who: Claims, sql: string, params: unknown[] = [], before?: () => Promise<void>): Promise<Result<T>> {
  try {
    const result = await asRole<{ r: T }>(c, who ? "authenticated" : "anon", who, sql, params, before);
    return { data: result.rows[0]?.r ?? null, error: null };
  } catch (error) {
    const e = error as { code?: string; message?: string; hint?: string };
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

/** As a verified admin; fails the test on an error. */
async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const { data, error } = await once<T>(ADMIN2, sql, params);
  if (error) throw new Error(`${sql}: ${error.code} ${error.hint ?? ""} ${error.message}`);
  return data as T;
}

const j = (v: unknown) => JSON.stringify(v);

let productCount = 0;
type Product = { id: string; code: string; skus: string[] };
/** A product inserted as the owner (like the admin functions would leave it). */
async function product(opts: { status?: "new" | "preloved"; price: number; sale?: number | null; sizes?: number[]; publication?: "published" | "draft" | "archived"; listed?: string }): Promise<Product> {
  const status = opts.status ?? "new";
  const code = `PR-${++productCount}-${randomBytes(2).toString("hex").toUpperCase()}`;
  const sizes = status === "preloved" ? [opts.sizes?.[0] ?? 1] : (opts.sizes ?? [5]);
  const publication = opts.publication ?? "published";
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, sale_price_paisa, publication_status, listed_at)
    values ('${code}', lower('${code}'), 'Pricing ${code}', 'Testbrand', 'men', '{sneakers}', '${status}',
      '${status === "new" ? "new" : "good"}', 'Black', 'Test', ${opts.price}, ${opts.sale ?? "null"}, 'draft', ${opts.listed ? `'${opts.listed}'` : "current_date"});
    ${sizes.map((stock, i) => `insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, '${code}-${40 + i}', ${40 + i}, ${stock} from public.products where item_code = '${code}';`).join("\n")}
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    ${publication !== "draft" ? `update public.products set publication_status = '${publication}' where item_code = '${code}';` : ""}`);
  const { rows } = await db.query<{ id: string }>("select id from public.products where item_code = $1", [code]);
  return { id: rows[0].id, code, skus: sizes.map((_, i) => `${code}-${40 + i}`) };
}

const row = async (id: string) =>
  (await db.query<{ price_paisa: number; sale_price_paisa: number | null; reference_price_paisa: number | null; referral_excluded: boolean; version: number; publication_status: string }>(
    "select price_paisa, sale_price_paisa, reference_price_paisa, referral_excluded, version, publication_status from public.products where id = $1", [id])).rows[0];

type Plan = { token: string; lines: Line[]; summary: Record<string, number> };
type Line = {
  product_id: string; action: string; reason: string | null; from: Record<string, unknown>; to: Record<string, unknown>;
  badge_from: number | null; badge_to: number | null; economics: { margin: string; worst: { paid_paisa: number; commission_paisa: number; retained_paisa: number | null }; scenarios: unknown[]; agents_excluded: number };
  calculation: { status: string; price_paisa: number | null } | null;
};

const previewPricing = (items: unknown[]) => admin<Plan>("select public.admin_preview_product_pricing($1) as r", [j(items)]);
const applyPricing = (requestId: string, items: unknown[], token: string) =>
  once<{ result: string; applied?: number; skipped?: { reason: string }[]; replayed?: boolean; preview?: Plan }>(ADMIN2,
    "select public.admin_apply_product_pricing($1, $2, $3) as r", [requestId, j(items), token]);

async function setPricing(items: unknown[]) {
  const plan = await previewPricing(items);
  const applied = await applyPricing(randomUUID(), items, plan.token);
  if (applied.error || applied.data?.result !== "applied") throw new Error(j(applied));
  return { plan, applied: applied.data };
}

async function createGroup(name: string, maxPaisa: number) {
  const r = await admin<{ result: string; id: string }>("select public.admin_create_pricing_group($1, $2, $3) as r", [randomUUID(), name, maxPaisa]);
  if (r.result !== "created") throw new Error(j(r));
  return r.id;
}

type Campaign = { id: string; version: number; status: string };
async function createCampaign(input: Record<string, unknown>) {
  const r = await admin<{ result: string; id: string; version: number }>("select public.admin_create_campaign($1, $2) as r", [randomUUID(), j({
    name: "Test sale", discount_bp: 2000, starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: null, ...input })]);
  return { id: r.id, version: r.version };
}
const campaign = (id: string) => admin<{ campaign: Campaign; lines: (Record<string, unknown> & { product_id: string; action: string; reason: string | null })[]; token: string; summary: Record<string, number>; overlaps: unknown[] }>(
  "select public.admin_get_campaign($1) as r", [id]);
async function select(id: string, changes: { product_id: string; state: string; note?: string; override_reason?: string }[]) {
  const c = await campaign(id);
  return admin<{ result: string; version: number }>("select public.admin_set_campaign_selection($1, $2, $3, $4) as r", [id, c.campaign.version, randomUUID(), j(changes)]);
}
async function applyCampaign(id: string) {
  const c = await campaign(id);
  return once<{ result: string; version: number; applied: number; skipped: number; removed: number; preview?: unknown }>(ADMIN2,
    "select public.admin_apply_campaign($1, $2, $3, $4) as r", [id, c.campaign.version, randomUUID(), c.token]);
}
async function endCampaign(id: string, action: "end" | "cancel" | "unschedule" = "end") {
  const c = await campaign(id);
  return admin<{ result: string; status: string }>("select public.admin_end_campaign($1, $2, $3, $4) as r", [id, c.campaign.version, randomUUID(), action]);
}
async function endAllActive() {
  const { rows } = await db.query<{ id: string; status: string }>("select id, status from private.sale_campaigns where status in ('active', 'scheduled', 'draft')");
  for (const r of rows) await endCampaign(r.id, r.status === "active" ? "end" : "cancel");
}

async function settings(patch: Record<string, number | null>) {
  const current = (await admin<{ settings: Record<string, number | null> & { version: number } }>("select public.admin_pricing_overview() as r")).settings;
  const next = { ...current, ...patch };
  return admin("select public.admin_save_pricing_settings($1, $2, $3) as r", [current.version, randomUUID(), j(next)]);
}

type Quote = { lines: { sku: string; unit_price_paisa: number; regular_price_paisa: number; reference_price_paisa: number | null; referral_excluded: boolean; referral_eligible: boolean | null; discount_paisa: number; price_changed: boolean }[]; subtotal_paisa: number; discount_paisa: number; total_paisa: number; delivery_paisa: number; exact: boolean; referral: { status: string } | null };
async function quote(lines: { sku: string; quantity: number; unit_price_paisa: number }[], code: string | null = null) {
  const r = await once<Quote>(null, "select public.quote_order($1, $2, 'Lahore', $3) as r", [GATEWAY, j(lines), code]);
  if (r.error) throw new Error(j(r.error));
  return r.data!;
}
const randomPhone = () => `+92302${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
async function place(lines: { sku: string; quantity: number; unit_price_paisa: number }[], q: Quote, code: string | null = null) {
  return once<{ result: string; order?: { order_number: string }; quote?: Quote }>(null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, randomBytes(32).toString("base64url"), j({
    lines, delivery_paisa: q.delivery_paisa, total_paisa: q.total_paisa,
    ...(code ? { referral_code: code, discount_paisa: q.discount_paisa } : {}),
    customer: { name: "Pricing Customer", phone: randomPhone(), city: "Lahore", address: "House 7, Street 7, Test Town" } })]);
}

let agentCount = 0;
async function agent(terms: { discount_bp: number; commission_bp: number; applies_to_sale_items: boolean }) {
  const n = ++agentCount;
  const r = await admin<{ result: string; agent: { id: string; code: string; version: number } }>("select public.admin_create_agent($1, $2) as r", [randomUUID(), j({
    username: `pricing${n}x${randomBytes(2).toString("hex")}`, display_name: `Pricing ${n}`, email: `pricing${n}-${randomBytes(3).toString("hex")}@test.invalid`,
    code: `PC${n}${randomBytes(3).toString("hex")}`.toUpperCase().slice(0, 16), code_enabled: true, ...terms })]);
  if (r.result !== "created") throw new Error(j(r));
  return r.agent;
}
async function disableAgents() {
  await db.exec("update public.sales_agents set code_enabled = false where code_enabled;");
}

beforeAll(async () => {
  db = await createDatabase("pricing");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'p-admin@test.invalid'), ('${USER}', 'p-user@test.invalid');
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

// ---------------------------------------------------------------------------

describe("1. the rules: SQL and lib/pricing/rules.ts agree", () => {
  it("price endings, scores and sale prices, over a grid", async () => {
    const amounts = Array.from({ length: 400 }, (_, i) => i * 1237 - 500);
    for (const ending of [95, 99, 0, 50]) {
      const { rows } = await db.query<{ a: string; p: string | null }>(
        "select a::text, private.price_with_ending(a, $1)::text as p from unnest($2::bigint[]) a", [ending, amounts]);
      for (const r of rows) expect(r.p === null ? null : Number(r.p), `${r.a} ending ${ending}`).toBe(priceWithEnding(Number(r.a), ending));
    }
    for (const max of [rs(5000), rs(3333), rs(100), rs(1000000)]) {
      const { rows } = await db.query<{ s: number; c: { status: string; calculated_paisa: number | null; price_paisa: number | null } }>(
        "select s, private.score_calculation($1, s, false, 95) as c from generate_series(0, 100) s", [max]);
      for (const r of rows) {
        const ts = scorePrice(max, r.s, 95);
        expect({ status: r.c.status, price: r.c.price_paisa, calc: r.c.calculated_paisa }, `${max} × ${r.s}`).toEqual({ status: ts.status, price: ts.pricePaisa, calc: ts.calculatedPaisa });
      }
    }
    for (const regular of [rs(95), rs(150), rs(1495), rs(2495), rs(4995), rs(123456)]) {
      const { rows } = await db.query<{ bp: number; c: { raw_paisa: number; price_paisa: number | null; rounding_paisa: number | null; actual_percent: number | null } }>(
        "select bp, private.sale_calculation($1, bp, 95) as c from unnest(array[100, 1000, 1250, 1500, 2000, 2500, 3000, 9000]) bp", [regular]);
      for (const r of rows) {
        const ts = salePrice(regular, r.bp, 95);
        expect(r.c, `${regular} at ${r.bp}`).toEqual({ raw_paisa: ts.rawPaisa, price_paisa: ts.pricePaisa, rounding_paisa: ts.roundingPaisa, actual_percent: ts.actualPercent });
      }
    }
  });
});

describe("1b. the price spread: SQL and lib/pricing/rules.ts agree", () => {
  it("each product's offset, and the price it gives, for many ids and spreads", async () => {
    const ids = [...Array.from({ length: 300 }, () => randomUUID()), "00000000-0000-4000-8000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff"];
    for (const spread of [0, 1, 250, 500]) {
      for (const [max, score] of [[rs(6000), 47], [rs(5000), 100], [rs(100), 1], [rs(1000000), 99]] as const) {
        const { rows } = await db.query<{ id: string; o: number; c: { status: string; calculated_paisa: number; price_paisa: number | null; spread_bp: number } }>(
          "select id::text, private.spread_offset_bp(id, $1) as o, private.score_calculation($2, $3, false, 95, id, $1) as c from unnest($4::uuid[]) id",
          [spread, max, score, ids]);
        for (const r of rows) {
          const offset = spreadOffsetBp(r.id, spread);
          expect(r.o, `${r.id} at ${spread}`).toBe(offset);
          expect(offset).toBeGreaterThanOrEqual(0);
          expect(offset).toBeLessThanOrEqual(spread);
          const ts = scorePrice(max, score, 95, false, offset);
          expect({ status: r.c.status, calc: r.c.calculated_paisa, price: r.c.price_paisa, spread: r.c.spread_bp }, `${r.id} ${max} × ${score} at ${spread}`)
            .toEqual({ status: ts.status, calc: ts.calculatedPaisa, price: ts.pricePaisa, spread: offset });
          // Never above the price without a spread.
          expect(r.c.calculated_paisa).toBeLessThanOrEqual(Math.floor((max * score) / 100));
        }
      }
    }
    // Spread 0 is exactly the 4-argument calculation.
    const same = await db.query<{ a: unknown; b: unknown }>(
      "select private.score_calculation($1, 37, false, 95) - 'spread_bp' as a, private.score_calculation($1, 37, false, 95, $2, 0) - 'spread_bp' as b", [rs(7000), ids[0]]);
    expect(same.rows[0].a).toEqual(same.rows[0].b);
  });
});

describe("2. access: only a verified admin", () => {
  const fns: [string, unknown[]][] = [
    ["select public.admin_pricing_overview() as r", []],
    ["select public.admin_pricing_products('{}') as r", []],
    ["select public.admin_product_pricing($1) as r", [randomUUID()]],
    ["select public.admin_preview_product_pricing($1) as r", [j([{ product_id: randomUUID(), mode: "manual" }])]],
    ["select public.admin_preview_reprice('[]') as r", []],
    ["select public.admin_save_pricing_settings(1, $1, '{}') as r", [randomUUID()]],
    ["select public.admin_create_pricing_group($1, 'Nope', 100000) as r", [randomUUID()]],
    ["select public.admin_apply_product_pricing($1, '[]', $2) as r", [randomUUID(), "0".repeat(64)]],
    ["select public.admin_apply_reprice($1, '[]', $2) as r", [randomUUID(), "0".repeat(64)]],
    ["select public.admin_list_campaigns() as r", []],
    ["select public.admin_get_campaign($1) as r", [randomUUID()]],
    ["select public.admin_campaign_candidates($1) as r", [randomUUID()]],
    ["select public.admin_sale_coverage() as r", []],
    ["select public.admin_create_campaign($1, $2) as r", [randomUUID(), j({ name: "Nope", discount_bp: 1000, starts_at: new Date().toISOString() })]],
    ["select public.admin_update_campaign($1, 1, $2, '{}') as r", [randomUUID(), randomUUID()]],
    ["select public.admin_set_campaign_selection($1, 1, $2, '[]') as r", [randomUUID(), randomUUID()]],
    ["select public.admin_apply_campaign($1, 1, $2, $3) as r", [randomUUID(), randomUUID(), "0".repeat(64)]],
    ["select public.admin_end_campaign($1, 1, $2, 'end') as r", [randomUUID(), randomUUID()]],
    ["select public.admin_run_sale_schedule() as r", []],
    ["select public.admin_sale_schedule_health() as r", []],
  ];

  it("anon, signed-in non-admins, an aal1 admin and an agent are refused every admin function", async () => {
    const agentUser = randomUUID();
    const a = await agent({ discount_bp: 1000, commission_bp: 500, applies_to_sale_items: true });
    await db.query("insert into auth.users (id, email) values ($1, $2)", [agentUser, `agent-${a.code.toLowerCase()}@test.invalid`]);
    await db.query("update public.sales_agents set email = $2 where id = $1", [a.id, `agent-${a.code.toLowerCase()}@test.invalid`]).catch(() => {});
    const who: Record<string, Claims> = { anon: null, "user aal1": claims(USER), "user aal2": claims(USER, "aal2"), "admin aal1": claims(ADMIN), "agent aal2": claims(agentUser, "aal2") };
    for (const [sql, params] of fns) {
      for (const [name, c] of Object.entries(who)) {
        const r = await once(c, sql, params);
        // anon: no EXECUTE at all; signed-in: the function's own check.
        expect(r.error?.code, `${name}: ${sql}`).toBe("42501");
      }
    }
    await disableAgents();
  });

  it("no API role can read the internal tables, and visitors see only the public price columns", async () => {
    for (const table of ["pricing_settings", "pricing_groups", "product_pricing", "price_history", "product_reference_prices", "pricing_events", "sale_campaigns", "sale_campaign_products", "product_pricing_state"]) {
      for (const c of [null, claims(USER, "aal2"), ADMIN2]) {
        const r = await once(c, `select count(*) as r from private.${table}`);
        expect(r.error?.code, `${table} as ${c?.sub ?? "anon"}`).toBe("42501");
      }
    }
    const p = await product({ price: rs(2000) });
    expect((await once<number>(null, "select reference_price_paisa as r from public.products where id = $1", [p.id])).error).toBeNull();
    expect((await once<boolean>(null, "select referral_excluded as r from public.products where id = $1", [p.id])).data).toBe(false);
    for (const c of [null, claims(USER, "aal2")]) {
      expect((await once(c, "select zero_price_approved as r from public.products limit 1")).error?.code).toBe("42501");
    }
    // Nobody but the pricing functions can set these.
    for (const c of [null, claims(USER, "aal2"), ADMIN2]) {
      const r = await once(c, "update public.products set referral_excluded = true, reference_price_paisa = 1 where id = $1 returning 1 as r", [p.id]);
      expect(r.error?.code ?? "no rows").not.toBeUndefined();
      expect((await row(p.id)).referral_excluded).toBe(false);
    }
  });
});

describe("3. groups, settings and requests", () => {
  it("creates groups once per request; names are unique; the same id with other data is refused", async () => {
    const request = randomUUID();
    const first = await admin<{ result: string; id: string }>("select public.admin_create_pricing_group($1, 'Kids sneakers', 300000) as r", [request]);
    expect(first.result).toBe("created");
    expect(await admin("select public.admin_create_pricing_group($1, 'Kids sneakers', 300000) as r", [request])).toMatchObject({ result: "created", id: first.id, replayed: true });
    expect((await once(ADMIN2, "select public.admin_create_pricing_group($1, 'Kids sneakers', 400000) as r", [request])).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect(await admin("select public.admin_create_pricing_group($1, 'KIDS  sneakers', 300000) as r", [randomUUID()])).toEqual({ result: "name_taken" });
    for (const bad of [9900, 100000001, 150050]) {
      expect((await once(ADMIN2, "select public.admin_create_pricing_group($1, 'Bad', $2) as r", [randomUUID(), bad])).error?.hint).toBe("invalid_maximum");
    }
  });

  it("settings are versioned: a stale form is refused, a retry gets the original version", async () => {
    const before = (await admin<{ settings: { version: number } & Record<string, unknown> }>("select public.admin_pricing_overview() as r")).settings;
    const request = randomUUID();
    const next = { ...before, price_ending_rupees: 99 };
    const saved = await admin<{ result: string; version: number }>("select public.admin_save_pricing_settings($1, $2, $3) as r", [before.version, request, j(next)]);
    expect(saved).toEqual({ result: "done", version: before.version + 1 });
    expect(await admin("select public.admin_save_pricing_settings($1, $2, $3) as r", [before.version, request, j(next)])).toEqual({ result: "done", version: before.version + 1, replayed: true });
    expect((await once(ADMIN2, "select public.admin_save_pricing_settings($1, $2, $3) as r", [before.version, randomUUID(), j(next)])).error).toMatchObject({ code: "PT409", hint: "version_conflict" });
    expect((await once(ADMIN2, "select public.admin_save_pricing_settings($1, $2, $3) as r", [before.version + 1, randomUUID(), j({ ...next, price_ending_rupees: 100 })])).error?.hint).toBe("invalid_settings");
    await settings({ price_ending_rupees: 95 });
  });

  it("existing products stay manual with their prices: nothing is converted or invented", async () => {
    const counts = await db.query<{ n: number }>("select count(*)::int as n from private.product_pricing");
    expect(counts.rows[0].n).toBe(0);
    const baseline = await db.query<{ n: number }>("select count(*)::int as n from private.price_history where reason = 'observed_at_migration'");
    // A fresh test database had no products before the migration.
    expect(baseline.rows[0].n).toBe(0);
  });
});

describe("4. score pricing", () => {
  let group: string;
  beforeAll(async () => {
    group = await createGroup("Men's sneakers", rs(5000));
  });

  it("opting in prices from the score with the 95 ending; manual products keep their price", async () => {
    const a = await product({ price: rs(3000) });
    const b = await product({ price: rs(1234) });
    const { plan, applied } = await setPricing([
      { product_id: a.id, mode: "auto", group_id: group, score: 50, cost_paisa: null },
      { product_id: b.id, mode: "manual", group_id: group, score: 70, cost_paisa: rs(500) },
    ]);
    expect(applied.applied).toBe(2);
    const [la, lb] = plan.lines;
    expect(la).toMatchObject({ action: "apply", calculation: { status: "ok", price_paisa: rs(2495) }, to: { price_paisa: rs(2495), mode: "auto", score: 50 } });
    // Manual: the calculated price is shown but not written.
    expect(lb).toMatchObject({ action: "apply", calculation: { status: "ok", price_paisa: rs(3495) }, to: { price_paisa: rs(1234), mode: "manual", cost_paisa: rs(500) } });
    expect((await row(a.id)).price_paisa).toBe(rs(2495));
    expect((await row(b.id)).price_paisa).toBe(rs(1234));
    const history = await db.query("select reason, request_id is not null as has_request from private.price_history where product_id = $1 order by id", [a.id]);
    expect(history.rows.at(-1)).toEqual({ reason: "score_pricing", has_request: true });
  });

  it("score 0 needs pricing; tiny prices are flagged; neither is written", async () => {
    const zero = await product({ price: rs(1500) });
    const tiny = await product({ price: rs(1500) });
    const tinyGroup = await createGroup("Tiny", rs(100));
    const { plan, applied } = await setPricing([
      { product_id: zero.id, mode: "auto", group_id: group, score: 0 },
      { product_id: tiny.id, mode: "auto", group_id: tinyGroup, score: 50 },
    ]);
    expect(plan.lines.map((l) => [l.action, l.reason])).toEqual([["skip", "needs_pricing"], ["skip", "too_small"]]);
    expect(applied.applied).toBe(0);
    expect((await row(zero.id)).price_paisa).toBe(rs(1500));
    expect((await db.query("select count(*)::int n from private.product_pricing where product_id = any($1)", [[zero.id, tiny.id]])).rows[0].n).toBe(0);
  });

  it("a free product needs the explicit giveaway; publishing at zero otherwise is refused", async () => {
    const draft = await product({ price: 0, publication: "draft" });
    const refused = await once(ADMIN2, "select public.admin_set_publication_status($1, (select version from public.products where id = $1), 'published') as r", [draft.id]);
    expect(refused.error?.message).toMatch(/products_published_price_positive/);
    const giveaway = await product({ price: rs(800) });
    const { plan } = await setPricing([{ product_id: giveaway.id, mode: "auto", group_id: group, score: 0, giveaway: true }]);
    expect(plan.lines[0]).toMatchObject({ action: "apply", calculation: { status: "giveaway" }, to: { price_paisa: 0, giveaway: true } });
    expect((await row(giveaway.id)).price_paisa).toBe(0);
    expect((await db.query("select count(*)::int n from private.pricing_events where kind = 'giveaway_set' and details ->> 'product_id' = $1", [giveaway.id])).rows[0].n).toBe(1);
    // A giveaway only with an automatic score of 0.
    expect((await previewPricing([{ product_id: draft.id, mode: "manual", giveaway: true }])).lines[0]).toMatchObject({ action: "skip", reason: "giveaway_needs_score_0" });
    // Nobody can approve a zero price directly.
    expect(await db.query("update public.products set zero_price_approved = true where id = $1", [draft.id]).catch((e) => e.hint)).toBe("auto_priced");
  });

  it("an automatically priced product's price can't be changed by the product form", async () => {
    const p = await product({ price: rs(2000) });
    await setPricing([{ product_id: p.id, mode: "auto", group_id: group, score: 60 }]);
    const saved = await row(p.id);
    const err = await db.query("update public.products set price_paisa = $2 where id = $1", [p.id, rs(9999)]).catch((e) => e);
    expect(err).toMatchObject({ code: "PT400", hint: "auto_priced" });
    // Saving the same price (the form always sends it) is fine.
    await db.query("update public.products set name = name, price_paisa = price_paisa where id = $1", [p.id]);
    expect((await row(p.id)).price_paisa).toBe(saved.price_paisa);
  });

  it("applies exactly the reviewed plan: a change in between makes it stale and nothing is written", async () => {
    const p = await product({ price: rs(2000) });
    const items = [{ product_id: p.id, mode: "auto", group_id: group, score: 80 }];
    const plan = await previewPricing(items);
    await db.query("update public.products set price_paisa = $2 where id = $1", [p.id, rs(2100)]);
    const stale = await applyPricing(randomUUID(), items, plan.token);
    expect(stale.data?.result).toBe("stale");
    expect((await row(p.id)).price_paisa).toBe(rs(2100));
    expect((await applyPricing(randomUUID(), items, "f".repeat(64))).data?.result).toBe("stale");
    expect((await applyPricing(randomUUID(), items, "no")).error?.hint).toBe("preview_required");
  });

  it("a lost answer retried with the same request id is applied once and answered the same", async () => {
    const p = await product({ price: rs(2000) });
    const items = [{ product_id: p.id, mode: "auto", group_id: group, score: 90 }];
    const plan = await previewPricing(items);
    const request = randomUUID();
    const first = await applyPricing(request, items, plan.token);
    const historyAfterFirst = (await db.query("select count(*)::int n from private.price_history where product_id = $1", [p.id])).rows[0].n;
    const again = await applyPricing(request, items, plan.token);
    expect(again.data).toEqual({ ...first.data, replayed: true });
    expect((await db.query("select count(*)::int n from private.price_history where product_id = $1", [p.id])).rows[0].n).toBe(historyAfterFirst);
    expect((await applyPricing(request, [{ ...items[0], score: 91 }], plan.token)).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    // Six copies at once: one applies, five replay.
    const p2 = await product({ price: rs(2000) });
    const items2 = [{ product_id: p2.id, mode: "auto", group_id: group, score: 30 }];
    const plan2 = await previewPricing(items2);
    const request2 = randomUUID();
    const settled = await simultaneously(db, 6, (c, _i, before) => call<{ result: string; replayed?: boolean }>(c, ADMIN2,
      "select public.admin_apply_product_pricing($1, $2, $3) as r", [request2, j(items2), plan2.token], before));
    const answers = settled.map((s) => (s.status === "fulfilled" ? (s.value.data?.replayed ? "replayed" : s.value.data?.result ?? s.value.error?.code) : "rejected"));
    expect(answers.filter((a) => a === "applied")).toHaveLength(1);
    expect(answers.filter((a) => a === "replayed")).toHaveLength(5);
    expect((await db.query("select count(*)::int n from private.pricing_events where request_id = $1", [request2])).rows[0].n).toBe(1);
  });

  it("changing a maximum reprices automatic products only, after a preview", async () => {
    const g = await createGroup("Boots", rs(10000));
    const auto1 = await product({ price: rs(5000) });
    const auto2 = await product({ price: rs(5000) });
    const manual = await product({ price: rs(4321) });
    await setPricing([
      { product_id: auto1.id, mode: "auto", group_id: g, score: 50 },
      { product_id: auto2.id, mode: "auto", group_id: g, score: 25 },
      { product_id: manual.id, mode: "manual", group_id: g, score: 50 },
    ]);
    expect((await row(auto1.id)).price_paisa).toBe(rs(4995));
    const changes = [{ group_id: g, max_price_paisa: rs(8000) }];
    const preview = await admin<Plan & { groups: { max_from: number; max_to: number }[] }>("select public.admin_preview_reprice($1) as r", [j(changes)]);
    expect(preview.groups[0]).toMatchObject({ max_from: rs(10000), max_to: rs(8000) });
    expect(preview.lines.map((l) => (l.to as { price_paisa: number }).price_paisa).sort()).toEqual([rs(1995), rs(3995)]);
    // Nothing happens until it's applied.
    expect((await row(auto1.id)).price_paisa).toBe(rs(4995));
    const request = randomUUID();
    const applied = await admin<{ result: string; applied: number }>("select public.admin_apply_reprice($1, $2, $3) as r", [request, j(changes), preview.token]);
    expect(applied).toMatchObject({ result: "applied", applied: 2 });
    expect((await row(auto1.id)).price_paisa).toBe(rs(3995));
    expect((await row(auto2.id)).price_paisa).toBe(rs(1995));
    expect((await row(manual.id)).price_paisa).toBe(rs(4321));
    // A retry of the same request changes nothing more.
    expect(await admin("select public.admin_apply_reprice($1, $2, $3) as r", [request, j(changes), preview.token])).toMatchObject({ result: "applied", replayed: true });
    // An old preview of the same change is stale now.
    expect((await admin<{ result: string }>("select public.admin_apply_reprice($1, $2, $3) as r", [randomUUID(), j(changes), preview.token])).result).toBe("stale");
  });

  it("a price spread gives shoes at the same score their own prices, only after a review, never above the score price", async () => {
    const g = await createGroup("Spread test", rs(6000));
    const shoes = await Promise.all(Array.from({ length: 30 }, () => product({ price: rs(5000) })));
    await setPricing(shoes.map((p) => ({ product_id: p.id, mode: "auto", group_id: g, score: 50 })));
    for (const p of shoes) expect((await row(p.id)).price_paisa).toBe(rs(2995));
    // Out of range is refused.
    const current = (await admin<{ settings: Record<string, unknown> & { version: number } }>("select public.admin_pricing_overview() as r")).settings;
    expect((await once(ADMIN2, "select public.admin_save_pricing_settings($1, $2, $3) as r", [current.version, randomUUID(), j({ ...current, price_spread_bp: 501 })])).error?.hint).toBe("invalid_settings");
    // Leaving it out (an older page) keeps it.
    await settings({ price_spread_bp: 500 });
    await settings({ price_spread_bp: undefined as unknown as null });
    const overview = await admin<{ settings: { price_spread_bp: number }; counts: { out_of_date: number } }>("select public.admin_pricing_overview() as r");
    expect(overview.settings.price_spread_bp).toBe(500);
    // Saving the setting changes no price; they show as out of date instead.
    for (const p of shoes) expect((await row(p.id)).price_paisa).toBe(rs(2995));
    const expected = shoes.map((p) => scorePrice(rs(6000), 50, 95, false, spreadOffsetBp(p.id, 500)).pricePaisa!);
    expect(overview.counts.out_of_date).toBeGreaterThanOrEqual(expected.filter((e) => e !== rs(2995)).length);
    const listed = await admin<{ items: { product_id: string; calculation: { price_paisa: number; spread_bp: number } }[] }>(
      "select public.admin_pricing_products($1) as r", [j({ group_id: g, limit: 100 })]);
    for (const item of listed.items) {
      expect(item.calculation.price_paisa).toBe(expected[shoes.findIndex((p) => p.id === item.product_id)]);
    }
    const preview = await admin<Plan>("select public.admin_preview_reprice('[]') as r");
    await admin("select public.admin_apply_reprice($1, '[]', $2) as r", [randomUUID(), preview.token]);
    const prices = await Promise.all(shoes.map(async (p) => (await row(p.id)).price_paisa));
    expect(prices).toEqual(expected);
    expect(Math.max(...prices)).toBeLessThanOrEqual(rs(2995));
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(rs(2795)); // at most 5% below Rs. 3,000, then the ending
    expect(new Set(prices).size).toBeGreaterThan(1);
    // Repricing again moves nothing: each shoe's spread is fixed.
    const again = await admin<Plan>("select public.admin_preview_reprice('[]') as r");
    expect(again.lines.filter((l) => shoes.some((p) => p.id === l.product_id) && l.action === "apply")).toHaveLength(0);
    // Back to no spread for the tests below.
    await settings({ price_spread_bp: 0 });
    const back = await admin<Plan>("select public.admin_preview_reprice('[]') as r");
    await admin("select public.admin_apply_reprice($1, '[]', $2) as r", [randomUUID(), back.token]);
    for (const p of shoes) expect((await row(p.id)).price_paisa).toBe(rs(2995));
  });

  it("changing the price ending, then bringing automatic prices up to date", async () => {
    const g = await createGroup("Ending test", rs(5000));
    const p = await product({ price: rs(5000) });
    await setPricing([{ product_id: p.id, mode: "auto", group_id: g, score: 40 }]);
    expect((await row(p.id)).price_paisa).toBe(rs(1995));
    await settings({ price_ending_rupees: 99 });
    const preview = await admin<Plan>("select public.admin_preview_reprice('[]') as r");
    const line = preview.lines.find((l) => l.product_id === p.id)!;
    expect(line).toMatchObject({ action: "apply", to: { price_paisa: rs(1999) } });
    await admin("select public.admin_apply_reprice($1, '[]', $2) as r", [randomUUID(), preview.token]);
    expect((await row(p.id)).price_paisa).toBe(rs(1999));
    await settings({ price_ending_rupees: 95 });
    const back = await admin<Plan>("select public.admin_preview_reprice('[]') as r");
    await admin("select public.admin_apply_reprice($1, '[]', $2) as r", [randomUUID(), back.token]);
    expect((await row(p.id)).price_paisa).toBe(rs(1995));
  });
});

describe("5. honest reference prices", () => {
  it("a sale started on a product offered at its price gets that reference; the badge is rounded down", async () => {
    await endAllActive();
    const p = await product({ price: rs(2495) });
    const c = await createCampaign({ name: "Reference sale", discount_bp: 1000 });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    expect((await applyCampaign(c.id)).data).toMatchObject({ result: "activated", applied: 1 });
    // Rs. 2,495 at 10%: Rs. 2,245.50 → Rs. 2,195 (the ending adds Rs. 50.50 off); badge floor(300 / 2495) = 12%.
    expect(await row(p.id)).toMatchObject({ sale_price_paisa: rs(2195), reference_price_paisa: rs(2495) });
    const provenance = await db.query("select offered_price_paisa, offered_since is not null as since, unsupported_reason from private.product_reference_prices where product_id = $1", [p.id]);
    expect(provenance.rows[0]).toEqual({ offered_price_paisa: rs(2495), since: true, unsupported_reason: null });
    await endCampaign(c.id);
    expect(await row(p.id)).toMatchObject({ sale_price_paisa: null, reference_price_paisa: null });
  });

  it("no reference for a product never offered at its price: new listings, drafts, prices raised just before (with a minimum)", async () => {
    // Inserted already on sale: a new listing has no history.
    const listed = await product({ price: rs(3000), sale: rs(2495) });
    expect((await row(listed.id)).reference_price_paisa).toBeNull();
    expect((await db.query("select unsupported_reason from private.product_reference_prices where product_id = $1", [listed.id])).rows[0].unsupported_reason).toBe("new_listing");
    // A draft going on sale (never offered).
    const draft = await product({ price: rs(3000), publication: "draft" });
    await db.query("update public.products set sale_price_paisa = $2 where id = $1", [draft.id, rs(2495)]);
    expect((await db.query("select unsupported_reason from private.product_reference_prices where product_id = $1", [draft.id])).rows[0].unsupported_reason).toBe("not_published");
    // With the owner's minimum of 7 days, a price raised today isn't a reference yet.
    await settings({ reference_min_days: 7 });
    const raised = await product({ price: rs(2000) });
    await db.query("update public.products set price_paisa = $2 where id = $1", [raised.id, rs(4000)]);
    await db.query("update public.products set sale_price_paisa = $2 where id = $1", [raised.id, rs(2995)]);
    expect(await row(raised.id)).toMatchObject({ sale_price_paisa: rs(2995), reference_price_paisa: null });
    expect((await db.query("select unsupported_reason from private.product_reference_prices where product_id = $1", [raised.id])).rows[0].unsupported_reason).toBe("offered_too_briefly");
    // Offered for 8 days (history moved back as a fixture): now it is.
    const old = await product({ price: rs(4000) });
    await db.exec(`set local session_replication_role = replica;
      update private.price_history set created_at = now() - interval '8 days' where product_id = '${old.id}';`);
    await db.query("update public.products set sale_price_paisa = $2 where id = $1", [old.id, rs(2995)]);
    expect((await row(old.id)).reference_price_paisa).toBe(rs(4000));
    await settings({ reference_min_days: null });
    // A reference can't be written by anyone: it's always worked out.
    await db.query("update public.products set reference_price_paisa = $2 where id = $1", [listed.id, rs(9000)]);
    expect((await row(listed.id)).reference_price_paisa).toBeNull();
  });

  it("a campaign can require a supported reference: products without one are left out, with the reason", async () => {
    await endAllActive();
    const ok = await product({ price: rs(2000) });
    const draft = await product({ price: rs(2000), publication: "draft" });
    const c = await createCampaign({ name: "Reference only", discount_bp: 1500, require_reference: true });
    await select(c.id, [{ product_id: ok.id, state: "included" }, { product_id: draft.id, state: "included" }]);
    const plan = await campaign(c.id);
    expect(plan.lines.map((l) => [l.product_id, l.action, l.reason])).toEqual(expect.arrayContaining([[ok.id, "apply", null], [draft.id, "skip", "not_published"]]));
    await endCampaign(c.id, "cancel");
  });
});

describe("6. campaigns", () => {
  it("does not mark a campaign line applied when its reviewed regular price no longer matches", async () => {
    await endAllActive();
    const p = await product({ price: rs(3000) });
    const c = await createCampaign({ name: "Changed price guard", discount_bp: 1000 });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    const { rows } = await db.query(
      "select private.campaign_apply_line(c, $2, $3, $4, null) as applied from private.sale_campaigns c where c.id = $1",
      [c.id, p.id, rs(4000), rs(2695)],
    );
    expect(rows[0].applied).toBe(false);
    expect((await row(p.id)).sale_price_paisa).toBeNull();
    expect((await db.query("select applied_at from private.sale_campaign_products where campaign_id = $1 and product_id = $2", [c.id, p.id])).rows[0].applied_at).toBeNull();
    await endCampaign(c.id, "cancel");
  });

  it("draft → active → ended: the reviewed sale prices, then the regular prices again", async () => {
    await endAllActive();
    const n1 = await product({ price: rs(4995) });
    const n2 = await product({ price: rs(2495) });
    const kept = await product({ price: rs(3000) });
    const c = await createCampaign({ name: "New shoes 20", discount_bp: 2000, preset: "new" });
    const sel = await select(c.id, [{ product_id: n1.id, state: "included" }, { product_id: n2.id, state: "included" }, { product_id: kept.id, state: "excluded", note: "Just arrived" }]);
    expect(sel.result).toBe("done");
    const plan = await campaign(c.id);
    expect(plan.summary).toMatchObject({ apply: 2, kept_regular: 1 });
    const l1 = plan.lines.find((l) => l.product_id === n1.id)!;
    // Rs. 4,995 at 20% = Rs. 3,996 → Rs. 3,995; the preview shows the Rs. 1 the ending added.
    expect(l1).toMatchObject({ sale_paisa: rs(3995), sale: { raw_paisa: rs(3996), rounding_paisa: 100, actual_percent: 20 }, badge_percent: 20 });
    // Nothing changes until it's applied.
    expect((await row(n1.id)).sale_price_paisa).toBeNull();
    const applied = await applyCampaign(c.id);
    expect(applied.data).toMatchObject({ result: "activated", applied: 2, skipped: 0 });
    expect((await row(n1.id)).sale_price_paisa).toBe(rs(3995));
    expect((await row(n2.id)).sale_price_paisa).toBe(rs(1995));
    expect((await row(kept.id)).sale_price_paisa).toBeNull();
    // The running sale's prices can't be changed by the product form.
    expect(await db.query("update public.products set sale_price_paisa = $2 where id = $1", [n1.id, rs(1000)]).catch((e) => e.hint)).toBe("campaign_price");
    expect(await db.query("update public.products set price_paisa = $2 where id = $1", [n1.id, rs(9000)]).catch((e) => e.hint)).toBe("campaign_price");
    const ended = await endCampaign(c.id);
    expect(ended).toMatchObject({ result: "done", status: "ended" });
    expect(await row(n1.id)).toMatchObject({ price_paisa: rs(4995), sale_price_paisa: null, reference_price_paisa: null });
    const reasons = await db.query<{ reason: string }>("select reason from private.price_history where product_id = $1 order by id", [n1.id]);
    expect(reasons.rows.map((r) => r.reason).slice(-2)).toEqual(["campaign_start", "campaign_end"]);
  });

  it("one sale at a time: overlapping windows need an explicit resolution", async () => {
    await endAllActive();
    const p = await product({ price: rs(2000) });
    const a = await createCampaign({ name: "Sale A", discount_bp: 1000 });
    await select(a.id, [{ product_id: p.id, state: "included" }]);
    expect((await applyCampaign(a.id)).data?.result).toBe("activated");
    const b = await createCampaign({ name: "Sale B", discount_bp: 1500, starts_at: new Date(Date.now() + 3600_000).toISOString() });
    await select(b.id, [{ product_id: p.id, state: "included" }]);
    const refused = await applyCampaign(b.id);
    expect(refused.error).toMatchObject({ code: "PT409", hint: "campaign_overlap" });
    expect(refused.error?.message).toContain("Sale A");
    // A product already on another sale is left out of a plan, never stacked.
    const plan = await campaign(b.id);
    expect(plan.lines[0]).toMatchObject({ action: "skip", reason: "other_sale" });
    // Resolution: end A; B (scheduled for later) can then be activated.
    await endCampaign(a.id);
    expect((await applyCampaign(b.id)).data?.result).toBe("scheduled");
    await endCampaign(b.id, "cancel");
  });

  it("two overlapping activations at the same moment: exactly one succeeds", async () => {
    await endAllActive();
    const p1 = await product({ price: rs(2000) });
    const p2 = await product({ price: rs(2000) });
    const a = await createCampaign({ name: "Race A", discount_bp: 1000 });
    const b = await createCampaign({ name: "Race B", discount_bp: 1000 });
    await select(a.id, [{ product_id: p1.id, state: "included" }]);
    await select(b.id, [{ product_id: p2.id, state: "included" }]);
    const plans = [await campaign(a.id), await campaign(b.id)];
    const settled = await simultaneously(db, 2, (c, i, before) => call<{ result: string }>(c, ADMIN2,
      "select public.admin_apply_campaign($1, $2, $3, $4) as r", [plans[i].campaign.id, plans[i].campaign.version, randomUUID(), plans[i].token], before));
    const answers = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.hint : "rejected"));
    expect(answers.sort()).toEqual(["activated", "campaign_overlap"]);
    expect((await db.query("select count(*)::int n from private.sale_campaigns where status = 'active'")).rows[0].n).toBe(1);
    await endAllActive();
  });

  it("scheduled: nothing changes until the start; then only products still as reviewed go on sale", async () => {
    await endAllActive();
    const same = await product({ price: rs(3000) });
    const changed = await product({ price: rs(3000) });
    const c = await createCampaign({ name: "Weekend", discount_bp: 1500, starts_at: new Date(Date.now() + 3600_000).toISOString(), ends_at: new Date(Date.now() + 7200_000).toISOString() });
    await select(c.id, [{ product_id: same.id, state: "included" }, { product_id: changed.id, state: "included" }]);
    expect((await applyCampaign(c.id)).data).toMatchObject({ result: "scheduled", applied: 2 });
    expect((await row(same.id)).sale_price_paisa).toBeNull();
    // Selection is frozen while scheduled.
    expect((await once(ADMIN2, "select public.admin_set_campaign_selection($1, $2, $3, $4) as r", [c.id, (await campaign(c.id)).campaign.version, randomUUID(), j([{ product_id: same.id, state: "excluded" }])])).error?.hint).toBe("campaign_scheduled");
    // The regular price of one product changes before the start.
    await db.query("update public.products set price_paisa = $2 where id = $1", [changed.id, rs(3500)]);
    // The start time arrives (moved as a fixture) and the job runs.
    await db.query("update private.sale_campaigns set starts_at = now() - interval '1 minute' where id = $1", [c.id]);
    expect(await db.query("select private.run_sale_schedule() as r").then((r) => r.rows[0].r)).toMatchObject({ started: 1, failed: 0 });
    expect((await row(same.id)).sale_price_paisa).toBe(rs(2495)); // 3,000 × 85% = 2,550 → 2,495
    expect((await row(changed.id)).sale_price_paisa).toBeNull();
    const skipped = await db.query("select skipped_reason from private.sale_campaign_products where campaign_id = $1 and product_id = $2", [c.id, changed.id]);
    expect(skipped.rows[0].skipped_reason).toBe("changed_since_review");
    // The end arrives: the job ends it and the prices are restored.
    await db.query("update private.sale_campaigns set ends_at = now() - interval '1 second' where id = $1", [c.id]);
    expect(await db.query("select private.run_sale_schedule() as r").then((r) => r.rows[0].r)).toMatchObject({ ended: 1 });
    expect((await row(same.id)).sale_price_paisa).toBeNull();
    expect((await db.query("select status, end_reason from private.sale_campaigns where id = $1", [c.id])).rows[0]).toEqual({ status: "ended", end_reason: "schedule" });
    const heartbeat = await db.query("select last_succeeded_at is not null as ok from private.job_heartbeats where job = 'sale_schedule'");
    expect(heartbeat.rows[0].ok).toBe(true);
  });

  it("cancel, unschedule and stale forms", async () => {
    await endAllActive();
    const p = await product({ price: rs(2000) });
    const c = await createCampaign({ name: "Later", discount_bp: 1000, starts_at: new Date(Date.now() + 3600_000).toISOString() });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    const first = await campaign(c.id);
    // A stale version is refused.
    expect((await once(ADMIN2, "select public.admin_set_campaign_selection($1, $2, $3, $4) as r", [c.id, first.campaign.version - 1, randomUUID(), j([{ product_id: p.id, state: "excluded" }])])).error?.hint).toBe("version_conflict");
    await applyCampaign(c.id);
    expect((await endCampaign(c.id, "unschedule")).status).toBe("draft");
    expect((await db.query("select planned_sale_paisa from private.sale_campaign_products where campaign_id = $1", [c.id])).rows[0].planned_sale_paisa).toBeNull();
    expect((await endCampaign(c.id, "cancel")).status).toBe("cancelled");
    expect((await once(ADMIN2, "select public.admin_end_campaign($1, $2, $3, 'end') as r", [c.id, (await campaign(c.id)).campaign.version, randomUUID()])).error?.hint).toBe("bad_transition");
    expect((await row(p.id)).sale_price_paisa).toBeNull();
  });

  it("a duplicate activation (lost answer, retried) applies once", async () => {
    await endAllActive();
    const p = await product({ price: rs(2000) });
    const c = await createCampaign({ name: "Retry", discount_bp: 1000 });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    const plan = await campaign(c.id);
    const request = randomUUID();
    const settled = await simultaneously(db, 4, (cl, _i, before) => call<{ result: string; replayed?: boolean }>(cl, ADMIN2,
      "select public.admin_apply_campaign($1, $2, $3, $4) as r", [c.id, plan.campaign.version, request, plan.token], before));
    const answers = settled.map((s) => (s.status === "fulfilled" ? (s.value.data?.replayed ? "replayed" : s.value.data?.result ?? s.value.error?.hint) : "rejected"));
    expect(answers.sort()).toEqual(["activated", "replayed", "replayed", "replayed"]);
    expect((await db.query("select count(*)::int n from private.price_history where product_id = $1 and reason = 'campaign_start'", [p.id])).rows[0].n).toBe(1);
    // An identical create, retried after a lost answer: one campaign.
    const createRequest = randomUUID();
    const input = j({ name: "Created once", discount_bp: 1000, starts_at: new Date(Date.now() + 86400_000).toISOString() });
    const one = await admin<{ id: string }>("select public.admin_create_campaign($1, $2) as r", [createRequest, input]);
    const two = await admin<{ id: string; replayed: boolean }>("select public.admin_create_campaign($1, $2) as r", [createRequest, input]);
    expect(two).toMatchObject({ id: one.id, replayed: true });
    expect((await db.query("select count(*)::int n from private.sale_campaigns where name = 'Created once'")).rows[0].n).toBe(1);
    await endAllActive();
  });

  it("changing a maximum during a sale: previewed; the reference only goes down, so no bigger discount is manufactured", async () => {
    await endAllActive();
    const g = await createGroup("During sale", rs(5000));
    const down = await product({ price: rs(4000) });
    const up = await product({ price: rs(4000) });
    await setPricing([{ product_id: down.id, mode: "auto", group_id: g, score: 50 }, { product_id: up.id, mode: "auto", group_id: g, score: 40 }]);
    // Regular Rs. 2,495 and Rs. 1,995; on sale at 20%: Rs. 1,995 (badge 20%) and Rs. 1,595 (badge 20%).
    const c = await createCampaign({ name: "Max change", discount_bp: 2000 });
    await select(c.id, [{ product_id: down.id, state: "included" }, { product_id: up.id, state: "included" }]);
    await applyCampaign(c.id);
    expect(await row(down.id)).toMatchObject({ price_paisa: rs(2495), sale_price_paisa: rs(1995), reference_price_paisa: rs(2495) });
    // Lower the maximum to Rs. 4,000: Rs. 1,995 regular, Rs. 1,595 sale.
    let preview = await admin<Plan>("select public.admin_preview_reprice($1) as r", [j([{ group_id: g, max_price_paisa: rs(4000) }])]);
    const l = preview.lines.find((x) => x.product_id === down.id)!;
    expect(l).toMatchObject({ to: { price_paisa: rs(1995), sale_price_paisa: rs(1595), reference_price_paisa: rs(1995) }, badge_from: 20, badge_to: 20 });
    await admin("select public.admin_apply_reprice($1, $2, $3) as r", [randomUUID(), j([{ group_id: g, max_price_paisa: rs(4000) }]), preview.token]);
    // Kept at 20%: the old Rs. 2,495 would have made it 36%.
    expect(await row(down.id)).toMatchObject({ price_paisa: rs(1995), sale_price_paisa: rs(1595), reference_price_paisa: rs(1995) });
    // Raise it to Rs. 8,000: the reference doesn't rise with the price.
    preview = await admin<Plan>("select public.admin_preview_reprice($1) as r", [j([{ group_id: g, max_price_paisa: rs(8000) }])]);
    await admin("select public.admin_apply_reprice($1, $2, $3) as r", [randomUUID(), j([{ group_id: g, max_price_paisa: rs(8000) }]), preview.token]);
    const after = await row(up.id);
    // Score 40 of Rs. 8,000: Rs. 3,195 regular, Rs. 2,556 → Rs. 2,495 on sale; reference Rs. 1,995 < sale: dropped, no badge.
    expect(after).toMatchObject({ price_paisa: rs(3195), sale_price_paisa: rs(2495), reference_price_paisa: null });
    const line = await db.query("select applied_regular_paisa, applied_sale_paisa from private.sale_campaign_products where campaign_id = $1 and product_id = $2", [c.id, up.id]);
    expect(line.rows[0]).toEqual({ applied_regular_paisa: rs(3195), applied_sale_paisa: rs(2495) });
    await endCampaign(c.id);
    expect(await row(up.id)).toMatchObject({ price_paisa: rs(3195), sale_price_paisa: null });
  });
});

describe("7. margins and agents", () => {
  it("checks the margin of every agent even when a different agent has the lowest profit", async () => {
    await endAllActive();
    await disableAgents();
    await settings({ min_profit_paisa: null, min_margin_bp: 9000 });
    try {
      await agent({ discount_bp: 2000, commission_bp: 0, applies_to_sale_items: true });
      await agent({ discount_bp: 0, commission_bp: 1500, applies_to_sale_items: true });
      // First agent: Rs. 80 retained / Rs. 80 paid = 100% margin.
      // Second: Rs. 85 retained / Rs. 100 paid = 85%: below the 90% minimum.
      const { rows } = await db.query("select private.unit_economics(10000, 0, true, true) as r");
      expect(rows[0].r.worst).toMatchObject({ paid_paisa: 8000, retained_paisa: 8000 });
      expect(rows[0].r.margin).toBe("violation");
      await settings({ min_margin_bp: null });
      const p = await product({ price: rs(1000) });
      await setPricing([{ product_id: p.id, mode: "manual", cost_paisa: 0 }]);
      await settings({ min_margin_bp: 9000 });
      const c = await createCampaign({ name: "Margin ratios", discount_bp: 1000 });
      await select(c.id, [{ product_id: p.id, state: "included" }]);
      expect((await campaign(c.id)).lines[0]).toMatchObject({ action: "skip", reason: "margin_violation" });
      await endCampaign(c.id, "cancel");
    } finally {
      await settings({ min_profit_paisa: null, min_margin_bp: null });
      await disableAgents();
    }
  });

  it("unknown costs stay unknown; margins use the worst current agent terms; overrides are explicit and audited", async () => {
    await endAllActive();
    await disableAgents();
    await settings({ min_profit_paisa: rs(500) });
    await agent({ discount_bp: 1000, commission_bp: 500, applies_to_sale_items: true });
    await agent({ discount_bp: 1500, commission_bp: 1000, applies_to_sale_items: true });
    await agent({ discount_bp: 2000, commission_bp: 2000, applies_to_sale_items: false });
    const g = await createGroup("Margins", rs(5000));
    const known = await product({ price: rs(3000) });
    const unknown = await product({ price: rs(3000) });
    const tight = await product({ price: rs(3000) });
    await setPricing([
      { product_id: known.id, mode: "manual", group_id: g, score: 60, cost_paisa: rs(1000) },
      { product_id: tight.id, mode: "manual", group_id: g, score: 60, cost_paisa: rs(1900) },
    ]);
    const c = await createCampaign({ name: "Margin sale", discount_bp: 2000 });
    await select(c.id, [{ product_id: known.id, state: "included" }, { product_id: unknown.id, state: "included" }, { product_id: tight.id, state: "included" }]);
    const plan = await campaign(c.id);
    const byId = Object.fromEntries(plan.lines.map((l) => [l.product_id, l])) as Record<string, Line & { sale_paisa: number }>;
    // Rs. 3,000 at 20% → Rs. 2,395. Worst sale-item terms: 15% off (Rs. 359.25 → 359), 10% of Rs. 2,036 = Rs. 203.60 → 204.
    expect(byId[known.id].economics.worst).toMatchObject({ paid_paisa: 203575, commission_paisa: 20358, retained_paisa: 203575 - 20358 - rs(1000) });
    // The agent whose terms exclude sale items isn't a scenario; it's counted as excluded.
    expect(byId[known.id].economics.scenarios).toHaveLength(3);
    expect(byId[known.id].economics.agents_excluded).toBe(1);
    expect(byId[known.id]).toMatchObject({ action: "apply" });
    expect(byId[unknown.id]).toMatchObject({ action: "skip", reason: "cost_unknown", economics: { margin: "cost_unknown", worst: { retained_paisa: null } } });
    // Rs. 2,035.75 − Rs. 203.58 − Rs. 1,900 = −Rs. 67.83: below the Rs. 500 minimum.
    expect(byId[tight.id]).toMatchObject({ action: "skip", reason: "margin_violation", economics: { margin: "violation" } });
    // An explicit override with a reason lets it through, and is recorded.
    await select(c.id, [{ product_id: tight.id, state: "included", override_reason: "Clearing old stock, owner approved" }]);
    const plan2 = await campaign(c.id);
    expect(plan2.lines.find((l) => l.product_id === tight.id)).toMatchObject({ action: "apply" });
    expect((await db.query("select count(*)::int n from private.pricing_events where kind = 'margin_override' and details ->> 'product_id' = $1", [tight.id])).rows[0].n).toBe(1);
    expect((await applyCampaign(c.id)).data).toMatchObject({ applied: 2, skipped: 1 });
    await endCampaign(c.id);
    await settings({ min_profit_paisa: null });
    await disableAgents();
  });
});

describe("8. checkout", () => {
  it("a 20% sale then a 10% code is 28% off; commission on what's paid after the discount; delivery earns none", async () => {
    await endAllActive();
    await disableAgents();
    const a = await agent({ discount_bp: 1000, commission_bp: 500, applies_to_sale_items: true });
    const p = await product({ price: rs(10000) });
    await setPricing([{ product_id: p.id, mode: "manual", group_id: await createGroup("Checkout", rs(10000)), score: 100 }]);
    const c = await createCampaign({ name: "Twenty", discount_bp: 2000 });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    await applyCampaign(c.id);
    // Rs. 10,000 at 20% = Rs. 8,000 → Rs. 7,995 with the 95 ending.
    const lines = [{ sku: p.skus[0], quantity: 1, unit_price_paisa: rs(7995) }];
    const q = await quote(lines, a.code);
    expect(q.lines[0]).toMatchObject({ unit_price_paisa: rs(7995), regular_price_paisa: rs(10000), reference_price_paisa: rs(10000), referral_eligible: true, discount_paisa: 79950 });
    expect(q.subtotal_paisa - q.discount_paisa).toBe(719550);
    const placed = await place(lines, q, a.code);
    expect(placed.data?.result).toBe("placed");
    const snap = await db.query("select r.eligible_subtotal_paisa::int, r.discount_paisa::int, r.commission_basis_paisa::int, r.commission_paisa::int, o.delivery_paisa::int from public.order_referrals r join public.orders o on o.id = r.order_id where o.order_number = $1", [placed.data!.order!.order_number]);
    expect(snap.rows[0]).toEqual({ eligible_subtotal_paisa: rs(7995), discount_paisa: 79950, commission_basis_paisa: 719550, commission_paisa: 35978, delivery_paisa: 30000 });
    // The sale ends, the price changes: the order and its commission keep their snapshot.
    await endCampaign(c.id);
    const after = await db.query("select oi.unit_price_paisa::int, r.commission_paisa::int from public.order_items oi join public.orders o on o.id = oi.order_id join public.order_referrals r on r.order_id = o.id where o.order_number = $1", [placed.data!.order!.order_number]);
    expect(after.rows[0]).toEqual({ unit_price_paisa: rs(7995), commission_paisa: 35978 });
    await disableAgents();
  });

  it("a sale starting between the quote and the order is caught (quote_changed), never charged silently", async () => {
    await endAllActive();
    const p = await product({ price: rs(3000) });
    const lines = [{ sku: p.skus[0], quantity: 1, unit_price_paisa: rs(3000) }];
    const q = await quote(lines);
    const c = await createCampaign({ name: "Sudden", discount_bp: 1000 });
    await select(c.id, [{ product_id: p.id, state: "included" }]);
    await applyCampaign(c.id);
    const placed = await place(lines, q);
    expect(placed.data).toMatchObject({ result: "quote_changed", quote: { lines: [{ unit_price_paisa: rs(2695), price_changed: true }] } });
    await endCampaign(c.id);
  });

  it("clearance can exclude referral discounts, disclosed in the quote", async () => {
    await endAllActive();
    await disableAgents();
    const a = await agent({ discount_bp: 1000, commission_bp: 500, applies_to_sale_items: true });
    const clearance = await product({ price: rs(2000) });
    const regular = await product({ price: rs(2000) });
    const c = await createCampaign({ name: "Clearance", discount_bp: 3000, preset: "clearance", referral_allowed: false });
    await select(c.id, [{ product_id: clearance.id, state: "included" }]);
    await applyCampaign(c.id);
    expect((await row(clearance.id)).referral_excluded).toBe(true);
    const q = await quote([{ sku: clearance.skus[0], quantity: 1, unit_price_paisa: rs(1395) }, { sku: regular.skus[0], quantity: 1, unit_price_paisa: rs(2000) }], a.code);
    expect(q.lines[0]).toMatchObject({ referral_excluded: true, referral_eligible: false, discount_paisa: 0 });
    expect(q.lines[1]).toMatchObject({ referral_excluded: false, referral_eligible: true, discount_paisa: rs(200) });
    const only = await quote([{ sku: clearance.skus[0], quantity: 1, unit_price_paisa: rs(1395) }], a.code);
    expect(only.referral?.status).toBe("no_eligible_items");
    await endCampaign(c.id);
    expect((await row(clearance.id)).referral_excluded).toBe(false);
    await disableAgents();
  });
});

describe("9. coverage", () => {
  it("counts published, in-stock listings (not sizes); ceil(85%) for new; flags what needs review", async () => {
    await endAllActive();
    // Make this test's catalogue the only published stock.
    await db.exec("set local session_replication_role = replica; update public.products set publication_status = 'archived' where publication_status = 'published';");
    const news = [];
    for (let i = 0; i < 7; i++) news.push(await product({ price: rs(2000), sizes: [3, 2, 1] }));
    await product({ price: rs(2000), sizes: [0, 0] }); // sold out: not eligible
    await product({ price: rs(2000), publication: "draft" }); // unpublished: not eligible
    const pre = [await product({ status: "preloved", price: rs(1500) }), await product({ status: "preloved", price: rs(1500) })];
    const before = await admin<{ statuses: Record<string, { eligible: number; on_sale: number; target: number; gap: number }>; needs_review: { product_id: string }[] }>("select public.admin_sale_coverage() as r");
    expect(before.statuses.new).toMatchObject({ eligible: 7, on_sale: 0, target: 6, gap: 6 });
    expect(before.statuses.preloved).toMatchObject({ eligible: 2, on_sale: 0, target: 2 });
    expect(before.needs_review).toHaveLength(9);
    const c = await createCampaign({ name: "Coverage", discount_bp: 1000 });
    await select(c.id, [
      ...news.slice(0, 6).map((p) => ({ product_id: p.id, state: "included" })),
      { product_id: news[6].id, state: "excluded", note: "Kept at regular price" },
      ...pre.map((p) => ({ product_id: p.id, state: "included" })),
    ]);
    await applyCampaign(c.id);
    const after = await admin<{ statuses: Record<string, { eligible: number; on_sale: number; coverage_bp: number; gap: number }>; needs_review: unknown[]; kept_regular: unknown[] }>("select public.admin_sale_coverage() as r");
    expect(after.statuses.new).toMatchObject({ eligible: 7, on_sale: 6, coverage_bp: 8571, gap: 0 });
    expect(after.statuses.preloved).toMatchObject({ eligible: 2, on_sale: 2, coverage_bp: 10000, gap: 0 });
    expect(after.needs_review).toHaveLength(0);
    expect(after.kept_regular).toHaveLength(1);
    // A newly published listing is flagged for review; nothing changes its price by itself.
    const fresh = await product({ price: rs(2000) });
    const later = await admin<{ needs_review: { product_id: string }[] }>("select public.admin_sale_coverage() as r");
    expect(later.needs_review.map((r) => r.product_id)).toEqual([fresh.id]);
    expect((await row(fresh.id)).sale_price_paisa).toBeNull();
    // Adding it to the running sale is a reviewed change too.
    await select(c.id, [{ product_id: fresh.id, state: "included" }]);
    expect((await applyCampaign(c.id)).data).toMatchObject({ result: "updated", applied: 1 });
    // And removing one takes it off sale.
    await select(c.id, [{ product_id: news[0].id, state: "excluded" }]);
    expect((await applyCampaign(c.id)).data).toMatchObject({ result: "updated", removed: 1 });
    expect((await row(news[0].id)).sale_price_paisa).toBeNull();
    await endCampaign(c.id);
  });
});
