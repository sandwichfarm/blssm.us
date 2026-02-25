/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { handleAdminRefreshPrice } from "./admin-refresh-price.ts";
import { _resetPriceCacheForTesting } from "../middleware/price-feed.ts";

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    return handler(url);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function geckoResponse(price: number): Response {
  return new Response(JSON.stringify({ bitcoin: { usd: price } }), {
    status: 200,
  });
}

function coinbaseResponse(price: number): Response {
  return new Response(JSON.stringify({ data: { amount: String(price) } }), {
    status: 200,
  });
}

function priceStubBoth(price: number): () => void {
  return stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(price);
    if (url.includes("coinbase")) return coinbaseResponse(price);
    // Bunny API upsert — return 200
    return new Response("", { status: 200 });
  });
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const originals: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      originals[key] = Deno.env.get(key);
      const val = vars[key];
      if (val === undefined) Deno.env.delete(key);
      else Deno.env.set(key, val);
    }
    try {
      await fn();
    } finally {
      for (const [key, val] of Object.entries(originals)) {
        if (val === undefined) Deno.env.delete(key);
        else Deno.env.set(key, val);
      }
    }
  };
}

function makeRequest(headers?: Record<string, string>): Request {
  return new Request("https://example.com/admin/refresh-price", {
    method: "POST",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "admin-refresh-price: returns 500 when ADMIN_KEY not configured",
  withEnv({ ADMIN_KEY: undefined }, async () => {
    const res = await handleAdminRefreshPrice(makeRequest());
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "server misconfigured");
  }),
);

Deno.test(
  "admin-refresh-price: returns 401 when no X-Admin-Key header",
  withEnv({ ADMIN_KEY: "secret123" }, async () => {
    const res = await handleAdminRefreshPrice(makeRequest());
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "unauthorized");
  }),
);

Deno.test(
  "admin-refresh-price: returns 401 when wrong key",
  withEnv({ ADMIN_KEY: "secret123" }, async () => {
    const res = await handleAdminRefreshPrice(
      makeRequest({ "X-Admin-Key": "wrong" }),
    );
    assertEquals(res.status, 401);
  }),
);

Deno.test(
  "admin-refresh-price: returns 502 when price fetch fails",
  withEnv({ ADMIN_KEY: "secret123" }, async () => {
    _resetPriceCacheForTesting();
    const restore = stubFetch(async () => {
      throw new Error("network error");
    });
    try {
      const res = await handleAdminRefreshPrice(
        makeRequest({ "X-Admin-Key": "secret123" }),
      );
      assertEquals(res.status, 502);
      const body = await res.json();
      assertEquals(body.error, "price fetch failed");
    } finally {
      restore();
    }
  }),
);

Deno.test(
  "admin-refresh-price: returns 200 with price on success",
  withEnv(
    { ADMIN_KEY: "secret123", BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined },
    async () => {
      _resetPriceCacheForTesting();
      const restore = priceStubBoth(95_000);
      try {
        const res = await handleAdminRefreshPrice(
          makeRequest({ "X-Admin-Key": "secret123" }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.btc_usd, 95_000);
        assertEquals(typeof body.updated, "string");
        // Verify env was set
        assertEquals(Deno.env.get("BTC_USD_PRICE"), "95000");
      } finally {
        restore();
        Deno.env.delete("BTC_USD_PRICE");
      }
    },
  ),
);

Deno.test(
  "admin-refresh-price: fires Bunny API upsert when keys are configured",
  withEnv(
    { ADMIN_KEY: "secret123", BUNNY_API_KEY: "bunny-key", BUNNY_SCRIPT_ID: "12345" },
    async () => {
      _resetPriceCacheForTesting();
      let bunnyApiCalled = false;
      const restore = stubFetch(async (url) => {
        if (url.includes("coingecko")) return geckoResponse(90_000);
        if (url.includes("coinbase")) return coinbaseResponse(90_000);
        if (url.includes("api.bunny.net")) {
          bunnyApiCalled = true;
          return new Response("", { status: 200 });
        }
        return new Response("", { status: 404 });
      });
      try {
        const res = await handleAdminRefreshPrice(
          makeRequest({ "X-Admin-Key": "secret123" }),
        );
        assertEquals(res.status, 200);
        // Give fire-and-forget a moment to complete
        await new Promise((r) => setTimeout(r, 100));
        assertEquals(bunnyApiCalled, true);
      } finally {
        restore();
        Deno.env.delete("BTC_USD_PRICE");
      }
    },
  ),
);
