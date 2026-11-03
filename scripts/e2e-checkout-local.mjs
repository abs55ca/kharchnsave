// Local checkout test stack: the real checkout UI and Server Action, end to
// end, against a real PostgreSQL database with every migration applied.
//
//   node scripts/e2e-checkout-local.mjs
//
// What runs, all on this machine and all removed afterwards:
//   * a throwaway PostgreSQL server (embedded-postgres; no Docker)
//   * e2e/local-stack/postgrest-shim.mjs, a minimal stand-in for Supabase's
//     HTTP API (NOT PostgREST, NOT Supabase Auth or Storage)
//   * a production build of the site in .next-e2e, pointed at the stand-in
//   * three servers of that build, using Cloudflare's published Turnstile
//     testing keys (https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
//     one whose secret always passes, one "already spent", one always failing.
//     Only this local configuration sets CHECKOUT_TURNSTILE_TESTING_KEYS=allow.
//   * e2e/checkout-local.spec.ts in Playwright
//
// It never reads .env.local's Supabase project: the build and servers get
// their own settings, which take precedence. Needs internet access for the
// Turnstile widget and Siteverify.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { startShim } from "../e2e/local-stack/postgrest-shim.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const DIST = ".next-e2e";
const TEST_SITE_KEY = "1x00000000000000000000AA"; // always passes, visible
const SECRETS = {
  pass: "1x0000000000000000000000000000000AA",
  spent: "3x0000000000000000000000000000000AA", // "token already spent"
  fail: "2x0000000000000000000000000000000AA",
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function run(command, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))));
  });
}

function startServer(port, env) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} didn't start`);
}

const dir = mkdtempSync(join(tmpdir(), "kharchnsave-e2e-db-"));
const dbPort = await freePort();
const password = randomBytes(18).toString("base64url");
const database = new EmbeddedPostgres({
  databaseDir: dir, port: dbPort, user: "postgres", password, persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=200"],
  onLog: () => {}, onError: () => {},
});
const children = [];
let shim;
let exitCode = 1;

try {
  await database.initialise();
  await database.start();
  const connection = { host: "127.0.0.1", port: dbPort, user: "postgres", password, database: "kns_e2e" };
  const admin = new pg.Client({ ...connection, database: "postgres" });
  await admin.connect();
  await admin.query("create database kns_e2e");
  await admin.end();

  const gatewaySecret = randomBytes(32).toString("base64url");
  const owner = new pg.Client(connection);
  await owner.connect();
  owner.on("notice", () => {});
  const migrations = readdirSync(new URL("supabase/migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  for (const step of [
    "db-tests/supabase-stub.sql",
    ...migrations.map((f) => `supabase/migrations/${f}`),
    "supabase/seeds/dev_catalogue_fixtures.sql",
  ]) {
    await owner.query(read(step));
  }
  const hash = createHash("sha256").update(gatewaySecret, "utf8").digest("hex");
  // TEST VALUES ONLY.
  await owner.query(`
    insert into private.checkout_gateway_keys (key_hash, label) values (decode('${hash}', 'hex'), 'local e2e');
    update public.shop_settings set delivery_area_mode = 'nationwide', free_delivery_enabled = true,
      free_delivery_min_paisa = 500000, max_lines_per_order = 10, max_units_per_order = 10, max_units_per_line = 4,
      max_open_orders_per_phone = 20, place_attempts_per_ip_10min = 1000, place_attempts_per_ip_day = 10000,
      lookups_per_ip_10min = 1000, quotes_per_ip_10min = 10000, orders_per_minute_global = 1000, orders_open = true;`);
  await owner.end();

  shim = await startShim({ connection, port: await freePort() });
  const common = {
    NEXT_DIST_DIR: DIST,
    NEXT_PUBLIC_SUPABASE_URL: shim.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_e2e_only",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  // Always build: NEXT_PUBLIC_ values (the stand-in's URL, whose port changes
  // every run) are compiled into the build, server code included.
  await run(process.execPath, ["node_modules/next/dist/bin/next", "build"], common, "next build");

  const ports = { pass: await freePort(), spent: await freePort(), fail: await freePort() };
  for (const [name, port] of Object.entries(ports)) {
    children.push(startServer(port, {
      ...common,
      CHECKOUT_ENABLED: "true",
      CHECKOUT_GATEWAY_SECRET: gatewaySecret,
      TURNSTILE_SITE_KEY: TEST_SITE_KEY,
      TURNSTILE_SECRET_KEY: SECRETS[name],
      CHECKOUT_TURNSTILE_TESTING_KEYS: "allow",
      CLIENT_IP_SOURCE: "none",
    }));
  }
  for (const port of Object.values(ports)) await waitFor(`http://127.0.0.1:${port}/order`);

  await run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "e2e/checkout-local.spec.ts"], {
    E2E_LOCAL_STACK: "1",
    E2E_BASE_URL: `http://127.0.0.1:${ports.pass}`,
    E2E_BASE_URL_SPENT: `http://127.0.0.1:${ports.spent}`,
    E2E_BASE_URL_FAIL: `http://127.0.0.1:${ports.fail}`,
    E2E_DB_URL: `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${dbPort}/kns_e2e`,
  }, "playwright");
  exitCode = 0;
} catch (error) {
  console.error(error.message);
} finally {
  for (const child of children) child.kill();
  await shim?.close().catch(() => {});
  await database.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
