import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, MIGRATIONS, migrationSteps, read, SQL_TESTS, type Step, type TestDatabase } from "./lib/db";

/*
 * Runs every migration and every supabase/tests/*.sql file on real
 * PostgreSQL, in a fresh database, as the Supabase SQL Editor would (each
 * file is one script; the test files roll themselves back). A file passes
 * only if it completes without "FAIL ..." errors.
 */

const INVENTORY = "supabase/migrations/20261031120000_inventory_ledger.sql";
const FIXTURES: Step[] = [
  ["supabase/seeds/dev_catalogue_fixtures.sql", read("supabase/seeds/dev_catalogue_fixtures.sql")],
  ["e2e/fixtures.sql", read("e2e/fixtures.sql")],
];

let db: TestDatabase | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function runTests(database: TestDatabase) {
  const passes: Record<string, number> = {};
  for (const file of SQL_TESTS) {
    try {
      passes[file] = (await database.exec(read(file))).length;
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  }
  return passes;
}

async function ledgerReconciles(database: TestDatabase) {
  const { rows } = await database.query<{ sku: string }>(`
    select v.sku from public.product_variants v
    left join (
      select variant_id, sum(available_delta) as available, sum(reserved_delta) as reserved
      from public.stock_movements group by variant_id
    ) m on m.variant_id = v.id
    where coalesce(m.available, 0) <> v.stock or coalesce(m.reserved, 0) <> v.reserved`);
  return rows.map((r) => r.sku);
}

describe("SQL test files on real PostgreSQL", () => {
  it("fresh database: all migrations, then every test file", async () => {
    db = await createDatabase("sql_fresh");
    const passes = await runTests(db);
    console.log("PASS checks per file:", JSON.stringify(passes));
    for (const file of SQL_TESTS) expect(passes[file], file).toBeGreaterThan(0);
    expect(await ledgerReconciles(db)).toEqual([]);
  });

  it("existing data: catalogue and fixtures before the inventory migration, then every test file", async () => {
    const before = MIGRATIONS.filter((m) => m < INVENTORY);
    const after = MIGRATIONS.filter((m) => m >= INVENTORY);
    db = await createDatabase("sql_existing", [...migrationSteps(before.at(-1)), ...FIXTURES]);
    const stockBefore = await db.query<{ sku: string; stock: number }>("select sku, stock from public.product_variants order by sku");
    expect(stockBefore.rows.length).toBeGreaterThan(0);

    for (const file of after) await db.exec(read(file));

    // Opening balances: one row per existing size, equal to its stock.
    const opening = await db.query<{ sku: string; available_delta: number; reason: string }>(
      "select sku, available_delta, reason from public.stock_movements order by sku",
    );
    expect(opening.rows).toEqual(stockBefore.rows.map((r) => ({ sku: r.sku, available_delta: r.stock, reason: "opening_balance" })));
    expect(await ledgerReconciles(db)).toEqual([]);

    const passes = await runTests(db);
    for (const file of SQL_TESTS) expect(passes[file], file).toBeGreaterThan(0);
    expect(await ledgerReconciles(db)).toEqual([]);
  });
});
