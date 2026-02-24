# Phase 1: Config Foundation - Research

**Researched:** 2026-02-24
**Domain:** TypeScript config loading with TTL cache — Bunny Storage JSON + Deno/EdgeScript runtime
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CFG-01 | Server loads access control config from `config/access.json` in Bunny Storage | `storage.getJson()` already exists and returns typed JSON; same path convention as `config/blocked.json` |
| CFG-02 | Config is cached with 60s TTL matching existing `blocked.json` pattern | `isBlocked()` in `metadata.ts` is the canonical TTL cache template; copy exactly |
| CFG-03 | Config includes `public` boolean (true = open to all, false = whitelist only) | Field named `public` in JSON; maps to `AccessConfig.public: boolean` TypeScript type |
| CFG-04 | Config includes `whitelist` array of hex pubkeys | `AccessConfig.whitelist: string[]`; validated to hex on load |
| CFG-05 | Config includes `blacklist` array of hex pubkeys | `AccessConfig.blacklist: string[]`; validated to hex on load |
| CFG-06 | Server rejects npub-formatted pubkeys in config with logged warning, skips them | `isValidPubkey()` already exists in `util.ts`; use it during config normalization |
| CFG-07 | Missing `config/access.json` defaults to public mode with empty lists | `storage.getJson()` returns `null` on 404; default: `{ public: true, whitelist: [], blacklist: [] }` |
</phase_requirements>

---

## Summary

Phase 1 delivers a single new module (`src/middleware/access.ts`) that loads, validates, and caches `config/access.json` from Bunny Storage. The implementation is a direct extension of the existing `isBlocked()` cache pattern already present in `src/storage/metadata.ts` — the entire codebase infrastructure for this phase already exists.

The only genuinely new TypeScript is: an `AccessConfig` interface added to `src/types.ts`, a module-level TTL cache variable, a `loadAccessConfig()` async function that fetches from Bunny Storage on cache miss, and a `normalizeAccessConfig()` helper that filters npub-format entries and logs warnings. No new npm/JSR packages are required. All utilities (`isValidPubkey`, `errorResponse`, `StorageClient.getJson`) are already present in the codebase.

Phase 1 does NOT implement the `checkAccess()` decision logic (that is Phase 2) and does NOT wire access control into any handler (that is Phase 3). The deliverable is specifically the data layer: typed config that can be loaded cheaply on every request.

**Primary recommendation:** Copy the `isBlocked()` TTL cache pattern from `metadata.ts` verbatim; adapt it for `AccessConfig` shape; add hex-validation filtering in the normalization step using the existing `isValidPubkey()` from `util.ts`.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | All new code | Existing project language — no change |
| Deno | 2.x | Runtime | Bunny EdgeScript; no change |
| `StorageClient.getJson()` | n/a (internal) | Fetch JSON from Bunny Storage | Already used by every metadata operation in the codebase |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `isValidPubkey()` from `src/util.ts` | n/a (internal) | Validate 64-char hex pubkey format | Use during config normalization to filter bad entries |
| `Set<string>` (builtin) | n/a | O(1) pubkey membership lookup | Convert `whitelist` and `blacklist` arrays to Sets in the cache struct |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Module-level cache var | KV store / shared cache | No KV available in Bunny EdgeScript; module-level is the only option |
| JSON in Bunny Storage | YAML config | No Deno stdlib YAML parser; JSON is already the project convention |
| `isValidPubkey()` reuse | Inline regex | No reason to duplicate — the function exists and is tested |

**Installation:** No new packages. Zero dependency changes.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── middleware/
│   ├── cors.ts           # (existing)
│   ├── payments.ts       # (existing)
│   └── access.ts         # NEW: AccessConfig loader + cache (Phase 1 deliverable)
├── types.ts              # Add AccessConfig interface here
├── storage/
│   └── metadata.ts       # (existing) — do NOT add access config logic here
└── util.ts               # (existing) isValidPubkey already here
```

The new file is `src/middleware/access.ts`. Config types go in `src/types.ts` alongside all other domain types. Do NOT put cache logic in `metadata.ts` — that file is for blob metadata, not server configuration.

### Pattern 1: Module-Level TTL Cache (canonical pattern, copy verbatim)

**What:** A module-scoped variable holds parsed config with an expiry timestamp. On every call, check freshness. If stale, re-fetch and repopulate.

**When to use:** Always — this is the only viable caching strategy for a stateless Deno/EdgeScript isolate.

**Example (directly from existing `src/storage/metadata.ts`):**
```typescript
// Source: /home/sandwich/Develop/blssm.us/src/storage/metadata.ts lines 127-138
let blockedCache: { hashes: Set<string>; expires: number } | null = null;
const BLOCKED_CACHE_TTL_MS = 60_000;

export async function isBlocked(storage: StorageClient, sha256: string): Promise<boolean> {
  const now = Date.now();
  if (blockedCache && now < blockedCache.expires) {
    return blockedCache.hashes.has(sha256);
  }
  const config = (await storage.getJson<BlockedConfig>("config/blocked.json")) || { hashes: [] };
  blockedCache = { hashes: new Set(config.hashes), expires: now + BLOCKED_CACHE_TTL_MS };
  return blockedCache.hashes.has(sha256);
}
```

**Adapted for access config:**
```typescript
// src/middleware/access.ts
import type { AccessConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { isValidPubkey } from "../util.ts";

const ACCESS_CACHE_TTL_MS = 60_000;

interface AccessCache {
  config: AccessConfig;
  whitelist: Set<string>;
  blacklist: Set<string>;
  expires: number;
}

let accessCache: AccessCache | null = null;

export async function loadAccessConfig(storage: StorageClient): Promise<AccessCache> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) {
    return accessCache;
  }
  const raw = await storage.getJson<AccessConfig>("config/access.json");
  const config = normalizeAccessConfig(raw);
  accessCache = {
    config,
    whitelist: new Set(config.whitelist),
    blacklist: new Set(config.blacklist),
    expires: now + ACCESS_CACHE_TTL_MS,
  };
  return accessCache;
}
```

### Pattern 2: Config Normalization with Warn-and-Skip

**What:** On each cache miss, the raw JSON from Bunny Storage is filtered through a normalization function. Invalid entries (npub format, wrong length, non-hex) are logged as warnings and excluded from the normalized config. Valid entries are kept. The function always returns a structurally correct `AccessConfig` even if the file is missing or partially malformed.

**When to use:** Always — this satisfies CFG-06 (npub rejection) and CFG-07 (missing file default).

**Example:**
```typescript
// src/middleware/access.ts
const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  public: true,
  whitelist: [],
  blacklist: [],
};

function normalizeAccessConfig(raw: AccessConfig | null): AccessConfig {
  if (!raw) return DEFAULT_ACCESS_CONFIG;

  const isPublic = typeof raw.public === "boolean" ? raw.public : true;

  const filterPubkeys = (list: unknown, fieldName: string): string[] => {
    if (!Array.isArray(list)) return [];
    return list.filter((entry) => {
      if (typeof entry !== "string" || !isValidPubkey(entry)) {
        console.warn(
          `[access] Skipping invalid pubkey in ${fieldName}: ${String(entry).substring(0, 20)}...`
        );
        return false;
      }
      return true;
    });
  };

  return {
    public: isPublic,
    whitelist: filterPubkeys(raw.whitelist, "whitelist"),
    blacklist: filterPubkeys(raw.blacklist, "blacklist"),
  };
}
```

**Key behavior:** `isValidPubkey()` from `src/util.ts` uses `HEX64_RE = /^[0-9a-f]{64}$/`. An npub starts with `npub1` — it fails both the hex check and the length check. This correctly rejects all npub-format entries per CFG-06.

### Pattern 3: Type Definition in types.ts

**What:** `AccessConfig` interface added to `src/types.ts` alongside existing interfaces.

**Example:**
```typescript
// src/types.ts — add after BlockedConfig
/** Access control configuration from config/access.json */
export interface AccessConfig {
  /** true = public mode (anyone can publish unless blacklisted)
   *  false = private mode (only whitelisted pubkeys can publish) */
  public: boolean;
  /** Hex pubkeys that always bypass restrictions (in public mode with payments, also skip payment) */
  whitelist: string[];
  /** Hex pubkeys that are always denied (in public mode; ignored in private mode) */
  blacklist: string[];
}
```

### Anti-Patterns to Avoid

- **Storing access config cache in `metadata.ts`:** That file manages blob ownership and index state. Config caching belongs in `middleware/access.ts` to keep concerns separated and match the planned project structure from `.planning/research/ARCHITECTURE.md`.
- **Returning raw `AccessConfig` from cache:** The cache struct should include pre-built `Set<string>` for whitelist and blacklist so Phase 2's `checkAccess()` gets O(1) membership tests without re-constructing Sets on every call.
- **Calling `storage.getJson("config/access.json")` directly from handlers:** Always go through `loadAccessConfig()` — the cache lives at the module level in `access.ts`. Direct calls bypass caching.
- **Treating a malformed `public` field as an error:** If `public` is missing or not a boolean, default to `true` (open/public mode). This is the safest fail-open behavior for a backward-compatible default.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Pubkey hex validation | Custom regex | `isValidPubkey()` from `src/util.ts` | Already exists, uses same `HEX64_RE` as all other pubkey validation in the codebase |
| HTTP fetch to Bunny Storage | Direct fetch | `storage.getJson()` | Already handles auth headers, 404→null, JSON parse errors |
| O(1) set membership | `Array.includes()` | `new Set(list)` + `.has()` | O(1) vs O(n); no library needed — JS builtin |
| TTL cache structure | Custom caching library | Module-level variable (same as `blockedCache`) | No library available in EdgeScript that adds value here |

**Key insight:** Every piece of infrastructure needed for Phase 1 is already in the codebase. This phase is pure glue code following existing patterns — the risk is deviating from them, not implementing them.

---

## Common Pitfalls

### Pitfall 1: npub Silent Pass-Through

**What goes wrong:** npub entries in `access.json` pass through without validation. The hex comparison with the auth pubkey always fails silently — whitelisted npub operators get 403, blacklisted npub keys get through.

**Why it happens:** `isValidPubkey` is available but not called during config load, only during individual operations.

**How to avoid:** Always filter both `whitelist` and `blacklist` through `isValidPubkey()` in `normalizeAccessConfig()`. Log a warning per-entry. Never let the raw array reach the cache.

**Warning signs:** Whitelisted pubkey receives 403. Or: blacklisted pubkey successfully uploads.

### Pitfall 2: Missing File Throws Instead of Defaulting

**What goes wrong:** `storage.getJson()` returns `null` for a 404. If `null` is not explicitly handled, accessing `raw.whitelist` throws, crashing the isolate.

**Why it happens:** TypeScript's `null` check is easy to forget when destructuring.

**How to avoid:** The `normalizeAccessConfig(raw)` function must handle `raw === null` as its first condition, returning `DEFAULT_ACCESS_CONFIG`. The `getJson` call pattern `|| { public: true, ... }` is also acceptable but the normalization approach is cleaner.

**Warning signs:** `500 Internal Server Error` on all write endpoints when `config/access.json` doesn't exist.

### Pitfall 3: Cache Stores Arrays, Not Sets

**What goes wrong:** The cache stores `config.whitelist` and `config.blacklist` as plain arrays. Phase 2's `checkAccess()` calls `config.whitelist.includes(pubkey)` which is O(n). Fine at < 100 entries; degrades at larger lists.

**Why it happens:** The `isBlocked()` cache already converts `hashes` to a `Set` — but a developer adapting it might miss that nuance and just cache the raw `AccessConfig`.

**How to avoid:** The `AccessCache` interface (internal to `access.ts`) must include `whitelist: Set<string>` and `blacklist: Set<string>` alongside the raw `config` object. Build the Sets during normalization, before storing in cache.

**Warning signs:** Cache struct contains `config.whitelist` as an array; Phase 2 code calls `.includes()` on it.

### Pitfall 4: Cache Not Invalidated After Config Edit

**What goes wrong:** Operator edits `config/access.json` in Bunny Storage but the running edge instance serves stale config for up to 60 seconds (per TTL). This is expected behavior — but the operator must be told.

**Why it happens:** Module-level cache is isolate-local. Each edge instance has independent state.

**How to avoid:** This is by design and matches the existing `blocked.json` behavior. Document the 60-second propagation window in code comments adjacent to `ACCESS_CACHE_TTL_MS`. No code change needed.

**Warning signs:** Operator reports banned pubkeys still uploading immediately after config edit. Expected if within the TTL window.

### Pitfall 5: `public` as a Reserved Word

**What goes wrong:** In certain contexts (older TypeScript configs or strict mode), using `public` as a property name in an interface could conflict with the TypeScript access modifier keyword.

**Why it happens:** `public` is a reserved keyword in TypeScript class definitions, though it is valid as an object/interface property name.

**How to avoid:** In interfaces and plain objects, `public` as a property name is valid TypeScript and compiles without error. The `BlockedConfig` and similar interfaces in `types.ts` use similar patterns. No issue in practice, but verify with `deno task check` after adding the interface.

**Warning signs:** TypeScript compile error referencing `public` as unexpected token — unlikely but verify.

---

## Code Examples

Verified patterns from codebase (all HIGH confidence — direct file inspection):

### Existing Cache Pattern to Mirror

```typescript
// Source: /home/sandwich/Develop/blssm.us/src/storage/metadata.ts (lines 127-138)
let blockedCache: { hashes: Set<string>; expires: number } | null = null;
const BLOCKED_CACHE_TTL_MS = 60_000;

export async function isBlocked(storage: StorageClient, sha256: string): Promise<boolean> {
  const now = Date.now();
  if (blockedCache && now < blockedCache.expires) {
    return blockedCache.hashes.has(sha256);
  }
  const config = (await storage.getJson<BlockedConfig>("config/blocked.json")) || { hashes: [] };
  blockedCache = { hashes: new Set(config.hashes), expires: now + BLOCKED_CACHE_TTL_MS };
  return blockedCache.hashes.has(sha256);
}
```

### Existing Pubkey Validation to Reuse

```typescript
// Source: /home/sandwich/Develop/blssm.us/src/util.ts (lines 50-61)
const HEX64_RE = /^[0-9a-f]{64}$/;

export function isValidPubkey(pubkey: string): boolean {
  return HEX64_RE.test(pubkey);
}
```

### Existing getJson Null-Safety Pattern

```typescript
// Source: /home/sandwich/Develop/blssm.us/src/storage/client.ts (lines 67-75)
async getJson<T>(path: string): Promise<T | null> {
  const resp = await this.get(path);
  if (!resp) return null;  // 404 returns null
  try {
    return (await resp.json()) as T;
  } catch {
    return null;  // parse error returns null
  }
}
```

### Existing BlockedConfig Type to Model AccessConfig After

```typescript
// Source: /home/sandwich/Develop/blssm.us/src/types.ts (lines 46-48)
export interface BlockedConfig {
  hashes: string[];
}
// AccessConfig follows same pattern: flat interface, string arrays
```

### Complete Phase 1 Implementation Sketch

```typescript
// src/middleware/access.ts
import type { AccessConfig } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { isValidPubkey } from "../util.ts";

const ACCESS_CACHE_TTL_MS = 60_000; // Match BLOCKED_CACHE_TTL_MS

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
      console.warn(`[access] Skipping invalid pubkey in config.${fieldName}: "${String(entry).substring(0, 30)}"`);
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
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-request storage reads | Module-level TTL cache | Already established in this codebase (blockedCache) | Follow existing pattern — no debate needed |
| Array linear scan for membership | `Set<string>` O(1) lookup | Already used in blockedCache (`new Set(config.hashes)`) | Follow existing pattern — pre-build Sets in cache struct |

**Deprecated/outdated:**
- `Array.includes()` for pubkey list membership: The codebase already moved to `Set.has()` for the blocked hashes list. Access config must follow suit.

---

## Open Questions

1. **Should `loadAccessConfig()` return the full `AccessCache` struct or just `AccessConfig`?**
   - What we know: Phase 2 will need both the Sets (for O(1) lookup) and the `config.public` boolean.
   - What's unclear: Whether to expose the internal `AccessCache` type or wrap it in a cleaner API.
   - Recommendation: Return the full `AccessCache` as a typed internal interface. Phase 2 consumes it directly. Avoids rebuilding Sets per-call in `checkAccess()`.

2. **Warn-and-skip vs. warn-and-fallback-to-defaults for malformed config structure?**
   - What we know: STATE.md lists this as an open decision. Both approaches are valid. The requirements say "skips them" for invalid pubkeys (CFG-06), not for the entire config.
   - What's unclear: What to do if `public` field is missing or not a boolean — treat as `true` or reject the file?
   - Recommendation: Warn-and-default at the field level (missing `public` → `true`; invalid list → empty list). Never reject the entire file. A partial config is better than a hard-fail that locks out all users.

3. **Should the cache expose a manual-invalidation function for future OPS-02 support?**
   - What we know: OPS-02 (config changes take effect immediately) is a v2 requirement, out of scope for Phase 1.
   - What's unclear: Whether to design the cache with a reset hook now.
   - Recommendation: Do not add invalidation hooks in Phase 1. Export `accessCache = null` style reset as a separate exported function only when OPS-02 is in scope. Adding it now adds complexity with no current use.

---

## Sources

### Primary (HIGH confidence)

- `/home/sandwich/Develop/blssm.us/src/storage/metadata.ts` — `isBlocked()` + `blockedCache` pattern (direct codebase inspection)
- `/home/sandwich/Develop/blssm.us/src/types.ts` — Existing interface patterns (`BlockedConfig`, `AuthResult`) and `isValidPubkey` target (direct inspection)
- `/home/sandwich/Develop/blssm.us/src/storage/client.ts` — `getJson()` null-safety contract (direct inspection)
- `/home/sandwich/Develop/blssm.us/src/util.ts` — `isValidPubkey`, `HEX64_RE`, `errorResponse` (direct inspection)
- `/home/sandwich/Develop/blssm.us/src/handlers/blob-upload.ts` — Existing handler call order: auth → body → storage (direct inspection)
- `.planning/research/ARCHITECTURE.md` — Module-level cache pattern, recommended file placement
- `.planning/research/STACK.md` — No new packages; `Set<string>` pattern; JSON config recommendation
- `.planning/research/PITFALLS.md` — npub vs hex format mismatch, cache propagation delay, array-vs-Set pitfall
- `.planning/REQUIREMENTS.md` — CFG-01 through CFG-07 (authoritative requirements)
- `.planning/ROADMAP.md` — Phase 1 success criteria (authoritative scope)

### Secondary (MEDIUM confidence)

- `.planning/research/STACK.md` citing `hzrd149/umbrel-blob-box` — JSON config with `whitelist` + mode boolean is ecosystem-standard pattern
- `.planning/codebase/ARCHITECTURE.md` — Validated understanding of middleware layer placement

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new libraries; all tools directly inspected in codebase
- Architecture: HIGH — exact pattern template exists in `metadata.ts`; direct file inspection confirms structure
- Pitfalls: HIGH — majority derive from direct codebase analysis; npub pitfall verified against NIP-19 spec

**Research date:** 2026-02-24
**Valid until:** 2026-03-26 (30 days — stable domain, no fast-moving ecosystem dependencies)
