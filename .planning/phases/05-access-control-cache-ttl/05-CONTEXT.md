# Phase 5: Access Control + Cache TTL - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Extend checkAccess() with a new "public+payments" mode where whitelisted pubkeys upload free, blacklisted are denied (403), and unlisted pubkeys receive a payment-required signal. Wire configurable cache TTL from Phase 4's cache.json into existing access and blocked hash caches. Existing public and private modes must produce identical HTTP responses.

</domain>

<decisions>
## Implementation Decisions

### Payment mode activation
- New `payments` boolean field in access.json: `{"public": true, "payments": true, "whitelist": [...], "blacklist": [...]}`
- Added to AccessConfig type alongside existing fields
- Default: false when field is missing (silent backward compatibility, no log noise on upgrade)
- Independent of payment.json — access layer signals "needs payment" regardless of whether payment config exists; payment middleware handles the rest
- If payments=true but public=false (private mode): log warning and force payments=false in normalized config. Private mode means only whitelist — paying doesn't change that.

### Backward compatibility
- Silent upgrade: no log messages about new features when payments field is absent
- Test suite refactored to cover all modes systematically (public, private, public+payments) rather than preserving existing tests as-is
- Central cache loader: one place loads cache.json and passes TTL values to each cache module (access, blocked, payment), rather than each module loading independently

### Access result signaling
- Machine-readable reason strings (e.g., "payment_required") rather than human-readable sentences
- checkAccess() takes an action parameter: checkAccess(config, pubkey, action) where action is "upload" | "mirror" | "delete"
- This lets the access layer know delete is always free (Phase 4 decision) and only signal payment-required for upload/mirror on unlisted pubkeys

### Claude's Discretion
- Access result type shape (new variant with requiresPayment flag vs three-state enum vs other approach)
- Whether payment config details (amount, mints) are included in the access result or fetched separately by middleware
- Internal type changes for existing modes (as long as HTTP responses stay identical)
- Exact test organization structure for the refactored suite

</decisions>

<specifics>
## Specific Ideas

- The normalizer should handle the private+payments case at normalization time (force payments=false) so downstream code can trust the field directly without re-checking public
- Central TTL loader avoids each module independently fetching cache.json — single source of truth for all TTL values

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-access-control-cache-ttl*
*Context gathered: 2026-02-24*
