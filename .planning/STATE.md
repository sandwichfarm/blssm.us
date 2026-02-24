# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Server operator can control exactly who is allowed to publish blobs
**Current focus:** Phase 2 — Access Logic

## Current Position

Phase: 2 of 3 (Access Logic)
Plan: 1 of TBD in current phase
Status: In progress
Last activity: 2026-02-24 — Plan 02-01 complete

Progress: [██░░░░░░░░] 20%

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 8 min
- Total execution time: 0.13 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-config-foundation | 1 | 8 min | 8 min |
| 02-access-logic | 1 | 2 min | 2 min |

**Recent Trend:**
- Last 5 plans: 8 min, 2 min
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Config in Bunny Storage (not env vars): Lists can be long, matches blocked.json pattern
- Gate write endpoints only: Reads stay public per Blossom philosophy
- Compose with payments, don't implement them: Payment verification is separate concern
- Warn-and-skip for invalid pubkeys: invalid entries logged and excluded, valid entries preserved (not all-or-nothing fallback)
- Default to public mode on missing/malformed config/access.json: safe open default
- Set<string> in AccessCache (not string[]): O(1) membership lookup for Phase 2 checkAccess()
- [Phase 02-access-logic]: AccessResult exported from access.ts (not types.ts): co-located with checkAccess(); promotes to types.ts only if multiple modules need the type independently
- [Phase 02-access-logic]: Cache reset helper _resetAccessCacheForTesting() exported for test isolation of module-level accessCache singleton

### Pending Todos

None yet.

### Blockers/Concerns

- Three-mode payment composition (public+payment mode): `verifyLightningPayment` always returns false. Public+payment mode will block everyone not on whitelist until payments are wired. Must be documented in code comments.

## Session Continuity

Last session: 2026-02-24
Stopped at: Completed 02-01-PLAN.md (checkAccess() decision function + AccessResult type)
Resume file: None
