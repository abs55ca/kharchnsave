import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createDatabase, simultaneously, type Claims, type TestDatabase } from "./lib/db";

/*
 * Sales agents, referral codes, commission and payouts
 * (supabase/migrations/20261118120*.sql) on real PostgreSQL with every
 * migration applied. Calls are made the way Supabase's API makes them: one
 * transaction per call, as anon or authenticated with JWT claims.
 * NOT Supabase: Auth itself (invitations, passwords) isn't simulated; an
 * Auth user is a row in the stand-in auth.users table.
 */

const GATEWAY = "db-tests-gateway-secret-not-a-real-one-000003";
const ADMIN = "a1a1a1a1-0000-4000-8000-0000000000a1";
const USER = "b2b2b2b2-0000-4000-8000-0000000000b2";
const AGENT_A_USER = "c3c3c3c3-0000-4000-8000-0000000000c3";
const AGENT_B_USER = "d4d4d4d4-0000-4000-8000-0000000000d4";
const SUSPENDED_USER = "e5e5e5e5-0000-4000-8000-0000000000e5";
const claims = (sub: string, aal: "aal1" | "aal2" = "aal1"): Claims => ({ sub, role: "authenticated", aal });
const ADMIN2 = claims(ADMIN, "aal2");
const ROLES = {
  anon: null,
  "user aal1": claims(USER),
  "user aal2": claims(USER, "aal2"),
  "agent aal1": claims(AGENT_A_USER),
  "agent aal2": claims(AGENT_A_USER, "aal2"),
  "suspended agent": claims(SUSPENDED_USER),
  "admin aal1": claims(ADMIN),
  "admin aal2": ADMIN2,
} satisfies Record<string, Claims>;
type RoleName = keyof typeof ROLES;

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
  if (error) throw new Error(`${sql}: ${error.code} ${error.message}`);
  return data as T;
}

type Agent = { id: string; code: string; version: number; user_id: string | null; access_status: string; terms_version: number };
type AgentResult = { result: string; agent?: Agent; agent_id?: string };

const createAgent = (requestId: string, agent: Record<string, unknown>) =>
  once<AgentResult>(ADMIN2, "select public.admin_create_agent($1, $2) as r", [requestId, JSON.stringify(agent)]);

let agentCount = 0;
/** An active agent with a login, an enabled code and the given terms. */
async function activeAgent(
  terms: { discount_bp?: number; commission_bp?: number; applies_to_sale_items?: boolean } = {},
  userId: string = randomUUID(),
): Promise<Agent & { userId: string }> {
  const n = ++agentCount;
  const email = `agent${n}-${randomBytes(3).toString("hex")}@test.invalid`;
  const created = await createAgent(randomUUID(), {
    username: `agent${n}x${randomBytes(2).toString("hex")}`, display_name: `Agent ${n}`, email,
    code: `AG${n}${randomBytes(3).toString("hex")}`.toUpperCase().slice(0, 16),
    discount_bp: terms.discount_bp ?? 1000, commission_bp: terms.commission_bp ?? 500,
    applies_to_sale_items: terms.applies_to_sale_items ?? false, code_enabled: true,
  });
  if (created.error || created.data?.result !== "created") throw new Error(JSON.stringify(created));
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do update set email = excluded.email", [userId, email]);
  const linked = await admin<AgentResult>("select public.admin_link_agent_user($1) as r", [created.data.agent!.id]);
  if (linked.result !== "linked") throw new Error(JSON.stringify(linked));
  return { ...linked.agent!, userId };
}

let productCount = 0;
async function product(price: number, { sale = null as number | null, stock = 5 } = {}) {
  const code = `RF-${++productCount}`;
  await db.exec(`
    insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
      colour, description, price_paisa, sale_price_paisa, publication_status, listed_at)
    values ('${code}', 'rf-${productCount}', 'Referral ${code}', 'Testbrand', 'men', '{sneakers}', 'new', 'new',
      'Black', 'Test', ${price}, ${sale ?? "null"}, 'draft', current_date);
    insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
    select id, item_status, '${code}-40', 40, ${stock} from public.products where item_code = '${code}';
    insert into public.product_images (product_id, src, alt, width, height)
    select id, '/images/test.jpg', 'Test', 800, 800 from public.products where item_code = '${code}';
    update public.products set publication_status = 'published' where item_code = '${code}';`);
  return { sku: `${code}-40`, price: sale ?? price };
}

type QuoteLine = { sku: string; status: string; referral_eligible: boolean | null; discount_paisa: number; unit_price_paisa: number };
type Quote = {
  lines: QuoteLine[]; subtotal_paisa: number; discount_paisa: number; merchandise_paisa: number; delivery_paisa: number;
  total_paisa: number; exact: boolean; referral: { code: string; status: string; discount_bp?: number } | null;
};
type Line = { sku: string; quantity: number; unit_price_paisa: number };
const line = (p: { sku: string; price: number }, quantity = 1): Line => ({ sku: p.sku, quantity, unit_price_paisa: p.price });

async function quote(lines: Line[], code: string | null = null, city = "Lahore") {
  const { data, error } = await once<Quote>(null, "select public.quote_order($1, $2, $3, $4) as r", [GATEWAY, JSON.stringify(lines), city, code]);
  if (error) throw new Error(`quote: ${error.code} ${error.message}`);
  return data!;
}

const checkoutKey = () => randomBytes(32).toString("base64url");
const randomPhone = () => `+92301${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/** The order body a customer sends after seeing `q` (optionally tampered with). */
function body(lines: Line[], q: Quote, code: string | null, change: Record<string, unknown> = {}) {
  return {
    lines,
    delivery_paisa: q.delivery_paisa,
    total_paisa: q.total_paisa,
    ...(code !== null ? { referral_code: code, discount_paisa: q.discount_paisa } : {}),
    customer: { name: "Referral Customer", phone: randomPhone(), city: "Lahore", address: "House 9, Street 9, Test Town" },
    ...change,
  };
}

type Placed = { result: string; order?: Record<string, unknown> & { order_number: string }; quote?: Quote };
const place = (key: string, order: object) => once<Placed>(null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, key, JSON.stringify(order)]);

async function placeOrder(lines: Line[], code: string | null) {
  const q = await quote(lines, code);
  const key = checkoutKey();
  const placed = await place(key, body(lines, q, code));
  if (placed.error || placed.data?.result !== "placed") throw new Error(JSON.stringify(placed));
  const { rows } = await db.query<{ id: string }>("select id from public.orders where order_number = $1", [placed.data.order!.order_number]);
  return { id: rows[0].id, number: placed.data.order!.order_number, quote: q, key };
}

const version = async (orderId: string) => (await db.query<{ version: number }>("select version from public.orders where id = $1", [orderId])).rows[0].version;

async function orderStep(orderId: string, step: "confirm" | "dispatch" | "deliver" | "deliver_uncollected" | "settle" | "cancel" | "return" | "collect", requestId = randomUUID()) {
  const v = await version(orderId);
  const calls: Record<typeof step, [string, unknown[]]> = {
    confirm: ["select public.admin_confirm_order($1, $2, $3) as r", [orderId, v, requestId]],
    dispatch: ["select public.admin_dispatch_order($1, $2, $3, 'TCS', 'T1') as r", [orderId, v, requestId]],
    deliver: ["select public.admin_mark_delivered($1, $2, $3, true) as r", [orderId, v, requestId]],
    deliver_uncollected: ["select public.admin_mark_delivered($1, $2, $3, false) as r", [orderId, v, requestId]],
    collect: ["select public.admin_record_payment($1, $2, $3, 'collected', (select total_paisa from public.orders where id = $1), null) as r", [orderId, v, requestId]],
    settle: ["select public.admin_record_payment($1, $2, $3, 'settled', null, 'REMIT-1') as r", [orderId, v, requestId]],
    cancel: ["select public.admin_cancel_order($1, $2, $3, 'customer_request') as r", [orderId, v, requestId]],
    return: ["select public.admin_receive_return($1, $2, $3, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'restock', quantity, 'write_off', 0)) from public.order_items where order_id = $1)) as r", [orderId, v, requestId]],
  };
  const [sql, params] = calls[step];
  return admin<{ result: string }>(sql, params);
}

/** Delivered, with the recorded delivery time moved back (test fixture only: triggers off for this update). */
async function backdateDelivery(orderId: string, hoursAgo: number) {
  await db.exec(`set local session_replication_role = replica;
    update public.orders set delivered_at = now() - make_interval(secs => ${hoursAgo * 3600}) where id = '${orderId}';`);
}

async function deliveredAndSettled(lines: Line[], code: string, hoursAgo = 721) {
  const o = await placeOrder(lines, code);
  for (const step of ["confirm", "dispatch", "deliver", "settle"] as const) await orderStep(o.id, step);
  await backdateDelivery(o.id, hoursAgo);
  return o;
}

type Row = { order_number: string; state: string; commission_paisa: number; earned_paisa: number; release_at: string };
async function stateOf(agentId: string, orderNumber: string) {
  const { rows } = await db.query<Row>("select * from private.commission_rows($1) where order_number = $2", [agentId, orderNumber]);
  return rows[0];
}

const payout = (agentId: string, requestId: string, orderIds: string[], adjustmentIds: string[], amount: number, extra: { method?: string; paidOn?: string } = {}) =>
  once<{ result: string; id?: string }>(ADMIN2,
    "select public.admin_record_agent_payout($1, $2, $3, $4, $5, $6, $7, 'REF-1') as r",
    [agentId, requestId, orderIds, adjustmentIds, amount, extra.paidOn ?? new Date().toISOString().slice(0, 10), extra.method ?? "bank_transfer"]);

beforeAll(async () => {
  db = await createDatabase("referrals");
  await db.exec(`
    insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to('${GATEWAY}', 'UTF8')), 'db-tests');
    insert into auth.users (id, email) values ('${ADMIN}', 'r-admin@test.invalid'), ('${USER}', 'r-user@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
    -- TEST VALUES ONLY.
    update public.shop_settings set delivery_area_mode = 'nationwide', standard_delivery_fee_paisa = 30000,
      free_delivery_enabled = false, max_lines_per_order = 10, max_units_per_order = 50, max_units_per_line = 20,
      max_open_orders_per_phone = 20, place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000,
      lookups_per_ip_10min = 1000, quotes_per_ip_10min = 1000, orders_per_minute_global = 10000,
      in_store_sells_unpublished = true, orders_open = true;`);
});

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------

describe("1. agent accounts and provisioning", () => {
  it("only a verified admin (member + aal2) can create an agent", async () => {
    const agent = { username: "nobody", display_name: "No Body", email: "nobody@test.invalid", code: "NOBODY", discount_bp: 1000 };
    for (const role of ["anon", "user aal1", "user aal2", "admin aal1"] as RoleName[]) {
      const r = await once(ROLES[role], "select public.admin_create_agent($1, $2) as r", [randomUUID(), JSON.stringify(agent)]);
      expect(r.error?.code, role).toBe("42501");
    }
    expect((await db.query("select count(*)::int n from public.sales_agents where username = 'nobody'")).rows[0].n).toBe(0);
  });

  it("creates with normalised fields; a retry returns the same agent; the same request id with other data is refused", async () => {
    const request = randomUUID();
    const input = { username: " Ahmed ", display_name: "  Ahmed   Khan ", email: "Ahmed@Test.invalid", code: " ah-med ", discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true };
    const first = await createAgent(request, input);
    expect(first.data).toMatchObject({ result: "created", agent: { code: "AHMED", access_status: "pending", user_id: null } });
    expect((first.data!.agent as unknown as Record<string, unknown>).username).toBe("ahmed");
    expect((first.data!.agent as unknown as Record<string, unknown>).display_name).toBe("Ahmed Khan");
    expect((first.data!.agent as unknown as Record<string, unknown>).email).toBe("ahmed@test.invalid");
    const again = await createAgent(request, input);
    expect(again.data).toMatchObject({ result: "existing", agent: { id: first.data!.agent!.id } });
    // The same request id with any other payload (including just code_enabled) is refused.
    for (const changed of [{ discount_bp: 1500 }, { code_enabled: false }, { display_name: "Ahmed K" }]) {
      expect((await createAgent(request, { ...input, ...changed })).error, JSON.stringify(changed)).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    }
    // A new attempt (new request id) for the same email points at the existing agent.
    expect((await createAgent(randomUUID(), { ...input, username: "ahmed2", code: "AHMED2" })).data)
      .toEqual({ result: "email_exists", agent_id: first.data!.agent!.id });
  });

  it("the same request sent 6 times at once creates one agent", async () => {
    const request = randomUUID();
    const input = { username: "parallel", display_name: "Parallel", email: "parallel@test.invalid", code: "PARALLEL", discount_bp: 1000 };
    const settled = await simultaneously(db, 6, (c, _i, before) =>
      call<AgentResult>(c, ADMIN2, "select public.admin_create_agent($1, $2) as r", [request, JSON.stringify(input)], before));
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.code : "rejected"));
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(results.filter((r) => r === "existing")).toHaveLength(5);
    expect((await db.query("select count(*)::int n from public.sales_agents where code = 'PARALLEL'")).rows[0].n).toBe(1);
  });

  it("8 different agents racing for one code (any case): exactly one gets it", async () => {
    const settled = await simultaneously(db, 8, (c, i, before) =>
      call<AgentResult>(c, ADMIN2, "select public.admin_create_agent($1, $2) as r", [randomUUID(), JSON.stringify({
        username: `racer${i}`, display_name: `Racer ${i}`, email: `racer${i}@test.invalid`,
        code: i % 2 ? "race-1" : "RACE1", discount_bp: 1000 })], before));
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.code : "rejected"));
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(results.filter((r) => r === "code_taken")).toHaveLength(7);
  });

  it("code rules: format, case-insensitive availability, taken usernames", async () => {
    const check = (code: string) => admin<{ code: string | null; valid: boolean; available: boolean }>("select public.admin_check_agent_code($1) as r", [code]);
    expect(await check("ab")).toEqual({ code: "AB", valid: false, available: false });
    expect(await check("ab$c")).toMatchObject({ valid: false });
    expect(await check("A".repeat(17))).toMatchObject({ valid: false });
    expect(await check("fresh 01")).toEqual({ code: "FRESH01", valid: true, available: true });
    expect(await check("ahmed")).toEqual({ code: "AHMED", valid: true, available: false });
    for (const role of ["anon", "user aal2", "admin aal1", "agent aal1"] as RoleName[]) {
      expect((await once(ROLES[role], "select public.admin_check_agent_code('x') as r")).error?.code, role).toBe("42501");
    }
    const bad = await createAgent(randomUUID(), { username: "okname", display_name: "Ok", email: "ok@test.invalid", code: "AB", discount_bp: 1000 });
    expect(bad.error).toMatchObject({ code: "PT400", hint: "invalid_code" });
    const badUser = await createAgent(randomUUID(), { username: "A", display_name: "Ok", email: "ok@test.invalid", code: "ABCD", discount_bp: 1000 });
    expect(badUser.error).toMatchObject({ code: "PT400", hint: "invalid_username" });
    const taken = await createAgent(randomUUID(), { username: "ahmed", display_name: "Other", email: "other@test.invalid", code: "OTHER", discount_bp: 1000 });
    expect(taken.data).toEqual({ result: "username_taken" });
  });

  it("a code can't be enabled without a commission and an explicit sale-item choice", async () => {
    const r = await createAgent(randomUUID(), { username: "noterms", display_name: "No Terms", email: "noterms@test.invalid", code: "NOTERMS", discount_bp: 1000, commission_bp: 500, code_enabled: true });
    expect(r.error).toMatchObject({ code: "PT400", hint: "terms_required" });
    const created = (await createAgent(randomUUID(), { username: "noterms", display_name: "No Terms", email: "noterms@test.invalid", code: "NOTERMS", discount_bp: 1000 })).data!;
    const enable = await once(ADMIN2, "select public.admin_set_agent_code_enabled($1, $2, $3, true) as r", [created.agent!.id, created.agent!.version, randomUUID()]);
    expect(enable.error).toMatchObject({ code: "PT400", hint: "terms_required" });
  });

  it("linking: recoverable after a partial failure, never to an admin or a second agent", async () => {
    const request = randomUUID();
    const input = { username: "partial", display_name: "Partial", email: "partial@test.invalid", code: "PARTIAL", discount_bp: 1000 };
    const created = (await createAgent(request, input)).data!;
    // The invitation step hasn't created the Auth user yet (or failed): nothing to link.
    expect(await admin("select public.admin_link_agent_user($1) as r", [created.agent!.id])).toEqual({ result: "no_auth_user" });
    // The invitation created the Auth user, then the website failed before linking. Retry everything:
    const userId = randomUUID();
    await db.query("insert into auth.users (id, email) values ($1, 'Partial@Test.invalid')", [userId]);
    expect((await createAgent(request, input)).data?.result).toBe("existing");
    const linked = await admin<AgentResult>("select public.admin_link_agent_user($1) as r", [created.agent!.id]);
    expect(linked).toMatchObject({ result: "linked", agent: { user_id: userId, access_status: "active" } });
    expect(await admin<AgentResult>("select public.admin_link_agent_user($1) as r", [created.agent!.id])).toMatchObject({ result: "already_linked" });

    // An admin's email: refused.
    const adminAgent = (await createAgent(randomUUID(), { username: "adminagent", display_name: "Admin Agent", email: "r-admin@test.invalid", code: "ADMINAG", discount_bp: 1000 })).data!;
    expect(await admin("select public.admin_link_agent_user($1) as r", [adminAgent.agent!.id])).toEqual({ result: "is_admin" });
    // Only admins can link.
    for (const role of ["anon", "user aal2", "admin aal1", "agent aal1"] as RoleName[]) {
      expect((await once(ROLES[role], "select public.admin_link_agent_user($1) as r", [adminAgent.agent!.id])).error?.code, role).toBe("42501");
    }
    // A login can't move to another agent row.
    const err = await db.query("update public.sales_agents set user_id = $1 where id = $2", [USER, created.agent!.id]).catch((e) => e);
    expect(err).toMatchObject({ code: "PT400" });
  });

  it("codes are fixed and stay reserved after deactivation; agents are never deleted", async () => {
    const a = await activeAgent();
    const err = await db.query("update public.sales_agents set code = 'CHANGED' where id = $1", [a.id]).catch((e) => e);
    expect(err).toMatchObject({ code: "PT400", hint: "agent_locked" });
    expect(await db.query("delete from public.sales_agents where id = $1", [a.id]).catch((e) => e)).toMatchObject({ code: "PT400" });
    // Suspend and disable the code: it stays taken, in any case.
    const v1 = (await admin<AgentResult>("select public.admin_set_agent_access($1, $2, $3, 'suspended') as r", [a.id, a.version, randomUUID()])).agent!;
    await admin("select public.admin_set_agent_code_enabled($1, $2, $3, false) as r", [a.id, v1.version, randomUUID()]);
    expect(await admin("select public.admin_check_agent_code($1) as r", [a.code.toLowerCase()])).toMatchObject({ available: false });
    const reuse = await createAgent(randomUUID(), { username: "reuser", display_name: "Reuser", email: "reuser@test.invalid", code: a.code.toLowerCase(), discount_bp: 1000 });
    expect(reuse.data).toEqual({ result: "code_taken" });
    // Changing the username keeps the code.
    const now = (await admin<{ version: number }>("select public.admin_get_agent($1) as r", [a.id])).version;
    const renamed = await admin<AgentResult>("select public.admin_update_agent_profile($1, $2, $3, 'renamed-agent', 'Renamed Agent') as r", [a.id, now, randomUUID()]);
    expect(renamed.agent).toMatchObject({ code: a.code });
  });

  it("admin changes are versioned, replay-safe and logged with who made them", async () => {
    const a = await activeAgent();
    const request = randomUUID();
    const terms = JSON.stringify({ discount_bp: 1200, commission_bp: 700, applies_to_sale_items: true });
    const first = await admin<AgentResult>("select public.admin_update_agent_terms($1, $2, $3, $4) as r", [a.id, a.version, request, terms]);
    expect(first.agent).toMatchObject({ terms_version: a.terms_version + 1 });
    expect((await admin<AgentResult>("select public.admin_update_agent_terms($1, $2, $3, $4) as r", [a.id, a.version, request, terms])).result).toBe("replayed");
    const stale = await once(ADMIN2, "select public.admin_update_agent_terms($1, $2, $3, $4) as r", [a.id, a.version, randomUUID(), terms]);
    expect(stale.error).toMatchObject({ code: "PT409", hint: "version_conflict" });
    const { rows } = await db.query("select kind, actor_user_id, details from public.sales_agent_events where agent_id = $1 and kind = 'terms_changed'", [a.id]);
    expect(rows).toEqual([expect.objectContaining({ actor_user_id: ADMIN, details: expect.objectContaining({ to: { discount_bp: 1200, commission_bp: 700, applies_to_sale_items: true } }) })]);
  });
});

// ---------------------------------------------------------------------------

/** Starts admin_create_agent in an open transaction (as a verified admin) and leaves it uncommitted. */
async function openCreation(request: string, agent: Record<string, unknown>) {
  const c = await db.pool.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(ADMIN2)]);
  const { rows } = await c.query<{ r: AgentResult }>("select public.admin_create_agent($1, $2) as r", [request, JSON.stringify(agent)]);
  return { client: c, result: rows[0].r };
}

/** Waits until exactly `n` sessions are blocked on an advisory lock (and returns how they are blocked). */
async function waitForAdvisoryWaiters(n: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await db.query<{ n: number }>("select count(*)::int n from pg_locks where locktype = 'advisory' and not granted");
    if (rows[0].n === n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no session reached the advisory lock");
}

describe("1a. concurrent creation: the interleaving that returned email_exists", () => {
  // The bug: the second copy of a request read "no agent for this request id"
  // while the first was still running, the first committed, and the second
  // then read "this email is taken" -> email_exists. Each test holds the
  // first request open, proves the second is blocked on the advisory lock
  // (which is taken BEFORE either read), then lets the first finish.
  const input = (n: string) => ({ username: `interleave${n}`, display_name: "Interleave", email: `interleave${n}@test.invalid`, code: `INTER${n}`,
    discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false, code_enabled: true });

  it("the same request: the copy waits before reading anything, then returns the same agent", async () => {
    const request = randomUUID();
    const first = await openCreation(request, input("1"));
    expect(first.result.result).toBe("created");
    const second = once<AgentResult>(ADMIN2, "select public.admin_create_agent($1, $2) as r", [request, JSON.stringify(input("1"))]);
    await waitForAdvisoryWaiters(1);
    await first.client.query("commit");
    first.client.release();
    expect((await second).data).toMatchObject({ result: "existing", agent: { id: first.result.agent!.id } });
  });

  it("the same request, first rolled back: the copy creates it", async () => {
    const request = randomUUID();
    const first = await openCreation(request, input("2"));
    const second = once<AgentResult>(ADMIN2, "select public.admin_create_agent($1, $2) as r", [request, JSON.stringify(input("2"))]);
    await waitForAdvisoryWaiters(1);
    await first.client.query("rollback");
    first.client.release();
    expect((await second).data?.result).toBe("created");
  });

  it("a different request for the same email waits, then conflicts; the same code from another email conflicts too", async () => {
    const first = await openCreation(randomUUID(), input("3"));
    const sameEmail = once<AgentResult>(ADMIN2, "select public.admin_create_agent($1, $2) as r",
      [randomUUID(), JSON.stringify({ ...input("3"), username: "interleave3b", code: "INTER3B" })]);
    await waitForAdvisoryWaiters(1);
    const sameCode = once<AgentResult>(ADMIN2, "select public.admin_create_agent($1, $2) as r",
      [randomUUID(), JSON.stringify({ ...input("3"), username: "interleave3c", email: "interleave3c@test.invalid" })]);
    await first.client.query("commit");
    first.client.release();
    expect((await sameEmail).data).toEqual({ result: "email_exists", agent_id: first.result.agent!.id });
    expect((await sameCode).data).toEqual({ result: "code_taken" });
  });
});

describe("1b. admin edits: retries, versions and new requests", () => {
  type Edit = { result: string; version?: number; error?: undefined };
  const terms = (discount: number) => JSON.stringify({ discount_bp: discount, commission_bp: 500, applies_to_sale_items: false });
  const editTerms = (id: string, version: number, request: string, discount: number) =>
    once<Edit>(ADMIN2, "select public.admin_update_agent_terms($1, $2, $3, $4) as r", [id, version, request, terms(discount)]);
  const editProfile = (id: string, version: number, request: string, name: string) =>
    once<Edit>(ADMIN2, "select public.admin_update_agent_profile($1, $2, $3, $4, $5) as r", [id, version, request, `user-${id.slice(0, 8)}`, name]);
  const setCode = (id: string, version: number, request: string, enabled: boolean) =>
    once<Edit>(ADMIN2, "select public.admin_set_agent_code_enabled($1, $2, $3, $4) as r", [id, version, request, enabled]);
  const setAccess = (id: string, version: number, request: string, access: string) =>
    once<Edit>(ADMIN2, "select public.admin_set_agent_access($1, $2, $3, $4) as r", [id, version, request, access]);
  const current = async (id: string) => (await db.query("select * from public.sales_agents where id = $1", [id])).rows[0];

  it("repeated saves of the same form, each with a new request id, are all applied", async () => {
    const a = await activeAgent();
    const one = await editTerms(a.id, a.version, randomUUID(), 1100);
    const two = await editTerms(a.id, one.data!.version!, randomUUID(), 1200);
    expect([one.data?.result, two.data?.result]).toEqual(["done", "done"]);
    expect(two.data!.version).toBe(a.version + 2);
    const p1 = await editProfile(a.id, two.data!.version!, randomUUID(), "First Name");
    const p2 = await editProfile(a.id, p1.data!.version!, randomUUID(), "Second Name");
    expect(p2.data?.result).toBe("done");
    expect(await current(a.id)).toMatchObject({ discount_bp: 1200, display_name: "Second Name", version: a.version + 4 });
  });

  it("disable -> enable -> disable and suspend -> restore -> suspend without reloading", async () => {
    const a = await activeAgent();
    let v = a.version;
    for (const enabled of [false, true, false]) {
      const r = await setCode(a.id, v, randomUUID(), enabled);
      expect(r.data?.result, String(enabled)).toBe("done");
      v = r.data!.version!;
    }
    for (const access of ["suspended", "active", "suspended"]) {
      const r = await setAccess(a.id, v, randomUUID(), access);
      expect(r.data?.result, access).toBe("done");
      v = r.data!.version!;
    }
    expect(await current(a.id)).toMatchObject({ code_enabled: false, access_status: "suspended", version: v });
  });

  it("a request id reused with another payload or another action is refused", async () => {
    const a = await activeAgent();
    const request = randomUUID();
    const first = await editTerms(a.id, a.version, request, 1100);
    expect(first.data?.result).toBe("done");
    expect((await editTerms(a.id, a.version, request, 1300)).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect((await editProfile(a.id, a.version, request, "Other Name")).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect((await setCode(a.id, a.version, request, false)).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    // An identical retry is a replay: applied once.
    expect((await editTerms(a.id, a.version, request, 1100)).data).toEqual({ result: "replayed", id: a.id, version: first.data!.version });
    expect((await db.query("select count(*)::int n from public.sales_agent_events where request_id = $1", [request])).rows[0].n).toBe(1);
    expect(await current(a.id)).toMatchObject({ discount_bp: 1100 });
  });

  it("a lost answer, then another admin's edit: the retry reports the first edit's version, so a stale save conflicts", async () => {
    const a = await activeAgent();
    const request = randomUUID();
    const lost = await editTerms(a.id, a.version, request, 1500); // applied; the answer never arrives
    const other = await editProfile(a.id, lost.data!.version!, randomUUID(), "Changed By B");
    expect(other.data?.result).toBe("done");
    const retry = await editTerms(a.id, a.version, request, 1500);
    expect(retry.data).toEqual({ result: "replayed", id: a.id, version: lost.data!.version });
    expect(retry.data!.version).toBeLessThan(other.data!.version!);
    // The first admin carries on from the version their edit produced: refused, B's change survives.
    expect((await editProfile(a.id, retry.data!.version!, randomUUID(), "Stale Name")).error).toMatchObject({ code: "PT409", hint: "version_conflict" });
    expect(await current(a.id)).toMatchObject({ display_name: "Changed By B", discount_bp: 1500 });
  });
});

// ---------------------------------------------------------------------------

describe("2. permissions: admins, agents, other users and visitors", () => {
  let a: Agent & { userId: string };
  let b: Agent & { userId: string };
  beforeAll(async () => {
    a = await activeAgent({}, AGENT_A_USER);
    b = await activeAgent({}, AGENT_B_USER);
    const s = await activeAgent({}, SUSPENDED_USER);
    await admin("select public.admin_set_agent_access($1, $2, $3, 'suspended') as r", [s.id, s.version, randomUUID()]);
    const p = await product(500000);
    await placeOrder([line(p)], a.code);
    await placeOrder([line(p)], b.code);
  });

  const ADMIN_CALLS: [string, () => unknown[]][] = [
    ["select public.admin_list_agents() as r", () => []],
    ["select public.admin_get_agent($1) as r", () => [a.id]],
    ["select public.admin_agent_commissions($1, 0, 10) as r", () => [a.id]],
    ["select public.admin_agent_payouts($1, 0, 10) as r", () => [a.id]],
    ["select public.admin_update_agent_terms($1, 1, $2, '{\"discount_bp\": 5000, \"commission_bp\": 5000}') as r", () => [a.id, randomUUID()]],
    ["select public.admin_set_agent_access($1, 1, $2, 'active') as r", () => [a.id, randomUUID()]],
    ["select public.admin_set_agent_code_enabled($1, 1, $2, true) as r", () => [a.id, randomUUID()]],
    ["select public.admin_add_agent_adjustment($1, $2, 100000, 'Give myself a bonus') as r", () => [a.id, randomUUID()]],
    ["select public.admin_record_agent_payout($1, $2, '{}', '{}', 1, current_date, 'cash') as r", () => [a.id, randomUUID()]],
    ["select public.admin_order_referral($1) as r", () => [randomUUID()]],
    ["select public.admin_set_commission_hold($1, null, $2, true, 'Return being arranged') as r", () => [randomUUID(), randomUUID()]],
    ["select public.admin_confirm_order($1, 1, $2) as r", () => [randomUUID(), randomUUID()]],
    ["select public.admin_save_product($1, 1, '{}', '[]', '[]') as r", () => [randomUUID()]],
  ];

  it("every admin agent function refuses everyone but a verified admin", async () => {
    for (const [sql, params] of ADMIN_CALLS) {
      for (const role of ["anon", "user aal1", "user aal2", "agent aal1", "agent aal2", "suspended agent", "admin aal1"] as RoleName[]) {
        const r = await once(ROLES[role], sql, params());
        expect(r.error?.code, `${role}: ${sql}`).toBe("42501");
      }
    }
    expect((await once(ADMIN2, "select public.admin_list_agents() as r")).error).toBeNull();
  });

  it("agent functions: only an active agent, and only their own data", async () => {
    const dashboard = (role: RoleName) => once<{ code: string; totals: { referred_orders: number } }>(ROLES[role], "select public.agent_dashboard() as r");
    expect((await dashboard("agent aal1")).data).toMatchObject({ code: a.code, totals: { referred_orders: 1 } });
    expect((await once<{ code: string }>(claims(AGENT_B_USER), "select public.agent_dashboard() as r")).data?.code).toBe(b.code);
    for (const role of ["anon", "user aal1", "user aal2", "suspended agent", "admin aal1", "admin aal2"] as RoleName[]) {
      for (const sql of ["select public.agent_dashboard() as r", "select public.agent_referrals(0, 10) as r", "select public.agent_payouts(0, 10) as r"]) {
        expect((await once(ROLES[role], sql)).error?.code, `${role}: ${sql}`).toBe("42501");
      }
    }
    const refs = await once<{ rows: { order_number: string }[] }>(ROLES["agent aal1"], "select public.agent_referrals(0, 10) as r");
    const bOrders = (await db.query<{ order_number: string }>("select o.order_number from public.orders o join public.order_referrals r on r.order_id = o.id where r.agent_id = $1", [b.id])).rows;
    expect(refs.data!.rows).toHaveLength(1);
    expect(refs.data!.rows.map((r) => r.order_number)).not.toContain(bOrders[0].order_number);
  });

  it("agent_session says what a login is without exposing anything else", async () => {
    expect((await once(ROLES["agent aal1"], "select public.agent_session() as r")).data).toMatchObject({ status: "active" });
    expect((await once(ROLES["suspended agent"], "select public.agent_session() as r")).data).toEqual({ status: "suspended" });
    expect((await once(ROLES["user aal1"], "select public.agent_session() as r")).data).toEqual({ status: "not_agent" });
    expect((await once(ROLES.anon, "select public.agent_session() as r")).error?.code).toBe("42501");
  });

  it("no API role can read or write the new tables directly", async () => {
    const tables = ["sales_agents", "sales_agent_events", "order_referrals", "order_line_referrals", "agent_adjustments", "agent_payouts", "agent_payout_lines"];
    for (const table of tables) {
      for (const role of ["anon", "user aal2", "agent aal1", "admin aal2"] as RoleName[]) {
        expect((await once(ROLES[role], `select count(*) as r from public.${table}`)).error?.code, `${role} ${table}`).toBe("42501");
      }
    }
    for (const role of ["agent aal1", "user aal2"] as RoleName[]) {
      expect((await once(ROLES[role], "insert into public.admin_members (user_id) values ($1) returning 1 as r", [ROLES[role]!.sub])).error?.code, role).toBe("42501");
      expect((await once(ROLES[role], `update public.sales_agents set commission_bp = 5000 where user_id = '${ROLES[role]!.sub}' returning 1 as r`)).error?.code, role).toBe("42501");
      // Orders: readable only by verified admins (RLS returns nothing).
      expect((await once<number>(ROLES[role], "select count(*)::int as r from public.orders")).data).toBe(0);
    }
  });

  it("an agent can't call the order, stock or product functions", async () => {
    for (const sql of [
      "select public.admin_mark_delivered($1, 1, $2, true) as r",
      "select public.admin_record_payment($1, 1, $2, 'settled', null) as r",
      "select public.admin_link_agent_user($1) as r",
    ]) {
      expect((await once(ROLES["agent aal2"], sql, sql.includes("link") ? [a.id] : [randomUUID(), randomUUID()])).error?.code, sql).toBe("42501");
    }
  });

  it("new functions are executable only where granted", async () => {
    const { rows } = await db.query<{ fn: string; anon: boolean; auth: boolean }>(`
      select p.oid::regprocedure::text fn, has_function_privilege('anon', p.oid, 'execute') anon,
             has_function_privilege('authenticated', p.oid, 'execute') auth
      from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and (p.proname like '%agent%' or p.proname like '%referral%' or p.proname like '%commission%'
             or p.proname in ('allocate_paisa', 'percent_of', 'page_bounds', 'quote_order', 'checkout_quote'))`);
    for (const r of rows) {
      const isPublicAdminOrAgent = /^(admin_|agent_)/.test(r.fn) ;
      if (r.fn.startsWith("quote_order")) expect({ anon: r.anon, auth: r.auth }, r.fn).toEqual({ anon: true, auth: false });
      else if (isPublicAdminOrAgent) expect({ anon: r.anon, auth: r.auth }, r.fn).toEqual({ anon: false, auth: true });
      else expect({ anon: r.anon, auth: r.auth }, r.fn).toEqual({ anon: false, auth: false });
    }
    expect(rows.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------

describe("3. checkout with a referral code", () => {
  beforeEach(async () => {
    await db.exec("update public.shop_settings set free_delivery_enabled = false, free_delivery_min_paisa = null");
  });

  it("the worked example: Rs. 5,000 of products, 10% off, 5% commission on Rs. 4,500, delivery excluded", async () => {
    const a = await activeAgent({ discount_bp: 1000, commission_bp: 500 });
    const p = await product(500000);
    const q = await quote([line(p)], a.code.toLowerCase());
    expect(q).toMatchObject({ subtotal_paisa: 500000, discount_paisa: 50000, merchandise_paisa: 450000, delivery_paisa: 30000, total_paisa: 480000, exact: true,
      referral: { code: a.code, status: "ok", discount_bp: 1000 } });
    expect(JSON.stringify(q)).not.toMatch(/commission|agent|display_name|username/);
    const o = await placeOrder([line(p)], ` ${a.code.toLowerCase()} `);
    const { rows: [r] } = await db.query("select * from public.order_referrals where order_id = $1", [o.id]);
    expect(r).toMatchObject({ agent_id: a.id, code: a.code, discount_bp: 1000, commission_bp: 500, eligible_subtotal_paisa: "500000",
      discount_paisa: "50000", commission_basis_paisa: "450000", commission_paisa: "22500", hold_hours: 720 });
    const { rows: [order] } = await db.query("select subtotal_paisa, discount_paisa, delivery_paisa, total_paisa from public.orders where id = $1", [o.id]);
    expect(order).toEqual({ subtotal_paisa: "500000", discount_paisa: "50000", delivery_paisa: "30000", total_paisa: "480000" });
  });

  it("orders without a code are unchanged: no snapshot, and the request normalises exactly as before", async () => {
    const p = await product(250000);
    const o = await placeOrder([line(p)], null);
    expect((await db.query("select count(*)::int n from public.order_referrals where order_id = $1", [o.id])).rows[0].n).toBe(0);
    const { rows: [n] } = await db.query<{ keys: string[] }>(`select array(select jsonb_object_keys(private.checkout_input($1)) order by 1) keys`,
      [JSON.stringify(body([line(p)], o.quote, null))]);
    expect(n.keys).toEqual(["customer", "delivery_paisa", "lines", "total_paisa"]);
    const view = await once<Record<string, unknown>>(null, "select public.get_customer_order($1, $2) as r", [GATEWAY, o.key]);
    expect(view.data).toMatchObject({ discount_paisa: 0, referral_code: null });
  });

  it("invalid, disabled and ineligible codes: clear status, not exact, and placing returns quote_changed", async () => {
    const p = await product(300000);
    const disabled = await activeAgent();
    await admin("select public.admin_set_agent_code_enabled($1, $2, $3, false) as r", [disabled.id, disabled.version, randomUUID()]);
    const saleOnly = await activeAgent({ applies_to_sale_items: false });
    const saleItem = await product(400000, { sale: 300000 });
    for (const [lines, code, status] of [
      [[line(p)], "NOSUCHCODE", "invalid"],
      [[line(p)], "ab", "invalid"],
      [[line(p)], "bad code!", "invalid"],
      [[line(p)], disabled.code, "disabled"],
      [[line(saleItem)], saleOnly.code, "no_eligible_items"],
    ] as [Line[], string, string][]) {
      const q = await quote(lines, code);
      expect(q.referral?.status, code).toBe(status);
      expect(q.exact, code).toBe(false);
      expect(q.discount_paisa).toBe(0);
      expect(JSON.stringify(q.referral)).not.toMatch(/agent|name/);
      const placed = await place(checkoutKey(), body(lines, q, code));
      expect(placed.data?.result, code).toBe("quote_changed");
    }
  });

  it("mixed carts: sale items are excluded unless the terms include them; per-line amounts add up", async () => {
    const regular = await product(200000);
    const sale = await product(300000, { sale: 150000 });
    const excl = await activeAgent({ discount_bp: 1000, commission_bp: 1000, applies_to_sale_items: false });
    const q1 = await quote([line(regular), line(sale)], excl.code);
    const bySku = Object.fromEntries(q1.lines.map((l) => [l.sku, l]));
    expect(bySku[regular.sku]).toMatchObject({ referral_eligible: true, discount_paisa: 20000 });
    expect(bySku[sale.sku]).toMatchObject({ referral_eligible: false, discount_paisa: 0, unit_price_paisa: 150000 });
    expect(q1).toMatchObject({ subtotal_paisa: 350000, discount_paisa: 20000, total_paisa: 360000 });
    const o1 = await placeOrder([line(regular), line(sale)], excl.code);
    const r1 = (await db.query("select eligible_subtotal_paisa, commission_paisa from public.order_referrals where order_id = $1", [o1.id])).rows[0];
    expect(r1).toEqual({ eligible_subtotal_paisa: "200000", commission_paisa: "18000" });

    const incl = await activeAgent({ discount_bp: 1000, commission_bp: 1000, applies_to_sale_items: true });
    const q2 = await quote([line(regular), line(sale)], incl.code);
    expect(q2).toMatchObject({ discount_paisa: 35000 });
    expect(q2.lines.every((l) => l.referral_eligible)).toBe(true);
    const o2 = await placeOrder([line(regular), line(sale)], incl.code);
    const lines = (await db.query("select line_no, eligible, line_total_paisa, discount_paisa, commission_paisa from public.order_line_referrals where order_id = $1 order by line_no", [o2.id])).rows;
    expect(lines.reduce((s, l) => s + Number(l.discount_paisa), 0)).toBe(35000);
    expect(lines.reduce((s, l) => s + Number(l.commission_paisa), 0)).toBe(31500);
  });

  it("rounding: half up per order, then whole paisa shared by largest remainder", async () => {
    expect((await db.query("select private.percent_of(1005, 500) a, private.percent_of(1010, 500) b, private.percent_of(99999, 1000) c, private.percent_of(0, 1000) d")).rows[0])
      .toEqual({ a: "50", b: "51", c: "10000", d: "0" });
    expect((await db.query("select private.allocate_paisa(10000, array[33333, 33333, 33333]::bigint[]) a, private.allocate_paisa(7, array[1, 0, 2]::bigint[]) b, private.allocate_paisa(5, array[0, 0]::bigint[]) c")).rows[0])
      .toEqual({ a: ["3334", "3333", "3333"], b: ["2", "0", "5"], c: ["0", "0"] });

    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 750 });
    const ps = await Promise.all([product(33333), product(33333), product(33333)]);
    const o = await placeOrder(ps.map((p) => line(p)), agent.code);
    expect(o.quote.discount_paisa).toBe(10000);
    const r = (await db.query("select commission_basis_paisa, commission_paisa from public.order_referrals where order_id = $1", [o.id])).rows[0];
    // 7.5% of 89,999 paisa = 6,749.925 -> 6,750.
    expect(r).toEqual({ commission_basis_paisa: "89999", commission_paisa: "6750" });
    const lines = (await db.query<{ discount_paisa: string; commission_paisa: string }>("select discount_paisa, commission_paisa from public.order_line_referrals where order_id = $1 order by line_no", [o.id])).rows;
    expect(lines.map((l) => Number(l.discount_paisa))).toEqual([3334, 3333, 3333]);
    expect(lines.reduce((s, l) => s + Number(l.commission_paisa), 0)).toBe(6750);
  });

  it("free delivery is judged on the merchandise total after the discount", async () => {
    await db.exec("update public.shop_settings set free_delivery_enabled = true, free_delivery_min_paisa = 500000");
    const agent = await activeAgent({ discount_bp: 1000 });
    const p = await product(520000);
    expect(await quote([line(p)])).toMatchObject({ delivery_paisa: 0, total_paisa: 520000 });
    // 520,000 - 52,000 = 468,000 < 500,000: delivery is charged.
    expect(await quote([line(p)], agent.code)).toMatchObject({ discount_paisa: 52000, merchandise_paisa: 468000, delivery_paisa: 30000, total_paisa: 498000 });
    const p2 = await product(560000);
    // 560,000 - 56,000 = 504,000 >= 500,000: still free.
    expect(await quote([line(p2)], agent.code)).toMatchObject({ delivery_paisa: 0, total_paisa: 504000 });
  });

  it("tampered discounts, prices, totals and commission inputs never reach an order", async () => {
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 500 });
    const p = await product(500000);
    const q = await quote([line(p)], agent.code);
    for (const change of [
      { discount_paisa: 100000, total_paisa: q.total_paisa - 50000 },
      { total_paisa: q.total_paisa - 1 },
      { lines: [{ ...line(p), unit_price_paisa: p.price - 100 }] },
      { delivery_paisa: 0, total_paisa: q.total_paisa - 30000 },
    ]) {
      expect((await place(checkoutKey(), body([line(p)], q, agent.code, change))).data?.result, JSON.stringify(change)).toBe("quote_changed");
    }
    // A discount without a code is malformed.
    const noCode = await place(checkoutKey(), body([line(p)], await quote([line(p)]), null, { discount_paisa: 50000 }));
    expect(noCode.error).toMatchObject({ code: "PT400", hint: "invalid_order" });
    // Commission fields sent by the browser are ignored: the database works it out.
    const key = checkoutKey();
    const placed = await place(key, body([line(p)], q, agent.code, { commission_paisa: 999999, commission_bp: 5000, agent_id: randomUUID() }));
    expect(placed.data?.result).toBe("placed");
    expect(JSON.stringify(placed.data)).not.toMatch(/commission/);
    const { rows: [r] } = await db.query("select r.commission_paisa, r.agent_id from public.order_referrals r join public.orders o on o.id = r.order_id where o.order_number = $1", [placed.data!.order!.order_number]);
    expect(r).toEqual({ commission_paisa: "22500", agent_id: agent.id });
  });

  it("terms or code changed between quote and order: quote_changed, or (commission only) the new terms are saved", async () => {
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 500 });
    const p = await product(500000);
    const q = await quote([line(p)], agent.code);
    let v = (await admin<AgentResult>("select public.admin_update_agent_terms($1, $2, $3, $4) as r",
      [agent.id, agent.version, randomUUID(), JSON.stringify({ discount_bp: 1500, commission_bp: 500, applies_to_sale_items: false })])).agent!.version;
    const changed = await place(checkoutKey(), body([line(p)], q, agent.code));
    expect(changed.data).toMatchObject({ result: "quote_changed", quote: { discount_paisa: 75000 } });

    const q2 = await quote([line(p)], agent.code);
    v = (await admin<AgentResult>("select public.admin_update_agent_terms($1, $2, $3, $4) as r",
      [agent.id, v, randomUUID(), JSON.stringify({ discount_bp: 1500, commission_bp: 900, applies_to_sale_items: false })])).agent!.version;
    const placed = await place(checkoutKey(), body([line(p)], q2, agent.code));
    expect(placed.data?.result).toBe("placed");
    const saved = (await db.query("select r.commission_bp, r.terms_version from public.order_referrals r join public.orders o on o.id = r.order_id where o.order_number = $1", [placed.data!.order!.order_number])).rows[0];
    expect(saved.commission_bp).toBe(900);

    const q3 = await quote([line(p)], agent.code);
    await admin("select public.admin_set_agent_code_enabled($1, $2, $3, false) as r", [agent.id, v, randomUUID()]);
    const off = await place(checkoutKey(), body([line(p)], q3, agent.code));
    expect(off.data).toMatchObject({ result: "quote_changed", quote: { referral: { status: "disabled" } } });
  });

  it("same-key retries give one order and one commission; the same key with another code is refused", async () => {
    const agent = await activeAgent();
    const other = await activeAgent();
    const p = await product(300000);
    const q = await quote([line(p)], agent.code);
    const key = checkoutKey();
    const order = body([line(p)], q, agent.code);
    expect((await place(key, order)).data?.result).toBe("placed");
    expect((await place(key, { ...order, referral_code: agent.code.toLowerCase() })).data?.result).toBe("existing");
    expect((await place(key, { ...order, referral_code: other.code })).data?.result).toBe("mismatch");
    const withoutCode: Record<string, unknown> = { ...order, total_paisa: q.subtotal_paisa + q.delivery_paisa };
    delete withoutCode.referral_code;
    delete withoutCode.discount_paisa;
    expect((await place(key, withoutCode)).data?.result).toBe("mismatch");
    const resolved = await once<{ state: string; matches: boolean }>(null, "select public.checkout_resolve($1, $2, $3) as r", [GATEWAY, key, JSON.stringify(order)]);
    expect(resolved.data).toMatchObject({ state: "placed", matches: true });
    const { rows } = await db.query("select count(*)::int n from public.order_referrals r join public.orders o on o.id = r.order_id where o.request_key_hash = sha256(convert_to($1, 'UTF8'))", [key]);
    expect(rows[0].n).toBe(1);
  });

  it("8 identical submissions at once: one order, one commission", async () => {
    const agent = await activeAgent();
    const p = await product(300000);
    const q = await quote([line(p)], agent.code);
    const key = checkoutKey();
    const order = JSON.stringify(body([line(p)], q, agent.code));
    const settled = await simultaneously(db, 8, (c, _i, before) =>
      call<Placed>(c, null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, key, order], before));
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.code : "rejected"));
    expect(results.filter((r) => r === "placed")).toHaveLength(1);
    expect(results.filter((r) => r === "existing")).toHaveLength(7);
    expect((await db.query("select count(*)::int n from public.order_referrals where agent_id = $1", [agent.id])).rows[0].n).toBe(1);
  });

  it("8 customers with the code competing for the last pair: one order, one commission, no oversell", async () => {
    const agent = await activeAgent();
    const p = await product(300000, { stock: 1 });
    const q = await quote([line(p)], agent.code);
    const settled = await simultaneously(db, 8, (c, _i, before) =>
      call<Placed>(c, null, "select public.place_cod_order($1, $2, $3) as r", [GATEWAY, checkoutKey(), JSON.stringify(body([line(p)], q, agent.code))], before));
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.code : "rejected"));
    expect(results.filter((r) => r === "placed")).toHaveLength(1);
    expect(results.filter((r) => r === "quote_changed")).toHaveLength(7);
    expect((await db.query("select stock, reserved from public.product_variants where sku = $1", [p.sku])).rows[0]).toEqual({ stock: 0, reserved: 1 });
    expect((await db.query("select count(*)::int n from public.order_referrals where agent_id = $1", [agent.id])).rows[0].n).toBe(1);
  });

  it("a terms change waits for an order in progress, so the saved terms are the ones the order was checked against", async () => {
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 500 });
    const p = await product(500000);
    const q = await quote([line(p)], agent.code);
    const holder = await db.pool.connect();
    try {
      // An order in progress holds the agent row (FOR SHARE) until it commits.
      await holder.query("begin");
      await holder.query("select 1 from public.sales_agents where id = $1 for share", [agent.id]);
      const change = once(ADMIN2, "select public.admin_update_agent_terms($1, $2, $3, $4) as r",
        [agent.id, agent.version, randomUUID(), JSON.stringify({ discount_bp: 2000, commission_bp: 500, applies_to_sale_items: false })]);
      const settled = await Promise.race([change.then(() => "finished"), new Promise((r) => setTimeout(() => r("waiting"), 500))]);
      expect(settled).toBe("waiting");
      await holder.query("commit");
      expect((await change).error).toBeNull();
    } finally {
      holder.release();
    }
    expect((await place(checkoutKey(), body([line(p)], q, agent.code))).data?.result).toBe("quote_changed");
  });

  it("historical orders keep their terms; orders from before the feature still read correctly", async () => {
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 500 });
    const p = await product(400000);
    const before = await placeOrder([line(p)], agent.code);
    await admin("select public.admin_update_agent_terms($1, $2, $3, $4) as r",
      [agent.id, agent.version, randomUUID(), JSON.stringify({ discount_bp: 500, commission_bp: 1000, applies_to_sale_items: true })]);
    const after = await placeOrder([line(p)], agent.code);
    const rows = (await db.query("select o.order_number, r.discount_bp, r.commission_bp, r.terms_version, r.commission_paisa from public.order_referrals r join public.orders o on o.id = r.order_id where r.agent_id = $1 order by o.created_at", [agent.id])).rows;
    expect(rows).toEqual([
      { order_number: before.number, discount_bp: 1000, commission_bp: 500, terms_version: 1, commission_paisa: "18000" },
      { order_number: after.number, discount_bp: 500, commission_bp: 1000, terms_version: 2, commission_paisa: "38000" },
    ]);
    const report = await admin<{ rows: { order_number: string; commission_bp: number; discount_bp: number }[] }>("select public.admin_agent_commissions($1, 0, 10) as r", [agent.id]);
    expect(report.rows.map((r) => [r.order_number, r.discount_bp, r.commission_bp])).toEqual([[after.number, 500, 1000], [before.number, 1000, 500]]);
  });
});

// ---------------------------------------------------------------------------

describe("4. commission lifecycle", () => {
  it("placed -> awaiting delivery; cancelled -> zero", async () => {
    const agent = await activeAgent();
    const p = await product(300000);
    const o = await placeOrder([line(p)], agent.code);
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "awaiting_delivery", commission_paisa: "13500", earned_paisa: "13500" });
    await orderStep(o.id, "cancel");
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "cancelled", earned_paisa: "0" });
  });

  it("held for exactly 720 hours from the recorded delivery time, then available only once payment is settled", async () => {
    const agent = await activeAgent();
    const p = await product(300000);
    const o = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver"] as const) await orderStep(o.id, step);
    expect((await stateOf(agent.id, o.number)).state).toBe("held");

    // The boundary, evaluated in one transaction (one now()).
    const at = async (offset: string) => {
      const c = await db.pool.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        await c.query(`update public.orders set delivered_at = now() - interval '720 hours' + interval '${offset}' where id = $1`, [o.id]);
        const { rows } = await c.query("select state, release_at = now() as at_release from private.commission_rows($1) where order_id = $2", [agent.id, o.id]);
        await c.query("rollback");
        return rows[0];
      } finally {
        c.release();
      }
    };
    expect(await at("1 microsecond")).toEqual({ state: "held", at_release: false });
    expect(await at("0 seconds")).toEqual({ state: "awaiting_payment", at_release: true });

    await backdateDelivery(o.id, 721);
    // Collected but not settled with the shop: still not available.
    expect((await stateOf(agent.id, o.number)).state).toBe("awaiting_payment");
    const refused = await payout(agent.id, randomUUID(), [o.id], [], 13500);
    expect(refused.error).toMatchObject({ code: "PT409", hint: "not_available" });
    await orderStep(o.id, "settle");
    expect((await stateOf(agent.id, o.number)).state).toBe("available");
  });

  it("a replayed or repeated delivery event never restarts or shortens the hold", async () => {
    const agent = await activeAgent();
    const p = await product(300000);
    const o = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch"] as const) await orderStep(o.id, step);
    const request = randomUUID();
    await orderStep(o.id, "deliver", request);
    const first = (await stateOf(agent.id, o.number)).release_at;
    await new Promise((r) => setTimeout(r, 20));
    expect((await orderStep(o.id, "deliver", request)).result).toBe("replayed");
    const again = await once(ADMIN2, "select public.admin_mark_delivered($1, $2, $3, true) as r", [o.id, await version(o.id), randomUUID()]);
    expect(again.error).toMatchObject({ code: "PT409", hint: "bad_transition" });
    expect((await stateOf(agent.id, o.number)).release_at).toEqual(first);
    expect(await db.query("update public.orders set delivered_at = now() where id = $1", [o.id]).catch((e) => e)).toMatchObject({ code: "PT400", hint: "order_locked" });
  });

  it("a return before payout reverses the commission (per line), with no adjustment", async () => {
    const agent = await activeAgent();
    const p1 = await product(300000);
    const p2 = await product(200000);
    const o = await placeOrder([line(p1), line(p2, 2)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver"] as const) await orderStep(o.id, step);
    await orderStep(o.id, "return");
    const row = await stateOf(agent.id, o.number);
    expect(row).toMatchObject({ state: "reversed", earned_paisa: "0" });
    expect((await db.query("select private.commission_reversed($1) r, (select sum(commission_paisa) from public.order_line_referrals where order_id = $1) s", [o.id])).rows[0])
      .toEqual({ r: row.commission_paisa, s: row.commission_paisa });
    expect((await db.query("select count(*)::int n from public.agent_adjustments where order_id = $1", [o.id])).rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("5. payouts and adjustments", () => {
  it("pays available commissions once; retries are replayed; reuse with other data and overpayment are refused", async () => {
    const agent = await activeAgent();
    const p = await product(300000, { stock: 10 });
    const [o1, o2] = [await deliveredAndSettled([line(p)], agent.code), await deliveredAndSettled([line(p)], agent.code)];
    const request = randomUUID();
    expect((await payout(agent.id, request, [o1.id], [], 13501)).error).toMatchObject({ code: "PT400", hint: "invalid_amount" });
    const first = await payout(agent.id, request, [o1.id], [], 13500);
    expect(first.data?.result).toBe("done");
    expect((await payout(agent.id, request, [o1.id], [], 13500)).data).toEqual({ result: "replayed", id: first.data!.id });
    expect((await payout(agent.id, request, [o1.id, o2.id], [], 27000)).data).toEqual({ result: "mismatch" });
    expect((await payout(agent.id, randomUUID(), [o1.id], [], 13500)).error).toMatchObject({ code: "PT409", hint: "already_paid" });
    expect((await stateOf(agent.id, o1.number)).state).toBe("paid");
    expect((await db.query("select count(*)::int n from public.agent_payouts where agent_id = $1", [agent.id])).rows[0].n).toBe(1);
    // Not this agent's, held, or a future date: refused.
    const other = await activeAgent();
    const held = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver", "settle"] as const) await orderStep(held.id, step);
    expect((await payout(other.id, randomUUID(), [o2.id], [], 13500)).error).toMatchObject({ hint: "not_available" });
    expect((await payout(agent.id, randomUUID(), [held.id], [], 13500)).error).toMatchObject({ hint: "not_available" });
    expect((await payout(agent.id, randomUUID(), [o2.id], [], 13500, { paidOn: "2099-01-01" })).error).toMatchObject({ hint: "invalid_date" });
    expect((await payout(agent.id, randomUUID(), [o2.id], [], 13500, { method: "crypto" })).error).toMatchObject({ hint: "invalid_method" });
  });

  it("5 payouts of the same commission at once: exactly one is recorded", async () => {
    const agent = await activeAgent();
    const p = await product(300000);
    const o = await deliveredAndSettled([line(p)], agent.code);
    const settled = await simultaneously(db, 5, (c, _i, before) =>
      call<{ result: string }>(c, ADMIN2, "select public.admin_record_agent_payout($1, $2, $3, '{}', 13500, current_date, 'cash') as r",
        [agent.id, randomUUID(), [o.id]], before));
    const results = settled.map((s) => (s.status === "fulfilled" ? s.value.data?.result ?? s.value.error?.hint : "rejected"));
    expect(results.filter((r) => r === "done")).toHaveLength(1);
    expect(results.filter((r) => r === "already_paid")).toHaveLength(4);
    expect((await db.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [o.id])).rows[0].n).toBe(1);
  });

  it("a return after payout keeps the payout and records a deduction that the next payout must include", async () => {
    const agent = await activeAgent();
    const p = await product(300000, { stock: 10 });
    const paid = await deliveredAndSettled([line(p)], agent.code);
    expect((await payout(agent.id, randomUUID(), [paid.id], [], 13500)).data?.result).toBe("done");
    await orderStep(paid.id, "return");
    expect(await stateOf(agent.id, paid.number)).toMatchObject({ state: "reversed", earned_paisa: "0" });
    const { rows: adjustments } = await db.query<{ id: string; amount_paisa: string; kind: string }>("select id, amount_paisa, kind from public.agent_adjustments where order_id = $1", [paid.id]);
    expect(adjustments).toEqual([expect.objectContaining({ amount_paisa: "-13500", kind: "return_after_payout" })]);
    expect((await db.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [paid.id])).rows[0].n).toBe(1);

    const next = await deliveredAndSettled([line(p, 2)], agent.code);
    expect((await stateOf(agent.id, next.number)).commission_paisa).toBe("27000");
    expect((await payout(agent.id, randomUUID(), [next.id], [], 27000)).error).toMatchObject({ code: "PT409", hint: "adjustments_required" });
    const totals = (await admin<{ totals: Record<string, number> }>("select public.admin_get_agent($1) as r", [agent.id])).totals;
    expect(totals).toMatchObject({ available_paisa: 27000, outstanding_adjustments_paisa: -13500, payable_paisa: 13500 });
    expect((await payout(agent.id, randomUUID(), [next.id], [adjustments[0].id], 13500)).data?.result).toBe("done");
    const agentView = await once<{ adjustments: { amount_paisa: number; settled: boolean }[] }>(claims(agent.userId), "select public.agent_payouts(0, 10) as r");
    expect(agentView.data!.adjustments).toEqual([expect.objectContaining({ amount_paisa: -13500, settled: true })]);
  });

  it("return and payout of the same order at the same moment: never paid and reversed without a deduction", async () => {
    for (let round = 0; round < 4; round++) {
      const agent = await activeAgent();
      const p = await product(300000);
      const o = await deliveredAndSettled([line(p)], agent.code);
      const v = await version(o.id);
      const settled = await simultaneously(db, 2, (c, i, before) =>
        i === 0
          ? call(c, ADMIN2, "select public.admin_record_agent_payout($1, $2, $3, '{}', 13500, current_date, 'cash') as r", [agent.id, randomUUID(), [o.id]], before)
          : call(c, ADMIN2, "select public.admin_receive_return($1, $2, $3, (select jsonb_agg(jsonb_build_object('order_item_id', id, 'restock', quantity, 'write_off', 0)) from public.order_items where order_id = $1)) as r", [o.id, v, randomUUID()], before));
      const [pay, ret] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
      expect(ret?.error, `round ${round}`).toBeNull();
      const paidLines = (await db.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [o.id])).rows[0].n;
      const deductions = (await db.query("select coalesce(sum(amount_paisa), 0)::int s from public.agent_adjustments where order_id = $1", [o.id])).rows[0].s;
      if (pay?.error) {
        expect(pay.error.hint, `round ${round}`).toBe("not_available");
        expect([paidLines, deductions]).toEqual([0, 0]);
      } else {
        expect([paidLines, deductions], `round ${round}`).toEqual([1, -13500]);
      }
    }
  });

  it("manual adjustments need a reason, record who made them, and are replay-safe", async () => {
    const agent = await activeAgent();
    expect((await once(ADMIN2, "select public.admin_add_agent_adjustment($1, $2, 5000, 'no') as r", [agent.id, randomUUID()])).error).toMatchObject({ hint: "reason_required" });
    expect((await once(ADMIN2, "select public.admin_add_agent_adjustment($1, $2, 0, 'A real reason') as r", [agent.id, randomUUID()])).error).toMatchObject({ hint: "invalid_amount" });
    const request = randomUUID();
    const first = await admin<{ result: string; id: string }>("select public.admin_add_agent_adjustment($1, $2, 5000, 'Bonus for the launch week') as r", [agent.id, request]);
    expect(first.result).toBe("done");
    expect(await admin("select public.admin_add_agent_adjustment($1, $2, 5000, 'Bonus for the launch week') as r", [agent.id, request])).toEqual({ result: "replayed", id: first.id });
    expect(await admin("select public.admin_add_agent_adjustment($1, $2, 6000, 'Bonus for the launch week') as r", [agent.id, request])).toEqual({ result: "mismatch" });
    expect((await db.query("select created_by, kind from public.agent_adjustments where id = $1", [first.id])).rows[0]).toEqual({ created_by: ADMIN, kind: "manual" });
    // A positive adjustment alone can be paid.
    expect((await payout(agent.id, randomUUID(), [], [first.id], 5000)).data?.result).toBe("done");
  });

  it("accounting history can't be edited or deleted", async () => {
    for (const sql of ["update public.agent_payouts set amount_paisa = 1", "delete from public.agent_payout_lines", "update public.agent_adjustments set amount_paisa = 1",
      "update public.order_referrals set commission_paisa = 0", "delete from public.order_line_referrals", "update public.sales_agent_events set kind = 'linked'"]) {
      const err = await db.query(sql).catch((e) => e);
      if ((await db.query(`select count(*)::int n from public.${sql.split(" ")[sql.startsWith("update") ? 1 : 2].replace("public.", "")}`)).rows[0].n > 0) {
        expect(err, sql).toMatchObject({ code: "PT400", hint: "append_only" });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("5a. zero commissions", () => {
  it("are never offered or paid; the positive earnings beside them are paid exactly once", async () => {
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 0 });
    const p = await product(300000, { stock: 10 });
    const zero = await deliveredAndSettled([line(p)], agent.code);
    expect(await stateOf(agent.id, zero.number)).toMatchObject({ state: "no_commission", commission_paisa: "0" });
    await admin("select public.admin_update_agent_terms($1, $2, $3, $4) as r",
      [agent.id, (await admin<{ version: number }>("select public.admin_get_agent($1) as r", [agent.id])).version, randomUUID(),
        JSON.stringify({ discount_bp: 1000, commission_bp: 500, applies_to_sale_items: false })]);
    const positive = await deliveredAndSettled([line(p)], agent.code);

    const detail = await admin<{ available: { order_id: string }[]; totals: Record<string, number> }>("select public.admin_get_agent($1) as r", [agent.id]);
    expect(detail.available.map((a) => a.order_id)).toEqual([positive.id]);
    expect(detail.totals).toMatchObject({ available_paisa: 13500, payable_paisa: 13500 });

    expect((await payout(agent.id, randomUUID(), [zero.id, positive.id], [], 13500)).error).toMatchObject({ code: "PT409", hint: "nothing_to_pay" });
    const request = randomUUID();
    expect((await payout(agent.id, request, [positive.id], [], 13500)).data?.result).toBe("done");
    expect((await payout(agent.id, request, [positive.id], [], 13500)).data?.result).toBe("replayed");
    expect((await payout(agent.id, randomUUID(), [positive.id], [], 13500)).error).toMatchObject({ hint: "already_paid" });
    expect((await payout(agent.id, randomUUID(), [zero.id], [], 1)).error).toMatchObject({ hint: "nothing_to_pay" });
    const { rows } = await db.query("select order_id, count(*)::int n from public.agent_payout_lines where agent_id = $1 group by order_id", [agent.id]);
    expect(rows).toEqual([{ order_id: positive.id, n: 1 }]);
    // History keeps the zero order.
    const report = await admin<{ total: number }>("select public.admin_agent_commissions($1, 0, 10) as r", [agent.id]);
    expect(report.total).toBe(2);
  });
});

describe("5b. commission holds for pending returns", () => {
  type HoldResult = { result: string; on_hold: boolean; event_id: number };
  /** The latest hold event of an order: what a freshly opened hold/release form names. */
  const latestEvent = async (orderId: string) =>
    (await db.query<{ id: string | null }>("select max(id)::text id from public.commission_hold_events where order_id = $1", [orderId])).rows[0].id;
  /** A hold/release as sent by a form opened when the latest event was `expected` (default: opened just now). */
  const hold = async (orderId: string, request: string, onHold: boolean, reason = "Customer reported a fault; return being arranged", expected?: string | null) =>
    once<HoldResult>(ADMIN2, "select public.admin_set_commission_hold($1, $2, $3, $4, $5) as r",
      [orderId, expected === undefined ? await latestEvent(orderId) : expected, request, onHold, reason]);

  it("needs a verified admin and a reason, and is kept as an audit trail", async () => {
    const agent = await activeAgent();
    const o = await deliveredAndSettled([line(await product(300000))], agent.code);
    for (const role of ["anon", "user aal2", "agent aal1", "admin aal1"] as RoleName[]) {
      expect((await once(ROLES[role], "select public.admin_set_commission_hold($1, null, $2, true, 'Return being arranged') as r", [o.id, randomUUID()])).error?.code, role).toBe("42501");
    }
    expect((await hold(o.id, randomUUID(), true, "no")).error).toMatchObject({ hint: "reason_required" });
    const request = randomUUID();
    const first = await hold(o.id, request, true, undefined, null);
    expect(first.data).toEqual({ result: "done", on_hold: true, event_id: expect.any(Number) });
    expect((await hold(o.id, request, true, undefined, null)).data).toEqual({ result: "replayed", on_hold: true, event_id: first.data!.event_id });
    expect((await hold(o.id, request, true, "A different reason entirely", null)).error).toMatchObject({ hint: "request_mismatch" });
    expect((await hold(o.id, randomUUID(), true)).error).toMatchObject({ hint: "already_on_hold" });
    await hold(o.id, randomUUID(), false, "Customer kept the shoes");
    const { rows } = await db.query("select action, reason, actor_user_id from public.commission_hold_events where order_id = $1 order by id", [o.id]);
    expect(rows).toEqual([
      { action: "hold", reason: "Customer reported a fault; return being arranged", actor_user_id: ADMIN },
      { action: "release", reason: "Customer kept the shoes", actor_user_id: ADMIN },
    ]);
    expect((await hold(o.id, randomUUID(), false, "Releasing twice")).error).toMatchObject({ hint: "not_on_hold" });
  });

  it("blocks the payout; releasing still needs the 30-day hold and settled payment; the order itself is untouched", async () => {
    const agent = await activeAgent();
    const p = await product(300000, { stock: 10 });
    const ready = await deliveredAndSettled([line(p)], agent.code);
    const before = (await db.query("select version, status, payment_status, delivered_at from public.orders where id = $1", [ready.id])).rows[0];
    await hold(ready.id, randomUUID(), true);
    expect(await stateOf(agent.id, ready.number)).toMatchObject({ state: "on_hold" });
    expect((await payout(agent.id, randomUUID(), [ready.id], [], 13500)).error).toMatchObject({ code: "PT409", hint: "on_hold" });
    expect((await db.query("select version, status, payment_status, delivered_at from public.orders where id = $1", [ready.id])).rows[0]).toEqual(before);
    await hold(ready.id, randomUUID(), false, "Return cancelled by the customer");
    expect((await stateOf(agent.id, ready.number)).state).toBe("available");
    expect((await payout(agent.id, randomUUID(), [ready.id], [], 13500)).data?.result).toBe("done");

    // Held while still unpaid by the courier: releasing it leaves it waiting for payment.
    const unpaid = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver"] as const) await orderStep(unpaid.id, step);
    await backdateDelivery(unpaid.id, 721);
    await hold(unpaid.id, randomUUID(), true);
    await hold(unpaid.id, randomUUID(), false, "Return not needed after all");
    expect((await stateOf(agent.id, unpaid.number)).state).toBe("awaiting_payment");
    // ...and inside the 30-day hold, releasing leaves it held.
    const recent = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver", "settle"] as const) await orderStep(recent.id, step);
    await hold(recent.id, randomUUID(), true);
    await hold(recent.id, randomUUID(), false, "Return not needed after all");
    expect((await stateOf(agent.id, recent.number)).state).toBe("held");
  });

  it("receiving the return while on hold reverses the commission with nothing to deduct; paid ones can't be held", async () => {
    const agent = await activeAgent();
    const p = await product(300000, { stock: 10 });
    const o = await deliveredAndSettled([line(p)], agent.code);
    await hold(o.id, randomUUID(), true);
    await orderStep(o.id, "return");
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "reversed", earned_paisa: "0" });
    expect((await db.query("select count(*)::int n from public.agent_adjustments where order_id = $1", [o.id])).rows[0].n).toBe(0);
    const paid = await deliveredAndSettled([line(p)], agent.code);
    await payout(agent.id, randomUUID(), [paid.id], [], 13500);
    expect((await hold(paid.id, randomUUID(), true)).error).toMatchObject({ hint: "already_paid" });
    const cancelled = await placeOrder([line(p)], agent.code);
    await orderStep(cancelled.id, "cancel");
    expect((await hold(cancelled.id, randomUUID(), true)).error).toMatchObject({ hint: "not_holdable" });
  });

  it("hold and payout of the same order at the same moment: exactly one wins", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const agent = await activeAgent();
      const o = await deliveredAndSettled([line(await product(300000))], agent.code);
      const settled = await simultaneously(db, 2, (c, i, before) =>
        i === 0
          ? call<{ result: string }>(c, ADMIN2, "select public.admin_record_agent_payout($1, $2, $3, '{}', 13500, current_date, 'cash') as r", [agent.id, randomUUID(), [o.id]], before)
          : call<{ result: string }>(c, ADMIN2, "select public.admin_set_commission_hold($1, null, $2, true, 'Return being arranged') as r", [o.id, randomUUID()], before));
      const [pay, held] = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
      const paidLines = (await db.query("select count(*)::int n from public.agent_payout_lines where order_id = $1", [o.id])).rows[0].n;
      const holds = (await db.query("select count(*)::int n from public.commission_hold_events where order_id = $1", [o.id])).rows[0].n;
      if (pay?.data?.result === "done") {
        expect(held?.error?.hint, `round ${round}`).toBe("already_paid");
        expect([paidLines, holds]).toEqual([1, 0]);
        outcomes.add("payout first");
      } else {
        expect(pay?.error?.hint, `round ${round}`).toBe("on_hold");
        expect(held?.data?.result).toBe("done");
        expect([paidLines, holds]).toEqual([0, 1]);
        outcomes.add("hold first");
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it("two tabs: a release form opened for hold #1 can't release hold #2; the payout stays blocked", async () => {
    const agent = await activeAgent();
    const o = await deliveredAndSettled([line(await product(300000))], agent.code);
    await hold(o.id, randomUUID(), true, "Hold 1: first dispute");
    const tabA = await latestEvent(o.id); // tab A opens the release form for hold #1
    expect((await hold(o.id, randomUUID(), false, "Tab B: first dispute settled")).data?.result).toBe("done");
    expect((await hold(o.id, randomUUID(), true, "Hold 2: a new dispute")).data?.result).toBe("done");
    const stale = await hold(o.id, randomUUID(), false, "Tab A: releasing hold 1", tabA);
    expect(stale.error).toMatchObject({ code: "PT409", hint: "hold_conflict" });
    expect(stale.error?.message).toMatch(/changed since you opened/);
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "on_hold" });
    expect((await payout(agent.id, randomUUID(), [o.id], [], 13500)).error).toMatchObject({ hint: "on_hold" });
    const { rows } = await db.query("select action, reason from public.commission_hold_events where order_id = $1 order by id", [o.id]);
    expect(rows.map((r) => r.reason)).toEqual(["Hold 1: first dispute", "Tab B: first dispute settled", "Hold 2: a new dispute"]);
  });

  it("a stale 'place hold' form is refused after holds and releases in between", async () => {
    const agent = await activeAgent();
    const o = await deliveredAndSettled([line(await product(300000))], agent.code);
    const opened = await latestEvent(o.id); // null: no hold events yet
    expect(opened).toBeNull();
    await hold(o.id, randomUUID(), true, "Hold placed in another tab");
    await hold(o.id, randomUUID(), false, "Released in another tab");
    expect((await hold(o.id, randomUUID(), true, "Old form: hold it", opened)).error).toMatchObject({ code: "PT409", hint: "hold_conflict" });
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "available" });
  });

  it("a release whose answer was lost, then a new hold: the retry returns the release's own result and the new hold stays", async () => {
    const agent = await activeAgent();
    const o = await deliveredAndSettled([line(await product(300000))], agent.code);
    await hold(o.id, randomUUID(), true, "Hold 1: first dispute");
    const opened = await latestEvent(o.id);
    const request = randomUUID();
    const release = await hold(o.id, request, false, "First dispute settled", opened); // answer lost
    expect(release.data?.result).toBe("done");
    await hold(o.id, randomUUID(), true, "Hold 2: a new dispute");
    const retry = await hold(o.id, request, false, "First dispute settled", opened);
    expect(retry.data).toEqual({ result: "replayed", on_hold: false, event_id: release.data!.event_id });
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "on_hold" });
    expect((await db.query("select count(*)::int n from public.commission_hold_events where order_id = $1", [o.id])).rows[0].n).toBe(3);
    // The same request id with a changed reason or another expected version: refused.
    expect((await hold(o.id, request, false, "A different reason", opened)).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect((await hold(o.id, request, false, "First dispute settled", await latestEvent(o.id))).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect((await hold(o.id, request, true, "First dispute settled", opened)).error).toMatchObject({ code: "PT409", hint: "request_mismatch" });
    expect(await stateOf(agent.id, o.number)).toMatchObject({ state: "on_hold" });
  });
});

// ---------------------------------------------------------------------------

describe("6. the agent's dashboard", () => {
  it("totals by state, release dates, pagination, and no customer details", async () => {
    const userId = randomUUID();
    const agent = await activeAgent({ discount_bp: 1000, commission_bp: 500 }, userId);
    const p = await product(300000, { stock: 20 });
    const waiting = await placeOrder([line(p)], agent.code);
    const held = await placeOrder([line(p)], agent.code);
    for (const step of ["confirm", "dispatch", "deliver"] as const) await orderStep(held.id, step);
    const available = await deliveredAndSettled([line(p)], agent.code);
    const cancelled = await placeOrder([line(p)], agent.code);
    await orderStep(cancelled.id, "cancel");
    expect(waiting && available).toBeTruthy();

    const me = claims(userId);
    const dash = await once<{ code: string; totals: Record<string, number | string>; upcoming_releases: { order_number: string; release_at: string }[] }>(me, "select public.agent_dashboard() as r");
    expect(dash.data!.totals).toMatchObject({ referred_orders: 4, cancelled_orders: 1, awaiting_delivery_paisa: 13500, held_paisa: 13500, available_paisa: 13500, paid_paisa: 0 });
    expect(dash.data!.upcoming_releases).toEqual([expect.objectContaining({ order_number: held.number })]);

    const page0 = await once<{ total: number; rows: Record<string, unknown>[] }>(me, "select public.agent_referrals(0, 3) as r");
    const page1 = await once<{ total: number; rows: Record<string, unknown>[] }>(me, "select public.agent_referrals(1, 3) as r");
    expect(page0.data!.total).toBe(4);
    expect(page0.data!.rows).toHaveLength(3);
    expect(page1.data!.rows).toHaveLength(1);
    expect(Object.keys(page0.data!.rows[0]).sort()).toEqual(["commission_bp", "commission_paisa", "delivered_at", "discount_paisa", "earned_paisa",
      "eligible_subtotal_paisa", "order_number", "placed_at", "release_at", "reversed_paisa", "state"]);
    expect(JSON.stringify([dash.data, page0.data, page1.data])).not.toMatch(/Referral Customer|Test Town|\+92|phone|address/);
    expect((await once(me, "select public.agent_referrals(0, 1000) as r")).error).toMatchObject({ code: "PT400" });
  });
});
