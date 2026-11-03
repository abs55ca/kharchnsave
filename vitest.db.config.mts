import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Database tests on a real, local PostgreSQL server: `npm run test:db`.
// db-tests/global-setup.ts starts a throwaway server (no Docker) unless
// DB_TESTS_URL names another local one. Never runs against a hosted project.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  test: {
    environment: "node",
    include: ["db-tests/**/*.test.ts"],
    globalSetup: ["db-tests/global-setup.ts"],
    // One file at a time: the concurrency tests measure real lock behaviour.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
