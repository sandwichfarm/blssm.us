# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-24)

**Core value:** Server operator can control exactly who is allowed to publish blobs
**Current focus:** v1.1 Phase 7 — Handler Wiring

## Current Position

Milestone: v1.1 Payments & Cache
Phase: 7 of 7 (Handler Wiring) — COMPLETE
Plan: 2 of 2 plans done
Status: Phase 7 Plan 2 complete (all four write handlers wired with BUD-07 payment flow)
Last activity: 2026-02-25 — Phase 7 Plan 2 complete (blob-upload, mirror, media, upload-check payment wiring)

Progress: [██████████] 100% (11/11 total plans complete across all milestones)

## Performance Metrics

**Velocity:**
- Total plans completed: 10
- Average duration: 4 min
- Total execution time: 0.73 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-config-foundation | 1 | 8 min | 8 min |
| 02-access-logic | 1 | 2 min | 2 min |
| 03-endpoint-wiring | 1 | 10 min | 10 min |
| 04-payment-config-types | 1 | 2 min | 2 min |
| 05-access-control-cache-ttl | 2 | 4 min | 2 min |
| 06-payment-middleware | 3 (of 3) | 17 min | 5.7 min |
| 07-handler-wiring | 2 (of 2) | 4 min | 2 min |

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
- checkAccess threads optional ttlMs through to loadAccessConfig (single TTL injection point per call)
- HEAD /upload 402 uses X-Reason: payment_required with no body (BUD-06 HEAD responses must be bodyless)
- 402 handler stubs are minimal — Phase 6 replaces with full BUD-07 format (X-Cashu, X-Lightning headers)
- setInterval (not Deno.cron) for BTC price feed cron — runtime portability
- computeSatPrice uses 1-sat floor: Math.max(1, ceil(...)) — prevents zero pricing on tiny files
- loadPricingConfig defaults entire [pricing] section on any invalid field (matches payment-config.ts reject-all pattern)
- deno.ns reference directive required on non-test files that use Deno.readTextFile/writeTextFile
- deno.ns reference directive also required in test files that use Deno.test (not just non-test files)
- buildPaymentRequired takes raw params (not config struct) for testability and explicitness
- X-Lightning omitted from 402 until Lightning verification is wired (honored in Phase 6 Plan 2)
- NUT-18 PaymentRequest: singleUse=true for stateless fresh quote per request — no quote caching
- cashu-ts v3 exports Wallet/Mint not CashuWallet/CashuMint; rollup d.ts wraps exports requiring @ts-ignore
- validateTokenStructure exported as pure function for unit-testable proof validation without network calls
- Overpayment accepted as tip — wallet.receive() consumes all proofs, server discards returned new proofs
- paymentGate() accepts optional deps parameter for test injection (Deno lacks module-level mocking)
- paymentGate() fails open on null BTC price — startup race safety, mint still validates cryptographically
- 411 returned for missing Content-Length on PUT handlers (not 0-fallback) — file size required for pricing
- Mirror SC4 exception: JSON body parsed before access check to get URL for remote HEAD pricing
- HEAD preflights use buildPaymentRequired() directly, never paymentGate() — proof consumption forbidden on HEAD
- X-Content-Length (not Content-Length) used for HEAD preflight size — BUD-06 HEAD convention

### Pending Todos

None.

### Blockers/Concerns

- [Phase 6]: NUT-09 hash_to_curve exact calling convention is LOW confidence — must verify against spec before writing Y-value computation
- [Phase 6]: Cashu proof consumption endpoint unclear (NUT-07 checkstate-only vs NUT-03 swap) — clarify during Phase 6 planning

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 07-02-PLAN.md (all four write handlers wired with BUD-07 payment flow)
Resume file: None
