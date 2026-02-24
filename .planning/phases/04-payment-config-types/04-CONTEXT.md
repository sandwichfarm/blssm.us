# Phase 4: Payment Config + Types - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Define PaymentConfig type, config/payment.json schema, config/cache.json schema, cacheTtl field, and safe defaults. Operator can configure payment settings and the type system supports the full payment+access model. Loading, caching, and wiring into access control are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Config schema design
- Mints specified as array of objects: `[{"url": "https://mint.example.com", ...}]` — allows optional per-mint fields later
- Per-action payment amounts: separate fields for upload, mirror (delete is always free)
- Unit is always satoshis — no configurable unit field
- Delete operations never require payment (encourages storage cleanup)

### Default & fallback behavior
- Missing payment.json = payments disabled, no 402s issued
- Empty file or malformed JSON = same as missing (payments disabled, no warning needed)
- Missing fields filled with defaults: missing amount defaults to 0 (free), missing mints defaults to empty array
- Amount of 0 = free, no 402 issued for that action
- Empty mints array (even with amounts set) = payments disabled entirely (can't verify proofs without mints)

### Cache TTL placement
- Separate config/cache.json file for all cache settings
- Per-cache TTLs: separate fields for access, payment, and blocked caches (e.g., accessTtl, paymentTtl, blockedTtl)
- TTL=0 means very short (1 second floor) — not true zero, avoids hammering Bunny Storage on burst traffic
- Missing config/cache.json defaults to 60 seconds for all caches (backward compatible with current hardcoded behavior)

### Config validation rules
- Invalid mint entries: skip with console warning, use remaining valid mints (matches current pubkey validation pattern)
- Mint URL validation: format check only (valid HTTPS URL), no network probing during config load
- Invalid amounts (negative or non-integer): reject entire payment config, disable payments, warn loudly
- Cache TTL values: clamp to valid range (negative → 0/floor, above max → cap)

### Claude's Discretion
- Exact TypeScript type structure and naming conventions
- Config normalization function implementation details
- Max TTL cap value
- Whether mint objects include any optional fields beyond URL in initial implementation

</decisions>

<specifics>
## Specific Ideas

- Follow existing access config patterns: `normalizeAccessConfig()` approach for payment config normalization
- Cache config is a new file (`config/cache.json`) separate from access and payment configs
- The per-action amount model means the schema needs explicit action keys (upload, mirror) — delete is excluded by design

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-payment-config-types*
*Context gathered: 2026-02-24*
