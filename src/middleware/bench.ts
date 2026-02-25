/// <reference lib="deno.ns" />
/**
 * CPU-time benchmarks for middleware introduced on feature/allowlist-blocklist.
 *
 * Run: deno bench -A src/middleware/bench.ts
 *
 * Each benchmark isolates the synchronous/pure-function cost so numbers reflect
 * CPU time only — no network, no filesystem.
 */

import { normalizeCacheConfig } from "./cache-config.ts";
import { normalizePaymentConfig, paymentsEnabled } from "./payment-config.ts";
import { computeSatPrice } from "./price-feed.ts";
import {
  validateTokenStructure,
  isProofSpent,
  addToSpentCache,
  buildPaymentError,
  _resetSpentCacheForTesting,
} from "./proof-validator.ts";
import { buildPaymentRequired } from "./payments.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ACCESS_RAW = {
  public: true,
  payments: true,
  allowlist: Array.from({ length: 100 }, (_, i) =>
    i.toString(16).padStart(64, "0")
  ),
  blocklist: Array.from({ length: 50 }, (_, i) =>
    (i + 1000).toString(16).padStart(64, "0")
  ),
};

const VALID_CACHE_RAW = { accessTtl: 120, paymentTtl: 90, blockedTtl: 60 };
const NULL_CACHE_RAW = null;

const VALID_PAYMENT_RAW = {
  mints: [
    { url: "https://mint1.example.com" },
    { url: "https://mint2.example.com" },
  ],
  amounts: { upload: 100, mirror: 50 },
};
const MALFORMED_PAYMENT_RAW = "not-an-object";

const PRICING_CONFIG = {
  cost_per_gb_usd: 0.02,
  profit_margin_pct: 0.20,
  slippage_premium_pct: 0.05,
};

const MINT_URLS = [
  "https://mint1.example.com",
  "https://mint2.example.com",
];

const DECODED_TOKEN_VALID = {
  mint: "https://mint1.example.com",
  unit: "sat",
  proofs: Array.from({ length: 4 }, (_, i) => ({
    amount: 8,
    secret: `secret-${i}`,
  })),
};

const DECODED_TOKEN_UNTRUSTED = {
  mint: "https://evil.example.com",
  unit: "sat",
  proofs: [{ amount: 32, secret: "s1" }],
};

const DECODED_TOKEN_INSUFFICIENT = {
  mint: "https://mint1.example.com",
  unit: "sat",
  proofs: [{ amount: 1, secret: "s-low" }],
};

// ---------------------------------------------------------------------------
// cache-config.ts — normalizeCacheConfig
// ---------------------------------------------------------------------------

Deno.bench("normalizeCacheConfig: valid input", () => {
  normalizeCacheConfig(VALID_CACHE_RAW);
});

Deno.bench("normalizeCacheConfig: null input (defaults)", () => {
  normalizeCacheConfig(NULL_CACHE_RAW);
});

Deno.bench("normalizeCacheConfig: partial input", () => {
  normalizeCacheConfig({ accessTtl: 30 });
});

// ---------------------------------------------------------------------------
// payment-config.ts — normalizePaymentConfig + paymentsEnabled
// ---------------------------------------------------------------------------

Deno.bench("normalizePaymentConfig: valid 2-mint config", () => {
  normalizePaymentConfig(VALID_PAYMENT_RAW);
});

Deno.bench("normalizePaymentConfig: malformed (string)", () => {
  normalizePaymentConfig(MALFORMED_PAYMENT_RAW);
});

Deno.bench("paymentsEnabled: enabled (2 mints)", () => {
  paymentsEnabled({ mints: [{ url: "https://m.com" }], amounts: { upload: 0, mirror: 0 } });
});

Deno.bench("paymentsEnabled: disabled (0 mints)", () => {
  paymentsEnabled({ mints: [], amounts: { upload: 0, mirror: 0 } });
});

// ---------------------------------------------------------------------------
// price-feed.ts — computeSatPrice (pure arithmetic)
// ---------------------------------------------------------------------------

Deno.bench("computeSatPrice: 1 GB @ $100k BTC", () => {
  computeSatPrice(1024 ** 3, 100_000, PRICING_CONFIG);
});

Deno.bench("computeSatPrice: 10 MB @ $50k BTC", () => {
  computeSatPrice(10 * 1024 * 1024, 50_000, PRICING_CONFIG);
});

Deno.bench("computeSatPrice: 0 bytes (floor)", () => {
  computeSatPrice(0, 100_000, PRICING_CONFIG);
});

// ---------------------------------------------------------------------------
// proof-validator.ts — validateTokenStructure (pure)
// ---------------------------------------------------------------------------

Deno.bench("validateTokenStructure: valid (4 proofs)", () => {
  validateTokenStructure(DECODED_TOKEN_VALID, MINT_URLS, 20);
});

Deno.bench("validateTokenStructure: untrusted mint (early reject)", () => {
  validateTokenStructure(DECODED_TOKEN_UNTRUSTED, MINT_URLS, 20);
});

Deno.bench("validateTokenStructure: insufficient amount", () => {
  validateTokenStructure(DECODED_TOKEN_INSUFFICIENT, MINT_URLS, 100);
});

// ---------------------------------------------------------------------------
// proof-validator.ts — isProofSpent / addToSpentCache (Set ops)
// ---------------------------------------------------------------------------

// Pre-populate spent cache for hit/miss benchmarks
_resetSpentCacheForTesting();
addToSpentCache(["known-1", "known-2", "known-3"]);

Deno.bench("isProofSpent: miss", () => {
  isProofSpent(["a", "b", "c"]);
});

Deno.bench("isProofSpent: hit", () => {
  isProofSpent(["known-1", "known-2"]);
});

Deno.bench("addToSpentCache: 4 secrets", () => {
  addToSpentCache(["s1", "s2", "s3", "s4"]);
});

// ---------------------------------------------------------------------------
// proof-validator.ts — buildPaymentError
// ---------------------------------------------------------------------------

Deno.bench("buildPaymentError: 400 (untrusted_mint)", () => {
  buildPaymentError({ valid: false, reason: "untrusted_mint" });
});

Deno.bench("buildPaymentError: 503 (mint_unreachable)", () => {
  buildPaymentError({ valid: false, reason: "mint_unreachable", status: 503 });
});

// ---------------------------------------------------------------------------
// payments.ts — buildPaymentRequired (NUT-18 encoding)
// ---------------------------------------------------------------------------

Deno.bench("buildPaymentRequired: 10 MB file, 2 mints", () => {
  buildPaymentRequired(10 * 1024 * 1024, MINT_URLS, 100_000, PRICING_CONFIG);
});

Deno.bench("buildPaymentRequired: 1 GB file, 1 mint", () => {
  buildPaymentRequired(1024 ** 3, ["https://mint1.example.com"], 100_000, PRICING_CONFIG);
});

// ---------------------------------------------------------------------------
// Simulated paymentGate fast-path (payments disabled — cache hit)
// This measures the CPU cost of the most common code path:
//   loadCacheConfig (cache hit) → loadPaymentConfig (cache hit) → paymentsEnabled → null
// Without real I/O, we benchmark just the decision logic.
// ---------------------------------------------------------------------------

Deno.bench("paymentGate fast-path simulation: payments disabled", () => {
  // Simulates what happens when all caches are warm and payments are off
  const config = normalizePaymentConfig(null);
  if (!paymentsEnabled(config)) {
    // null return — this is the hot path
  }
});
