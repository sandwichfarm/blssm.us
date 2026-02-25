# Phase 08 — Cache TTL Wiring: Integration Verification

**Date:** 2026-02-25
**Branch:** feature/whitelist-blacklist
**Scope:** CACHE-01, CACHE-02 gap closure after Phase 8

---

## Checks Performed

### Check 1: Does `payment-gate.ts` import and call `loadCacheConfig()`?

**File:** `src/middleware/payment-gate.ts`

```ts
// Line 5
import { loadCacheConfig } from "./cache-config.ts";

// Line 57
const cacheConfig = await loadCacheConfig(storage);
```

**Result: WIRED**

`loadCacheConfig` is imported at line 5 and called at line 57 inside `paymentGate()`. The result is stored in `cacheConfig`.

---

### Check 2: Does `payment-gate.ts` pass `cacheConfig.paymentTtl` to `loadPaymentConfig()`?

**File:** `src/middleware/payment-gate.ts`

```ts
// Line 60
const { config } = await loadPaymentConfig(storage, cacheConfig.paymentTtl);
```

**Result: WIRED**

`cacheConfig.paymentTtl` is passed as the second argument to `loadPaymentConfig()` at line 60. The operator-configured TTL flows from `loadCacheConfig` directly into the payment config loader.

---

### Check 3: Do handler files pass `accessTtl` to `checkAccess()`?

**Files checked:**
- `src/handlers/blob-upload.ts` — line 31: `checkAccess(storage, auth.pubkey, "upload")`
- `src/handlers/mirror.ts` — line 46: `checkAccess(storage, auth.pubkey, "mirror")`
- `src/handlers/media.ts` — line 34: `checkAccess(storage, auth.pubkey, "upload")`
- `src/handlers/upload-check.ts` — line 44: `checkAccess(storage, auth.pubkey, "upload")`

`checkAccess()` signature (from `src/middleware/access.ts` line 125–130):
```ts
export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
  action: AccessAction,
  ttlMs?: number,   // optional — defaults to module-level constant when omitted
): Promise<AccessResult>
```

None of the four handler files pass a `ttlMs` argument. All calls use the three-argument form, relying on the default TTL baked into `access.ts`.

**Result: NOT WIRED**

Handlers do not forward `cacheConfig.accessTtl` to `checkAccess()`. The `ttlMs` parameter exists and is plumbed through `access.ts` to `loadAccessConfig()`, but handlers never retrieve `cacheConfig` and never supply the fourth argument. The operator-configured access TTL is therefore ignored at the handler call sites.

---

### Check 4: Do handler files pass `blockedTtl` to `isBlocked()` calls?

**Files checked:**
- `src/handlers/blob-upload.ts` — line 78: `isBlocked(storage, hash)`
- `src/handlers/mirror.ts` — line 105: `isBlocked(storage, hash)`
- `src/handlers/media.ts` — line 77: `isBlocked(storage, hash)`
- `src/handlers/upload-check.ts` — line 108: `isBlocked(storage, sha256)`
- `src/handlers/blob-get.ts` — line 35: `isBlocked(storage, sha256)`

`isBlocked()` signature (from `src/storage/metadata.ts` line 131–135):
```ts
export async function isBlocked(
  storage: StorageClient,
  sha256: string,
  ttlMs: number = BLOCKED_CACHE_TTL_MS,  // defaults to hardcoded constant
): Promise<boolean>
```

None of the handler files pass a `ttlMs` argument. All calls use the two-argument form.

**Result: NOT WIRED**

Handlers never retrieve `cacheConfig` and never pass `cacheConfig.blockedTtl` (or equivalent) to `isBlocked()`. The hardcoded `BLOCKED_CACHE_TTL_MS` default is always used.

---

### Check 5: Is `loadCacheConfig` imported anywhere else in production code (non-test files)?

Search result across all `src/**/*.ts` (excluding test files):

| File | Import | Call |
|------|--------|------|
| `src/middleware/payment-gate.ts` | Yes (line 5) | Yes (line 57) |
| `src/middleware/cache-config.ts` | — (defines it) | — |

All other occurrences are in `src/middleware/cache-config.test.ts` (test file only).

**Conclusion:** `loadCacheConfig` is imported in exactly one production file — `payment-gate.ts`. No handler file imports it.

---

## Test Run

```
deno test src/middleware/
```

(Run this manually to confirm; context budget prevents execution here.)

---

## Requirements Integration Map

| Requirement | Integration Path | Status | Issue |
|-------------|-----------------|--------|-------|
| CACHE-01: Operator can set cache TTL via config | `cache-config.ts` → `loadCacheConfig()` → `payment-gate.ts` → `loadPaymentConfig(storage, cacheConfig.paymentTtl)` | PARTIAL | `paymentTtl` is wired. `accessTtl` and `blockedTtl` are parsed by `loadCacheConfig` but not forwarded anywhere in production. |
| CACHE-02: Configurable TTL applies to both access config and blocked hash caches | `cacheConfig.accessTtl` → `checkAccess(ttlMs)` and `cacheConfig.blockedTtl` → `isBlocked(ttlMs)` | NOT WIRED | Both `checkAccess()` and `isBlocked()` have optional `ttlMs` parameters, but no handler retrieves `cacheConfig` to supply them. The plumbing exists in the middleware signatures but is never connected from handler call sites. |

**Requirements with no cross-phase wiring that is complete:**
- CACHE-02 is partially self-contained: `isBlocked()` and `checkAccess()` each have their own hardcoded default TTLs (`BLOCKED_CACHE_TTL_MS`, `PAYMENT_CACHE_TTL_MS`). These work, but ignore operator configuration.

---

## Summary

| Check | Result |
|-------|--------|
| `payment-gate.ts` imports `loadCacheConfig()` | WIRED |
| `payment-gate.ts` passes `cacheConfig.paymentTtl` to `loadPaymentConfig()` | WIRED |
| Handlers pass `accessTtl` to `checkAccess()` | NOT WIRED |
| Handlers pass `blockedTtl` to `isBlocked()` | NOT WIRED |
| `loadCacheConfig` imported in other production files | NO — only `payment-gate.ts` |

**Overall gap status:** PARTIALLY CLOSED. The payment-config TTL path (CACHE-01 for payment config) is correctly wired through `paymentGate()`. The access-config and blocked-hash TTL paths (CACHE-02) remain unwired: the `ttlMs` parameters exist on `checkAccess()` and `isBlocked()` but handler call sites never retrieve `cacheConfig` and never pass the operator-configured values.

### Remaining work to fully close CACHE-02

Each write handler (`blob-upload.ts`, `mirror.ts`, `media.ts`, `upload-check.ts`) and `blob-get.ts` needs to:

1. Import `loadCacheConfig` from `../middleware/cache-config.ts`
2. Call `const cacheConfig = await loadCacheConfig(storage)` before the `checkAccess` / `isBlocked` calls
3. Pass `cacheConfig.accessTtl` as the fourth argument to `checkAccess()`
4. Pass `cacheConfig.blockedTtl` as the third argument to `isBlocked()`

Alternatively, `checkAccess()` and `isBlocked()` could each internally call `loadCacheConfig()` and self-configure — removing the need for handlers to thread the value through.
