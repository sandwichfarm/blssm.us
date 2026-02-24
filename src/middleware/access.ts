import type { AccessConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { isValidPubkey } from "../util.ts";

// 60-second propagation window — config changes may take up to 60s to reflect
// across running instances. Matches BLOCKED_CACHE_TTL_MS in storage/metadata.ts.
const ACCESS_CACHE_TTL_MS = 60_000;

interface AccessCache {
  config: AccessConfig;
  whitelist: Set<string>; // Pre-built for O(1) lookup in Phase 2
  blacklist: Set<string>; // Pre-built for O(1) lookup in Phase 2
  expires: number;
}

let accessCache: AccessCache | null = null;

const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  public: true,
  whitelist: [],
  blacklist: [],
};

/** Filter raw pubkey list — skip and warn on non-hex-64 entries (CFG-06) */
function filterPubkeys(list: unknown, fieldName: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry: unknown) => {
    if (typeof entry !== "string" || !isValidPubkey(entry)) {
      console.warn(
        `[access] Skipping invalid pubkey in config.${fieldName}: "${String(entry).substring(0, 30)}"`,
      );
      return false;
    }
    return true;
  });
}

/** Normalize raw JSON into a valid AccessConfig — handles null (CFG-07) and invalid entries (CFG-06) */
function normalizeAccessConfig(raw: unknown): AccessConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ACCESS_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    public: typeof r.public === "boolean" ? r.public : true,
    whitelist: filterPubkeys(r.whitelist, "whitelist"),
    blacklist: filterPubkeys(r.blacklist, "blacklist"),
  };
}

/** Load and cache access config — 60s TTL, same pattern as isBlocked() (CFG-01, CFG-02) */
export async function loadAccessConfig(storage: StorageClient): Promise<AccessCache> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) {
    return accessCache;
  }
  // Missing file → null → normalizeAccessConfig returns defaults (CFG-07)
  const raw = await storage.getJson<unknown>("config/access.json");
  const config = normalizeAccessConfig(raw);
  accessCache = {
    config,
    whitelist: new Set(config.whitelist),
    blacklist: new Set(config.blacklist),
    expires: now + ACCESS_CACHE_TTL_MS,
  };
  return accessCache;
}
