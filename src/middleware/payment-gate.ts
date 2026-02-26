/// <reference lib="deno.ns" />
import type { StorageClient } from "../storage/client.ts";
import type { LightningConfig, ValidationResult } from "../types.ts";
import { loadPaymentConfig, paymentsEnabled } from "./payment-config.ts";
import { loadCacheConfig } from "./cache-config.ts";
import { loadPricingConfig, getBtcUsdPrice, computeSatPrice } from "./price-feed.ts";
import { buildPaymentRequired } from "./payments.ts";
import { validateCashuPayment, buildPaymentError } from "./proof-validator.ts";
import {
  loadLightningConfig,
  createInvoice,
  validateLightningPayment,
} from "./lightning-validator.ts";

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
    storage?: StorageClient,
  ) => Promise<ValidationResult>;
  /** Override for getBtcUsdPrice (allows test injection) */
  getBtcPrice?: () => Promise<number | null>;
  /** Override for validateLightningPayment (allows test injection) */
  validateLightning?: (
    preimage: string,
    requiredSats: number,
    config: LightningConfig,
  ) => Promise<ValidationResult>;
  /** Override for createInvoice (allows test injection) */
  createLnInvoice?: (
    amountSats: number,
    config: LightningConfig,
  ) => Promise<string | null>;
  /** Override for loadLightningConfig (allows test injection) */
  loadLnConfig?: () => LightningConfig | null;
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
  const validateLn = deps?.validateLightning ?? validateLightningPayment;
  const createLn = deps?.createLnInvoice ?? createInvoice;
  const getLnConfig = deps?.loadLnConfig ?? loadLightningConfig;

  // Step 1: Load cache config for operator-configured TTL values
  const cacheConfig = await loadCacheConfig(storage);

  // Step 2: Load payment config
  const { config } = await loadPaymentConfig(storage, cacheConfig.paymentTtl);

  // Step 3: Load lightning config (null if not configured) — needed for paymentsEnabled check
  const lnConfig = getLnConfig();

  // Step 4: Check if payments are enabled — if not, pass through
  if (!paymentsEnabled(config, lnConfig)) {
    return null;
  }

  // Step 5: Load pricing config (env vars → TOML fallback)
  const { pricing } = await loadPricingConfig(pricingTomlPath);

  // Step 6: Read BTC/USD price from in-memory cache
  const btcUsd = await getPrice();

  // Step 7: Fail closed if price unavailable — reject with 503 (never allow free uploads due to feed outage)
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

  // Step 8: Extract payment headers (unchanged)
  const cashuToken = request.headers.get("X-Cashu");
  const lightningPreimage = request.headers.get("X-Lightning");

  const mintList = config.mints.map((m) => m.url);
  const requiredSats = computeSatPrice(fileSizeBytes, btcUsd, pricing);

  // Step 9: X-Lightning preimage provided — validate Lightning payment
  if (lightningPreimage) {
    if (!lnConfig) {
      return new Response(null, {
        status: 400,
        headers: {
          "X-Reason": "lightning_not_supported",
          "Cache-Control": "no-store",
        },
      });
    }
    const lnResult = await validateLn(lightningPreimage, requiredSats, lnConfig);
    if (!lnResult.valid) {
      return buildPaymentError(lnResult);
    }
    return null;
  }

  // Step 10: X-Cashu token provided — validate Cashu payment (existing path)
  if (cashuToken) {
    const result = await validate(cashuToken, mintList, requiredSats, storage);
    if (!result.valid) {
      return buildPaymentError(result);
    }
    return null;
  }

  // Step 11: No payment header — return 402 Payment Required
  // Attempt to create Lightning invoice (graceful — Cashu-only if LND unreachable)
  let bolt11: string | undefined;
  if (lnConfig) {
    bolt11 = (await createLn(requiredSats, lnConfig)) ?? undefined;
  }
  return buildPaymentRequired(fileSizeBytes, mintList, btcUsd, pricing, bolt11);
}
