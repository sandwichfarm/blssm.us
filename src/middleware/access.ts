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

/** Reset the module-level cache — for use in tests only */
export function _resetAccessCacheForTesting(): void {
  accessCache = null;
}

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

/**
 * Access check result — discriminated union consumed by gated write handlers.
 *
 * Decision matrix (v1):
 *   Mode     | Pubkey state        | Decision  | Req
 *   ---------|---------------------|-----------|------
 *   public   | blacklisted         | DENY 403  | ACL-02
 *   public   | whitelisted         | ALLOW     | ACL-01, ACL-03 (whitelist is a no-op: allow via "not blacklisted")
 *   public   | neither             | ALLOW     | ACL-01
 *   private  | whitelisted         | ALLOW     | ACL-04
 *   private  | not whitelisted     | DENY 403  | ACL-05
 *   private  | blacklisted only    | DENY 403  | ACL-05 (blacklist irrelevant: denied by "not whitelisted")
 *
 * NOTE: `requiresPayment` is RESERVED for v2 payment composition.
 * It MUST NOT be set in any v1 return path. Handlers always return 403 on denied.
 */
export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresPayment?: true };

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

/**
 * Core access control decision function — ACL-07: signature takes (storage, pubkey) only.
 * Callers MUST invoke this BEFORE reading the request body (request.arrayBuffer()).
 *
 * @param storage - StorageClient used to load access config via loadAccessConfig()
 * @param pubkey - hex-64 pubkey to evaluate; obtained from validateAuth() result
 * @returns AccessResult — { allowed: true } or { allowed: false, reason }
 */
export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage);

  if (cache.config.public) {
    // Public mode (ACL-01, ACL-02, ACL-03):
    // - Blacklist bans unconditionally (ACL-02)
    // - Whitelist has NO effect in v1 — do NOT add a whitelist fast-path here (ACL-03)
    // - Everyone else is allowed (ACL-01)
    if (cache.blacklist.has(pubkey)) {
      return { allowed: false, reason: "pubkey is blacklisted" }; // ACL-02
    }
    return { allowed: true }; // ACL-01
  }

  // Private mode (ACL-04, ACL-05, ACL-06):
  // - Whitelist is the ONLY path to allowed (ACL-04)
  // - Blacklist is IGNORED — do NOT add a blacklist check here (ACL-06)
  // - Non-whitelisted pubkeys are denied with a user-facing reason (ACL-05)
  if (cache.whitelist.has(pubkey)) {
    return { allowed: true }; // ACL-04
  }
  return {
    allowed: false,
    reason: "This server requires explicit access. Contact the operator.",
  }; // ACL-05
}
