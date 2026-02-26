import type { AccessConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { isValidPubkey } from "../util.ts";

// 60-second propagation window — config changes may take up to 60s to reflect
// across running instances. Matches BLOCKED_CACHE_TTL_MS in storage/metadata.ts.
const ACCESS_CACHE_TTL_MS = 60_000;

/** Actions that can be gated by access control */
export type AccessAction = "upload" | "mirror" | "delete";

interface AccessCache {
  config: AccessConfig;
  allowlist: Set<string>; // Pre-built for O(1) lookup
  blocklist: Set<string>; // Pre-built for O(1) lookup
  expires: number;
}

let accessCache: AccessCache | null = null;

/** Reset the module-level cache — for use in tests only */
export function _resetAccessCacheForTesting(): void {
  accessCache = null;
}

const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  public: true,
  allowlist: [],
  blocklist: [],
  payments: false,
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

/**
 * Try to load access config from environment variables.
 * Returns null if ACCESS_PUBLIC is not set (signal: env not configured).
 */
function loadAccessConfigFromEnv(): AccessConfig | null {
  const publicRaw = process.env["ACCESS_PUBLIC"];
  if (publicRaw === undefined) return null;

  const isPublic = publicRaw === "true";
  const payments = process.env["ACCESS_PAYMENTS"] === "true";

  const allowlistRaw = process.env["ACCESS_ALLOWLIST"] || "";
  const blocklistRaw = process.env["ACCESS_BLOCKLIST"] || "";

  const allowlist = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const blocklist = blocklistRaw
    ? blocklistRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  // Validate and filter pubkeys through the same path as storage-loaded configs
  const validAllowlist = filterPubkeys(allowlist, "allowlist");
  const validBlocklist = filterPubkeys(blocklist, "blocklist");

  // Apply same normalization: payments=true in private mode is forced to false
  let normalizedPayments = payments;
  if (normalizedPayments && !isPublic) {
    console.warn("[access] payments=true ignored in private mode (public=false)");
    normalizedPayments = false;
  }

  return {
    public: isPublic,
    allowlist: validAllowlist,
    blocklist: validBlocklist,
    payments: normalizedPayments,
  };
}

/** Normalize raw JSON into a valid AccessConfig — handles null (CFG-07) and invalid entries (CFG-06) */
function normalizeAccessConfig(raw: unknown): AccessConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ACCESS_CONFIG };
  const r = raw as Record<string, unknown>;

  const isPublic = typeof r.public === "boolean" ? r.public : true;

  // Normalize payments field:
  // - Missing field → false silently (no log)
  // - Non-boolean → false silently
  // - true + public=false → false with warning (payments is meaningless in private mode)
  let payments = typeof r.payments === "boolean" ? r.payments : false;
  if (payments && !isPublic) {
    console.warn("[access] payments=true ignored in private mode (public=false)");
    payments = false;
  }

  return {
    public: isPublic,
    allowlist: filterPubkeys(r.allowlist, "allowlist"),
    blocklist: filterPubkeys(r.blocklist, "blocklist"),
    payments,
  };
}

/**
 * Access check result — discriminated union consumed by gated write handlers.
 *
 * Decision matrix (v1.1):
 *   Mode     | Pubkey state        | Decision  | Req
 *   ---------|---------------------|-----------|------
 *   public   | blocklisted         | DENY 403  | ACL-02
 *   public   | allowlisted         | ALLOW     | ACL-01, ACL-03 (allowlist is a no-op: allow via "not blocklisted")
 *   public   | neither             | ALLOW     | ACL-01
 *   private  | allowlisted         | ALLOW     | ACL-04
 *   private  | not allowlisted     | DENY 403  | ACL-05
 *   private  | blocklisted only    | DENY 403  | ACL-05 (blocklist irrelevant: denied by "not allowlisted")
 *   pub+pay  | blocklisted         | DENY 403  | ACL-03
 *   pub+pay  | allowlisted         | ALLOW     | ACL-02
 *   pub+pay  | unlisted + upload   | PAY 402   | ACL-04
 *   pub+pay  | unlisted + mirror   | PAY 402   | ACL-04
 *   pub+pay  | unlisted + delete   | ALLOW     | ACL-04 (delete always free)
 */
export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresPayment?: true };

/** Load and cache access config — env vars → storage fallback → defaults. 60s TTL by default. */
export async function loadAccessConfig(
  storage: StorageClient,
  ttlMs: number = ACCESS_CACHE_TTL_MS,
): Promise<AccessCache> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) {
    return accessCache;
  }

  // Try env vars first
  const fromEnv = loadAccessConfigFromEnv();
  const config = fromEnv ?? normalizeAccessConfig(
    await storage.getJson<unknown>("config/access.json"),
  );

  accessCache = {
    config,
    allowlist: new Set(config.allowlist),
    blocklist: new Set(config.blocklist),
    expires: now + ttlMs,
  };
  return accessCache;
}

/**
 * Core access control decision function.
 * Callers MUST invoke this BEFORE reading the request body (request.arrayBuffer()).
 *
 * @param storage - StorageClient used to load access config via loadAccessConfig()
 * @param pubkey - hex-64 pubkey to evaluate; obtained from validateAuth() result
 * @param action - The action being requested (upload, mirror, or delete)
 * @param ttlMs - Optional TTL override for cache (defaults to ACCESS_CACHE_TTL_MS)
 * @returns AccessResult — { allowed: true } or { allowed: false, reason, requiresPayment? }
 */
export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
  action: AccessAction,
  ttlMs?: number,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage, ttlMs);

  if (cache.config.public) {
    // Blocklist always takes priority in all public modes (ACL-03)
    if (cache.blocklist.has(pubkey)) {
      return { allowed: false, reason: "pubkey is blocked" };
    }

    // Public+payments mode (v1.1)
    if (cache.config.payments && action !== "delete") {
      // Allowlisted pubkeys bypass payment (ACL-02)
      if (cache.allowlist.has(pubkey)) {
        return { allowed: true };
      }
      // Unlisted pubkeys are routed to payment for upload/mirror (ACL-04)
      return { allowed: false, reason: "payment_required", requiresPayment: true };
    }

    // Plain public mode: everyone allowed (ACL-01)
    return { allowed: true };
  }

  // Private mode (ACL-04, ACL-05, ACL-06):
  // - Allowlist is the ONLY path to allowed (ACL-04)
  // - Blocklist is IGNORED — do NOT add a blocklist check here (ACL-06)
  // - Non-allowlisted pubkeys are denied with a user-facing reason (ACL-05)
  if (cache.allowlist.has(pubkey)) {
    return { allowed: true }; // ACL-04
  }
  return {
    allowed: false,
    reason: "This server requires explicit access. Contact the operator.",
  }; // ACL-05
}
