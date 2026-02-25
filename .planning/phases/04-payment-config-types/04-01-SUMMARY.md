---
phase: 04-payment-config-types
plan: "01"
subsystem: payment-config
tags: [types, config, normalization, caching, payments, cache-ttl]
dependency_graph:
  requires: []
  provides:
    - MintEntry interface (src/types.ts)
    - PaymentAmounts interface (src/types.ts)
    - PaymentConfig interface (src/types.ts)
    - CacheConfig interface (src/types.ts)
    - normalizePaymentConfig() (src/middleware/payment-config.ts)
    - paymentsEnabled() (src/middleware/payment-config.ts)
    - loadPaymentConfig() with TTL cache (src/middleware/payment-config.ts)
    - normalizeCacheConfig() (src/middleware/cache-config.ts)
    - loadCacheConfig() with TTL cache (src/middleware/cache-config.ts)
  affects:
    - Phase 5 will wire CacheConfig.paymentTtl into loadPaymentConfig()
    - Phase 6 will call paymentsEnabled() and loadPaymentConfig() for 402 logic
tech_stack:
  added: []
  patterns:
    - "normalizeX(raw: unknown): X — same pattern as normalizeAccessConfig()"
    - "Module-level cache with expires timestamp — same pattern as loadAccessConfig()"
    - "warn-and-skip for invalid mint entries vs reject-all for invalid amounts"
key_files:
  created:
    - src/middleware/payment-config.ts
    - src/middleware/payment-config.test.ts
    - src/middleware/cache-config.ts
    - src/middleware/cache-config.test.ts
  modified:
    - src/types.ts
decisions:
  - "TTL=0 in cache JSON maps to 1000ms floor, not true zero — prevents hammering Bunny Storage on burst traffic"
  - "Invalid amounts (negative, non-integer, non-number) reject entire payment config (not field-level) — consistent with CONTEXT.md"
  - "Invalid mint entries warn-and-skip individually — partial valid config preferred over all-or-nothing"
  - "paymentsEnabled() checks mints.length > 0 only, not amounts — can't verify proofs without a mint"
  - "Max TTL cap set to 86_400_000ms (24h) — reasonable operator cap per plan discretion"
  - "loadCacheConfig() returns CacheConfig directly (not wrapper) for downstream convenience"
metrics:
  duration: "2 min"
  completed: "2026-02-24"
  tasks_completed: 2
  files_created: 4
  files_modified: 1
---

# Phase 4 Plan 1: Payment Config + Cache Config Types Summary

**One-liner:** PaymentConfig and CacheConfig types with normalizers, warn-and-skip mint validation, reject-all amount validation, and TTL-cached loaders following the established normalizeAccessConfig() pattern.

## What Was Built

Four new source files establishing the type system and config loading infrastructure for Phases 5-7:

- **`src/types.ts`** (modified): Added `MintEntry`, `PaymentAmounts`, `PaymentConfig`, and `CacheConfig` interfaces with JSDoc
- **`src/middleware/payment-config.ts`**: `normalizePaymentConfig()`, `paymentsEnabled()`, `loadPaymentConfig()` with 60s TTL cache
- **`src/middleware/payment-config.test.ts`**: 17 tests covering PAY-01, PAY-02, PAY-03 requirements
- **`src/middleware/cache-config.ts`**: `normalizeCacheConfig()`, `loadCacheConfig()` with 60s meta-cache
- **`src/middleware/cache-config.test.ts`**: 12 tests covering CACHE-01, CACHE-02 requirements

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| TTL=0 → 1000ms floor | Avoids hammering storage on burst traffic; per CONTEXT.md |
| Invalid amounts → disable entire config | Config-level rejection consistent with spec intent |
| Invalid mint entries → warn-and-skip | Field-level recovery preferred; matches pubkey validation pattern |
| paymentsEnabled() checks mints only | Semantic: can't verify proofs without a mint (amounts are irrelevant) |
| 24h max TTL cap | Reasonable operator cap per plan's "Claude's discretion" grant |

## Test Results

All tests pass: `deno test src/middleware/` — 37 passed, 0 failed

- 8 existing ACL tests: no regression
- 17 payment config tests: PAY-01, PAY-02, PAY-03 covered
- 12 cache config tests: CACHE-01, CACHE-02 covered

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED
