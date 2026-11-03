import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { LOCAL_HOSTS } from "./config";

/*
 * Helpers for the database tests: a fresh database per test file on the local
 * test server (see ../global-setup.ts), with the Supabase stand-in and every
 * migration applied, and connections that act like Supabase's API (a role
 * plus request.jwt.claims, one transaction per call).
 */

const ROOT = new URL("../../", import.meta.url);

export const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

export const MIGRATIONS = readdirSync(new URL("supabase/migrations/", ROOT))
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => `supabase/migrations/${file}`);

export const SQL_TESTS = readdirSync(new URL("supabase/tests/", ROOT))
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => `supabase/tests/${file}`);

export type Step = [label: string, sql: string];

function connection(database: string, max = 1) {
  const server = inject("dbServer");
  if (!LOCAL_HOSTS.includes(server.host)) throw new Error("Database tests only run against localhost.");
  return { host: server.host, port: server.port, user: server.user, password: server.password, database, max };
}

/** Runs a multi-statement script (one implicit transaction) and returns its PASS notices. */
export async function runScript(client: pg.Client | pg.PoolClient, sql: string) {
  const notices: string[] = [];
  const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? "");
  client.on("notice", onNotice);
  try {
    await client.query(sql);
  } finally {
    client.off("notice", onNotice);
  }
  return notices.filter((message) => message.startsWith("PASS"));
}

export type TestDatabase = {
  name: string;
  pool: pg.Pool;
  /** Runs a script as the database owner; returns the PASS notices. */
  exec: (sql: string) => Promise<string[]>;
  /** One query as the owner. */
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
  close: () => Promise<void>;
};

/**
 * Creates a new database with the Supabase stand-in, then runs `steps`
 * (by default every migration). Each step is labelled in errors.
 */
export async function createDatabase(prefix: string, steps: Step[] = migrationSteps(), poolSize = 60): Promise<TestDatabase> {
  const name = `${prefix.replace(/[^a-z0-9_]/g, "_")}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client(connection("postgres"));
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const pool = new pg.Pool(connection(name, poolSize));
  // A notice handler on every connection keeps unexpected notices quiet.
  pool.on("connect", (client) => client.on("notice", () => {}));
  const exec = async (sql: string) => {
    const client = await pool.connect();
    try {
      return await runScript(client, sql);
    } finally {
      client.release();
    }
  };

  for (const [label, sql] of [["supabase stand-in", read("db-tests/supabase-stub.sql")] as Step, ...steps]) {
    try {
      await exec(sql);
    } catch (error) {
      await pool.end();
      throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
    }
  }

  return {
    name,
    pool,
    exec,
    query: (sql, params) => pool.query(sql, params),
    close: async () => {
      await pool.end();
      const cleanup = new pg.Client(connection("postgres"));
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}

export function migrationSteps(until?: string): Step[] {
  const list = until ? MIGRATIONS.filter((m) => m <= until) : MIGRATIONS;
  return list.map((m) => [m, read(m)]);
}

export type Claims = { sub: string; role: "authenticated"; aal: "aal1" | "aal2" } | null;

/**
 * Calls a statement the way Supabase's API would: in its own transaction,
 * as `role` (anon or authenticated) with the given JWT claims.
 */
export async function asRole<R extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.PoolClient,
  role: "anon" | "authenticated",
  claims: Claims,
  sql: string,
  params: unknown[] = [],
  before?: () => Promise<void>,
): Promise<pg.QueryResult<R>> {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    if (before) await before();
    const result = await client.query<R>(sql, params);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/**
 * Starts `count` callers at the same moment. Each one opens its transaction
 * and waits on a lock held here; once all of them are waiting (checked in
 * pg_locks), the lock is released and they run together.
 */
export async function simultaneously<T>(
  db: TestDatabase,
  count: number,
  run: (client: pg.PoolClient, index: number, waitAtBarrier: () => Promise<void>) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const barrierKey = Math.floor(Math.random() * 1_000_000) + 1;
  const holder = await db.pool.connect();
  const clients = await Promise.all(Array.from({ length: count }, () => db.pool.connect()));
  try {
    await holder.query("select pg_advisory_lock(7, $1)", [barrierKey]);
    const runs = clients.map((client, index) =>
      run(client, index, async () => {
        await client.query("select pg_advisory_xact_lock_shared(7, $1)", [barrierKey]);
      }),
    );
    // Wait until every caller is blocked at the barrier.
    for (let attempt = 0; ; attempt++) {
      const { rows } = await holder.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_locks
         where locktype = 'advisory' and classid = 7 and objid = $1 and objsubid = 2 and not granted`,
        [barrierKey],
      );
      if (rows[0].waiting === count) break;
      if (attempt > 500) throw new Error(`only ${rows[0].waiting} of ${count} callers reached the barrier`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await holder.query("select pg_advisory_unlock(7, $1)", [barrierKey]);
    return await Promise.allSettled(runs);
  } finally {
    holder.release();
    for (const client of clients) client.release();
  }
}
