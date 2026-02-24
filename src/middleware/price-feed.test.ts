/// <reference lib="deno.ns" />
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import {
  computeSatPrice,
  loadPricingConfig,
  readBtcUsdPrice,
} from "./price-feed.ts";
import type { PricingConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// computeSatPrice tests
// ---------------------------------------------------------------------------

const STANDARD_CONFIG: PricingConfig = {
  cost_per_gb_usd: 0.02,
  profit_margin_pct: 0.20,
  slippage_premium_pct: 0.05,
};

Deno.test("computeSatPrice: 1 GB at $100k BTC returns 26 sats", () => {
  // Expected: ceil((1 * 0.02 * 1.20 * 1.05) / 100000 * 100_000_000)
  // = ceil((0.0252) / 100000 * 100_000_000)
  // = ceil(25.2)
  // = 26
  const bytes = 1024 ** 3; // 1 GB
  const result = computeSatPrice(bytes, 100_000, STANDARD_CONFIG);
  assertEquals(result, 26);
});

Deno.test("computeSatPrice: 0 byte file returns 1 sat (floor)", () => {
  const result = computeSatPrice(0, 100_000, STANDARD_CONFIG);
  assertEquals(result, 1);
});

Deno.test("computeSatPrice: 1 byte file returns 1 sat (floor)", () => {
  const result = computeSatPrice(1, 100_000, STANDARD_CONFIG);
  assertEquals(result, 1);
});

Deno.test("computeSatPrice: 10 GB at $50k BTC returns reasonable sat amount", () => {
  const bytes = 10 * 1024 ** 3; // 10 GB
  // Expected: ceil((10 * 0.02 * 1.20 * 1.05) / 50000 * 100_000_000)
  // = ceil((0.252) / 50000 * 100_000_000)
  // = ceil(504)
  // = 504
  const result = computeSatPrice(bytes, 50_000, STANDARD_CONFIG);
  assertEquals(result, 504);
});

Deno.test("computeSatPrice: BTC price of $1 returns very high sat amount without overflow", () => {
  const bytes = 1024 ** 3; // 1 GB
  // Expected: ceil((1 * 0.02 * 1.20 * 1.05) / 1 * 100_000_000)
  // = ceil(0.0252 * 100_000_000)
  // = ceil(2_520_000)
  // = 2_520_000
  const result = computeSatPrice(bytes, 1, STANDARD_CONFIG);
  assertEquals(result, 2_520_000);
  // Verify it's a safe JS integer
  assertEquals(Number.isSafeInteger(result), true);
});

Deno.test("computeSatPrice: negative byte size treated as 0 (returns 1 sat floor)", () => {
  const result = computeSatPrice(-1000, 100_000, STANDARD_CONFIG);
  assertEquals(result, 1);
});

// ---------------------------------------------------------------------------
// loadPricingConfig tests
// ---------------------------------------------------------------------------

Deno.test("loadPricingConfig: valid TOML with mints and pricing loads correctly", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"

[[mints]]
url = "https://mint.coinos.io"

[pricing]
cost_per_gb_usd = 0.05
profit_margin_pct = 0.30
slippage_premium_pct = 0.10
`);
    const { mints, pricing } = await loadPricingConfig(tmpFile);
    assertEquals(mints, [
      "https://mint.minibits.cash/Bitcoin",
      "https://mint.coinos.io",
    ]);
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.05);
    assertAlmostEquals(pricing.profit_margin_pct, 0.30);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.10);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: HTTP mint URL is skipped with warning", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "http://insecure-mint.example.com"

[[mints]]
url = "https://mint.coinos.io"

[pricing]
cost_per_gb_usd = 0.02
profit_margin_pct = 0.20
slippage_premium_pct = 0.05
`);
    const { mints } = await loadPricingConfig(tmpFile);
    assertEquals(mints.length, 1);
    assertEquals(mints[0], "https://mint.coinos.io");
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: missing pricing section uses defaults", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"
`);
    const { mints, pricing } = await loadPricingConfig(tmpFile);
    assertEquals(mints, ["https://mint.minibits.cash/Bitcoin"]);
    // Should use defaults
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
    assertAlmostEquals(pricing.profit_margin_pct, 0.20);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: non-existent path returns defaults with empty mints", async () => {
  const { mints, pricing } = await loadPricingConfig("/non/existent/path.toml");
  assertEquals(mints, []);
  assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
  assertAlmostEquals(pricing.profit_margin_pct, 0.20);
  assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
});

Deno.test("loadPricingConfig: invalid pricing values (negative) use defaults", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"

[pricing]
cost_per_gb_usd = -0.01
profit_margin_pct = 0.20
slippage_premium_pct = 0.05
`);
    const { pricing } = await loadPricingConfig(tmpFile);
    // Invalid negative value should fall back to defaults
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
    assertAlmostEquals(pricing.profit_margin_pct, 0.20);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// readBtcUsdPrice tests
// ---------------------------------------------------------------------------

Deno.test("readBtcUsdPrice: valid JSON file returns price", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify({ btc_usd: 95000, updated: Date.now() }));
    const price = await readBtcUsdPrice(tmpFile);
    assertEquals(price, 95000);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readBtcUsdPrice: non-existent file returns null", async () => {
  const price = await readBtcUsdPrice("/non/existent/price.json");
  assertEquals(price, null);
});

Deno.test("readBtcUsdPrice: invalid JSON returns null", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, "not valid json {{{}}}");
    const price = await readBtcUsdPrice(tmpFile);
    assertEquals(price, null);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readBtcUsdPrice: JSON with non-number btc_usd returns null", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify({ btc_usd: "not-a-number", updated: 0 }));
    const price = await readBtcUsdPrice(tmpFile);
    assertEquals(price, null);
  } finally {
    await Deno.remove(tmpFile);
  }
});
