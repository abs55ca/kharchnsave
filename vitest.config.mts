import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests (no network, no database): `npm test`. Synchronous pages are
// rendered to HTML; browser tests are separate (playwright.config.ts).
export default defineConfig({
  resolve: {
    alias: [
      // tsconfig.json's "@/*" path.
      { find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) },
      // Next.js resolves this marker itself; outside it, use its empty stub.
      {
        find: /^server-only$/,
        replacement: fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.{ts,tsx}"],
    // The QR tests render and decode several large images.
    testTimeout: 60_000,
  },
});
