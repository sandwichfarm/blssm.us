import type { LightningConfig, MintEntry, PaymentAmounts, PaymentConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";

// Hardcoded 60s TTL for the payment config cache.
// Phase 5 will replace this with CacheConfig.paymentTtl once cache config wiring is complete.
const PAYMENT_CACHE_TTL_MS = 60_000;

const DEFAULT_PAYMENT_AMOUNTS: PaymentAmounts = { upload: 0, mirror: 0 };

const DEFAULT_PAYMENT_CONFIG: PaymentConfig = {
  mints: [],
  amounts: { upload: 0, mirror: 0 },
};

interface PaymentCache {
  config: PaymentConfig;
  expires: number;
}

let paymentCache: PaymentCache | null = null;

/** Reset the module-level cache — for use in tests only */
export function _resetPaymentCacheForTesting(): void {
  paymentCache = null;
}

/**
 * Validate a mint URL — format check only, NO network probing.
 * Must be a string containing a valid HTTPS URL.
 */
function isValidMintUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Normalize raw mint list — skip non-objects and entries with invalid URLs.
 * Valid entries are preserved; invalid entries warn and are skipped (PAY-01).
 */
function normalizeMints(raw: unknown): MintEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: MintEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      console.warn(`[payment] Skipping mint entry that is not an object: ${JSON.stringify(entry)}`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isValidMintUrl(e.url)) {
      console.warn(`[payment] Skipping mint with invalid URL: "${String(e.url).substring(0, 100)}"`);
      continue;
    }
    result.push({ url: e.url as string });
  }
  return result;
}

/**
 * Normalize raw amounts object.
 * If any present amount is invalid (non-number, non-integer, negative),
 * returns null to signal that the entire payment config should be disabled (PAY-03).
 * Missing amounts default to 0.
 */
function normalizeAmounts(raw: unknown): PaymentAmounts | null {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYMENT_AMOUNTS };
  const r = raw as Record<string, unknown>;

  let upload = 0;
  let mirror = 0;

  if ("upload" in r) {
    const v = r.upload;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      console.warn(`[payment] Invalid upload amount: ${JSON.stringify(v)} — disabling payments`);
      return null;
    }
    upload = v;
  }

  if ("mirror" in r) {
    const v = r.mirror;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      console.warn(`[payment] Invalid mirror amount: ${JSON.stringify(v)} — disabling payments`);
      return null;
    }
    mirror = v;
  }

  return { upload, mirror };
}

/**
 * Try to load payment config from environment variables.
 * Returns null if neither PRICING_MINT_URLS nor LND_REST_URL is set.
 */
function loadPaymentConfigFromEnv(): PaymentConfig | null {
  const mintUrlsRaw = process.env["PRICING_MINT_URLS"];
  const hasLnd = !!process.env["LND_REST_URL"];
  if (!mintUrlsRaw && !hasLnd) return null;

  // Parse mint URLs — reuse normalizeMints via object wrapper
  const mintEntries: unknown[] = [];
  if (mintUrlsRaw) {
    for (const raw of mintUrlsRaw.split(",")) {
      const url = raw.trim();
      if (url) mintEntries.push({ url });
    }
  }
  const mints = normalizeMints(mintEntries);

  // Parse amounts from env
  const uploadRaw = process.env["PAYMENT_UPLOAD_AMOUNT"];
  const mirrorRaw = process.env["PAYMENT_MIRROR_AMOUNT"];

  const upload = uploadRaw ? parseInt(uploadRaw, 10) : 0;
  const mirror = mirrorRaw ? parseInt(mirrorRaw, 10) : 0;

  // Validate amounts through the same path
  const amounts = normalizeAmounts({ upload, mirror });
  if (amounts === null) {
    return { ...DEFAULT_PAYMENT_CONFIG };
  }

  return { mints, amounts };
}

/**
 * Normalize raw JSON into a valid PaymentConfig.
 * Handles null (missing file), non-object, and partial/malformed inputs with safe defaults.
 * Invalid amounts disable the entire config; invalid mint entries are skipped individually.
 */
export function normalizePaymentConfig(raw: unknown): PaymentConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYMENT_CONFIG };
  const r = raw as Record<string, unknown>;

  const amounts = normalizeAmounts(r.amounts);
  if (amounts === null) {
    // Invalid amounts → disable payments entirely (PAY-03)
    return { ...DEFAULT_PAYMENT_CONFIG };
  }

  const mints = normalizeMints(r.mints);
  return { mints, amounts };
}

/**
 * Returns true if payments are enabled for this config.
 * Payments are enabled when at least one payment method is configured:
 * Cashu mints, Lightning (LND), or both.
 */
export function paymentsEnabled(config: PaymentConfig, lnConfig?: LightningConfig | null): boolean {
  return config.mints.length > 0 || lnConfig != null;
}

/**
 * Load and cache payment config — env vars → storage fallback → defaults. 60s TTL by default.
 */
export async function loadPaymentConfig(
  storage: StorageClient,
  ttlMs: number = PAYMENT_CACHE_TTL_MS,
): Promise<PaymentCache> {
  const now = Date.now();
  if (paymentCache && now < paymentCache.expires) {
    return paymentCache;
  }

  // Try env vars first
  const fromEnv = loadPaymentConfigFromEnv();
  const config = fromEnv ?? normalizePaymentConfig(
    await storage.getJson<unknown>("config/payment.json"),
  );

  paymentCache = {
    config,
    expires: now + ttlMs,
  };
  return paymentCache;
}
