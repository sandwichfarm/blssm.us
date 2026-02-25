---
phase: 05-access-control-cache-ttl
plan: "01"
subsystem: auth
tags: [access-control, payments, deno, typescript, tdd]

# Dependency graph
requires:
  - phase: 02-access-logic
    provides: "original checkAccess() and normalizeAccessConfig() implementation"
  - phase: 04-payment-config-types
    provides: "PaymentConfig types and payment concepts"
provides:
  - "AccessAction type exported from access.ts"
  - "checkAccess() with action parameter for public+payments mode routing"
  - "payments field on AccessConfig (types.ts)"
  - "normalizeAccessConfig() enforcing private-mode invariant for payments"
  - "19-test suite covering public, private, and public+payments modes"
affects: [06-payment-verification, 07-endpoint-wiring, handlers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AccessAction discriminated union for action-based access gating"
    - "Blacklist-first priority in all public modes before whitelist/payment checks"
    - "Delete action always free in payments mode (encourages storage cleanup)"
    - "Silent normalization for missing optional fields; warn-only for invalid configs"

key-files:
  created: []
  modified:
    - src/types.ts
    - src/middleware/access.ts
    - src/middleware/access.test.ts

key-decisions:
  - "delete action is always free in public+payments mode — blacklist still applies"
  - "Blacklist takes priority over payment gate: blacklisted pubkeys get 403, not 402"
  - "Whitelisted pubkeys bypass payment in public+payments mode (ACL-02)"
  - "payments=true in private mode is silently forced to false with a console.warn (nonsensical config)"
  - "payments field missing from config JSON defaults to false with no log (silent upgrade path)"

patterns-established:
  - "AccessAction: action parameter thread through from handler → checkAccess for gating decisions"
  - "Three-mode dispatch: private → public → public+payments, resolved from normalized config"

requirements-completed: [ACL-01, ACL-02, ACL-03, ACL-04, ACL-05]

# Metrics
duration: 2min
completed: 2026-02-24
---

# Phase 05 Plan 01: Access Control - Public+Payments Mode Summary

**checkAccess() extended with AccessAction type and three-mode dispatch: public, private, and public+payments where unlisted pubkeys get 402 and blacklist always wins**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-24T00:26:09Z
- **Completed:** 2026-02-24T00:28:54Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Added `AccessAction` type (`"upload" | "mirror" | "delete"`) exported from access.ts
- Extended `checkAccess()` to accept `action` parameter enabling action-based routing decisions
- Implemented public+payments mode: blacklist (403) → whitelist (free) → unlisted (402 for upload/mirror, free for delete)
- Updated `normalizeAccessConfig()` to handle `payments` field with private-mode invariant enforcement
- Refactored test suite from 8 tests to 19 covering all three modes and normalizer edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Add payments field to AccessConfig and write failing tests** - `fe7dc70` (test)
2. **Task 2: Implement AccessAction, update normalizer and checkAccess** - `9333785` (feat)

_Note: TDD plan — test commit (RED) followed by implementation commit (GREEN)_

## Files Created/Modified
- `/home/sandwich/Develop/blssm.us/src/types.ts` - Added `payments?: boolean` field to AccessConfig interface
- `/home/sandwich/Develop/blssm.us/src/middleware/access.ts` - AccessAction type, updated checkAccess() and normalizeAccessConfig()
- `/home/sandwich/Develop/blssm.us/src/middleware/access.test.ts` - Full 19-test suite covering all three modes

## Decisions Made
- Blacklist takes priority over payment gate in public+payments mode — a blacklisted pubkey gets 403, not 402 (security over payments logic)
- Delete action always free in all modes including public+payments (encourages storage cleanup per plan spec)
- payments field missing from config silently defaults to false (no console.warn) — silent upgrade path per CONTEXT.md
- payments=true when public=false logs a console.warn and forces payments=false (nonsensical config combination)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- checkAccess() now has action parameter and public+payments routing ready for handler integration
- Handlers (blob-upload, mirror) need to be updated to pass action parameter and handle 402 responses
- loadAccessConfig() caches payments field — Phase 6 payment verification can rely on this

---
*Phase: 05-access-control-cache-ttl*
*Completed: 2026-02-24*
