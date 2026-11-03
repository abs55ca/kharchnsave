import { describe, expect, it, vi } from "vitest";
import { clientBucket, clientIp } from "./client-ip";
import { getCheckoutConfig, parseClientIpSource } from "./config";
import { cdataFor, verifyTurnstile } from "./turnstile";

const SECRET = "s".repeat(40);

describe("checkout configuration", () => {
  const complete = {
    CHECKOUT_ENABLED: "true",
    CHECKOUT_GATEWAY_SECRET: SECRET,
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "secret",
    CLIENT_IP_SOURCE: "header:x-test-client-ip",
  };

  it("is enabled only when everything is set", () => {
    expect(getCheckoutConfig(complete).enabled).toBe(true);
    for (const name of Object.keys(complete)) {
      const config = getCheckoutConfig({ ...complete, [name]: undefined });
      expect(config.enabled, name).toBe(false);
      expect(config.problems).toEqual([name]);
    }
  });

  it("is off by default, and lists only variable names (never values)", () => {
    const config = getCheckoutConfig({});
    expect(config.enabled).toBe(false);
    expect(config.problems).toEqual(["CHECKOUT_ENABLED", "CHECKOUT_GATEWAY_SECRET", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "CLIENT_IP_SOURCE"]);
  });

  it("refuses a short gateway secret", () => {
    expect(getCheckoutConfig({ ...complete, CHECKOUT_GATEWAY_SECRET: "short" }).gatewaySecret).toBeNull();
  });

  it("never trusts X-Forwarded-For as the client IP header", () => {
    expect(parseClientIpSource("header:x-forwarded-for")).toBeNull();
    expect(parseClientIpSource("header:")).toBeNull();
    expect(parseClientIpSource("none")).toEqual({ kind: "none" });
    expect(parseClientIpSource("HEADER:X-Real-Client")).toEqual({ kind: "header", header: "x-real-client" });
  });
});

describe("client IP", () => {
  it("reads only the configured header, and only a valid address", () => {
    const headers = new Headers({ "x-test-client-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.1" });
    expect(clientIp(headers, { kind: "header", header: "x-test-client-ip" })).toBe("203.0.113.5");
    expect(clientIp(headers, { kind: "none" })).toBeNull();
    expect(clientIp(new Headers({ "x-test-client-ip": "1.2.3.4, 5.6.7.8" }), { kind: "header", header: "x-test-client-ip" })).toBeNull();
  });

  it("is hashed with a secret before it reaches the database", () => {
    const bucket = clientBucket("203.0.113.5", SECRET)!;
    expect(bucket).toMatch(/^ip:[0-9a-f]{64}$/);
    expect(bucket).not.toContain("203");
    expect(clientBucket("203.0.113.5", SECRET)).toBe(bucket);
    expect(clientBucket("203.0.113.5", "t".repeat(40))).not.toBe(bucket);
    expect(clientBucket(null, SECRET)).toBeNull();
  });
});

describe("Turnstile verification", () => {
  const KEY = "k".repeat(43);
  const respond = (body: object, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const verify = (fetchImpl: typeof fetch, hostnames: string[] = []) =>
    verifyTurnstile("token", { secret: "secret", checkoutKey: KEY, remoteIp: "203.0.113.5", hostnames, fetchImpl });
  const passed = { success: true, action: "place_order", cdata: cdataFor(KEY), hostname: "shop.example" };

  it("accepts a token for this action and this checkout key", async () => {
    const fetchImpl = respond(passed);
    expect(await verify(fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ secret: "secret", response: "token", remoteip: "203.0.113.5" });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a token solved for another checkout key or action", async () => {
    expect(await verify(respond({ ...passed, cdata: "other" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(respond({ ...passed, action: "login" }) as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
  });

  it("checks the hostname when one is configured", async () => {
    expect(await verify(respond(passed) as unknown as typeof fetch, ["other.example"])).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(respond(passed) as unknown as typeof fetch, ["shop.example"])).toEqual({ ok: true });
  });

  it("an expired or already-used token: ask again", async () => {
    expect(await verify(respond({ success: false, "error-codes": ["timeout-or-duplicate"] }) as unknown as typeof fetch))
      .toEqual({ ok: false, reason: "expired" });
  });

  it("our secret refused, or Cloudflare down: unavailable (fails closed)", async () => {
    expect(await verify(respond({ success: false, "error-codes": ["invalid-input-secret"] }) as unknown as typeof fetch))
      .toEqual({ ok: false, reason: "unavailable" });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await verify(down as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable" });
    expect(down).toHaveBeenCalledTimes(2);
  });

  describe("Cloudflare testing keys", () => {
    // What Siteverify really returned for the always-pass testing secret (2026-10-30).
    const testingPass = { success: true, "error-codes": [], hostname: "example.com", metadata: { result_with_testing_key: true } };

    it("are refused by default, so a misconfigured host can't use them", async () => {
      expect(await verify(respond(testingPass) as unknown as typeof fetch)).toEqual({ ok: false, reason: "invalid" });
    });

    it("are accepted only with the local test opt-in", async () => {
      const fetchImpl = respond(testingPass) as unknown as typeof fetch;
      expect(await verifyTurnstile("XXXX.DUMMY.TOKEN.XXXX", { secret: "x", checkoutKey: KEY, remoteIp: null, hostnames: [], allowTestingKeys: true, fetchImpl }))
        .toEqual({ ok: true });
    });

    it("the opt-in doesn't relax checks on real tokens", async () => {
      const fetchImpl = respond({ ...passed, cdata: "other" }) as unknown as typeof fetch;
      expect(await verifyTurnstile("token", { secret: "x", checkoutKey: KEY, remoteIp: null, hostnames: [], allowTestingKeys: true, fetchImpl }))
        .toEqual({ ok: false, reason: "invalid" });
    });

    it("the opt-in is off unless set to exactly \"allow\"", () => {
      expect(getCheckoutConfig({}).turnstileTestingKeys).toBe(false);
      expect(getCheckoutConfig({ CHECKOUT_TURNSTILE_TESTING_KEYS: "true" }).turnstileTestingKeys).toBe(false);
      expect(getCheckoutConfig({ CHECKOUT_TURNSTILE_TESTING_KEYS: "allow" }).turnstileTestingKeys).toBe(true);
    });
  });

  it("retries a failed request once, with the same idempotency key", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const flaky = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      if (calls++ === 0) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(passed));
    });
    expect(await verify(flaky as unknown as typeof fetch)).toEqual({ ok: true });
    expect(bodies[0]).toBe(bodies[1]);
  });
});
