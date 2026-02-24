# Phase 5: Access Control + Cache TTL - Research

**Researched:** 2026-02-24
**Domain:** TypeScript access control middleware, cache TTL wiring, Deno runtime
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **Payment mode activation:** New `payments` boolean field in access.json: `{"public": true, "payments": true, "whitelist": [...], "blacklist": [...]}`. Added to AccessConfig type alongside existing fields. Default: false when field is missing (silent backward compatibility, no log noise on upgrade). Independent of payment.json — access layer signals "needs payment" regardless of whether payment config exists; payment middleware handles the rest. If payments=true but public=false (private mode): log warning and force payments=false in normalized config.

- **Backward compatibility:** Silent upgrade: no log messages about new features when payments field is absent. Test suite refactored to cover all modes systematically (public, private, public+payments) rather than preserving existing tests as-is. Central cache loader: one place loads cache.json and passes TTL values to each cache module (access, blocked, payment), rather than each module loading independently.

- **Access result signaling:** Machine-readable reason strings (e.g., "payment_required") rather than human-readable sentences. checkAccess() takes an action parameter: checkAccess(config, pubkey, action) where action is "upload" | "mirror" | "delete". This lets the access layer know delete is always free and only signal payment-required for upload/mirror on unlisted pubkeys.

### Claude's Discretion

- Access result type shape (new variant with requiresPayment flag vs three-state enum vs other approach)
- Whether payment config details (amount, mints) are included in the access result or fetched separately by middleware
- Internal type changes for existing modes (as long as HTTP responses stay identical)
- Exact test organization structure for the refactored suite

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ACL-01 | Operator can enable public+payments mode via payments field in access config | `payments` boolean added to AccessConfig type; normalizeAccessConfig handles default=false |
| ACL-02 | In public+payments mode, whitelisted pubkeys upload free (no 402) | checkAccess returns `{ allowed: true }` for whitelisted pubkeys in payments mode; existing whitelist Set used |
| ACL-03 | In public+payments mode, blacklisted pubkeys are denied (403, not 402) | Blacklist check runs first (before whitelist), returns `{ allowed: false, reason: "blacklisted" }` |
| ACL-04 | In public+payments mode, unlisted pubkeys receive 402 payment required | checkAccess returns new result shape with `requiresPayment: true`; handler returns 402 not 403 |
| ACL-05 | Existing public and private modes work unchanged (backward compatible) | All existing test cases pass; no behavioral change for configs without `payments` field |
</phase_requirements>

## Summary

Phase 5 extends the existing `checkAccess()` function in `src/middleware/access.ts` to add a third operating mode ("public+payments") and wires configurable cache TTL from Phase 4's `loadCacheConfig()` into the three hardcoded-TTL cache modules: access.ts, payment-config.ts, and storage/metadata.ts. The codebase is entirely TypeScript/Deno and has no external library dependencies for this phase — all work is internal refactoring and extension.

The existing access.ts is well-structured for this extension. The `AccessResult` discriminated union already has a reserved `requiresPayment?: true` field (commented "RESERVED for v2 payment composition") that is precisely the extension point for Phase 5. The `AccessCache` struct, `normalizeAccessConfig()`, `loadAccessConfig()`, and `checkAccess()` all need targeted updates. The `checkAccess()` signature change (adding `action` parameter) will require callers in blob-upload.ts and mirror.ts to be updated.

The cache TTL wiring is the most structurally significant change: each of the three cache modules currently has a hardcoded `const X_CACHE_TTL_MS = 60_000`. The central loader pattern (one call to `loadCacheConfig()` at the top of a request, result passed to each module) requires each module's `load*` function to accept an optional or required TTL override. The key constraint is that `loadCacheConfig()` itself must not circularly depend on itself for its own TTL (it already hardcodes its meta-cache to 60s correctly).

**Primary recommendation:** Extend checkAccess() with the `action` parameter and `payments` mode in access.ts, update AccessConfig type and normalizeAccessConfig() in types.ts and access.ts respectively, wire CacheConfig TTL values into the three load functions by passing CacheConfig as a parameter, and update callers (blob-upload.ts, mirror.ts) to pass the action and pass TTL context.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Deno (runtime) | current | TypeScript runtime, test runner | Project already uses Deno exclusively |
| `jsr:@std/assert` | current | Test assertions | Already used in all 3 test files |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | — | — | Phase is pure internal refactoring; no new external deps required |

**Installation:**
No new packages needed.

## Architecture Patterns

### Existing Project Structure (relevant to this phase)
```
src/
├── types.ts                    # AccessConfig type — ADD `payments?: boolean`
├── middleware/
│   ├── access.ts               # PRIMARY CHANGE: checkAccess(), normalizeAccessConfig(), loadAccessConfig()
│   ├── access.test.ts          # REFACTOR: add public+payments mode tests, keep existing
│   ├── cache-config.ts         # EXISTS: loadCacheConfig() — pass result to other loaders
│   ├── payment-config.ts       # ADD: accept TTL param from CacheConfig.paymentTtl
│   └── payments.ts             # No change needed
└── storage/
    └── metadata.ts             # CHANGE: isBlocked() hardcoded TTL → accept CacheConfig.blockedTtl
```

### Pattern 1: Extending AccessConfig type
**What:** Add optional `payments` boolean to AccessConfig in types.ts
**When to use:** When adding operator-configurable behavior to the access layer
**Example:**
```typescript
// src/types.ts — existing interface, add payments field
export interface AccessConfig {
  public: boolean;
  whitelist: string[];
  blacklist: string[];
  /** true = public+payments mode (unlisted pubkeys routed to payment) */
  payments?: boolean;
}
```

### Pattern 2: normalizeAccessConfig extension
**What:** Handle the `payments` field with default=false, enforce private+payments=false invariant
**When to use:** Normalizer is the single trusted source; downstream code can trust the field directly
**Example:**
```typescript
function normalizeAccessConfig(raw: unknown): AccessConfig {
  // ...existing logic...
  const payments = typeof r.payments === "boolean" ? r.payments : false;

  // Invariant: private mode + payments is nonsensical — log warning, force false
  if (payments && !publicMode) {
    console.warn("[access] payments=true ignored in private mode (public=false)");
    return { public: false, payments: false, whitelist: ..., blacklist: ... };
  }
  return { public: publicMode, payments, whitelist: ..., blacklist: ... };
}
```

### Pattern 3: checkAccess() signature and decision matrix extension
**What:** Add `action` parameter; add public+payments decision branch
**When to use:** All write handlers that call checkAccess() — upload, mirror
**Example:**
```typescript
export type AccessAction = "upload" | "mirror" | "delete";

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresPayment?: true };

export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
  action: AccessAction,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage);

  if (cache.config.public) {
    // Blacklist always wins (ACL-03)
    if (cache.blacklist.has(pubkey)) {
      return { allowed: false, reason: "blacklisted" };
    }

    // public+payments mode: whitelisted = free, unlisted = payment required
    if (cache.config.payments && action !== "delete") {
      if (cache.whitelist.has(pubkey)) {
        return { allowed: true };  // ACL-02: whitelist skips payment
      }
      // ACL-04: unlisted → payment required signal
      return { allowed: false, reason: "payment_required", requiresPayment: true };
    }

    // Plain public mode: everyone else allowed (ACL-05 backward compat)
    return { allowed: true };
  }

  // Private mode unchanged (ACL-05)
  if (cache.whitelist.has(pubkey)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "This server requires explicit access. Contact the operator." };
}
```

### Pattern 4: Caller updates for action parameter
**What:** blob-upload.ts and mirror.ts pass action to checkAccess(); on `requiresPayment` return 402 not 403
**When to use:** Any write handler that already calls checkAccess()
**Example:**
```typescript
// In blob-upload.ts
const access = await checkAccess(storage, auth.pubkey, "upload");
if (!access.allowed) {
  if (access.requiresPayment) {
    // Phase 6 will add full 402 logic; for now return minimal signal
    return new Response(JSON.stringify({ message: "payment_required" }), {
      status: 402,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return errorResponse(access.reason, 403);
}
```

### Pattern 5: Central cache TTL wiring
**What:** Pass CacheConfig as a parameter to each load function instead of each module using its own hardcoded const
**When to use:** Any loader that previously used a hardcoded 60s TTL
**Example:**
```typescript
// Approach A: Pass full CacheConfig to loadAccessConfig
export async function loadAccessConfig(
  storage: StorageClient,
  cacheCfg?: CacheConfig,
): Promise<AccessCache> {
  const ttl = cacheCfg?.accessTtl ?? ACCESS_CACHE_TTL_MS;
  // ...use ttl instead of hardcoded const...
}

// Approach B (Claude's discretion): Accept ttl directly
export async function loadAccessConfig(
  storage: StorageClient,
  ttlMs: number = ACCESS_CACHE_TTL_MS,
): Promise<AccessCache> {
  // ...
}
```

### Anti-Patterns to Avoid
- **Calling loadCacheConfig() from inside loadAccessConfig():** Creates a circular dependency path and adds storage round-trips per request. TTL must be passed in from the caller.
- **Checking `public && payments` in multiple places:** Normalizer must enforce the invariant once so downstream code trusts `config.payments` directly.
- **Returning 403 for requiresPayment:** ACL-04 specifically requires payment signal (402), not a flat deny. Handler must branch on `requiresPayment`.
- **Logging on silent upgrade:** When payments field is absent from config, normalizer MUST NOT log anything. Log only on the private+payments conflict.
- **Modifying `loadAccessConfig()` to return CacheConfig:** loadAccessConfig already returns `AccessCache` — keep concerns separate, pass TTL in.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Set intersection for whitelist/blacklist | Custom iteration | Existing `Set<string>` with `.has()` | Already in place; O(1) lookup |
| JSON schema validation | Custom validator | Existing normalizeAccessConfig() pattern | Established pattern across all 3 config modules |
| Cache invalidation | Timer-based | Existing expires-timestamp pattern | Already proven in access.ts, cache-config.ts, payment-config.ts |

**Key insight:** This phase has zero external library needs. Every pattern is already established in the codebase. The work is extending existing modules using the project's own conventions.

## Common Pitfalls

### Pitfall 1: Forgetting to export AccessAction type
**What goes wrong:** Callers (blob-upload.ts, mirror.ts) can't use the type without importing it
**Why it happens:** New types added alongside updated functions sometimes miss the export
**How to avoid:** Add `export type AccessAction = ...` in access.ts alongside the updated function
**Warning signs:** TypeScript error "AccessAction is not exported" at compile time

### Pitfall 2: private+payments warning fires on every cache hit
**What goes wrong:** Normalizer is called once at cache load, not per-request — so the warning fires once then is silent for 60s+. This is correct, but tests that call _resetAccessCacheForTesting() will see the warning in test output for the private+payments case.
**Why it happens:** normalizeAccessConfig is called inside loadAccessConfig only on cache miss
**How to avoid:** Accepted behavior; suppress in test output via post-test output block (Deno does this automatically)

### Pitfall 3: action parameter changes break delete handler
**What goes wrong:** blob-delete.ts does NOT call checkAccess() (it only checks auth and ownership). Adding `action` to checkAccess() doesn't break it, but the dev might incorrectly add an access check to delete.
**Why it happens:** Confusion about which handlers use access control
**How to avoid:** Only blob-upload.ts and mirror.ts call checkAccess(). blob-delete.ts uses auth + ownership only. Do not add checkAccess() to delete.

### Pitfall 4: TTL wiring breaks cache when CacheConfig not provided
**What goes wrong:** If loadCacheConfig() fails (e.g., storage error), the fallback should still give 60s default — not throw
**Why it happens:** Passing `undefined` as CacheConfig when load fails
**How to avoid:** Use `cacheCfg?.accessTtl ?? ACCESS_CACHE_TTL_MS` pattern so missing config falls back gracefully

### Pitfall 5: Test reset helpers not exported from updated modules
**What goes wrong:** Tests for the new public+payments mode need `_resetAccessCacheForTesting()` — already exported. But if any new internal state is added (e.g., separate payments cache), it needs its own reset.
**Why it happens:** Adding new module-level state without adding a corresponding reset helper
**How to avoid:** Any new module-level `let x = null` added must have a paired `export function _resetXForTesting()` per project pattern

### Pitfall 6: Circular import if access.ts imports cache-config.ts
**What goes wrong:** If loadAccessConfig() calls loadCacheConfig() internally, there's no circular import (the modules don't import each other currently), but it defeats the "central loader" design decision
**Why it happens:** Trying to be self-contained within each module
**How to avoid:** The caller (handler or router) loads CacheConfig first, then passes it to loadAccessConfig(). Keep loaders as pure functions that accept TTL, not self-loading.

## Code Examples

Verified patterns from official sources (project codebase):

### Existing AccessResult type (access.ts line 70-72)
```typescript
// Source: src/middleware/access.ts
export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresPayment?: true };
// NOTE: requiresPayment is already reserved — just needs to be SET in Phase 5
```

### Existing cache pattern used by all 3 modules
```typescript
// Source: src/middleware/access.ts — template for all loaders
let accessCache: AccessCache | null = null;

export async function loadAccessConfig(storage: StorageClient): Promise<AccessCache> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) {
    return accessCache;
  }
  const raw = await storage.getJson<unknown>("config/access.json");
  const config = normalizeAccessConfig(raw);
  accessCache = {
    config,
    whitelist: new Set(config.whitelist),
    blacklist: new Set(config.blacklist),
    expires: now + ACCESS_CACHE_TTL_MS,  // Phase 5: replace with passed-in TTL
  };
  return accessCache;
}
```

### Existing checkAccess call site pattern (blob-upload.ts line 30-33)
```typescript
// Source: src/handlers/blob-upload.ts
const access = await checkAccess(storage, auth.pubkey);
if (!access.allowed) {
  return errorResponse(access.reason, 403);
}
// Phase 5: add action arg, add requiresPayment branch before errorResponse
```

### CacheConfig type (types.ts line 138-145)
```typescript
// Source: src/types.ts
export interface CacheConfig {
  accessTtl: number;   // ms
  paymentTtl: number;  // ms
  blockedTtl: number;  // ms
}
```

### Blocked hash cache (metadata.ts lines 127-139) — needs TTL wiring
```typescript
// Source: src/storage/metadata.ts
let blockedCache: { hashes: Set<string>; expires: number } | null = null;
const BLOCKED_CACHE_TTL_MS = 60_000;  // Phase 5: replace with CacheConfig.blockedTtl param

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

### Test reset pattern used by all test files
```typescript
// Source: src/middleware/access.test.ts
_resetAccessCacheForTesting();
const storage = makeStorage({ public: true, payments: true, whitelist: [...], blacklist: [...] });
const result = await checkAccess(storage, PUB_UNLISTED, "upload");
assertEquals(result.allowed, false);
if (!result.allowed) assertEquals(result.requiresPayment, true);
```

## State of the Art

| Old Approach | Current Approach | Impact on Phase 5 |
|--------------|------------------|-------------------|
| Per-module hardcoded TTL constants | Central CacheConfig loaded once, passed to each loader | Modules accept TTL param; hardcoded consts become fallback defaults |
| `checkAccess(storage, pubkey)` 2-arg | `checkAccess(storage, pubkey, action)` 3-arg | All call sites updated; delete is never gated |
| requiresPayment reserved/unset | requiresPayment: true returned for unlisted in payments mode | Handler branches on this flag to return 402 vs 403 |

## Open Questions

1. **402 response format in Phase 5 vs Phase 6**
   - What we know: Phase 6 adds full BUD-07 402 with X-Cashu header. Phase 5 must return some 402 for unlisted pubkeys.
   - What's unclear: Should Phase 5's 402 be a minimal stub or attempt BUD-07 structure?
   - Recommendation: Return a minimal `{ message: "payment_required" }` 402 with `Cache-Control: no-store` header in Phase 5. Phase 6 replaces it with full BUD-07 format. This keeps Phase 5 self-contained while satisfying ACL-04.

2. **CacheConfig propagation path to isBlocked()**
   - What we know: isBlocked() is called from blob-upload.ts and mirror.ts. loadCacheConfig() is called (or will be called) in the same handlers.
   - What's unclear: Should handlers call loadCacheConfig() once and pass to both checkAccess() and isBlocked(), or should isBlocked() call it internally?
   - Recommendation: Handlers load CacheConfig once at top of request and pass to both. Avoids double storage round-trips and keeps modules pure/testable.

3. **Whether `_resetBlockedCacheForTesting()` needs to be added to metadata.ts**
   - What we know: metadata.ts currently has no reset export for blockedCache. Tests for isBlocked() wiring TTL will need it.
   - What's unclear: Are there existing tests for isBlocked()?
   - Recommendation: Add `export function _resetBlockedCacheForTesting(): void` to metadata.ts if isBlocked() TTL is tested. If isBlocked() TTL wiring is tested indirectly, may not be needed — planner should decide whether to add direct isBlocked() TTL test.

## Sources

### Primary (HIGH confidence)
- `src/middleware/access.ts` — full existing implementation, AccessResult type, AccessCache struct, checkAccess() decision matrix, reserved requiresPayment field
- `src/middleware/cache-config.ts` — loadCacheConfig() API, CacheConfig shape, clampTtl behavior
- `src/middleware/payment-config.ts` — hardcoded PAYMENT_CACHE_TTL_MS=60_000 with Phase 5 note
- `src/storage/metadata.ts` — hardcoded BLOCKED_CACHE_TTL_MS=60_000, isBlocked() signature
- `src/types.ts` — AccessConfig, CacheConfig, PaymentConfig types
- `src/handlers/blob-upload.ts` and `mirror.ts` — call sites for checkAccess()
- `src/middleware/access.test.ts` — existing test patterns, makeStorage helper, _reset helper

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions — locked implementation choices documented from prior discussion
- REQUIREMENTS.md — ACL-01 through ACL-05 requirement definitions

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new external libraries; Deno and jsr:@std/assert already in use
- Architecture: HIGH — all patterns verified from actual codebase files; extending known working patterns
- Pitfalls: HIGH — derived from direct code reading, not speculation

**Research date:** 2026-02-24
**Valid until:** 2026-03-26 (30 days — internal codebase, stable)
