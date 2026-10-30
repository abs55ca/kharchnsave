import { describe, expect, it } from "vitest";
import { QR_REDIRECT_TARGET } from "@/lib/links";
import { GET, HEAD } from "./route";

const request = (method = "GET") => new Request("https://kharchnsave.pk/qr", { method });

describe("/qr", () => {
  it("is a temporary redirect (307) to the links page with the merch UTM tags", () => {
    const response = GET(request());
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://kharchnsave.pk/links?utm_source=merch&utm_medium=qr");
    expect(QR_REDIRECT_TARGET).toBe("/links?utm_source=merch&utm_medium=qr");
  });

  it("is never permanent and never cached", () => {
    const response = GET(request());
    expect([301, 308]).not.toContain(response.status);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers HEAD the same way", () => {
    const response = HEAD(request("HEAD"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://kharchnsave.pk/links?utm_source=merch&utm_medium=qr");
  });
});
