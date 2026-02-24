# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Server operator can control exactly who is allowed to publish blobs
**Current focus:** v1.1 Phase 4 — Payment Config + Types

## Current Position

Milestone: v1.1 Payments & Cache
Phase: 4 of 7 (Payment Config + Types)
Plan: 0 of ? in current phase
Status: Ready to plan
Last activity: 2026-02-24 — v1.1 roadmap created, Phase 4 ready for planning

Progress: [███░░░░░░░] 30% (3/10 total plans complete across all milestones)

## Performance Metrics

**Velocity:**
- Total plans completed: 3
- Average duration: 4 min
- Total execution time: 0.20 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-config-foundation | 1 | 8 min | 8 min |
| 02-access-logic | 1 | 2 min | 2 min |
| 03-endpoint-wiring | 1 | 10 min | 10 min |

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

### Pending Todos

None.

### Blockers/Concerns

- [Phase 6]: NUT-09 hash_to_curve exact calling convention is LOW confidence — must verify against spec before writing Y-value computation
- [Phase 6]: Cashu proof consumption endpoint unclear (NUT-07 checkstate-only vs NUT-03 swap) — clarify during Phase 6 planning

## Session Continuity

Last session: 2026-02-24
Stopped at: Roadmap created for v1.1, Phase 4 ready to plan
Resume file: None
