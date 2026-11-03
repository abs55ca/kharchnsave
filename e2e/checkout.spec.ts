import { expect, test } from "@playwright/test";

/*
 * Checkout while it is OFF (no checkout settings on the server: the default).
 * Needs only a running build (npm run build && npm start); no database writes,
 * no sign-in. Safe against any environment where checkout isn't configured.
 *
 * Placing real orders in a browser needs a real Turnstile widget on the
 * deployed hostname and a database with the order migrations; that is a
 * manual check on the dev deployment (README, "Checkout: manual checks").
 */

const KEY = "e2e".padEnd(43, "x");

test.describe("checkout while it is off", () => {
  test("the checkout page explains that ordering isn't open and asks for nothing", async ({ page }) => {
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: /Checkout isn.t connected yet/ })).toBeVisible();
    // No personal details are asked for (the site header's search box aside).
    await expect(page.locator("main input, main textarea")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("the checkout APIs are closed and never cached", async ({ request }) => {
    const quote = await request.post("/api/checkout/quote", { data: { lines: [{ sku: "X-1", quantity: 1, unit_price_paisa: 100 }], city: "Lahore" } });
    expect(quote.status()).toBe(503);
    expect(quote.headers()["cache-control"]).toContain("no-store");

    const order = await request.post("/api/checkout/order", { data: { key: KEY } });
    expect(order.status()).toBe(503);
    expect(order.headers()["cache-control"]).toContain("no-store");
    expect(order.headers()["x-robots-tag"]).toContain("noindex");
  });

  test("the order page: no key, no order; the key is sent in the request body, never in a URL", async ({ page }) => {
    await page.goto("/order");
    await expect(page.getByText("We couldn’t find an order for this link.")).toBeVisible();

    const requests: { url: string; body: string | null }[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/checkout/")) requests.push({ url: r.url(), body: r.postData() });
    });
    await page.goto(`/order#k=${KEY}`);
    await expect(page.getByText(/couldn’t load your order/)).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).not.toContain(KEY);
    expect(requests[0].body).toContain(KEY);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("order administration needs a signed-in admin", async ({ page }) => {
    for (const path of ["/admin/orders", "/admin/settings", `/admin/orders/00000000-0000-4000-8000-000000000000`]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\/login/);
    }
  });
});
