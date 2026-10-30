import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests (no network, no database): `npm test`. Synchronous pages are
// rendered to HTML; browser tests are separate (playwright.config.ts).
export default defineConfig({
  resolve: {
    // tsconfig.json's "@/*" path.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.{ts,tsx}"],
    // The QR tests render and decode several large images.
    testTimeout: 60_000,
  },
});
