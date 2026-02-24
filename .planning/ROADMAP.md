# Roadmap: blssm.us — Access Control

## Overview

This milestone adds pubkey-based publish access control to an existing BUD-compliant Blossom server on Bunny CDN EdgeScript. The work is purely additive: a config loader, a decision function, and wiring into existing write handlers. Three phases deliver the capability in dependency order — config data first, access logic second, endpoint integration third.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Config Foundation** - Load and cache `config/access.json` from Bunny Storage with validation
- [ ] **Phase 2: Access Logic** - Implement `checkAccess()` decision function covering all mode/list combinations
- [ ] **Phase 3: Endpoint Wiring** - Integrate access control into all gated write handlers and verify end-to-end

## Phase Details

### Phase 1: Config Foundation
**Goal**: The server can load, cache, and validate the access control configuration from Bunny Storage
**Depends on**: Nothing (first phase)
**Requirements**: CFG-01, CFG-02, CFG-03, CFG-04, CFG-05, CFG-06, CFG-07
**Success Criteria** (what must be TRUE):
  1. Server reads `config/access.json` from Bunny Storage and exposes an `AccessConfig` typed object
  2. Config is not re-fetched on every request — a 60-second TTL cache serves repeated reads
  3. When `access.json` is absent, server defaults to public mode with empty whitelist and blacklist (no 500, no lockout)
  4. Any pubkey entry that is not a 64-character lowercase hex string is logged as a warning and skipped — it does not silently pass or hard-fail
  5. Config includes `public` boolean, `whitelist` array, and `blacklist` array with correct types
**Plans**: TBD

### Phase 2: Access Logic
**Goal**: A pure `checkAccess()` function correctly determines allow/deny for every mode and pubkey combination
**Depends on**: Phase 1
**Requirements**: ACL-01, ACL-02, ACL-03, ACL-04, ACL-05, ACL-06, ACL-07
**Success Criteria** (what must be TRUE):
  1. In public mode, any authenticated pubkey not on the blacklist receives an allow result
  2. In public mode, a blacklisted pubkey receives a deny result regardless of any other list membership
  3. In public mode, whitelist membership has no effect on the outcome
  4. In private mode, only a whitelisted pubkey receives an allow result — all others are denied
  5. In private mode, blacklist membership has no effect on the outcome
**Plans**: TBD

### Phase 3: Endpoint Wiring
**Goal**: Access control is active on all write endpoints, absent from read and report endpoints, and returns correct HTTP responses
**Depends on**: Phase 2
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06, GATE-07, GATE-08
**Success Criteria** (what must be TRUE):
  1. PUT /upload, PUT /mirror, PUT /media, HEAD /upload, HEAD /media all enforce access control — a denied pubkey receives 403 before the request body is consumed
  2. PUT /report accepts requests from pubkeys that would be denied on write endpoints — it is never gated
  3. GET and HEAD blob retrieval endpoints remain public — no pubkey check occurs
  4. A denied request returns 403 with a JSON error body, not 401
  5. Access check runs after auth validation and before any request body read on all gated endpoints
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Config Foundation | 0/TBD | Not started | - |
| 2. Access Logic | 0/TBD | Not started | - |
| 3. Endpoint Wiring | 0/TBD | Not started | - |
