import type { CacheConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";

// 60 seconds — backward-compatible default matching current hardcoded behavior in access.ts and metadata.ts
const DEFAULT_CACHE_TTL_MS = 60_000;

// 1 second minimum — TTL=0 in JSON maps here to avoid hammering Bunny Storage on burst traffic
const TTL_FLOOR_MS = 1_000;

// 24 hours maximum — reasonable cap to prevent accidental stale-forever configs
const TTL_CAP_MS = 86_400_000;

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  accessTtl: DEFAULT_CACHE_TTL_MS,
  paymentTtl: DEFAULT_CACHE_TTL_MS,
  blockedTtl: DEFAULT_CACHE_TTL_MS,
};

interface CacheConfigCache {
  config: CacheConfig;
  expires: number;
}

let cacheConfigCache: CacheConfigCache | null = null;

/** Reset the module-level cache — for use in tests only */
export function _resetCacheCacheForTesting(): void {
  cacheConfigCache = null;
}

/**
 * Convert a raw TTL value from JSON (seconds) to internal milliseconds with floor/cap clamping.
 * Non-finite or non-number values return the 60s default.
 * TTL=0 in JSON → 0ms → clamped to 1000ms (TTL_FLOOR_MS).
 */
function clampTtl(raw: unknown): number {
  if (typeof raw !== "number" || !isFinite(raw)) return DEFAULT_CACHE_TTL_MS;
  const ms = Math.round(raw) * 1_000;
  return Math.min(Math.max(ms, TTL_FLOOR_MS), TTL_CAP_MS);
}

/**
 * Normalize raw JSON into a valid CacheConfig.
 * JSON values are in seconds; internal values are in milliseconds.
 * Handles null (missing file), non-object, and partial inputs with 60s defaults.
 */
export function normalizeCacheConfig(raw: unknown): CacheConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CACHE_CONFIG };
  }
  const r = raw as Record<string, unknown>;
  return {
    accessTtl: "accessTtl" in r ? clampTtl(r.accessTtl) : DEFAULT_CACHE_TTL_MS,
    paymentTtl: "paymentTtl" in r ? clampTtl(r.paymentTtl) : DEFAULT_CACHE_TTL_MS,
    blockedTtl: "blockedTtl" in r ? clampTtl(r.blockedTtl) : DEFAULT_CACHE_TTL_MS,
  };
}

/**
 * Load and cache the cache config from config/cache.json — 60s TTL.
 * The meta-cache TTL is hardcoded (not configurable by the cache config it loads).
 * Returns the CacheConfig directly (not the wrapper) for downstream consumption.
 */
export async function loadCacheConfig(storage: StorageClient): Promise<CacheConfig> {
  const now = Date.now();
  if (cacheConfigCache && now < cacheConfigCache.expires) {
    return cacheConfigCache.config;
  }
  const raw = await storage.getJson<unknown>("config/cache.json");
  const config = normalizeCacheConfig(raw);
  cacheConfigCache = {
    config,
    expires: now + DEFAULT_CACHE_TTL_MS,
  };
  return config;
}
