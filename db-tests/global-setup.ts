import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";
import { LOCAL_HOSTS, type ServerConfig } from "./lib/config";

/*
 * Starts a throwaway PostgreSQL server for the database tests: a native
 * process from the embedded-postgres package, in a temporary data directory,
 * listening on 127.0.0.1 only. No Docker, no containers, and nothing is
 * shared with other projects. It is stopped and its files deleted afterwards.
 *
 * To use another LOCAL server instead, set DB_TESTS_URL (a superuser
 * connection string) and ALLOW_DB_TESTS=1. Anything that isn't localhost is
 * refused, so these tests can never reach a hosted database.
 */

declare module "vitest" {
  export interface ProvidedContext {
    dbServer: ServerConfig;
  }
}

function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      const fallback = createServer();
      fallback.listen(0, "127.0.0.1", () => {
        const port = (fallback.address() as { port: number }).port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolve(preferred)));
  });
}

export default async function setup(project: TestProject) {
  const url = process.env.DB_TESTS_URL;
  if (url) {
    const parsed = new URL(url);
    if (process.env.ALLOW_DB_TESTS !== "1" || !LOCAL_HOSTS.includes(parsed.hostname)) {
      throw new Error("DB_TESTS_URL must point at localhost, and ALLOW_DB_TESTS=1 must be set.");
    }
    project.provide("dbServer", {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "kharchnsave-db-tests-"));
  const port = await freePort(54329);
  const password = randomBytes(18).toString("base64url");
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    // Enough connections for the concurrency tests; local only.
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "max_connections=200"],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  project.provide("dbServer", { host: "127.0.0.1", port, user: "postgres", password });

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
