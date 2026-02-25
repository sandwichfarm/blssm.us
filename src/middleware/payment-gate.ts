/// <reference lib="deno.ns" />
import type { StorageClient } from "../storage/client.ts";
import type { ValidationResult } from "../types.ts";
import { loadPaymentConfig, paymentsEnabled } from "./payment-config.ts";
import { loadCacheConfig } from "./cache-config.ts";
import { loadPricingConfig, readBtcUsdPrice, computeSatPrice } from "./price-feed.ts";
import { buildPaymentRequired } from "./payments.ts";
import { validateCashuPayment, buildPaymentError } from "./proof-validator.ts";

/** Hardcoded path to the operator pricing TOML (same pattern as PAYMENT_CACHE_TTL_MS in payment-config.ts) */
const PRICING_TOML_PATH = "config/payment.toml";

/** Hardcoded path where startPriceFeedCron writes the BTC/USD price */
const PRICE_PATH = "/tmp/btc-price.json";

/**
 * Optional dependency injection for testing.
 * Allows tests to override file paths and the validate function
 * without needing module-level mocking.
 */
export interface PaymentGateDeps {
  /** Override for the BTC price file path (default: PRICE_PATH) */
  pricePath?: string;
  /** Override for the pricing TOML path (default: PRICING_TOML_PATH) */
  pricingTomlPath?: string;
  /** Override for validateCashuPayment (allows test injection) */
  validatePayment?: (
    token: string,
    mints: string[],
    requiredSats: number,
  ) => Promise<ValidationResult>;
}

/**
 * Shared payment gate for all write handlers.
 * Modeled after checkAccess() in access.ts — self-contained, returns Response | null.
 *
 * Returns null = payment accepted (or payments disabled), handler may proceed.
 * Returns Response = 402 (no proof), 400 (bad proof), 503 (mint unreachable).
 *
 * @param request - Incoming HTTP request (reads X-Cashu header)
 * @param storage - StorageClient to load payment config via loadPaymentConfig()
 * @param fileSizeBytes - File size in bytes (used to compute sat price for 402 responses)
 * @param deps - Optional dependency overrides (for testing)
 */
export async function paymentGate(
  request: Request,
  storage: StorageClient,
  fileSizeBytes: number,
  deps?: PaymentGateDeps,
): Promise<Response | null> {
  const pricePath = deps?.pricePath ?? PRICE_PATH;
  const pricingTomlPath = deps?.pricingTomlPath ?? PRICING_TOML_PATH;
  const validate = deps?.validatePayment ?? validateCashuPayment;

  // Step 1: Load cache config for operator-configured TTL values
  const cacheConfig = await loadCacheConfig(storage);

  // Step 2: Load payment config
  const { config } = await loadPaymentConfig(storage, cacheConfig.paymentTtl);

  // Step 3: Check if payments are enabled — if not, pass through
  if (!paymentsEnabled(config)) {
    return null;
  }

  // Step 4: Load pricing config (TOML — defaults used on missing/invalid file)
  const { pricing } = await loadPricingConfig(pricingTomlPath);

  // Step 4: Read BTC/USD price from cron-written file
  const btcUsd = await readBtcUsdPrice(pricePath);

  // Step 5: Fail open if price unavailable (startup race — mint still validates cryptographically)
  if (btcUsd === null) {
    return null;
  }

  // Step 6: Extract X-Cashu header from request
  const cashuToken = request.headers.get("X-Cashu");

  // Step 7: No proof provided — return 402 Payment Required
  if (!cashuToken) {
    const mintList = config.mints.map((m) => m.url);
    return buildPaymentRequired(fileSizeBytes, mintList, btcUsd, pricing);
  }

  // Step 8: Validate Cashu proof
  const mintList = config.mints.map((m) => m.url);
  const requiredSats = computeSatPrice(fileSizeBytes, btcUsd, pricing);
  const result = await validate(cashuToken, mintList, requiredSats);

  // Step 9: Invalid proof — return error response (400 or 503)
  if (!result.valid) {
    return buildPaymentError(result);
  }

  // Step 10: Valid proof — allow through
  return null;
}
