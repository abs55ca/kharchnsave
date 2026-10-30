import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for plain TypeScript modules (no React rendering, no network,
// no database): `npm test`. Browser tests are separate (playwright.config.ts).
export default defineConfig({
  resolve: {
    // tsconfig.json's "@/*" path.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
