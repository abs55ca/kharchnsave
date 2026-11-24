import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// This folder's tests only (same aliases as vitest.config.mts):
//   npx vitest run --config scripts/import-kids-shoes/vitest.config.mts
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("../../", import.meta.url)) },
      { find: /^server-only$/, replacement: fileURLToPath(new URL("../../node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)) },
    ],
  },
  test: { environment: "node", include: ["scripts/import-kids-shoes/**/*.test.ts"] },
});
