---
phase: 06-payment-middleware
plan: "02"
subsystem: payments
tags: [cashu, cashu-ts, NUT-18, BUD-07, payment-required, 402]

# Dependency graph
requires:
  - phase: 06-01
    provides: computeSatPrice and PricingConfig for dynamic sat amount calculation

provides:
  - buildPaymentRequired() function in src/middleware/payments.ts
  - BUD-07 compliant 402 Response with NUT-18 X-Cashu header
  - cashu-ts PaymentRequest encoding with singleUse=true

affects:
  - 06-03 (Cashu token verification — receives payments and verifies against mints)
  - 07-handler-wiring (wires buildPaymentRequired into upload/mirror handlers)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "NUT-18 PaymentRequest constructor: new PaymentRequest(transport, id, amount, unit, mints, description, singleUse)"
    - "toEncodedRequest() produces creqA-prefixed base64url CBOR for X-Cashu header"
    - "null body 402 response: new Response(null, { status: 402, headers: {...} })"
    - "stateless quote-per-request: no caching, singleUse=true enforced"

key-files:
  created:
    - src/middleware/payments.test.ts
  modified:
    - src/middleware/payments.ts

key-decisions:
  - "X-Lightning omitted entirely until Lightning verification is wired (pre-existing decision honored)"
  - "null body (not JSON) for 402 per strict BUD-07 compliance"
  - "singleUse=true on PaymentRequest — fresh stateless quote per request, no quote caching"
  - "buildPaymentRequired takes raw params (not config object) for testability and explicitness"

patterns-established:
  - "TDD: write failing tests first, verify RED, then implement GREEN"
  - "402 response always has Cache-Control: no-store (prevents Bunny CDN caching)"

requirements-completed: [PAY-04, PAY-08]

# Metrics
duration: 7min
completed: 2026-02-24
---

# Phase 6 Plan 02: buildPaymentRequired — BUD-07 NUT-18 402 Response Builder Summary

**BUD-07 compliant 402 builder using cashu-ts PaymentRequest to encode NUT-18 X-Cashu header with dynamically computed sat pricing from price-feed module**

## Performance

- **Duration:** 7 min
- **Started:** 2026-02-24T16:50:48Z
- **Completed:** 2026-02-24T16:57:30Z
- **Tasks:** 1 (TDD: RED + GREEN phases)
- **Files modified:** 2

## Accomplishments

- Rewrote payments.ts replacing Phase 5 stubs (paymentRequired + verifyLightningPayment) with buildPaymentRequired()
- 402 response uses cashu-ts PaymentRequest.toEncodedRequest() for NUT-18 X-Cashu header (creqA prefix)
- Null body, Cache-Control: no-store, no Content-Type, no X-Lightning — strict BUD-07 compliance
- 7 TDD tests covering all trust surfaces: status, headers, body, decode round-trip

## Task Commits

Each TDD phase committed atomically:

1. **RED: Failing tests** - `53f98f5` (test)
2. **GREEN: buildPaymentRequired implementation** - `f8a9eaa` (feat)

_TDD task: RED commit (failing tests) + GREEN commit (passing implementation)_

## Files Created/Modified

- `src/middleware/payments.ts` - Rewritten: buildPaymentRequired() replacing old stubs
- `src/middleware/payments.test.ts` - Created: 7 tests for BUD-07 402 response construction

## Decisions Made

- Honored pre-existing decision: X-Lightning omitted entirely until Lightning is wired
- null body (not JSON) for 402 — strict BUD-07 interpretation per user decision
- singleUse=true on PaymentRequest — stateless fresh quote per request
- buildPaymentRequired takes raw params (fileSizeBytes, acceptedMintUrls, btcUsdPrice, pricingConfig) not a config struct — maximizes testability

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `/// <reference lib="deno.ns" />` directive to test file**
- **Found during:** Task 1 (RED phase test writing)
- **Issue:** TypeScript compiler couldn't find `Deno` namespace in test file — same issue documented in STATE.md decisions ("deno.ns reference directive required on non-test files that use Deno APIs"). Test files also require it.
- **Fix:** Added `/// <reference lib="deno.ns" />` as first line of payments.test.ts
- **Files modified:** src/middleware/payments.test.ts
- **Verification:** Type errors resolved; tests compiled and ran
- **Committed in:** 53f98f5 (RED phase commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Required for test file to compile. No scope creep.

## Issues Encountered

- Pre-existing price-feed.test.ts failures (need `--allow-write` flag) — out of scope, not caused by this plan. Logged for deferred attention.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- buildPaymentRequired() ready to be wired into upload/mirror handlers in Phase 7
- Phase 6 Plan 03 (Cashu token verification) can proceed — it will receive tokens issued against the NUT-18 payment requests built here
- Old PaymentInfo type in src/types.ts remains (Phase 7 wiring will clean up unused types)

---
*Phase: 06-payment-middleware*
*Completed: 2026-02-24*
