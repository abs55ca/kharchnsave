import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionFetch } from "./config";

/*
 * A stalled Supabase request used to leave admin pages on "Checking your
 * access…" until a manual refresh. Here fetch never answers; only the
 * timeout (or the caller's own signal) can end the request.
 */

const BASE = "https://example.supabase.co";
let calls: { url: string; init?: RequestInit }[] = [];

function stallEveryRequest() {
  calls = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin session fetch", () => {
  it("gives up on stalled Auth requests: the session check and a token refresh", async () => {
    stallEveryRequest();
    const fetch = createSessionFetch(20);
    await expect(fetch(`${BASE}/auth/v1/user`, { method: "GET" })).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: "POST" })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("gives up on stalled reads (membership, page data, counts)", async () => {
    stallEveryRequest();
    const fetch = createSessionFetch(20);
    await expect(fetch(`${BASE}/rest/v1/admin_members?select=user_id`)).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(fetch(`${BASE}/rest/v1/products?select=id`, { method: "HEAD" })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("never cuts a write short, and never caches", () => {
    stallEveryRequest();
    const fetch = createSessionFetch(20);
    void fetch(`${BASE}/rest/v1/rpc/admin_cancel_order`, { method: "POST", body: "{}" });
    void fetch(`${BASE}/storage/v1/object/product-photos/a.jpg`, { method: "POST" });
    expect(calls.map((c) => c.init?.signal)).toEqual([undefined, undefined]);
    expect(calls.map((c) => c.init?.cache)).toEqual(["no-store", "no-store"]);
  });

  it("keeps the caller's own abort signal (read RPCs pass one)", async () => {
    stallEveryRequest();
    const fetch = createSessionFetch(60_000);
    const caller = new AbortController();
    const request = fetch(`${BASE}/rest/v1/products?select=id`, { signal: caller.signal });
    caller.abort(new Error("caller gave up"));
    await expect(request).rejects.toThrow("caller gave up");
  });
});
