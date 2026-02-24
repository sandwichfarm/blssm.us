---
phase: 05-access-control-cache-ttl
plan: "02"
subsystem: auth
tags: [access-control, payments, cache-ttl, deno, typescript]

# Dependency graph
requires:
  - phase: 05-01
    provides: "checkAccess() with AccessAction type and public+payments mode"
  - phase: 04-payment-config-types
    provides: "PaymentConfig, loadPaymentConfig cache pattern"
provides:
  - "loadAccessConfig with optional ttlMs parameter"
  - "checkAccess with optional ttlMs parameter"
  - "loadPaymentConfig with optional ttlMs parameter"
  - "isBlocked with optional ttlMs parameter"
  - "_resetBlockedCacheForTesting exported from metadata.ts"
  - "All four write handlers pass action parameter and return 402 on requiresPayment"
affects: [06-payment-verification, handlers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional ttlMs parameter with default fallback to module constant (backward-compatible TTL override)"
    - "402 stub with Cache-Control: no-store on requiresPayment result"
    - "HEAD handler 402: no body, X-Reason: payment_required header"

key-files:
  created: []
  modified:
    - src/middleware/access.ts
    - src/middleware/payment-config.ts
    - src/storage/metadata.ts
    - src/handlers/blob-upload.ts
    - src/handlers/mirror.ts
    - src/handlers/media.ts
    - src/handlers/upload-check.ts

key-decisions:
  - "checkAccess accepts optional ttlMs and threads it through to loadAccessConfig (single TTL injection point)"
  - "402 responses always include Cache-Control: no-store (prevents Bunny CDN caching)"
  - "HEAD /upload returns 402 with X-Reason: payment_required and no body (BUD-06 compliant)"
  - "Phase 6 will replace 402 stubs with full BUD-07 format (X-Cashu, X-Lightning headers)"

patterns-established:
  - "Cache modules accept optional ttlMs: loadAccessConfig, loadPaymentConfig, isBlocked all follow identical pattern"
  - "Handler payment gate: checkAccess → requiresPayment check → 402 before 403"

requirements-completed: [ACL-01, ACL-02, ACL-03, ACL-04, ACL-05]

# Metrics
duration: 2min
completed: 2026-02-24
---

# Phase 05 Plan 02: Cache TTL Wiring and Handler 402 Branches Summary

**Optional ttlMs injected into all three cache modules, all four write handlers updated with action parameter and requiresPayment 402 stub**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-24T15:30:38Z
- **Completed:** 2026-02-24T15:32:06Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Added optional `ttlMs` parameter to `loadAccessConfig`, `checkAccess`, `loadPaymentConfig`, and `isBlocked` — all backward-compatible with existing 60s defaults
- Added `_resetBlockedCacheForTesting()` export to `src/storage/metadata.ts`
- Updated `blob-upload.ts`, `mirror.ts`, `media.ts` to pass action parameter and return 402 with `Cache-Control: no-store` on `requiresPayment`
- Updated `upload-check.ts` to pass action `"upload"` and return 402 with `X-Reason: payment_required` header (no body, BUD-06 HEAD compliance)
- All 48 existing tests pass without modification

## Task Commits

Each task was committed atomically:

1. **Task 1: Wire TTL parameters into loadAccessConfig, loadPaymentConfig, and isBlocked** - `25b4a8a` (feat)
2. **Task 2: Update all handler call sites with action parameter and 402 response branch** - `f3ba54a` (feat)

## Files Created/Modified
- `/home/sandwich/Develop/blssm.us/src/middleware/access.ts` - loadAccessConfig and checkAccess accept optional ttlMs
- `/home/sandwich/Develop/blssm.us/src/middleware/payment-config.ts` - loadPaymentConfig accepts optional ttlMs
- `/home/sandwich/Develop/blssm.us/src/storage/metadata.ts` - isBlocked accepts optional ttlMs; _resetBlockedCacheForTesting added
- `/home/sandwich/Develop/blssm.us/src/handlers/blob-upload.ts` - action="upload", 402 branch
- `/home/sandwich/Develop/blssm.us/src/handlers/mirror.ts` - action="mirror", 402 branch
- `/home/sandwich/Develop/blssm.us/src/handlers/media.ts` - action="upload", 402 branch
- `/home/sandwich/Develop/blssm.us/src/handlers/upload-check.ts` - action="upload", 402 with X-Reason header

## Decisions Made
- `checkAccess` accepts optional `ttlMs` and threads it through to `loadAccessConfig` — single injection point keeps the pattern simple
- 402 responses always include `Cache-Control: no-store` per STATE.md decision (prevents Bunny CDN caching of payment gates)
- HEAD /upload 402 uses `X-Reason: payment_required` with no body (BUD-06 HEAD responses must be bodyless)
- 402 bodies are minimal stubs (`{"message":"payment_required"}`) — Phase 6 replaces with full BUD-07 format

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All cache modules now accept configurable TTL — Phase 6 can pass `cacheCfg.accessTtl` to checkAccess when loading per-request
- All handlers correctly route `requiresPayment` to 402 — Phase 6 payment verification can replace stubs with BUD-07 headers
- `_resetBlockedCacheForTesting` available for future test isolation needs

## Self-Check: PASSED

Files verified:
- src/middleware/access.ts - FOUND, contains "ttlMs"
- src/middleware/payment-config.ts - FOUND, contains "ttlMs"
- src/storage/metadata.ts - FOUND, contains "ttlMs" and "_resetBlockedCacheForTesting"
- src/handlers/blob-upload.ts - FOUND, contains "requiresPayment" and "upload"
- src/handlers/mirror.ts - FOUND, contains "requiresPayment" and "mirror"
- src/handlers/media.ts - FOUND, contains "requiresPayment" and "upload"
- src/handlers/upload-check.ts - FOUND, contains "requiresPayment" and "X-Reason"
- Commit 25b4a8a - FOUND
- Commit f3ba54a - FOUND

---
*Phase: 05-access-control-cache-ttl*
*Completed: 2026-02-24*
