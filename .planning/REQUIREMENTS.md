# Requirements: blssm.us — Access Control

**Defined:** 2026-02-24
**Core Value:** The server operator can control exactly who is allowed to publish blobs

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Configuration

- [ ] **CFG-01**: Server loads access control config from `config/access.json` in Bunny Storage
- [ ] **CFG-02**: Config is cached with 60s TTL matching existing `blocked.json` pattern
- [ ] **CFG-03**: Config includes `public` boolean (true = open to all, false = whitelist only)
- [ ] **CFG-04**: Config includes `whitelist` array of hex pubkeys
- [ ] **CFG-05**: Config includes `blacklist` array of hex pubkeys
- [ ] **CFG-06**: Server rejects npub-formatted pubkeys in config with a logged warning and skips them
- [ ] **CFG-07**: Missing `config/access.json` defaults to public mode with empty lists (backward compatible)

### Access Logic

- [ ] **ACL-01**: In public mode, any authenticated pubkey can publish unless blacklisted
- [ ] **ACL-02**: In public mode, blacklisted pubkeys receive 403 Forbidden
- [ ] **ACL-03**: In public mode, whitelist is ignored (no effect)
- [ ] **ACL-04**: In private mode, only whitelisted pubkeys can publish
- [ ] **ACL-05**: In private mode, non-whitelisted pubkeys receive 403 Forbidden
- [ ] **ACL-06**: In private mode, blacklist is ignored (no effect)
- [ ] **ACL-07**: Access check runs after auth validation but before request body is read

### Endpoint Gating

- [ ] **GATE-01**: Access control gates PUT /upload (BUD-02)
- [ ] **GATE-02**: Access control gates PUT /mirror (BUD-04)
- [ ] **GATE-03**: Access control gates PUT /media (BUD-05)
- [ ] **GATE-04**: Access control gates HEAD /upload preflight (BUD-06)
- [ ] **GATE-05**: Access control gates HEAD /media preflight
- [ ] **GATE-06**: PUT /report is NOT gated by access control
- [ ] **GATE-07**: All GET/HEAD blob retrieval remains public (no access control)
- [ ] **GATE-08**: Denied requests return 403 with JSON error body, not 401

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
| CFG-01 | Phase 1 | Pending |
| CFG-02 | Phase 1 | Pending |
| CFG-03 | Phase 1 | Pending |
| CFG-04 | Phase 1 | Pending |
| CFG-05 | Phase 1 | Pending |
| CFG-06 | Phase 1 | Pending |
| CFG-07 | Phase 1 | Pending |
| ACL-01 | Phase 2 | Pending |
| ACL-02 | Phase 2 | Pending |
| ACL-03 | Phase 2 | Pending |
| ACL-04 | Phase 2 | Pending |
| ACL-05 | Phase 2 | Pending |
| ACL-06 | Phase 2 | Pending |
| ACL-07 | Phase 2 | Pending |
| GATE-01 | Phase 3 | Pending |
| GATE-02 | Phase 3 | Pending |
| GATE-03 | Phase 3 | Pending |
| GATE-04 | Phase 3 | Pending |
| GATE-05 | Phase 3 | Pending |
| GATE-06 | Phase 3 | Pending |
| GATE-07 | Phase 3 | Pending |
| GATE-08 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-24*
*Last updated: 2026-02-24 after roadmap creation*
