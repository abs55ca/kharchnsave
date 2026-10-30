import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LINKS, SITE_ORIGIN } from "@/lib/links";
import LinksPage, { metadata } from "./page";

const html = renderToStaticMarkup(<LinksPage />);

const decode = (text: string) =>
  text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The page's links: their attributes and visible text (React's static HTML is regular). */
const anchors = [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => ({
  attributes: Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)])),
  text: decode(inner.replace(/<[^>]+>/g, "")),
}));
const byId = (id: string) => anchors.find((anchor) => anchor.attributes["data-link"] === id)!;

describe("/links", () => {
  it("renders every configured link, in order, with its label and address", () => {
    expect(anchors.map((a) => a.attributes["data-link"])).toEqual(LINKS.map((link) => link.id));
    for (const link of LINKS) {
      expect(byId(link.id).attributes.href, link.id).toBe(link.href);
      expect(byId(link.id).text, link.id).toContain(link.label);
    }
  });

  it("has Instagram, Facebook, the three shop departments and the homepage", () => {
    expect(Object.fromEntries(anchors.map((a) => [a.attributes["data-link"], a.attributes.href]))).toEqual({
      instagram: "https://instagram.com/kharchnsave",
      facebook: "https://facebook.com/kharchnsave",
      "shop-men": "/shop?category=men",
      "shop-women": "/shop?category=women",
      "shop-kids": "/shop?category=kids",
      home: "/",
    });
  });

  it("opens external links safely in a new tab", () => {
    for (const { attributes } of anchors) {
      const external = /^https?:/.test(attributes.href);
      const id = attributes["data-link"];
      expect(attributes.target, id).toBe(external ? "_blank" : undefined);
      if (external) expect(attributes.rel?.split(" ").sort(), id).toEqual(["noopener", "noreferrer"]);
    }
    expect(anchors.filter((a) => a.attributes.target === "_blank")).toHaveLength(2);
  });

  it("shows the K mark, the name and the tagline, and no cart or demo notice", () => {
    expect(html).toMatch(/<h1[^>]*>Kharch n Save<\/h1>/);
    expect(html).toContain("Style Zyada. Kharch Kam.");
    expect(html.match(/<path fill="#163a2c" d="M760\.25/g)).toHaveLength(1);
    expect(html.match(/<path fill="#c3e604" d="M374\.6/g)).toHaveLength(1);
    expect(html).not.toMatch(/add to cart|demo/i);
  });

  it("has a title, description and social preview pointing at kharchnsave.pk", () => {
    expect(metadata.title).toEqual({ absolute: "Kharch n Save: Instagram, Facebook and the shop" });
    expect(metadata.description).toBeTruthy();
    // The root layout's metadataBase; e2e/links.spec.ts checks the rendered og: tags.
    expect(SITE_ORIGIN).toBe("https://kharchnsave.pk");
    expect(metadata.openGraph).toMatchObject({ url: "/links", siteName: "Kharch n Save" });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});
