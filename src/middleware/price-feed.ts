/// <reference lib="deno.ns" />
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

/**
 * Read the BTC/USD price from the static JSON file written by startPriceFeedCron.
 * Returns null if the file is missing, unreadable, or contains invalid JSON/data.
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

/**
 * Start a price feed cron that fetches BTC/USD every 5 minutes and writes to pricePath.
 * Runs immediately on startup, then every 300 seconds via setInterval.
 * Written format: { btc_usd: number, updated: number }
 *
 * NOTE: This function is intentionally called at server startup in Phase 7.
 * It is NOT wired in this plan — exported for use by the Phase 7 wiring plan.
 *
 * @param pricePath - Path to write the JSON price file (e.g. "/tmp/btc-price.json")
 */
export function startPriceFeedCron(pricePath: string): void {
  const tick = async () => {
    const price = await fetchBtcUsdPrice();
    if (price !== null) {
      try {
        await Deno.writeTextFile(
          pricePath,
          JSON.stringify({ btc_usd: price, updated: Date.now() }),
        );
      } catch (err) {
        console.warn(`[price-feed] Failed to write price file: ${String(err)}`);
      }
    } else {
      console.warn("[price-feed] Failed to fetch BTC/USD price from all sources");
    }
  };

  // Immediate first run
  tick();
  // Then every 5 minutes
  setInterval(tick, 300_000);
}

/**
 * Load and parse the operator pricing configuration from a TOML file.
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
  let raw: unknown;

  try {
    const text = await Deno.readTextFile(tomlPath);
    raw = parse(text);
  } catch {
    // Missing or unreadable file — return safe defaults
    return { mints: [], pricing: { ...DEFAULT_PRICING } };
  }

  if (!raw || typeof raw !== "object") {
    return { mints: [], pricing: { ...DEFAULT_PRICING } };
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

  return { mints, pricing };
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
