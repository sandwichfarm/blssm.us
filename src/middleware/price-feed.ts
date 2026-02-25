/// <reference lib="deno.ns" />
import process from "node:process";
import { parse } from "@std/toml";
import type { PricingConfig } from "../types.ts";

/** Default pricing parameters — used when config is missing or invalid */
const DEFAULT_PRICING: PricingConfig = {
  cost_per_gb_usd: 0.02,
  profit_margin_pct: 0.20,
  slippage_premium_pct: 0.05,
};

/** Bytes in one gigabyte */
const BYTES_PER_GB = 1024 ** 3;

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

/** Cached pricing config (never changes at runtime) */
let pricingCache: { mints: string[]; pricing: PricingConfig } | null = null;

/** Cached BTC/USD price */
let priceCache: { btcUsd: number; fetchedAt: number } | null = null;

/** Deduplication promise for in-flight BTC price fetches */
let priceFetchInFlight: Promise<number | null> | null = null;

/** How long before the BTC price is considered stale (5 min) */
const PRICE_STALE_MS = 300_000;

/**
 * Compute the sat price for a given file size.
 * Formula: ceil((fileSizeGb * cost_per_gb_usd * (1 + margin) * (1 + slippage)) / btcUsdPrice * 100_000_000)
 * Applies a 1-sat floor — never returns 0 for files of any size.
 *
 * @param fileSizeBytes - File size in bytes (0 or negative treated as 0 GB)
 * @param btcUsdPrice - Current BTC/USD spot price
 * @param config - Pricing parameters from operator config
 * @returns Satoshi amount (integer, minimum 1)
 */
export function computeSatPrice(
  fileSizeBytes: number,
  btcUsdPrice: number,
  config: PricingConfig,
): number {
  const fileSizeGb = Math.max(0, fileSizeBytes) / BYTES_PER_GB;
  const usdCost = fileSizeGb *
    config.cost_per_gb_usd *
    (1 + config.profit_margin_pct) *
    (1 + config.slippage_premium_pct);
  const sats = Math.ceil((usdCost / btcUsdPrice) * 100_000_000);
  return Math.max(1, sats);
}

// ---------------------------------------------------------------------------
// BTC/USD price fetching
// ---------------------------------------------------------------------------

/**
 * Fetch BTC/USD price from CoinGecko API.
 * Returns null on fetch error or unexpected response shape.
 */
async function fetchCoinGecko(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const btc = data["bitcoin"] as Record<string, unknown> | undefined;
    const price = btc?.["usd"];
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

/**
 * Fetch BTC/USD price from Coinbase API.
 * Returns null on fetch error or unexpected response shape.
 */
async function fetchCoinbase(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const amount = (data["data"] as Record<string, unknown> | undefined)?.["amount"];
    if (typeof amount !== "string") return null;
    const price = parseFloat(amount);
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

/**
 * Fetch BTC/USD price from dual sources (CoinGecko + Coinbase) concurrently.
 * - Both succeed: returns average
 * - One fails: returns the successful price
 * - Both fail: returns null
 */
export async function fetchBtcUsdPrice(): Promise<number | null> {
  const [geckoResult, coinbaseResult] = await Promise.allSettled([
    fetchCoinGecko(),
    fetchCoinbase(),
  ]);

  const gecko = geckoResult.status === "fulfilled" ? geckoResult.value : null;
  const coinbase = coinbaseResult.status === "fulfilled" ? coinbaseResult.value : null;

  if (gecko !== null && coinbase !== null) {
    return (gecko + coinbase) / 2;
  }
  if (gecko !== null) return gecko;
  if (coinbase !== null) return coinbase;
  return null;
}

// ---------------------------------------------------------------------------
// In-memory BTC price cache (replaces file-based approach)
// ---------------------------------------------------------------------------

/**
 * Set the in-memory BTC/USD price cache.
 * Called by the admin refresh-price handler after a successful fetch.
 */
export function setPriceCache(price: number): void {
  priceCache = { btcUsd: price, fetchedAt: Date.now() };
}

/**
 * Get the current BTC/USD price from the in-memory cache.
 * Priority: env var BTC_USD_PRICE → fresh in-memory cache → on-demand fetch.
 * Returns null only when all sources fail.
 */
export async function getBtcUsdPrice(): Promise<number | null> {
  // Check deploy-time / admin-refreshed env var first
  const envPrice = process.env["BTC_USD_PRICE"];
  if (envPrice) {
    const parsed = Number(envPrice);
    if (isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const now = Date.now();

  // Fresh cache — return immediately
  if (priceCache && (now - priceCache.fetchedAt) < PRICE_STALE_MS) {
    return priceCache.btcUsd;
  }

  // Stale or missing — need a fetch
  if (!priceFetchInFlight) {
    priceFetchInFlight = fetchBtcUsdPrice().then((price) => {
      priceFetchInFlight = null;
      if (price !== null) {
        priceCache = { btcUsd: price, fetchedAt: Date.now() };
      }
      return price;
    });
  }

  // If we have a stale value, return it while fetch is in-flight (don't block)
  if (priceCache) {
    return priceCache.btcUsd;
  }

  // No cache at all — must wait for the fetch
  return priceFetchInFlight;
}

/**
 * Read the BTC/USD price from a static JSON file.
 * Kept exported for backward compatibility with existing tests.
 *
 * @param pricePath - Path to the JSON file (e.g. "/tmp/btc-price.json")
 */
export async function readBtcUsdPrice(pricePath: string): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(pricePath);
    const data = JSON.parse(text) as Record<string, unknown>;
    const price = data["btc_usd"];
    return typeof price === "number" && isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pricing config loading (env vars → TOML fallback)
// ---------------------------------------------------------------------------

/**
 * Try to load pricing config from environment variables.
 * Returns null if the env vars aren't set.
 */
function loadPricingConfigFromEnv(): { mints: string[]; pricing: PricingConfig } | null {
  const mintUrlsRaw = process.env["PRICING_MINT_URLS"];
  if (!mintUrlsRaw) return null;

  // Parse mint URLs
  const mints: string[] = [];
  for (const raw of mintUrlsRaw.split(",")) {
    const url = raw.trim();
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") {
        console.warn(`[price-feed] Skipping env mint with non-HTTPS URL: "${url.substring(0, 100)}"`);
        continue;
      }
    } catch {
      console.warn(`[price-feed] Skipping env mint with invalid URL: "${url.substring(0, 100)}"`);
      continue;
    }
    mints.push(url);
  }

  // Parse pricing floats
  const costRaw = process.env["PRICING_COST_PER_GB_USD"];
  const marginRaw = process.env["PRICING_PROFIT_MARGIN_PCT"];
  const slippageRaw = process.env["PRICING_SLIPPAGE_PREMIUM_PCT"];

  const cost = costRaw ? parseFloat(costRaw) : NaN;
  const margin = marginRaw ? parseFloat(marginRaw) : NaN;
  const slippage = slippageRaw ? parseFloat(slippageRaw) : NaN;

  if (
    !isFinite(cost) || cost < 0 ||
    !isFinite(margin) || margin < 0 ||
    !isFinite(slippage) || slippage < 0
  ) {
    console.warn("[price-feed] Invalid pricing env vars — using defaults");
    return { mints, pricing: { ...DEFAULT_PRICING } };
  }

  return {
    mints,
    pricing: {
      cost_per_gb_usd: cost,
      profit_margin_pct: margin,
      slippage_premium_pct: slippage,
    },
  };
}

/**
 * Load and parse the operator pricing configuration.
 * Priority: in-memory cache → env vars → TOML file fallback.
 *
 * - Mint URLs are validated (must be HTTPS); invalid entries warn-and-skip.
 * - Pricing params are validated; if any are invalid, defaults are used.
 * - Missing file returns empty mints + default pricing.
 *
 * @param tomlPath - Path to the TOML config file (e.g. "config/payment.toml")
 * @returns Parsed mints (HTTPS URL strings) and PricingConfig
 */
export async function loadPricingConfig(
  tomlPath: string,
): Promise<{ mints: string[]; pricing: PricingConfig }> {
  // Return cached result if available
  if (pricingCache) return pricingCache;

  // Try env vars first
  const fromEnv = loadPricingConfigFromEnv();
  if (fromEnv) {
    pricingCache = fromEnv;
    return pricingCache;
  }

  // Fall back to TOML file
  let raw: unknown;

  try {
    const text = await Deno.readTextFile(tomlPath);
    raw = parse(text);
  } catch {
    // Missing or unreadable file — return safe defaults
    const result = { mints: [] as string[], pricing: { ...DEFAULT_PRICING } };
    pricingCache = result;
    return result;
  }

  if (!raw || typeof raw !== "object") {
    const result = { mints: [] as string[], pricing: { ...DEFAULT_PRICING } };
    pricingCache = result;
    return result;
  }

  const r = raw as Record<string, unknown>;

  // Parse mints — [[mints]] parses as an array of objects with a url field
  const mints: string[] = [];
  const rawMints = r["mints"];
  if (Array.isArray(rawMints)) {
    for (const entry of rawMints) {
      if (!entry || typeof entry !== "object") {
        console.warn(`[price-feed] Skipping mint entry that is not an object: ${JSON.stringify(entry)}`);
        continue;
      }
      const e = entry as Record<string, unknown>;
      const url = e["url"];
      if (typeof url !== "string") {
        console.warn(`[price-feed] Skipping mint entry with missing or non-string URL`);
        continue;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          console.warn(`[price-feed] Skipping mint with non-HTTPS URL: "${url.substring(0, 100)}"`);
          continue;
        }
      } catch {
        console.warn(`[price-feed] Skipping mint with invalid URL: "${url.substring(0, 100)}"`);
        continue;
      }
      mints.push(url);
    }
  }

  // Parse pricing section
  const rawPricing = r["pricing"];
  const pricing = parsePricingSection(rawPricing);

  const result = { mints, pricing };
  pricingCache = result;
  return result;
}

/**
 * Parse and validate a pricing section from parsed TOML.
 * Returns DEFAULT_PRICING if section is missing or any value is invalid.
 */
function parsePricingSection(raw: unknown): PricingConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PRICING };
  }
  const p = raw as Record<string, unknown>;

  const costPerGb = p["cost_per_gb_usd"];
  const margin = p["profit_margin_pct"];
  const slippage = p["slippage_premium_pct"];

  if (
    typeof costPerGb !== "number" || !isFinite(costPerGb) || costPerGb < 0 ||
    typeof margin !== "number" || !isFinite(margin) || margin < 0 ||
    typeof slippage !== "number" || !isFinite(slippage) || slippage < 0
  ) {
    console.warn("[price-feed] Invalid pricing config — using defaults");
    return { ...DEFAULT_PRICING };
  }

  return {
    cost_per_gb_usd: costPerGb,
    profit_margin_pct: margin,
    slippage_premium_pct: slippage,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all caches — for test isolation only */
export function _resetPriceCacheForTesting(): void {
  priceCache = null;
  priceFetchInFlight = null;
  pricingCache = null;
}
