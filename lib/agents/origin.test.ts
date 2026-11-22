import { describe, expect, it } from "vitest";
import { linkOrigin } from "./origin";

describe("the address in agents' password links", () => {
  const h = (values: Record<string, string>) => new Headers(values);

  it("uses AGENT_LINK_ORIGIN when it is a plain origin", () => {
    expect(linkOrigin(h({ origin: "https://other.example" }), { AGENT_LINK_ORIGIN: "https://kharchnsave.pk/" })).toBe("https://kharchnsave.pk");
    // Not a plain origin: ignored.
    expect(linkOrigin(h({ origin: "https://shop.example" }), { AGENT_LINK_ORIGIN: "kharchnsave.pk/path" })).toBe("https://shop.example");
  });

  it("otherwise the page the admin is using (the action's Origin), then the Host", () => {
    expect(linkOrigin(h({ origin: "http://127.0.0.1:3000", host: "localhost:3000" }), {})).toBe("http://127.0.0.1:3000");
    expect(linkOrigin(h({ host: "shop.example" }), {})).toBe("https://shop.example");
    expect(linkOrigin(h({ host: "localhost:3000" }), {})).toBe("http://localhost:3000");
    expect(linkOrigin(h({ origin: "null", host: "shop.example" }), {})).toBe("https://shop.example");
  });
});
