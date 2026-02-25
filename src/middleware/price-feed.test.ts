/// <reference lib="deno.ns" />
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import {
  computeSatPrice,
  fetchBtcUsdPrice,
  loadPricingConfig,
  readBtcUsdPrice,
  startPriceFeedCron,
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

Deno.test("readBtcUsdPrice: Infinity btc_usd returns null (isFinite guard)", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(tmpFile, JSON.stringify({ btc_usd: Infinity }));
    const price = await readBtcUsdPrice(tmpFile);
    assertEquals(price, null);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// fetchBtcUsdPrice tests (stub globalThis.fetch)
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

function geckoResponse(price: number): Response {
  return new Response(JSON.stringify({ bitcoin: { usd: price } }), { status: 200 });
}

function coinbaseResponse(price: number): Response {
  return new Response(JSON.stringify({ data: { amount: String(price) } }), { status: 200 });
}

Deno.test("fetchBtcUsdPrice: both sources succeed → returns average", async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(100_000);
    return coinbaseResponse(102_000);
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, 101_000);
  } finally {
    restore();
  }
});

Deno.test("fetchBtcUsdPrice: only CoinGecko succeeds → returns gecko price", async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(95_000);
    throw new Error("network error");
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, 95_000);
  } finally {
    restore();
  }
});

Deno.test("fetchBtcUsdPrice: only Coinbase succeeds → returns coinbase price", async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes("coinbase")) return coinbaseResponse(97_000);
    throw new Error("network error");
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, 97_000);
  } finally {
    restore();
  }
});

Deno.test("fetchBtcUsdPrice: both fail → returns null", async () => {
  const restore = stubFetch(async (_url) => {
    throw new Error("network error");
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, null);
  } finally {
    restore();
  }
});

Deno.test("fetchBtcUsdPrice: CoinGecko returns !res.ok → falls through to coinbase-only", async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return new Response("rate limited", { status: 429 });
    return coinbaseResponse(99_000);
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, 99_000);
  } finally {
    restore();
  }
});

Deno.test("fetchBtcUsdPrice: Coinbase returns non-number amount → treated as failure", async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(100_000);
    // amount is not a parseable number string
    return new Response(JSON.stringify({ data: { amount: "not-a-number" } }), { status: 200 });
  });
  try {
    const price = await fetchBtcUsdPrice();
    assertEquals(price, 100_000);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// loadPricingConfig — uncovered internal branches
// ---------------------------------------------------------------------------

Deno.test("loadPricingConfig: mint entry that is not an object is skipped with warn", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
  try {
    // TOML arrays of inline tables: use mints = [{...}] syntax won't yield bare strings.
    // But we can make an entry with just a string value via [[mints]] with no url key.
    // Actually a TOML [[mints]] always produces an object. To get a non-object we'd need
    // mints = ["bare"] which is a plain array of strings rather than array of tables.
    await Deno.writeTextFile(tmpFile, `mints = ["bare-string", 42]\n`);
    const { mints } = await loadPricingConfig(tmpFile);
    assertEquals(mints, []);
    assertEquals(warns.some((m) => m.includes("not an object")), true);
  } finally {
    console.warn = origWarn;
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: mint entry with non-string url is skipped with warn", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
port = 443
`);
    const { mints } = await loadPricingConfig(tmpFile);
    assertEquals(mints, []);
    assertEquals(warns.some((m) => m.includes("non-string URL")), true);
  } finally {
    console.warn = origWarn;
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: mint entry with malformed URL is skipped with warn", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "not a valid url at all"
`);
    const { mints } = await loadPricingConfig(tmpFile);
    assertEquals(mints, []);
    assertEquals(warns.some((m) => m.includes("invalid URL")), true);
  } finally {
    console.warn = origWarn;
    await Deno.remove(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// startPriceFeedCron — smoke tests
// ---------------------------------------------------------------------------

Deno.test({ name: "startPriceFeedCron: successful tick writes JSON file", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  // Remove it so we can confirm the cron creates it
  await Deno.remove(tmpFile);

  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(100_000);
    return coinbaseResponse(100_000);
  });
  try {
    startPriceFeedCron(tmpFile);
    // Wait for the immediate tick to complete
    await new Promise((r) => setTimeout(r, 200));
    const text = await Deno.readTextFile(tmpFile);
    const data = JSON.parse(text);
    assertEquals(typeof data.btc_usd, "number");
    assertEquals(data.btc_usd, 100_000);
    assertEquals(typeof data.updated, "number");
  } finally {
    restore();
    try { await Deno.remove(tmpFile); } catch { /* may not exist */ }
  }
}});

Deno.test({ name: "startPriceFeedCron: both fetches fail → file not written, console.warn fires", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.remove(tmpFile);

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };

  const restore = stubFetch(async (_url) => {
    throw new Error("network error");
  });
  try {
    startPriceFeedCron(tmpFile);
    await new Promise((r) => setTimeout(r, 200));
    // File should not have been written
    let exists = true;
    try { await Deno.stat(tmpFile); } catch { exists = false; }
    assertEquals(exists, false);
    assertEquals(warns.some((m) => m.includes("Failed to fetch")), true);
  } finally {
    console.warn = origWarn;
    restore();
    try { await Deno.remove(tmpFile); } catch { /* may not exist */ }
  }
}});
