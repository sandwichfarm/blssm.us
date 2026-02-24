---
phase: 02-access-logic
plan: 01
subsystem: api
tags: [access-control, acl, pubkey, whitelist, blacklist, deno, typescript]

# Dependency graph
requires:
  - phase: 01-config-foundation
    provides: loadAccessConfig() returning AccessCache with Set<string> whitelist/blacklist, AccessConfig type
provides:
  - checkAccess(storage, pubkey): Promise<AccessResult> — core access control decision function
  - AccessResult type — discriminated union for allowed/denied results exported from access.ts
  - _resetAccessCacheForTesting() — test isolation helper
  - Deno test suite with 8 cases covering full ACL decision matrix
affects:
  - 03-handler-integration (Phase 3 calls checkAccess() in gated write handlers)

# Tech tracking
tech-stack:
  added: [jsr:@std/assert (Deno test assertion library)]
  patterns:
    - TDD decision-matrix tests — one Deno.test per ACL requirement case
    - Cache reset via exported test helper (_resetAccessCacheForTesting) for module-level state isolation
    - Discriminated union return type (AccessResult) mirrors existing AuthResult pattern

key-files:
  created:
    - src/middleware/access.test.ts
  modified:
    - src/middleware/access.ts

key-decisions:
  - "AccessResult exported from access.ts (not types.ts): co-located with checkAccess(); promote to types.ts only if multiple modules need the type independently"
  - "Private-mode denial reason: 'This server requires explicit access. Contact the operator.' — user-facing, actionable"
  - "Blacklist-denial reason: 'pubkey is blacklisted' — operator-diagnostic, terse"
  - "Cache reset helper exported as _resetAccessCacheForTesting() with underscore prefix signaling test-only use"
  - "requiresPayment field on AccessResult type is v2-reserved — not set in any v1 return path"

patterns-established:
  - "Decision tree with two mutually exclusive branches (public/private) — no shared logic between modes"
  - "Each branch commented with the requirement IDs it satisfies (ACL-0N)"

requirements-completed: [ACL-01, ACL-02, ACL-03, ACL-04, ACL-05, ACL-06, ACL-07]

# Metrics
duration: 2min
completed: 2026-02-24
---

# Phase 2 Plan 01: checkAccess Decision Function Summary

**checkAccess(storage, pubkey) decision function with AccessResult discriminated union — 8-case TDD matrix covering all public/private mode ACL requirements**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-24T11:16:15Z
- **Completed:** 2026-02-24T11:18:25Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments

- Exported `AccessResult` discriminated union type from `src/middleware/access.ts` for Phase 3 handler use
- Implemented `checkAccess(storage, pubkey): Promise<AccessResult>` with clean two-branch decision tree
- Public branch: blacklist gates, whitelist ignored (ACL-01, ACL-02, ACL-03)
- Private branch: whitelist gates, blacklist ignored (ACL-04, ACL-05, ACL-06)
- Function signature enforces ACL-07 — no body/request parameter, forces callers to check before body read
- All 8 decision matrix test cases pass using Deno's built-in test framework

## Task Commits

Each task was committed atomically:

1. **RED — Failing tests** - `98f1c67` (test)
2. **GREEN — checkAccess implementation** - `87aaff5` (feat)

_TDD plan: two commits (test → feat). No refactor needed._

## Files Created/Modified

- `src/middleware/access.ts` — Added `AccessResult` type, `checkAccess()` function, `_resetAccessCacheForTesting()` helper
- `src/middleware/access.test.ts` — 8 Deno test cases covering complete ACL decision matrix

## Decisions Made

- `AccessResult` exported from `access.ts` alongside `checkAccess()` rather than `types.ts` — promotes to `types.ts` only if multiple modules need the type independently (matches research recommendation)
- Added `_resetAccessCacheForTesting()` export (underscore prefix signals test-only) to reset module-level `accessCache` between tests — necessary because the module singleton would otherwise leak state across test cases
- Denial reason strings finalized: `"pubkey is blacklisted"` (terse, operator-diagnostic) for public mode; `"This server requires explicit access. Contact the operator."` (user-facing, actionable) for private mode

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added _resetAccessCacheForTesting() to fix module-level cache leaking between tests**
- **Found during:** GREEN phase (running tests after implementation)
- **Issue:** Module-level `accessCache` singleton caches the first test's config for the TTL period (60s). Subsequent tests with different configs reused the stale cache, causing 4 of 8 tests to fail.
- **Fix:** Exported `_resetAccessCacheForTesting()` that sets `accessCache = null`. Each test calls this before creating its mock storage.
- **Files modified:** `src/middleware/access.ts`, `src/middleware/access.test.ts`
- **Verification:** All 8 tests pass after fix; cache isolation confirmed.
- **Committed in:** `87aaff5` (GREEN implementation commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Fix was necessary for test correctness — without it, 4/8 tests would have false results. No scope creep; the helper is clearly test-scoped via naming convention.

## Issues Encountered

- Deno project required `/// <reference lib="deno.ns" />` triple-slash directive in test file to expose `Deno` namespace (project's `deno.json` targets `esnext/dom` libs, not `deno.ns`). This is Deno's standard pattern for test files in non-NS lib configs.

## Next Phase Readiness

- `checkAccess()` and `AccessResult` are exported and ready for Phase 3 handler integration
- Caller contract established: invoke after `validateAuth()`, before `request.arrayBuffer()` (ACL-07)
- Handler pattern documented in 02-RESEARCH.md Pattern 2: always return 403 (not 401) on `!access.allowed`
- No blockers for Phase 3

## Self-Check: PASSED

- `src/middleware/access.ts` exists: FOUND
- `src/middleware/access.test.ts` exists: FOUND
- `02-01-SUMMARY.md` exists: FOUND
- Commit `98f1c67` (RED tests): FOUND
- Commit `87aaff5` (GREEN implementation): FOUND
- `checkAccess`, `AccessResult`, `_resetAccessCacheForTesting` all exported: CONFIRMED
- `requiresPayment` not set in any return statement: CONFIRMED
- Public branch code does not call `cache.whitelist.has()`: CONFIRMED (line 109 is a comment, not code)
- Private branch code does not call `cache.blacklist.has()`: CONFIRMED (line 119 is a comment, not code)
- All 8 tests pass: CONFIRMED (`deno test` output: 8 passed | 0 failed)

---
*Phase: 02-access-logic*
*Completed: 2026-02-24*
