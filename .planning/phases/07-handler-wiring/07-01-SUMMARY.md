---
phase: 07-handler-wiring
plan: 01
subsystem: middleware/payment-gate
tags: [payment, cashu, middleware, tdd, startup]
dependency_graph:
  requires:
    - 06-01 (payment-config.ts — loadPaymentConfig, paymentsEnabled)
    - 06-02 (payments.ts — buildPaymentRequired)
    - 06-03 (proof-validator.ts — validateCashuPayment, buildPaymentError)
    - 06-01 (price-feed.ts — loadPricingConfig, readBtcUsdPrice, computeSatPrice, startPriceFeedCron)
  provides:
    - paymentGate() shared function for all write handlers (Plan 02)
    - startPriceFeedCron() wired at server startup (BTC price available at request time)
  affects:
    - src/main.ts (startPriceFeedCron wired)
    - Phase 07 Plan 02 (handler wiring depends on paymentGate)
tech_stack:
  added: []
  patterns:
    - TDD RED-GREEN-REFACTOR for payment-gate.ts
    - Dependency injection via optional deps parameter (pricePath, pricingTomlPath, validatePayment)
    - Fail-open on missing BTC price file (startup race safety)
    - Same Response|null return pattern as checkAccess() in access.ts
key_files:
  created:
    - src/middleware/payment-gate.ts
    - src/middleware/payment-gate.test.ts
  modified:
    - src/main.ts
decisions:
  - paymentGate() accepts optional deps parameter for test injection (avoids module-level mocking, matches Deno limitations)
  - Fail-open on null BTC price: startup race is safe because mint still validates proofs cryptographically
  - PRICE_PATH and PRICING_TOML_PATH defined as module constants (same hardcoding pattern as PAYMENT_CACHE_TTL_MS)
  - startPriceFeedCron placed after StorageClient creation, before BunnySDK.net.http.serve (fire-and-forget)
metrics:
  duration: 2 min
  completed: 2026-02-25
  tasks_completed: 2
  files_created: 2
  files_modified: 1
---

# Phase 7 Plan 1: paymentGate() Central Integration Point Summary

**One-liner:** paymentGate() as shared 402-or-validate middleware using dependency injection for testability, with startPriceFeedCron() wired at server startup.

## Tasks Completed

| Task | Description | Commit | Status |
|------|-------------|--------|--------|
| 1 | TDD — paymentGate() RED-GREEN-REFACTOR | 200d3e1 | Done |
| 2 | Wire startPriceFeedCron into main.ts | 8d49c69 | Done |

## What Was Built

### src/middleware/payment-gate.ts

The central payment decision function `paymentGate(request, storage, fileSizeBytes, deps?)` integrates all Phase 6 middleware into a single gating function:

1. Loads payment config via `loadPaymentConfig(storage)`
2. Short-circuits (returns null) if `paymentsEnabled()` is false
3. Loads pricing config via `loadPricingConfig(pricingTomlPath)`
4. Reads BTC/USD price via `readBtcUsdPrice(pricePath)` — returns null (fail open) if unavailable
5. Checks `X-Cashu` header — returns 402 via `buildPaymentRequired()` if absent
6. Validates proof via `validateCashuPayment()` — returns 400/503 via `buildPaymentError()` on failure
7. Returns null on valid proof (handler proceeds)

**Design choice:** Optional `deps` parameter (pricePath, pricingTomlPath, validatePayment) enables test injection without module-level mocking — Deno's limitation.

### src/middleware/payment-gate.test.ts

7 unit tests covering all flow branches:
- Payments disabled (no mints) → null
- Missing payment.json → null
- BTC price file missing (fail open) → null
- No X-Cashu header → 402 with NUT-18 X-Cashu + Cache-Control: no-store
- Valid proof (mocked) → null
- Invalid proof → 400 with X-Reason + Cache-Control: no-store
- Mint unreachable → 503 with X-Reason + Retry-After + Cache-Control: no-store

### src/main.ts

Added `startPriceFeedCron(PRICE_PATH)` wiring:
- Import added from `./middleware/price-feed.ts`
- `PRICE_PATH = "/tmp/btc-price.json"` constant defined
- Called after `StorageClient` creation, before `BunnySDK.net.http.serve()`
- Fire-and-forget: first tick runs immediately, then every 5 minutes via `setInterval`

## Verification

- `deno test --allow-read --allow-write --allow-net src/middleware/payment-gate.test.ts` — 7/7 pass
- `deno check src/middleware/payment-gate.ts` — clean
- `deno check src/main.ts` — clean
- `deno test --allow-read --allow-write --allow-net src/middleware/` — 87/87 pass (all existing tests still pass)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `src/middleware/payment-gate.ts` exists
- [x] `src/middleware/payment-gate.test.ts` exists (7 tests, >50 lines)
- [x] `src/main.ts` contains `startPriceFeedCron`
- [x] Commit 200d3e1 exists (Task 1)
- [x] Commit 8d49c69 exists (Task 2)
- [x] paymentGate() imports from payment-config, price-feed, payments, proof-validator only (no new external dependencies)
