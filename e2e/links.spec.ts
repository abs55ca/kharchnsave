import { expect, test } from "@playwright/test";
import { LINKS, QR_REDIRECT_TARGET } from "@/lib/links";

/*
 * /qr and /links on a running build (npm run build && npm start, or any
 * deployment via E2E_BASE_URL). HTTP only: no browser, no sign-in, no
 * database. Safe to run against any environment.
 */

const html = (value: string) => value.replace(/&/g, "&amp;");

/** The page's HTML without <script> elements (React's serialized data), i.e. what is rendered. */
const markup = (page: string) => page.replace(/<script[\s\S]*?<\/script>/g, "");

test.describe("merch QR redirect and links page", () => {
  test("/qr is a temporary 307 to the links page with the merch UTM tags, never cached", async ({ request, baseURL }) => {
    const response = await request.get("/qr", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers().location).toBe(new URL(QR_REDIRECT_TARGET, baseURL).toString());
    expect(response.headers().location).toContain("/links?utm_source=merch&utm_medium=qr");
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("following /qr lands on the links page", async ({ request }) => {
    const response = await request.get("/qr");
    expect(response.status()).toBe(200);
    expect(response.url()).toMatch(/\/links\?utm_source=merch&utm_medium=qr$/);
    expect(await response.text()).toContain("Kharch n Save");
  });

  test("/links renders every configured link, external ones opening safely", async ({ request }) => {
    const page = await (await request.get("/links")).text();
    for (const link of LINKS) {
      const anchor = new RegExp(`<a [^>]*href="${html(link.href).replace(/[?.]/g, "\\$&")}"[^>]*>`).exec(page)?.[0];
      expect(anchor, link.id).toBeTruthy();
      expect(page, link.id).toContain(`>${link.label}<`);
      if (link.external) {
        expect(anchor, link.id).toContain('target="_blank"');
        expect(anchor, link.id).toContain('rel="noopener noreferrer"');
      }
    }
  });

  test("/links stands alone: no shop header, footer, cart button or demo notice", async ({ request }) => {
    const page = markup(await (await request.get("/links")).text());
    expect(page).toContain("Kharch n Save");
    expect(page).not.toMatch(/Demo storefront|Add to cart/i);
    expect(page).not.toContain("site-search-desktop");
  });

  test("other pages keep the shop header and footer", async ({ request }) => {
    const page = markup(await (await request.get("/about")).text());
    expect(page).toContain("site-search-desktop");
    expect(page).toContain("Demo storefront");
  });

  test("/links has a title and a social preview on kharchnsave.pk", async ({ request }) => {
    const page = await (await request.get("/links")).text();
    expect(page).toContain("<title>Kharch n Save: Instagram, Facebook and the shop</title>");
    expect(page).toMatch(/<meta property="og:url" content="https:\/\/kharchnsave\.pk\/links"/);
    const image = /<meta property="og:image" content="([^"]+)"/.exec(page)?.[1] ?? "";
    expect(image).toMatch(/^https:\/\/kharchnsave\.pk\/links\/opengraph-image/);
    expect(page).toContain('<meta name="twitter:card" content="summary_large_image"');

    // The image itself, fetched from this server.
    const png = await request.get(new URL(image).pathname + new URL(image).search);
    expect(png.headers()["content-type"]).toBe("image/png");
    const bytes = await png.body();
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});
