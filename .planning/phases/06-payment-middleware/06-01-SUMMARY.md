---
phase: 06-payment-middleware
plan: "01"
subsystem: payments
tags: [cashu, toml, btc-price, price-feed, pricing, deno]

# Dependency graph
requires:
  - phase: 04-payment-config-types
    provides: PaymentConfig, MintEntry, PaymentAmounts types and normalization patterns
  - phase: 05-access-control-cache-ttl
    provides: CacheConfig type (PricingConfig added alongside it)
provides:
  - PricingConfig interface in src/types.ts
  - price-feed.ts module with computeSatPrice, fetchBtcUsdPrice, readBtcUsdPrice, startPriceFeedCron, loadPricingConfig
  - config/payment.toml example operator config with mints and USD-basis pricing
  - @std/toml and @cashu/cashu-ts imports in deno.json
affects: [07-phase-wiring, 06-02, 06-03]

# Tech tracking
tech-stack:
  added:
    - "@std/toml jsr:@std/toml@^1.0.0 — TOML config parsing"
    - "@cashu/cashu-ts npm:@cashu/cashu-ts@3.5.0 — Cashu proof verification (used by plans 02/03)"
  patterns:
    - "Dual-source price averaging: Promise.allSettled + average both / single if one fails / null if both fail"
    - "warn-and-skip for invalid TOML mint URLs (matches existing payment-config.ts pattern)"
    - "Default-on-invalid for pricing section (entire section defaults if any field invalid)"
    - "1-sat floor via Math.max(1, ...) in computeSatPrice"
    - "setInterval every 300_000ms for price cron (not Deno.cron — portability)"
    - "deno.ns reference directive on non-test files that use Deno.readTextFile/writeTextFile"

key-files:
  created:
    - src/middleware/price-feed.ts
    - src/middleware/price-feed.test.ts
    - config/payment.toml
  modified:
    - deno.json
    - src/types.ts

key-decisions:
  - "Used setInterval (not Deno.cron) for price feed cron — portability per research recommendation"
  - "computeSatPrice 1-sat floor: Math.max(1, ceil(...)) — prevents 0-sat price for tiny files"
  - "loadPricingConfig defaults entire pricing section on any invalid field (not field-level defaults)"
  - "Triple-slash deno.ns reference directive added to price-feed.ts since it uses Deno.readTextFile/writeTextFile"

patterns-established:
  - "Price feed writes { btc_usd: number, updated: number } JSON to local disk; startPriceFeedCron wired at Phase 7 startup"
  - "loadPricingConfig: TOML [[mints]] = array of { url } objects; warn-and-skip invalid, return string[] of HTTPS URLs"

requirements-completed: [PAY-04, PAY-08]

# Metrics
duration: 3min
completed: 2026-02-24
---

# Phase 6 Plan 01: Pricing Infrastructure Summary

**TOML-based BTC/USD pricing infrastructure with dual-source price feed, computeSatPrice, and operator mint config loading**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-24T16:44:26Z
- **Completed:** 2026-02-24T16:47:12Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Created `price-feed.ts` with five exports: computeSatPrice (1-sat floor formula), fetchBtcUsdPrice (CoinGecko + Coinbase dual-source averaging), readBtcUsdPrice (local JSON read), startPriceFeedCron (setInterval 5-minute writer), loadPricingConfig (TOML parser with warn-and-skip mints)
- Added `PricingConfig` interface to `src/types.ts` alongside CacheConfig with cost_per_gb_usd, profit_margin_pct, slippage_premium_pct fields
- Created `config/payment.toml` example operator config with two Cashu mints and default pricing parameters
- Added `@std/toml` and `@cashu/cashu-ts` to deno.json imports (cashu-ts added now to avoid Plan 02/03 deno.json conflicts)
- 15 tests covering all exported functions; all 63 middleware tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Add dependencies, PricingConfig type, TOML config loader, and computeSatPrice** - `5e943c9` (feat)
2. **Task 2: Tests for computeSatPrice and loadPricingConfig** - `f0e5299` (test)

**Plan metadata:** (docs commit — created with SUMMARY.md)

## Files Created/Modified

- `src/middleware/price-feed.ts` — Five exported functions: computeSatPrice, fetchBtcUsdPrice, readBtcUsdPrice, startPriceFeedCron, loadPricingConfig
- `src/middleware/price-feed.test.ts` — 15 tests covering sat math, TOML loading, and price file reading
- `config/payment.toml` — Example operator TOML config with two mints and USD-basis pricing params
- `deno.json` — Added @cashu/cashu-ts@3.5.0 and @std/toml@^1.0.0 imports
- `src/types.ts` — Added PricingConfig interface after CacheConfig

## Decisions Made

- Used `setInterval` (not `Deno.cron`) for the 5-minute price feed cron for runtime portability
- `computeSatPrice` uses `Math.max(1, Math.ceil(...))` — 1-sat floor prevents zero pricing on tiny files
- `loadPricingConfig` defaults the entire `[pricing]` section when any field is invalid (not field-level defaults), matching the "reject-all on invalid amounts" pattern from payment-config.ts
- Added `/// <reference lib="deno.ns" />` triple-slash directive to price-feed.ts since it directly uses `Deno.readTextFile` and `Deno.writeTextFile` (non-test file requiring Deno namespace)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added deno.ns reference directive to price-feed.ts**
- **Found during:** Task 1 (price-feed.ts creation)
- **Issue:** `deno check` failed with "Cannot find name 'Deno'" — deno.json lib config uses ["esnext", "dom", "dom.iterable"] without deno.ns. Non-test files using Deno APIs need the triple-slash directive.
- **Fix:** Added `/// <reference lib="deno.ns" />` at top of price-feed.ts. Matches the pattern test files already use.
- **Files modified:** src/middleware/price-feed.ts
- **Verification:** `deno check src/middleware/price-feed.ts` passes cleanly
- **Committed in:** `5e943c9` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for type-checking to pass. Pattern consistent with existing test files. No scope creep.

## Issues Encountered

None beyond the deno.ns reference directive auto-fix.

## User Setup Required

None - no external service configuration required for this plan.

## Next Phase Readiness

- `startPriceFeedCron` is exported but NOT wired at server startup — Phase 7 wires this during server initialization
- Plans 02 and 03 depend on `loadPricingConfig`, `computeSatPrice`, and `readBtcUsdPrice` from this plan
- `@cashu/cashu-ts` is in deno.json ready for Plan 02's Cashu proof verification
- Blockers from STATE.md still apply: NUT-09 hash_to_curve and Cashu proof consumption endpoint clarity needed before Plan 02/03

## Self-Check: PASSED

- src/middleware/price-feed.ts: FOUND
- src/middleware/price-feed.test.ts: FOUND
- config/payment.toml: FOUND
- .planning/phases/06-payment-middleware/06-01-SUMMARY.md: FOUND
- Commit 5e943c9: FOUND (feat: pricing infrastructure)
- Commit f0e5299: FOUND (test: price-feed tests)

---
*Phase: 06-payment-middleware*
*Completed: 2026-02-24*
