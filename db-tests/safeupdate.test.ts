import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createDatabase, type Claims, type TestDatabase } from "./lib/db";

/*
 * Supabase loads pg-safeupdate for API requests: any UPDATE or DELETE without
 * a WHERE clause fails with 21000 ("UPDATE requires a WHERE clause"), even
 * inside a security definer function. The local test server doesn't have that
 * library, so a call here would succeed either way. Instead, every function as
 * it stands after all migrations is checked for such statements, and the
 * settings functions are then called the way /admin/settings calls them.
 */

const ADMIN = "e0e0e0e0-0000-4000-8000-0000000000af";
const ADMIN_CLAIMS: Claims = { sub: ADMIN, role: "authenticated", aal: "aal2" };

let db: TestDatabase;

beforeAll(async () => {
  db = await createDatabase("safeupdate");
  await db.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'safeupdate-admin@test.invalid');
    insert into public.admin_members (user_id) values ('${ADMIN}');
  `);
});

afterAll(async () => {
  await db?.close();
});

/** UPDATE and DELETE statements in a function body that have no WHERE clause. */
function writesWithoutWhere(body: string): string[] {
  const code = body
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (token) => (token.startsWith("'") ? "''" : " "))
    .toLowerCase();
  const found: string[] = [];
  for (const statement of code.split(";")) {
    // Not "select ... for update" or "on conflict ... do update set".
    const write = /(?<!\bdo\s+)\bupdate\s+(?:only\s+)?[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\b|\bdelete\s+from\b/.exec(statement);
    if (write && !/\bwhere\b/.test(statement.slice(write.index))) {
      found.push(statement.slice(write.index).replace(/\s+/g, " ").trim().slice(0, 60));
    }
  }
  return found;
}

describe("pg-safeupdate", () => {
  it("the checker recognises writes without WHERE", () => {
    expect(writesWithoutWhere("update public.t set a = 1 returning * into x;")).toHaveLength(1);
    expect(writesWithoutWhere("delete from public.t;")).toHaveLength(1);
    expect(writesWithoutWhere("update public.t set a = 1 where id; delete from public.t where true;")).toEqual([]);
    expect(writesWithoutWhere("select * from public.t for update; insert into t values (1) on conflict (id) do update set a = 2;")).toEqual([]);
    expect(writesWithoutWhere("-- delete from public.t;\nraise exception 'delete from t';")).toEqual([]);
  });

  it("no database function updates or deletes without a WHERE clause", async () => {
    const { rows } = await db.query<{ name: string; body: string }>(`
      select n.nspname || '.' || p.proname as name, p.prosrc as body
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname in ('public', 'private') and l.lanname in ('plpgsql', 'sql')
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`);
    expect(rows.length).toBeGreaterThan(0);
    const offenders = rows.flatMap((r) => writesWithoutWhere(r.body).map((statement) => `${r.name}: ${statement}`));
    expect(offenders).toEqual([]);
  });

  it("a verified admin can save settings with ordering off and save an empty city list", async () => {
    const client = await db.pool.connect();
    try {
      const { version } = (await db.query<{ version: number }>("select version from public.shop_settings")).rows[0];
      // The settings from the failed save on /admin/settings.
      const settings = {
        orders_open: false,
        delivery_area_mode: "nationwide",
        standard_delivery_fee_paisa: 30000,
        free_delivery_enabled: true,
        free_delivery_min_paisa: 499900,
        hold_minutes: 1440,
        max_lines_per_order: 10,
        max_units_per_order: 10,
        max_units_per_line: 3,
        max_open_orders_per_phone: 2,
        place_attempts_per_ip_10min: 10,
        place_attempts_per_ip_day: 50,
        lookups_per_ip_10min: 60,
        quotes_per_ip_10min: 120,
        orders_per_minute_global: 30,
        in_store_sells_unpublished: null,
      };
      const saved = await asRole<{ r: Record<string, unknown> }>(client, "authenticated", ADMIN_CLAIMS,
        "select public.admin_update_shop_settings($1, $2) as r", [version, settings]);
      expect(saved.rows[0].r).toMatchObject({ ...settings, version: version + 1 });

      const cities = await asRole<{ r: number }>(client, "authenticated", ADMIN_CLAIMS,
        "select public.admin_save_delivery_cities($1, $2) as r", [version + 1, JSON.stringify([])]);
      expect(cities.rows[0].r).toBe(version + 2);
    } finally {
      client.release();
    }
  });
});
