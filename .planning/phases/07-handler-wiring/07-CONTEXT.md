# Phase 7: Handler Wiring - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire Phase 6's payment middleware (buildPaymentRequired, validateCashuPayment) into all write handlers so the full 402-pay-retry flow works end-to-end. The handlers already have stub 402 responses and correct ordering (auth → access check → body read). This phase replaces stubs with real payment logic and adds proof validation on retry.

Handlers in scope: blob upload, mirror, media, delete (free gate), HEAD /upload, HEAD /media.
Report endpoint is explicitly exempt.

</domain>

<decisions>
## Implementation Decisions

### Pricing without body
- Use Content-Length request header to determine file size for sat price calculation
- If Content-Length is missing, return 411 Length Required (don't guess or fall back)
- For mirror: read the small JSON body to extract URL, then HEAD the remote URL to get Content-Length for pricing
- SC4 exception for mirror: reading a tiny JSON `{ url: string }` body before payment check is acceptable — SC4's intent is preventing large binary body buffering, not metadata reads

### Retry proof flow
- Client sends Cashu proof token in X-Cashu request header on retry (symmetric with 402 response's X-Cashu header)
- Shared `paymentGate()` function used by all handlers — extracts X-Cashu header, validates proof or returns 402
- paymentGate() is self-contained: loads payment config (mints, pricing, BTC price) internally, matching checkAccess() pattern
- Mint unreachable during proof validation → pass through 503 + Retry-After to client (never accept unverified proofs, don't waste client's spent proof)

### HEAD /upload and HEAD /media
- Both HEAD preflights return 402 with X-Cashu pricing header for unlisted pubkeys (client discovers price without uploading)
- HEAD /media mirrors HEAD /upload behavior exactly — consistent payment gate across all preflights
- HEAD 402 pricing: Claude's discretion on how to handle unknown file size (minimum price, omit amount, etc.)
- If client mistakenly sends X-Cashu proof header on HEAD, ignore it silently — HEAD never consumes proofs

### Report endpoint
- PUT /report (BUD-09) is always free — no payment gate, no access check
- Reports are moderation signals, not storage operations — gating them discourages abuse reporting
- Even blacklisted pubkeys can submit reports (event signature is sufficient validation)
- Report is explicitly exempt from Phase 7 wiring — "five write handlers" = four handlers + report exemption confirmation

### Claude's Discretion
- HEAD 402 pricing approach (minimum price vs omit amount vs other)
- Exact paymentGate() function signature and return type
- How to structure integration tests for the full 402-pay-retry flow
- Error response formatting details beyond what's specified

</decisions>

<specifics>
## Specific Ideas

- paymentGate() should follow the same self-contained pattern as checkAccess() — handlers call it and get back a Response or null
- The existing stub 402 responses in handlers should be replaced cleanly (not wrapped)
- Delete handler already has "always free" logic via checkAccess; no additional payment wiring needed there

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-handler-wiring*
*Context gathered: 2026-02-24*
