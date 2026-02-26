/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { handleServerInfo } from "./server-info.ts";
import { _resetAccessCacheForTesting } from "../middleware/access.ts";
import { _resetPaymentCacheForTesting } from "../middleware/payment-config.ts";
import { _resetPriceCacheForTesting } from "../middleware/price-feed.ts";
import type { StorageClient } from "../storage/client.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeStorage(
  configs: Record<string, unknown>,
): StorageClient {
  return {
    getJson: (path: string) => Promise.resolve(configs[path] ?? null),
  } as unknown as StorageClient;
}

function resetCaches(): void {
  _resetAccessCacheForTesting();
  _resetPaymentCacheForTesting();
  _resetPriceCacheForTesting();
}

// Valid 64-char hex pubkey for testing
const PK1 = "a".repeat(64);
const PK2 = "b".repeat(64);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("server-info: public + no payments → minimal response", async () => {
  resetCaches();
  const storage = makeStorage({
    "config/access.json": { public: true, allowlist: [], blocklist: [], payments: false },
  });
  const res = await handleServerInfo(storage);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.public, true);
  assertEquals(body.paymentsEnabled, false);
  assertEquals(body.allowlist, undefined);
  assertEquals(body.payment, undefined);
});

Deno.test("server-info: public + payments with fixed amounts", async () => {
  resetCaches();
  const storage = makeStorage({
    "config/access.json": { public: true, allowlist: [PK1], blocklist: [], payments: true },
    "config/payment.json": {
      mints: [{ url: "https://mint.example.com" }],
      amounts: { upload: 100, mirror: 50 },
    },
  });
  const res = await handleServerInfo(storage);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.public, true);
  assertEquals(body.paymentsEnabled, true);
  assertEquals(body.payment.fixedAmounts, true);
  assertEquals(body.payment.amounts.upload, 100);
  assertEquals(body.payment.amounts.mirror, 50);
  assertEquals(body.payment.mints, ["https://mint.example.com"]);
  assertEquals(body.payment.pricing, undefined);
});

Deno.test("server-info: public + payments with dynamic pricing (amounts=0)", async () => {
  resetCaches();
  const storage = makeStorage({
    "config/access.json": { public: true, allowlist: [], blocklist: [], payments: true },
    "config/payment.json": {
      mints: [{ url: "https://mint.example.com" }],
      amounts: { upload: 0, mirror: 0 },
    },
  });
  const res = await handleServerInfo(storage);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.paymentsEnabled, true);
  assertEquals(body.payment.fixedAmounts, false);
  // Pricing defaults from loadPricingConfig when no TOML/env
  assertEquals(typeof body.payment.pricing.cost_per_gb_usd, "number");
  assertEquals(typeof body.payment.pricing.profit_margin_pct, "number");
  assertEquals(typeof body.payment.pricing.slippage_premium_pct, "number");
});

Deno.test("server-info: private mode → includes allowlist, no payment", async () => {
  resetCaches();
  const storage = makeStorage({
    "config/access.json": { public: false, allowlist: [PK1, PK2], blocklist: [] },
  });
  const res = await handleServerInfo(storage);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.public, false);
  assertEquals(body.paymentsEnabled, false);
  assertEquals(body.allowlist, [PK1, PK2]);
  assertEquals(body.payment, undefined);
});

Deno.test("server-info: Cache-Control header present", async () => {
  resetCaches();
  const storage = makeStorage({
    "config/access.json": { public: true, allowlist: [], blocklist: [] },
  });
  const res = await handleServerInfo(storage);
  assertEquals(res.headers.get("Cache-Control"), "public, max-age=60");
});

Deno.test("server-info: missing configs → safe defaults", async () => {
  resetCaches();
  // Empty storage — all getJson calls return null
  const storage = makeStorage({});
  const res = await handleServerInfo(storage);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.public, true);
  assertEquals(body.paymentsEnabled, false);
});

Deno.test("server-info: payments enabled but no mints, no LN → payments disabled", async () => {
  resetCaches();
  // Ensure no LND env vars are set
  const savedUrl = Deno.env.get("LND_REST_URL");
  const savedMac = Deno.env.get("LND_INVOICE_MACAROON");
  Deno.env.delete("LND_REST_URL");
  Deno.env.delete("LND_INVOICE_MACAROON");
  try {
    const storage = makeStorage({
      "config/access.json": { public: true, allowlist: [], blocklist: [], payments: true },
      "config/payment.json": {
        mints: [],
        amounts: { upload: 100, mirror: 50 },
      },
    });
    const res = await handleServerInfo(storage);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.paymentsEnabled, false);
    assertEquals(body.payment, undefined);
  } finally {
    if (savedUrl) Deno.env.set("LND_REST_URL", savedUrl);
    if (savedMac) Deno.env.set("LND_INVOICE_MACAROON", savedMac);
  }
});

Deno.test("server-info: lightning-only → paymentsEnabled true, lightning flag, mints empty", async () => {
  resetCaches();
  // Set LND env vars to enable lightning-only mode
  const savedUrl = Deno.env.get("LND_REST_URL");
  const savedMac = Deno.env.get("LND_INVOICE_MACAROON");
  Deno.env.set("LND_REST_URL", "https://lnd.test");
  Deno.env.set("LND_INVOICE_MACAROON", "deadbeef");
  try {
    const storage = makeStorage({
      "config/access.json": { public: true, allowlist: [], blocklist: [], payments: true },
      "config/payment.json": {
        mints: [],
        amounts: { upload: 0, mirror: 0 },
      },
    });
    const res = await handleServerInfo(storage);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.paymentsEnabled, true);
    assertEquals(body.payment.mints, []);
    assertEquals(body.payment.lightning, true);
  } finally {
    if (savedUrl) Deno.env.set("LND_REST_URL", savedUrl);
    else Deno.env.delete("LND_REST_URL");
    if (savedMac) Deno.env.set("LND_INVOICE_MACAROON", savedMac);
    else Deno.env.delete("LND_INVOICE_MACAROON");
  }
});
