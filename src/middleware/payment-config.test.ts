/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import {
  normalizePaymentConfig,
  paymentsEnabled,
  loadPaymentConfig,
  _resetPaymentCacheForTesting,
} from "./payment-config.ts";
import type { StorageClient } from "../storage/client.ts";

// ---------------------------------------------------------------------------
// Minimal mock StorageClient — returns pre-configured getJson result
// ---------------------------------------------------------------------------

function makeStorage(paymentJson: unknown): StorageClient {
  return {
    getJson: async (_path: string) => {
      if (_path === "config/payment.json") return paymentJson as Awaited<ReturnType<StorageClient["getJson"]>>;
      return null;
    },
  } as unknown as StorageClient;
}

// ---------------------------------------------------------------------------
// PAY-01: normalizePaymentConfig — valid inputs
// ---------------------------------------------------------------------------

Deno.test("PAY-01: valid config with mints and amounts normalizes correctly", () => {
  const raw = {
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 100, mirror: 50 },
  };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 1);
  assertEquals(config.mints[0].url, "https://mint.example.com");
  assertEquals(config.amounts.upload, 100);
  assertEquals(config.amounts.mirror, 50);
});

Deno.test("PAY-01: HTTPS mint URL accepted", () => {
  const raw = { mints: [{ url: "https://mint.example.com" }], amounts: {} };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 1);
});

Deno.test("PAY-01: HTTP mint URL rejected (warn-and-skip)", () => {
  const raw = { mints: [{ url: "http://mint.example.com" }], amounts: {} };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 0);
});

Deno.test("PAY-01: non-URL string mint rejected (warn-and-skip)", () => {
  const raw = { mints: [{ url: "not-a-url" }], amounts: {} };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 0);
});

Deno.test("PAY-01: invalid mint entries skipped, valid ones preserved", () => {
  const raw = {
    mints: [
      { url: "http://bad.example.com" },     // HTTP → skipped
      { url: "https://good.example.com" },    // HTTPS → kept
      "not-an-object",                        // non-object → skipped
      { url: "https://also-good.example.com" }, // HTTPS → kept
    ],
    amounts: { upload: 10, mirror: 5 },
  };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 2);
  assertEquals(config.mints[0].url, "https://good.example.com");
  assertEquals(config.mints[1].url, "https://also-good.example.com");
});

// ---------------------------------------------------------------------------
// PAY-03: normalizePaymentConfig — null/malformed/invalid inputs
// ---------------------------------------------------------------------------

Deno.test("PAY-03: null input (missing file) → default config, paymentsEnabled() === false", () => {
  const config = normalizePaymentConfig(null);
  assertEquals(config.mints.length, 0);
  assertEquals(config.amounts.upload, 0);
  assertEquals(config.amounts.mirror, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: empty object → default config, paymentsEnabled() === false", () => {
  const config = normalizePaymentConfig({});
  assertEquals(config.mints.length, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: malformed JSON (non-object string) → default config", () => {
  const config = normalizePaymentConfig("not-an-object");
  assertEquals(config.mints.length, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: malformed JSON (array) → default config", () => {
  const config = normalizePaymentConfig([1, 2, 3]);
  assertEquals(config.mints.length, 0);
});

Deno.test("PAY-03: invalid amounts (negative upload) → entire config disabled", () => {
  const raw = {
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: -1, mirror: 50 },
  };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: invalid amounts (non-integer float) → entire config disabled", () => {
  const raw = {
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 1.5, mirror: 50 },
  };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: invalid amounts (non-number mirror) → entire config disabled", () => {
  const raw = {
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 100, mirror: "fifty" },
  };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.mints.length, 0);
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("PAY-03: missing amounts field → defaults to 0 for both actions", () => {
  const raw = { mints: [{ url: "https://mint.example.com" }] };
  const config = normalizePaymentConfig(raw);
  assertEquals(config.amounts.upload, 0);
  assertEquals(config.amounts.mirror, 0);
  // mints present → payments enabled
  assertEquals(paymentsEnabled(config), true);
});

// ---------------------------------------------------------------------------
// Edge cases: paymentsEnabled logic
// ---------------------------------------------------------------------------

Deno.test("Edge: empty mints with valid amounts → paymentsEnabled() === false", () => {
  const config = normalizePaymentConfig({ mints: [], amounts: { upload: 100, mirror: 50 } });
  assertEquals(paymentsEnabled(config), false);
});

Deno.test("Edge: valid mints with zero amounts → paymentsEnabled() === true (mints present)", () => {
  const config = normalizePaymentConfig({
    mints: [{ url: "https://mint.example.com" }],
    amounts: { upload: 0, mirror: 0 },
  });
  assertEquals(paymentsEnabled(config), true);
});

// ---------------------------------------------------------------------------
// PAY-02: loadPaymentConfig — caching behavior
// ---------------------------------------------------------------------------

Deno.test("PAY-02: loadPaymentConfig caches result and returns cached on second call", async () => {
  _resetPaymentCacheForTesting();
  let callCount = 0;
  const storage: StorageClient = {
    getJson: async (_path: string) => {
      callCount++;
      return { mints: [{ url: "https://mint.example.com" }], amounts: { upload: 10, mirror: 5 } } as unknown as Awaited<ReturnType<StorageClient["getJson"]>>;
    },
  } as unknown as StorageClient;

  const result1 = await loadPaymentConfig(storage);
  const result2 = await loadPaymentConfig(storage);

  assertEquals(callCount, 1, "getJson should only be called once due to caching");
  assertEquals(result1, result2, "Both calls should return same cached object");
  assertEquals(result1.config.mints.length, 1);
});

Deno.test("PAY-02: loadPaymentConfig refreshes after TTL expires", async () => {
  _resetPaymentCacheForTesting();
  let callCount = 0;
  const storage: StorageClient = {
    getJson: async (_path: string) => {
      callCount++;
      return { mints: [{ url: "https://mint.example.com" }], amounts: {} } as unknown as Awaited<ReturnType<StorageClient["getJson"]>>;
    },
  } as unknown as StorageClient;

  // First load — should hit storage
  const result1 = await loadPaymentConfig(storage);
  assertEquals(callCount, 1);

  // Manually expire the cache by backdating `expires`
  result1.expires = Date.now() - 1;

  // Second load — TTL expired, should hit storage again
  await loadPaymentConfig(storage);
  assertEquals(callCount, 2, "getJson should be called again after TTL expires");
});
