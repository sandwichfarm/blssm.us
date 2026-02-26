/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { paymentGate } from "./payment-gate.ts";
import type { StorageClient } from "../storage/client.ts";
import { _resetPaymentCacheForTesting } from "./payment-config.ts";
import { _resetPriceCacheForTesting } from "./price-feed.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a mock StorageClient that returns a given payment.json value */
function makeStorage(paymentJson: unknown): StorageClient {
  return {
    getJson: async (_path: string) => {
      if (_path === "config/payment.json") {
        return paymentJson as Awaited<ReturnType<StorageClient["getJson"]>>;
      }
      return null;
    },
  } as unknown as StorageClient;
}

/** Create a minimal Request with optional payment headers */
function makeRequest(cashuHeader?: string, lightningHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (cashuHeader !== undefined) {
    headers["X-Cashu"] = cashuHeader;
  }
  if (lightningHeader !== undefined) {
    headers["X-Lightning"] = lightningHeader;
  }
  return new Request("https://example.com/upload", {
    method: "PUT",
    headers,
  });
}

/** Create a getBtcPrice mock that returns the given price */
function mockGetBtcPrice(price: number | null): () => Promise<number | null> {
  return async () => price;
}

// ---------------------------------------------------------------------------
// Test: payments disabled (no mints configured) → returns null
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns null when payments disabled (no mints, no LN)", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();
  const storage = makeStorage({ mints: [], amounts: { upload: 0, mirror: 0 } });
  const request = makeRequest();
  const result = await paymentGate(request, storage, 1024, {
    loadLnConfig: () => null,
  });
  assertEquals(result, null);
});

Deno.test("paymentGate: returns null when payment.json missing and no LN (null config)", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();
  const storage = makeStorage(null);
  const request = makeRequest();
  const result = await paymentGate(request, storage, 1024, {
    loadLnConfig: () => null,
  });
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// Test: BTC price unavailable → fail closed (returns 503)
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 503 (fail closed) when BTC price unavailable", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest();

  const result = await paymentGate(request, storage, 1024, {
    getBtcPrice: mockGetBtcPrice(null),
  });
  assertEquals(result !== null, true, "Should return a Response, not null");
  assertEquals(result!.status, 503);
  assertEquals(result!.headers.get("X-Reason"), "price_unavailable");
  assertEquals(result!.headers.get("Retry-After"), "30");
});

// ---------------------------------------------------------------------------
// Test: no X-Cashu header → 402 with X-Cashu response header + Cache-Control: no-store
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 402 with X-Cashu header when no proof provided", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest(); // no X-Cashu header

  const result = await paymentGate(request, storage, 1024 * 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml", // uses defaults
    getBtcPrice: mockGetBtcPrice(50_000),
  });

  assertEquals(result !== null, true, "Should return a Response, not null");
  assertEquals(result!.status, 402);
  assertEquals(result!.headers.get("Cache-Control"), "no-store");
  // X-Cashu should be present (NUT-18 encoded PaymentRequest)
  const xCashu = result!.headers.get("X-Cashu");
  assertEquals(xCashu !== null, true, "X-Cashu header should be present");
  assertEquals(xCashu!.startsWith("creq"), true, "X-Cashu should be NUT-18 encoded (creq prefix)");
});

// ---------------------------------------------------------------------------
// Test: valid X-Cashu proof → returns null (payment accepted)
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns null when valid Cashu proof provided", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const mintUrl = "https://mint.example.com";
  let validateCalled = false;

  const storage = makeStorage({
    mints: [{ url: mintUrl }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest("cashuBvalid_token_header");

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    validatePayment: async (_token: string, _mints: string[], _sats: number) => {
      validateCalled = true;
      return { valid: true };
    },
  });

  assertEquals(result, null, "Valid proof should return null");
  assertEquals(validateCalled, true, "validatePayment should have been called");
});

// ---------------------------------------------------------------------------
// Test: invalid proof → 400 with X-Reason
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 400 with X-Reason when proof invalid", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest("cashuBbad_token");

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    validatePayment: async (_token: string, _mints: string[], _sats: number) => {
      return { valid: false, reason: "proof_invalid_or_spent" };
    },
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get("X-Reason"), "proof_invalid_or_spent");
  assertEquals(result!.headers.get("Cache-Control"), "no-store");
});

// ---------------------------------------------------------------------------
// Test: mint unreachable → 503 with Retry-After
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 503 with Retry-After when mint unreachable", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest("cashuBsome_token");

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    validatePayment: async (_token: string, _mints: string[], _sats: number) => {
      return { valid: false, reason: "mint_unreachable", status: 503 };
    },
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 503);
  assertEquals(result!.headers.get("X-Reason"), "mint_unreachable");
  assertEquals(result!.headers.get("Retry-After"), "30");
  assertEquals(result!.headers.get("Cache-Control"), "no-store");
});

// ---------------------------------------------------------------------------
// Test: X-Lightning preimage valid → returns null
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns null when valid Lightning preimage provided", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const preimage = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const request = makeRequest(undefined, preimage);

  let validateCalled = false;

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    validateLightning: async () => {
      validateCalled = true;
      return { valid: true };
    },
  });

  assertEquals(result, null, "Valid lightning preimage should return null");
  assertEquals(validateCalled, true, "validateLightning should have been called");
});

// ---------------------------------------------------------------------------
// Test: X-Lightning preimage invalid → returns 400
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 400 when Lightning preimage invalid", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest(undefined, "bad_preimage");

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    validateLightning: async () => {
      return { valid: false, reason: "invalid_preimage" };
    },
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get("X-Reason"), "invalid_preimage");
});

// ---------------------------------------------------------------------------
// Test: X-Lightning header but LND not configured → 400 lightning_not_supported
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 400 lightning_not_supported when LND not configured", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest(undefined, "some_preimage");

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => null,
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 400);
  assertEquals(result!.headers.get("X-Reason"), "lightning_not_supported");
});

// ---------------------------------------------------------------------------
// Test: LND unreachable on invoice creation → 402 Cashu-only (graceful)
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 402 Cashu-only when LND unreachable for invoice", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const request = makeRequest(); // no payment headers

  const result = await paymentGate(request, storage, 1024 * 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    createLnInvoice: async () => null, // LND unreachable
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 402);
  assertEquals(result!.headers.get("X-Cashu") !== null, true, "X-Cashu should be present");
  assertEquals(result!.headers.get("X-Lightning"), null, "X-Lightning should be absent");
});

// ---------------------------------------------------------------------------
// Test: LN-only mode (no mints) → 402 with X-Lightning only
// ---------------------------------------------------------------------------

Deno.test("paymentGate: returns 402 with X-Lightning only when LN configured but no mints", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [],
    amounts: { upload: 0, mirror: 0 },
  });
  const request = makeRequest(); // no payment headers

  const result = await paymentGate(request, storage, 1024 * 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    createLnInvoice: async () => "lnbc100n1...",
  });

  assertEquals(result !== null, true, "Should return a Response");
  assertEquals(result!.status, 402);
  assertEquals(result!.headers.get("X-Cashu"), null, "X-Cashu should be absent (no mints)");
  assertEquals(result!.headers.get("X-Lightning"), "lnbc100n1...", "X-Lightning should be present");
  assertEquals(result!.headers.get("Cache-Control"), "no-store");
});

// ---------------------------------------------------------------------------
// Test: both headers present → X-Lightning takes precedence
// ---------------------------------------------------------------------------

Deno.test("paymentGate: X-Lightning takes precedence over X-Cashu", async () => {
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();

  const storage = makeStorage({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 10, mirror: 5 },
  });
  const preimage = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const request = makeRequest("cashuBsome_token", preimage);

  let lightningCalled = false;
  let cashuCalled = false;

  const result = await paymentGate(request, storage, 1024, {
    pricingTomlPath: "/tmp/nonexistent-pricing.toml",
    getBtcPrice: mockGetBtcPrice(50_000),
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    validateLightning: async () => {
      lightningCalled = true;
      return { valid: true };
    },
    validatePayment: async () => {
      cashuCalled = true;
      return { valid: true };
    },
  });

  assertEquals(result, null, "Should pass through");
  assertEquals(lightningCalled, true, "Lightning validator should have been called");
  assertEquals(cashuCalled, false, "Cashu validator should NOT have been called");
});
