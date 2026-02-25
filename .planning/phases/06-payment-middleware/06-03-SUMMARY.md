---
phase: 06-payment-middleware
plan: "03"
subsystem: payments
tags: [cashu, proof-validation, spent-cache, bud-07, tdd, deno]

# Dependency graph
requires:
  - phase: 06-01
    provides: cashu-ts dependency in deno.json, ValidationResult type scaffold
  - phase: 04-payment-config-types
    provides: PaymentConfig, MintEntry types
provides:
  - ValidationResult interface in src/types.ts
  - proof-validator.ts module with validateCashuPayment, validateTokenStructure, buildPaymentError, isProofSpent, addToSpentCache, _resetSpentCacheForTesting
affects: [07-phase-wiring]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wallet-per-mint cache via Map<string, Wallet> — avoids redundant loadMint() network calls per request"
    - "Pure validateTokenStructure function for unit-testable mint/unit/amount checks without network"
    - "Module-level Set<string> spent-proof cache — fast-reject before authoritative NUT-03 swap"
    - "wallet.receive(tokenString) — cashu-ts v3 accepts raw token string directly"
    - "buildPaymentError null-body responses — consistent with 402 headers-only BUD-07 pattern"
    - "cashu-ts 3.5.0 rollup d.ts workaround: import Wallet/Mint (not CashuWallet/CashuMint)"

key-files:
  created:
    - src/middleware/proof-validator.ts
    - src/middleware/proof-validator.test.ts
  modified:
    - src/types.ts

key-decisions:
  - "Import Wallet/Mint from cashu-ts (not CashuWallet/CashuMint) — cashu-ts v3 exports use short names; CashuWallet/CashuMint don't exist as exports"
  - "Overpayment accepted as tip — wallet.receive() consumes all proofs and server discards returned proofs (simplest stateless approach)"
  - "validateTokenStructure exported as pure function — enables thorough unit testing without network mocks"
  - "Mint-unreachable detection via error message substring matching — imperfect but sufficient for the edge case; returns 503+Retry-After"

patterns-established:
  - "proof-validator.ts: validateCashuPayment is the primary entry point for Phase 7 handler wiring"
  - "validateTokenStructure(decoded, acceptedMintUrls, requiredAmountSats) takes plain object matching Token shape"

requirements-completed: [PAY-06, PAY-07]

# Metrics
duration: 7min
completed: 2026-02-24
---

# Phase 6 Plan 03: Cashu Proof Validator Summary

**Cashu proof validation with NUT-03 swap consumption, spent-proof fast-reject cache, and BUD-07 error responses**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-24T16:51:22Z
- **Completed:** 2026-02-24T16:58:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 3

## Accomplishments

- Added `ValidationResult` interface to `src/types.ts` with `valid`, `reason`, and `status` fields
- Created `proof-validator.ts` with six exports:
  - `validateCashuPayment(tokenHeader, acceptedMintUrls, requiredAmountSats)` — full async validation + swap consumption
  - `validateTokenStructure(decoded, acceptedMintUrls, requiredAmountSats)` — pure synchronous validation (mint trust, unit, amount)
  - `buildPaymentError(result)` — builds 400/503 Response with X-Reason + Cache-Control: no-store headers
  - `isProofSpent(secrets)` — fast-reject check against local spent cache
  - `addToSpentCache(secrets)` — records consumed proof secrets
  - `_resetSpentCacheForTesting()` — test isolation helper
- Wallet-per-mint cache (`walletCache`) avoids redundant `loadMint()` network calls
- Module-level `spentSecrets` Set provides O(1) fast-reject before calling mint NUT-03 swap
- `wallet.receive(tokenString)` used directly — cashu-ts v3 accepts raw token string
- 10 unit tests all pass: 5 pure structure validation, 3 spent-cache, 2 buildPaymentError

## Task Commits

1. **Task 1: TDD — Cashu proof validator with spent-proof cache** - `f54799b` (feat)

**Plan metadata:** (docs commit — created with SUMMARY.md)

## Files Created/Modified

- `src/middleware/proof-validator.ts` — Six exported functions; wallet cache + spent-proof cache
- `src/middleware/proof-validator.test.ts` — 10 unit tests (pure functions + error responses)
- `src/types.ts` — Added ValidationResult interface after PricingConfig

## Decisions Made

- **Import `Wallet`/`Mint` not `CashuWallet`/`CashuMint`**: cashu-ts v3 exports use the short names. The plan specified `CashuWallet`/`CashuMint` which don't exist. The rollup-bundled `.d.ts` file wraps most exports in a `declare` block that TypeScript's module resolver doesn't expose as named exports. Workaround: `// @ts-ignore` on the import line + runtime-verified aliases.
- **Overpayment as tip**: `wallet.receive()` consumes all proofs and returns new ones; server discards new proofs. Simplest stateless approach per plan recommendation.
- **Pure `validateTokenStructure`**: Enables comprehensive unit testing without any network mocking or real Cashu token construction.
- **Mint-unreachable via message substring**: Error message matching for `fetch`/`network`/`ECONNREFUSED`/`timeout` — imperfect but practical, returns 503+Retry-After.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Wrong cashu-ts import names (CashuWallet/CashuMint vs Wallet/Mint)**
- **Found during:** Task 1 GREEN phase (TypeScript compilation)
- **Issue:** Plan specified `import { getDecodedToken, CashuWallet, CashuMint } from "@cashu/cashu-ts"` but cashu-ts 3.5.0 exports `Wallet` and `Mint` (not `CashuWallet`/`CashuMint`). The `.d.ts` file also has a rollup artifact where most exports are inside a `declare` block, causing TypeScript to not recognize them as named module exports even though runtime works.
- **Fix:** Changed imports to `{ getDecodedToken, Wallet, Mint }`. Added `// @ts-ignore` on the import line (TypeScript cannot resolve the d.ts exports due to rollup wrapping). Used `InstanceType<typeof Wallet>` type aliases.
- **Files modified:** src/middleware/proof-validator.ts
- **Commit:** f54799b (included in Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Required correction — plan's assumed import names do not match actual cashu-ts v3 export names. Fix is minimal and correct.

## Issues Encountered

None beyond the cashu-ts import name correction.

## User Setup Required

None.

## Next Phase Readiness

- `validateCashuPayment` is exported but NOT wired into handlers yet — Phase 7 wires this during handler updates
- `buildPaymentError` ready for use in handler 402/payment-required flows
- Phase 6 Plan 02 (402 response builder) is the remaining plan before Phase 7 wiring

## Self-Check: PASSED

- src/middleware/proof-validator.ts: FOUND
- src/middleware/proof-validator.test.ts: FOUND
- src/types.ts (ValidationResult): FOUND
- Commit f54799b: FOUND (feat: Cashu proof validator)
- 10/10 tests pass

---
*Phase: 06-payment-middleware*
*Completed: 2026-02-24*
