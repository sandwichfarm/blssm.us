# Requirements: blssm.us — Access Control

**Defined:** 2026-02-24
**Core Value:** The server operator can control exactly who is allowed to publish blobs

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Configuration

- [x] **CFG-01**: Server loads access control config from `config/access.json` in Bunny Storage
- [x] **CFG-02**: Config is cached with 60s TTL matching existing `blocked.json` pattern
- [x] **CFG-03**: Config includes `public` boolean (true = open to all, false = whitelist only)
- [x] **CFG-04**: Config includes `whitelist` array of hex pubkeys
- [x] **CFG-05**: Config includes `blacklist` array of hex pubkeys
- [x] **CFG-06**: Server rejects npub-formatted pubkeys in config with a logged warning and skips them
- [x] **CFG-07**: Missing `config/access.json` defaults to public mode with empty lists (backward compatible)

### Access Logic

- [x] **ACL-01**: In public mode, any authenticated pubkey can publish unless blacklisted
- [x] **ACL-02**: In public mode, blacklisted pubkeys receive 403 Forbidden
- [x] **ACL-03**: In public mode, whitelist is ignored (no effect)
- [x] **ACL-04**: In private mode, only whitelisted pubkeys can publish
- [x] **ACL-05**: In private mode, non-whitelisted pubkeys receive 403 Forbidden
- [x] **ACL-06**: In private mode, blacklist is ignored (no effect)
- [x] **ACL-07**: Access check runs after auth validation but before request body is read

### Endpoint Gating

- [x] **GATE-01**: Access control gates PUT /upload (BUD-02)
- [x] **GATE-02**: Access control gates PUT /mirror (BUD-04)
- [x] **GATE-03**: Access control gates PUT /media (BUD-05)
- [x] **GATE-04**: Access control gates HEAD /upload preflight (BUD-06)
- [x] **GATE-05**: Access control gates HEAD /media preflight
- [x] **GATE-06**: PUT /report is NOT gated by access control
- [x] **GATE-07**: All GET/HEAD blob retrieval remains public (no access control)
- [x] **GATE-08**: Denied requests return 403 with JSON error body, not 401

## v2 Requirements

### Payment Composing

- **PAY-01**: In public+payments mode, whitelist pubkeys bypass payment requirement
- **PAY-02**: In public+payments mode, blacklisted pubkeys are banned regardless of payment
- **PAY-03**: In private mode, payment logic is ignored entirely
- **PAY-04**: Access check returns typed result indicating "payment required" vs "denied" vs "allowed"

### Operational

- **OPS-01**: Admin can add/remove pubkeys via API endpoint (no config file editing)
- **OPS-02**: Config changes take effect immediately (bypass TTL cache)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Read-side access control | Breaks CDN caching, conflicts with Blossom public-read philosophy |
| Admin UI | Operators are technical enough to edit JSON in Bunny Storage |
| Per-endpoint granularity | Same rules for all write endpoints; unnecessary complexity |
| Invite codes | Over-engineering for current needs |
| NIP-05 / Web of Trust verification | Adds external dependencies, not needed for hex pubkey lists |
| npub format support in config | Protocol uses hex; accepting npub creates silent failure risk |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CFG-01 | Phase 1 | Complete |
| CFG-02 | Phase 1 | Complete |
| CFG-03 | Phase 1 | Complete |
| CFG-04 | Phase 1 | Complete |
| CFG-05 | Phase 1 | Complete |
| CFG-06 | Phase 1 | Complete |
| CFG-07 | Phase 1 | Complete |
| ACL-01 | Phase 2 | Complete |
| ACL-02 | Phase 2 | Complete |
| ACL-03 | Phase 2 | Complete |
| ACL-04 | Phase 2 | Complete |
| ACL-05 | Phase 2 | Complete |
| ACL-06 | Phase 2 | Complete |
| ACL-07 | Phase 2 | Complete |
| GATE-01 | Phase 3 | Complete |
| GATE-02 | Phase 3 | Complete |
| GATE-03 | Phase 3 | Complete |
| GATE-04 | Phase 3 | Complete |
| GATE-05 | Phase 3 | Complete |
| GATE-06 | Phase 3 | Complete |
| GATE-07 | Phase 3 | Complete |
| GATE-08 | Phase 3 | Complete |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-24 after Phase 3 (Endpoint Wiring) completion*
