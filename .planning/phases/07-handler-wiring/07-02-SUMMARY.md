---
phase: 07-handler-wiring
plan: 02
subsystem: handlers/payment-wiring
tags: [payment, cashu, bud-07, handlers, 402, head-preflight]
dependency_graph:
  requires:
    - 07-01 (payment-gate.ts — paymentGate() shared middleware)
    - 06-02 (payments.ts — buildPaymentRequired)
    - 06-01 (payment-config.ts — loadPaymentConfig, paymentsEnabled)
    - 06-01 (price-feed.ts — loadPricingConfig, readBtcUsdPrice)
  provides:
    - Full BUD-07 compliant payment flow on all write handlers
    - HEAD preflight 402 pricing without proof consumption
  affects:
    - src/handlers/blob-upload.ts (paymentGate wired)
    - src/handlers/mirror.ts (paymentGate with remote HEAD pricing, SC4 exception)
    - src/handlers/media.ts (paymentGate wired)
    - src/handlers/upload-check.ts (buildPaymentRequired for HEAD preflights)
tech_stack:
  added: []
  patterns:
    - paymentGate() as unified 402-or-validate entry point for PUT handlers
    - SC4 exception for mirror.ts (JSON body read before access check for pricing)
    - HEAD preflights use buildPaymentRequired() directly (never consume proofs)
    - 411 on missing Content-Length for blob-upload and media (SC4 safe)
    - X-Content-Length convention for HEAD preflight size signaling (BUD-06)
key_files:
  created: []
  modified:
    - src/handlers/blob-upload.ts
    - src/handlers/mirror.ts
    - src/handlers/media.ts
    - src/handlers/upload-check.ts
decisions:
  - 411 returned for missing Content-Length on PUT handlers (not 0-fallback) — matches CONTEXT.md locked decision
  - Mirror SC4 exception approved — JSON body parsed before access check to get URL for remote HEAD pricing
  - HEAD preflights use buildPaymentRequired() directly, never paymentGate() — proof consumption forbidden on HEAD
  - X-Content-Length (not Content-Length) used for HEAD preflight size — BUD-06 HEAD convention
  - HEAD fail-open on missing BTC price or disabled payments — same pattern as paymentGate()
metrics:
  duration: 2 min
  completed: 2026-02-25
  tasks_completed: 2
  files_created: 0
  files_modified: 4
---

# Phase 7 Plan 2: Handler Wiring — Payment Gate Integration Summary

**One-liner:** All four write handlers wired with BUD-07 payment flow — PUT handlers via paymentGate(), HEAD preflights via buildPaymentRequired() with no proof consumption.

## Tasks Completed

| Task | Description | Commit | Status |
|------|-------------|--------|--------|
| 1 | Wire paymentGate into PUT handlers (blob-upload, mirror, media) | dd1dac1 | Done |
| 2 | Wire HEAD preflight 402 pricing in upload-check.ts | 0be4bc8 | Done |

## What Was Built

### src/handlers/blob-upload.ts

Stub 402 JSON response replaced with real `paymentGate()` call:
1. Content-Length checked BEFORE body read (SC4 compliant)
2. Missing Content-Length returns 411 (hard error — operator must know file size for pricing)
3. `paymentGate(request, storage, fileSizeBytes)` called — returns 402/400/503 Response or null
4. null return means proof valid — fall through to body read and upload

### src/handlers/media.ts

Identical pattern to blob-upload — stub 402 replaced with same paymentGate() call:
1. Content-Length checked BEFORE body read
2. 411 on missing Content-Length
3. paymentGate() called with file size

### src/handlers/mirror.ts

SC4-approved exception — JSON body parsed BEFORE access check (needed for remote URL):
1. JSON body parsed after auth (approved exception — body is tiny JSON, not blob)
2. `checkAccess()` runs after JSON parse
3. On `requiresPayment`: remote URL is HEAD-fetched to get Content-Length for pricing
4. HEAD failure defaults to 0 bytes (1-sat floor via computeSatPrice)
5. `paymentGate(request, storage, remoteSize)` called

Key difference from blob-upload: mirror uses remote HEAD Content-Length, not request Content-Length. No 411 for mirror — unknown remote size defaults to 0.

### src/handlers/upload-check.ts

HEAD preflight 402 wired with real NUT-18 pricing. Critical constraint honored: **never consumes a Cashu proof**.

Implementation:
1. Loads payment config via `loadPaymentConfig(storage)`
2. Returns 402 only if `paymentsEnabled()` is true AND BTC price is available
3. Uses `X-Content-Length` (not `Content-Length`) per BUD-06 HEAD convention
4. Unknown file size defaults to 0 → computeSatPrice returns 1 sat (minimum discoverable price)
5. `buildPaymentRequired()` called → response headers copied, null body per HTTP HEAD spec
6. Fail-open if payments disabled or price unavailable

**NOT imported:** `paymentGate`, `validateCashuPayment` — HEAD responses must never consume proofs.

## Verification

- `deno check src/handlers/blob-upload.ts src/handlers/mirror.ts src/handlers/media.ts src/handlers/upload-check.ts` — all 4 clean
- `deno test --allow-read --allow-write --allow-net src/middleware/` — 87/87 pass
- `blob-delete.ts` and `report.ts` confirmed unchanged (no payment imports)
- `upload-check.ts` confirmed: no `paymentGate` or `validateCashuPayment` import
- `mirror.ts` confirmed: JSON body parsed before access check (SC4 exception)
- `blob-upload.ts` and `media.ts` confirmed: Content-Length checked before body read

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `src/handlers/blob-upload.ts` modified — contains `paymentGate` import and call
- [x] `src/handlers/mirror.ts` modified — contains `paymentGate` import, SC4 JSON-before-access pattern
- [x] `src/handlers/media.ts` modified — contains `paymentGate` import and call
- [x] `src/handlers/upload-check.ts` modified — contains `buildPaymentRequired` import and call
- [x] Commit dd1dac1 exists (Task 1)
- [x] Commit 0be4bc8 exists (Task 2)
- [x] 87 middleware tests pass
- [x] `blob-delete.ts` untouched (no payment imports)
- [x] `report.ts` untouched (no payment imports)
- [x] `upload-check.ts` does NOT import `paymentGate` or `validateCashuPayment`
