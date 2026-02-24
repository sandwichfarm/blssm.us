---
phase: 01-config-foundation
plan: 01
subsystem: api
tags: [deno, typescript, bunny-storage, access-control, caching]

# Dependency graph
requires: []
provides:
  - AccessConfig interface in src/types.ts (public: boolean, whitelist: string[], blacklist: string[])
  - loadAccessConfig() function in src/middleware/access.ts with 60s TTL cache
  - AccessCache struct with Set<string> whitelist and blacklist for O(1) lookup
affects:
  - 01-02 (checkAccess middleware depends on loadAccessConfig and AccessCache)
  - 01-03 (endpoint wiring depends on loadAccessConfig)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TTL cache pattern: module-level nullable cache var checked against Date.now(), matches isBlocked() in metadata.ts
    - Warn-and-skip validation: invalid pubkeys are logged and excluded rather than causing fallback to defaults
    - Default on missing: null/absent config returns safe public defaults (public=true, empty lists)

key-files:
  created:
    - src/middleware/access.ts
  modified:
    - src/types.ts

key-decisions:
  - "Warn-and-skip for invalid pubkeys: invalid entries are logged with console.warn and excluded; valid entries are preserved (not all-or-nothing fallback)"
  - "Default to public mode when config/access.json is missing or malformed: safe open default matches intended Blossom server behavior"
  - "Set<string> in AccessCache (not string[]): pre-built sets provide O(1) membership lookup for Phase 2 checkAccess()"

patterns-established:
  - "TTL cache pattern: let cache: T | null = null; const TTL = 60_000; if (cache && now < cache.expires) return cache;"
  - "Pubkey normalization: filterPubkeys() validates with isValidPubkey(), warns on invalid, returns only valid hex-64 strings"
  - "Config normalization: normalizeAccessConfig() accepts unknown, handles null/missing, defaults invalid fields"

requirements-completed: [CFG-01, CFG-02, CFG-03, CFG-04, CFG-05, CFG-06, CFG-07]

# Metrics
duration: 8min
completed: 2026-02-24
---

# Phase 1 Plan 01: Config Foundation — AccessConfig Type and loadAccessConfig Loader Summary

**AccessConfig interface and loadAccessConfig() with 60s TTL cache, pubkey normalization via isValidPubkey(), and Set-based O(1) lookup for Phase 2**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-24T10:21:00Z
- **Completed:** 2026-02-24T10:29:45Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `AccessConfig` interface to `src/types.ts` (public: boolean, whitelist: string[], blacklist: string[]) after `BlockedConfig`
- Created `src/middleware/access.ts` exporting `loadAccessConfig(storage)` with 60s TTL cache matching `isBlocked()` in `metadata.ts`
- `normalizeAccessConfig()` handles null/missing config/access.json returning public-mode defaults (CFG-07)
- `filterPubkeys()` validates with `isValidPubkey()`, logs `console.warn` for npub/invalid entries, excludes them from result (CFG-06)
- `AccessCache` struct exposes `whitelist: Set<string>` and `blacklist: Set<string>` for O(1) lookup in Phase 2 (CFG-05)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add AccessConfig interface and loadAccessConfig loader** - `35677ec` (feat)

**Plan metadata:** (pending — docs commit)

## Files Created/Modified

- `src/types.ts` - Added `AccessConfig` interface after `BlockedConfig`
- `src/middleware/access.ts` - New file: TTL cache loader with normalization and pubkey filtering

## Decisions Made

- **Warn-and-skip for invalid pubkeys:** Invalid entries are logged with `console.warn` and excluded from the normalized config rather than causing a full fallback to defaults. This resolves the "Config validation strictness decision" blocker from STATE.md.
- **Default to public mode on missing/malformed config:** `normalizeAccessConfig(null)` returns `{ public: true, whitelist: [], blacklist: [] }`, matching the safe-open Blossom server default.
- **Set-based cache struct:** `AccessCache` stores pre-built `Set<string>` for whitelist and blacklist so Phase 2 `checkAccess()` gets O(1) membership tests without re-constructing Sets on each request.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `AccessConfig` and `loadAccessConfig()` are ready for Phase 2 (`checkAccess()` middleware)
- `loadAccessConfig()` accepts `StorageClient` parameter — same DI pattern as all other storage functions
- Resolved blocker: "Config validation strictness decision" — chose warn-and-skip (not warn-and-fallback-to-defaults)
- Remaining concern: Three-mode payment composition (`verifyLightningPayment` always returns false) is unchanged — documented in STATE.md

## Self-Check: PASSED

- FOUND: src/types.ts (contains AccessConfig interface)
- FOUND: src/middleware/access.ts (exports loadAccessConfig)
- FOUND: .planning/phases/01-config-foundation/01-01-SUMMARY.md
- FOUND: commit 35677ec (feat: AccessConfig + loadAccessConfig)
- FOUND: commit dc15d02 (docs: plan metadata)
- deno check src/main.ts — PASSED
- deno check src/middleware/access.ts — PASSED

---
*Phase: 01-config-foundation*
*Completed: 2026-02-24*
