import { defineConfig, devices } from "@playwright/test";

/*
 * Admin browser tests: `npm run test:e2e`. See README, "Barcodes and labels",
 * for the full set-up. In short, they need:
 *
 * - a LOCAL Supabase stack (Docker) with every migration applied, the dev
 *   fixtures (supabase/seeds/dev_catalogue_fixtures.sql) and
 *   e2e/fixtures.sql loaded, and a test admin with an authenticator app;
 * - the site built and running against that local stack (E2E_BASE_URL);
 * - E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and E2E_ADMIN_TOTP_SECRET.
 *
 * Without those variables every test is skipped. The tests only read data
 * (and sign in); never point them at the hosted project anyway.
 */
export default defineConfig({
  testDir: "e2e",
  // One signed-in session shared by the tests in a file; codes can't be reused.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
