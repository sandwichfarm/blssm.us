/// <reference lib="deno.ns" />
import type { StorageClient } from "../storage/client.ts";
import type { ValidationResult } from "../types.ts";
import { loadPaymentConfig, paymentsEnabled } from "./payment-config.ts";
import { loadCacheConfig } from "./cache-config.ts";
import { loadPricingConfig, getBtcUsdPrice, computeSatPrice } from "./price-feed.ts";
import { buildPaymentRequired } from "./payments.ts";
import { validateCashuPayment, buildPaymentError } from "./proof-validator.ts";

/** Hardcoded path to the operator pricing TOML (same pattern as PAYMENT_CACHE_TTL_MS in payment-config.ts) */
const PRICING_TOML_PATH = "config/payment.toml";

/**
 * Optional dependency injection for testing.
 * Allows tests to override file paths and the validate function
 * without needing module-level mocking.
 */
export interface PaymentGateDeps {
  /** Override for the pricing TOML path (default: PRICING_TOML_PATH) */
  pricingTomlPath?: string;
  /** Override for validateCashuPayment (allows test injection) */
  validatePayment?: (
    token: string,
    mints: string[],
    requiredSats: number,
  ) => Promise<ValidationResult>;
  /** Override for getBtcUsdPrice (allows test injection) */
  getBtcPrice?: () => Promise<number | null>;
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
  const pricingTomlPath = deps?.pricingTomlPath ?? PRICING_TOML_PATH;
  const validate = deps?.validatePayment ?? validateCashuPayment;
  const getPrice = deps?.getBtcPrice ?? getBtcUsdPrice;

  // Step 1: Load cache config for operator-configured TTL values
  const cacheConfig = await loadCacheConfig(storage);

  // Step 2: Load payment config
  const { config } = await loadPaymentConfig(storage, cacheConfig.paymentTtl);

  // Step 3: Check if payments are enabled — if not, pass through
  if (!paymentsEnabled(config)) {
    return null;
  }

  // Step 4: Load pricing config (env vars → TOML fallback)
  const { pricing } = await loadPricingConfig(pricingTomlPath);

  // Step 5: Read BTC/USD price from in-memory cache
  const btcUsd = await getPrice();

  // Step 6: Fail closed if price unavailable — reject with 503 (never allow free uploads due to feed outage)
  if (btcUsd === null) {
    console.warn("[payment-gate] BTC price unavailable — failing closed (503)");
    return new Response(null, {
      status: 503,
      headers: {
        "X-Reason": "price_unavailable",
        "Retry-After": "30",
        "Cache-Control": "no-store",
      },
    });
  }

  // Step 7: Extract X-Cashu header from request
  const cashuToken = request.headers.get("X-Cashu");

  // Step 8: No proof provided — return 402 Payment Required
  if (!cashuToken) {
    const mintList = config.mints.map((m) => m.url);
    return buildPaymentRequired(fileSizeBytes, mintList, btcUsd, pricing);
  }

  // Step 9: Validate Cashu proof
  const mintList = config.mints.map((m) => m.url);
  const requiredSats = computeSatPrice(fileSizeBytes, btcUsd, pricing);
  const result = await validate(cashuToken, mintList, requiredSats);

  // Step 10: Invalid proof — return error response (400 or 503)
  if (!result.valid) {
    return buildPaymentError(result);
  }

  // Step 11: Valid proof — allow through
  return null;
}
