# Phase 6: Payment Middleware - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

The payment middleware issues BUD-07 compliant 402 responses and validates Cashu proofs against the issuing mint. This phase covers: 402 response construction, Cashu proof verification, mint trust configuration, and dynamic pricing. Lightning payment verification and advanced payment features are out of scope.

</domain>

<decisions>
## Implementation Decisions

### 402 Response Shape
- Headers only, strict BUD-07 compliance — no JSON body
- X-Cashu header with NUT-18 encoded payment request, amount based on file size
- Omit X-Lightning header entirely until Lightning is actually wired up (no stub)
- Fresh quote generated per request — stateless, no caching of quotes
- Always include Cache-Control: no-store

### Mint Trust & Config
- Accepted mints configured in a TOML config file
- Support multiple accepted mints — client proofs from any configured mint are valid
- Config file holds mint list with URLs and optional metadata

### Proof Validation Flow
- When mint is unreachable during verification: reject with 503 + Retry-After header — never accept unverified proofs
- Local cache of redeemed proof secrets for fast-reject of known-spent proofs before calling mint swap endpoint
- Mint swap endpoint is the authoritative double-spend check

### Dynamic Pricing
- USD cost basis: operator sets cost_per_gb_usd, profit_margin_pct, and slippage_premium_pct in TOML config
- BTC/USD price fetched from dual sources (CoinGecko + exchange API like Coinbase/Kraken), averaged when both available, fallback to whichever is up
- Price feed runs on a 5-minute cron, writes to a static file that the server reads — no per-request API calls
- Final sat price = (file_size_gb × cost_per_gb_usd × (1 + margin) × (1 + slippage)) / btc_usd_price × 100_000_000
- Minimum charge: 1 sat floor regardless of file size

### Claude's Discretion
- Whether to advertise accepted mint URLs in the X-Cashu NUT-18 payment request (based on spec expectations)
- Overpayment handling (accept as tip vs reject vs return change)
- Where in the request flow proof validation happens (inline header on upload vs separate endpoint) — based on BUD-07 spec
- Price feed cron implementation details (systemd timer, internal scheduler, etc.)
- TOML config file location and naming convention

</decisions>

<specifics>
## Specific Ideas

- Price feed should be resilient: average both sources when available, degrade gracefully to single source
- The cron-to-static-file pattern avoids coupling the server to external API availability at request time
- Operator should be able to reason about pricing in familiar USD terms, not raw sats

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-payment-middleware*
*Context gathered: 2026-02-24*
