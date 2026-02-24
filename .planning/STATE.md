# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Server operator can control exactly who is allowed to publish blobs
**Current focus:** v1.1 Phase 5 — Access Control + Cache TTL

## Current Position

Milestone: v1.1 Payments & Cache
Phase: 5 of 7 (Access Control + Cache TTL)
Plan: 1 of 1 in current phase
Status: In progress
Last activity: 2026-02-24 — Phase 5 Plan 1 complete (checkAccess public+payments mode + AccessAction type)

Progress: [█████░░░░░] 50% (5/10 total plans complete across all milestones)

## Performance Metrics

**Velocity:**
- Total plans completed: 5
- Average duration: 5 min
- Total execution time: 0.40 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-config-foundation | 1 | 8 min | 8 min |
| 02-access-logic | 1 | 2 min | 2 min |
| 03-endpoint-wiring | 1 | 10 min | 10 min |
| 04-payment-config-types | 1 | 2 min | 2 min |
| 05-access-control-cache-ttl | 1 | 2 min | 2 min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

Recent decisions affecting v1.1:
- Cashu as primary payment method; Lightning stub remains returning false unconditionally
- public+payments mode requires explicit "payments": true opt-in flag (not inferred from payment.json presence)
- cacheTtl lives in config/access.json (not payment.json) — single location for cache config
- Cashu token replay prevention via mint /v1/checkstate (NUT-07) — no in-memory tracking (stateless edge)
- 402 responses must always include Cache-Control: no-store to prevent Bunny CDN caching
- TTL=0 in cache.json maps to 1000ms floor (not true zero) — avoids storage hammering on burst traffic
- Invalid payment amounts reject entire config (not field-level); invalid mint entries warn-and-skip
- paymentsEnabled() checks mints.length > 0 only — amounts irrelevant without a mint to verify against
- Max cache TTL cap: 86_400_000ms (24h) — reasonable operator protection
- Blacklist takes priority over payment gate: blacklisted pubkeys get 403 not 402 (security over payments)
- Delete action always free in public+payments mode (encourages storage cleanup)
- payments=true in private mode silently forced to false with console.warn (nonsensical config)

### Pending Todos

None.

### Blockers/Concerns

- [Phase 6]: NUT-09 hash_to_curve exact calling convention is LOW confidence — must verify against spec before writing Y-value computation
- [Phase 6]: Cashu proof consumption endpoint unclear (NUT-07 checkstate-only vs NUT-03 swap) — clarify during Phase 6 planning

## Session Continuity

Last session: 2026-02-24
Stopped at: Completed 05-01-PLAN.md (checkAccess public+payments mode + AccessAction type)
Resume file: None
