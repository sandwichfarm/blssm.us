/// <reference lib="deno.ns" />
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import {
  computeSatPrice,
  fetchBtcUsdPrice,
  getBtcUsdPrice,
  loadPricingConfig,
  readBtcUsdPrice,
  startPriceFeedCron,
  _resetPriceCacheForTesting,
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
  const result = computeSatPrice(bytes, 50_000, STANDARD_CONFIG);
  assertEquals(result, 504);
});

Deno.test("computeSatPrice: BTC price of $1 returns very high sat amount without overflow", () => {
  const bytes = 1024 ** 3; // 1 GB
  const result = computeSatPrice(bytes, 1, STANDARD_CONFIG);
  assertEquals(result, 2_520_000);
  assertEquals(Number.isSafeInteger(result), true);
});

Deno.test("computeSatPrice: negative byte size treated as 0 (returns 1 sat floor)", () => {
  const result = computeSatPrice(-1000, 100_000, STANDARD_CONFIG);
  assertEquals(result, 1);
});

// ---------------------------------------------------------------------------
// loadPricingConfig tests (TOML path)
// ---------------------------------------------------------------------------

Deno.test("loadPricingConfig: valid TOML with mints and pricing loads correctly", async () => {
  _resetPriceCacheForTesting();
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
  _resetPriceCacheForTesting();
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
  _resetPriceCacheForTesting();
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"
`);
    const { mints, pricing } = await loadPricingConfig(tmpFile);
    assertEquals(mints, ["https://mint.minibits.cash/Bitcoin"]);
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
    assertAlmostEquals(pricing.profit_margin_pct, 0.20);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: non-existent path returns defaults with empty mints", async () => {
  _resetPriceCacheForTesting();
  const { mints, pricing } = await loadPricingConfig("/non/existent/path.toml");
  assertEquals(mints, []);
  assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
  assertAlmostEquals(pricing.profit_margin_pct, 0.20);
  assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
});

Deno.test("loadPricingConfig: invalid pricing values (negative) use defaults", async () => {
  _resetPriceCacheForTesting();
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
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
    assertAlmostEquals(pricing.profit_margin_pct, 0.20);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("loadPricingConfig: caches result across calls", async () => {
  _resetPriceCacheForTesting();
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  try {
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"

[pricing]
cost_per_gb_usd = 0.03
profit_margin_pct = 0.25
slippage_premium_pct = 0.08
`);
    const first = await loadPricingConfig(tmpFile);
    // Modify the file — should NOT affect the second call (cached)
    await Deno.writeTextFile(tmpFile, `
[[mints]]
url = "https://different-mint.example.com"

[pricing]
cost_per_gb_usd = 0.99
profit_margin_pct = 0.99
slippage_premium_pct = 0.99
`);
    const second = await loadPricingConfig(tmpFile);
    assertEquals(first, second);
    assertAlmostEquals(second.pricing.cost_per_gb_usd, 0.03);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// ---------------------------------------------------------------------------
// loadPricingConfig — env var path
// ---------------------------------------------------------------------------

Deno.test("loadPricingConfig: loads from env vars when PRICING_MINT_URLS is set", async () => {
  _resetPriceCacheForTesting();
  const origEnv = {
    PRICING_MINT_URLS: Deno.env.get("PRICING_MINT_URLS"),
    PRICING_COST_PER_GB_USD: Deno.env.get("PRICING_COST_PER_GB_USD"),
    PRICING_PROFIT_MARGIN_PCT: Deno.env.get("PRICING_PROFIT_MARGIN_PCT"),
    PRICING_SLIPPAGE_PREMIUM_PCT: Deno.env.get("PRICING_SLIPPAGE_PREMIUM_PCT"),
  };

  try {
    Deno.env.set("PRICING_MINT_URLS", "https://mint.a.com,https://mint.b.com");
    Deno.env.set("PRICING_COST_PER_GB_USD", "0.04");
    Deno.env.set("PRICING_PROFIT_MARGIN_PCT", "0.15");
    Deno.env.set("PRICING_SLIPPAGE_PREMIUM_PCT", "0.03");

    const { mints, pricing } = await loadPricingConfig("/non/existent/path.toml");
    assertEquals(mints, ["https://mint.a.com", "https://mint.b.com"]);
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.04);
    assertAlmostEquals(pricing.profit_margin_pct, 0.15);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.03);
  } finally {
    // Restore original env
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) Deno.env.delete(key);
      else Deno.env.set(key, val);
    }
  }
});

Deno.test("loadPricingConfig: env vars with invalid pricing uses defaults for pricing", async () => {
  _resetPriceCacheForTesting();
  const origEnv = {
    PRICING_MINT_URLS: Deno.env.get("PRICING_MINT_URLS"),
    PRICING_COST_PER_GB_USD: Deno.env.get("PRICING_COST_PER_GB_USD"),
    PRICING_PROFIT_MARGIN_PCT: Deno.env.get("PRICING_PROFIT_MARGIN_PCT"),
    PRICING_SLIPPAGE_PREMIUM_PCT: Deno.env.get("PRICING_SLIPPAGE_PREMIUM_PCT"),
  };

  try {
    Deno.env.set("PRICING_MINT_URLS", "https://mint.a.com");
    Deno.env.set("PRICING_COST_PER_GB_USD", "not-a-number");
    Deno.env.set("PRICING_PROFIT_MARGIN_PCT", "0.15");
    Deno.env.set("PRICING_SLIPPAGE_PREMIUM_PCT", "0.03");

    const { mints, pricing } = await loadPricingConfig("/non/existent/path.toml");
    assertEquals(mints, ["https://mint.a.com"]);
    // Invalid cost → defaults used
    assertAlmostEquals(pricing.cost_per_gb_usd, 0.02);
    assertAlmostEquals(pricing.profit_margin_pct, 0.20);
    assertAlmostEquals(pricing.slippage_premium_pct, 0.05);
  } finally {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) Deno.env.delete(key);
      else Deno.env.set(key, val);
    }
  }
});

Deno.test("loadPricingConfig: env vars skip non-HTTPS mint URLs", async () => {
  _resetPriceCacheForTesting();
  const origVal = Deno.env.get("PRICING_MINT_URLS");
  const origCost = Deno.env.get("PRICING_COST_PER_GB_USD");
  const origMargin = Deno.env.get("PRICING_PROFIT_MARGIN_PCT");
  const origSlippage = Deno.env.get("PRICING_SLIPPAGE_PREMIUM_PCT");

  try {
    Deno.env.set("PRICING_MINT_URLS", "http://insecure.com,https://secure.com");
    Deno.env.set("PRICING_COST_PER_GB_USD", "0.02");
    Deno.env.set("PRICING_PROFIT_MARGIN_PCT", "0.20");
    Deno.env.set("PRICING_SLIPPAGE_PREMIUM_PCT", "0.05");

    const { mints } = await loadPricingConfig("/non/existent/path.toml");
    assertEquals(mints, ["https://secure.com"]);
  } finally {
    if (origVal === undefined) Deno.env.delete("PRICING_MINT_URLS");
    else Deno.env.set("PRICING_MINT_URLS", origVal);
    if (origCost === undefined) Deno.env.delete("PRICING_COST_PER_GB_USD");
    else Deno.env.set("PRICING_COST_PER_GB_USD", origCost);
    if (origMargin === undefined) Deno.env.delete("PRICING_PROFIT_MARGIN_PCT");
    else Deno.env.set("PRICING_PROFIT_MARGIN_PCT", origMargin);
    if (origSlippage === undefined) Deno.env.delete("PRICING_SLIPPAGE_PREMIUM_PCT");
    else Deno.env.set("PRICING_SLIPPAGE_PREMIUM_PCT", origSlippage);
  }
});

// ---------------------------------------------------------------------------
// loadPricingConfig — uncovered internal branches (TOML path)
// ---------------------------------------------------------------------------

Deno.test("loadPricingConfig: mint entry that is not an object is skipped with warn", async () => {
  _resetPriceCacheForTesting();
  const tmpFile = await Deno.makeTempFile({ suffix: ".toml" });
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
  try {
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
  _resetPriceCacheForTesting();
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
  _resetPriceCacheForTesting();
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
// readBtcUsdPrice tests (legacy file-based — kept for backward compat)
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
// getBtcUsdPrice tests (in-memory cache)
// ---------------------------------------------------------------------------

Deno.test("getBtcUsdPrice: returns fetched price and caches it", async () => {
  _resetPriceCacheForTesting();
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(100_000);
    return coinbaseResponse(100_000);
  });
  try {
    const price = await getBtcUsdPrice();
    assertEquals(price, 100_000);

    // Second call should return cached value (even if fetch would fail)
    const restore2 = stubFetch(async () => { throw new Error("should not fetch"); });
    try {
      const cached = await getBtcUsdPrice();
      assertEquals(cached, 100_000);
    } finally {
      restore2();
    }
  } finally {
    restore();
  }
});

Deno.test("getBtcUsdPrice: returns null when no cache and fetch fails", async () => {
  _resetPriceCacheForTesting();
  const restore = stubFetch(async () => { throw new Error("network error"); });
  try {
    const price = await getBtcUsdPrice();
    assertEquals(price, null);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// startPriceFeedCron — smoke tests (in-memory)
// ---------------------------------------------------------------------------

Deno.test({ name: "startPriceFeedCron: successful tick primes in-memory cache", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  _resetPriceCacheForTesting();
  const restore = stubFetch(async (url) => {
    if (url.includes("coingecko")) return geckoResponse(100_000);
    return coinbaseResponse(100_000);
  });
  try {
    startPriceFeedCron();
    // Wait for the immediate tick to complete
    await new Promise((r) => setTimeout(r, 200));
    // getBtcUsdPrice should return cached value without fetching
    const restore2 = stubFetch(async () => { throw new Error("should not fetch again"); });
    try {
      const price = await getBtcUsdPrice();
      assertEquals(price, 100_000);
    } finally {
      restore2();
    }
  } finally {
    restore();
  }
}});

Deno.test({ name: "startPriceFeedCron: both fetches fail → console.warn fires, cache stays null", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  _resetPriceCacheForTesting();
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };

  const restore = stubFetch(async (_url) => {
    throw new Error("network error");
  });
  try {
    startPriceFeedCron();
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(warns.some((m) => m.includes("Failed to fetch")), true);
  } finally {
    console.warn = origWarn;
    restore();
  }
}});
