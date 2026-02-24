# Requirements: blssm.us

**Defined:** 2026-02-24
**Core Value:** The server operator can control exactly who is allowed to publish blobs, with clear rules that compose with the existing payment system.

## v1.1 Requirements

Requirements for BUD-07 payment middleware, public+payments access mode, and configurable cache TTL.

### Payment Config

- [ ] **PAY-01**: Operator can configure accepted Cashu mints, payment amount, and unit in config/payment.json
- [ ] **PAY-02**: Payment config loads from Bunny Storage with configurable TTL cache (same pattern as access config)
- [ ] **PAY-03**: Missing payment config defaults safely (payments disabled, no 402s)

### Payment Middleware

- [ ] **PAY-04**: Server returns BUD-07 compliant 402 with NUT-18 encoded X-Cashu header when payment required
- [ ] **PAY-05**: Server returns BOLT-11 formatted X-Lightning header alongside X-Cashu in 402 response (stub — no verification)
- [ ] **PAY-06**: Server validates Cashu payment proof by calling mint swap endpoint (double-spend safe)
- [ ] **PAY-07**: Server returns 400 + X-Reason header when payment proof is invalid, expired, or from untrusted mint
- [ ] **PAY-08**: 402 responses include Cache-Control: no-store to prevent CDN caching

### Access Control

- [ ] **ACL-01**: Operator can enable public+payments mode via payments field in access config
- [ ] **ACL-02**: In public+payments mode, whitelisted pubkeys upload free (no 402)
- [ ] **ACL-03**: In public+payments mode, blacklisted pubkeys are denied (403, not 402)
- [ ] **ACL-04**: In public+payments mode, unlisted pubkeys receive 402 payment required
- [ ] **ACL-05**: Existing public and private modes work unchanged (backward compatible)

### Cache

- [ ] **CACHE-01**: Operator can set cache TTL via config (including TTL=0 for always-fresh)
- [ ] **CACHE-02**: Configurable TTL applies to both access config and blocked hash caches

## Future Requirements

### Lightning Verification

- **LN-01**: Server verifies Lightning preimage against issued invoice payment_hash
- **LN-02**: Server integrates with external Lightning provider API for invoice issuance

### Admin API

- **ADMIN-01**: Admin can add/remove pubkeys from whitelist via API endpoint
- **ADMIN-02**: Admin can add/remove pubkeys from blacklist via API endpoint
- **ADMIN-03**: Admin endpoints authenticated by designated admin pubkey

## Out of Scope

| Feature | Reason |
|---------|--------|
| Read-side payment gating | Breaks CDN caching, conflicts with Blossom public-read philosophy |
| Local Cashu double-spend tracking | Bunny Storage has no atomic operations — race condition makes this unsafe |
| Per-blob payment amounts | Requires per-blob state correlation across stateless edge invocations |
| Subscription/recurring payments | Requires external state management; whitelist is the equivalent |
| Full Lightning verification | Requires invoice issuance infrastructure incompatible with stateless edge — deferred |
| Admin UI | Operators are technical enough to edit JSON or use API |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PAY-01 | Phase 4 | Pending |
| PAY-02 | Phase 4 | Pending |
| PAY-03 | Phase 4 | Pending |
| PAY-04 | Phase 6 | Pending |
| PAY-05 | Phase 6 | Pending |
| PAY-06 | Phase 6 | Pending |
| PAY-07 | Phase 6 | Pending |
| PAY-08 | Phase 6 | Pending |
| ACL-01 | Phase 5 | Pending |
| ACL-02 | Phase 5 | Pending |
| ACL-03 | Phase 5 | Pending |
| ACL-04 | Phase 5 | Pending |
| ACL-05 | Phase 5 | Pending |
| CACHE-01 | Phase 4 | Pending |
| CACHE-02 | Phase 4 | Pending |

**Coverage:**
- v1.1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-24 after roadmap creation*
