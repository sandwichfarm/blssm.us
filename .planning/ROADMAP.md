# Roadmap: blssm.us

## Milestones

- ✅ **v1.0 Access Control** — Phases 1-3 (shipped 2026-02-24)
- 🚧 **v1.1 Payments & Cache** — Phases 4-7 (in progress)

## Phases

<details>
<summary>✅ v1.0 Access Control (Phases 1-3) — SHIPPED 2026-02-24</summary>

- [x] Phase 1: Config Foundation (1/1 plans) — completed 2026-02-24
- [x] Phase 2: Access Logic (1/1 plans) — completed 2026-02-24
- [x] Phase 3: Endpoint Wiring (1/1 plans) — completed 2026-02-24

Full details: `milestones/v1.0-ROADMAP.md`

</details>

### 🚧 v1.1 Payments & Cache (In Progress)

**Milestone Goal:** Wire BUD-07 payment verification into the access control flow and make config caching configurable.

- [ ] **Phase 4: Payment Config + Types** - Define PaymentConfig type, config/payment.json schema, cacheTtl field, and safe defaults
- [ ] **Phase 5: Access Control + Cache TTL** - Extend checkAccess() with public+payments mode and wire configurable TTL
- [ ] **Phase 6: Payment Middleware** - Implement Cashu verification, BUD-07 compliant 402 responses, and payment error handling
- [ ] **Phase 7: Handler Wiring** - Wire payment gate into all five write handlers and integration-test the full 402 flow

## Phase Details

### Phase 4: Payment Config + Types
**Goal**: Operator can configure payment settings and the type system supports the full payment+access model
**Depends on**: Phase 3 (v1.0 complete)
**Requirements**: PAY-01, PAY-02, PAY-03, CACHE-01, CACHE-02
**Success Criteria** (what must be TRUE):
  1. Operator can create config/payment.json with accepted Cashu mints, payment amount, and unit and have the server load it
  2. When config/payment.json is absent the server behaves as if payments are disabled and no 402s are issued
  3. Operator can set cacheTtl in config/access.json to any integer including 0 and the server respects the exact TTL for both access config and blocked hash caches
  4. With cacheTtl=0, every request fetches fresh config from Bunny Storage (no stale reads)
**Plans**: TBD

### Phase 5: Access Control + Cache TTL
**Goal**: The access control layer correctly routes unlisted pubkeys to payment in public+payments mode, with blacklist always taking priority
**Depends on**: Phase 4
**Requirements**: ACL-01, ACL-02, ACL-03, ACL-04, ACL-05
**Success Criteria** (what must be TRUE):
  1. Operator can set "payments": true in access config to enable public+payments mode
  2. In public+payments mode, a whitelisted pubkey is allowed to upload without any payment headers
  3. In public+payments mode, a blacklisted pubkey receives 403 even if they include a valid payment proof
  4. In public+payments mode, an unlisted pubkey receives a signal requiring payment (not a flat 403)
  5. Existing configs with public: true or private mode behave exactly as before with no behavior change
**Plans**: TBD

### Phase 6: Payment Middleware
**Goal**: The payment middleware issues BUD-07 compliant 402 responses and validates Cashu proofs against the issuing mint
**Depends on**: Phase 5
**Requirements**: PAY-04, PAY-05, PAY-06, PAY-07, PAY-08
**Success Criteria** (what must be TRUE):
  1. A 402 response includes a valid NUT-18 encoded X-Cashu header and a BOLT-11 formatted X-Lightning header (stub)
  2. A 402 response always includes Cache-Control: no-store so the CDN never caches it
  3. A client presenting a valid Cashu proof from an accepted mint passes verification and the upload proceeds
  4. A client presenting a Cashu token from an untrusted mint receives 400 + X-Reason header
  5. A client presenting a spent or invalid Cashu proof receives 400 + X-Reason header
**Plans**: TBD

### Phase 7: Handler Wiring
**Goal**: All five write handlers enforce the payment gate end-to-end and the full 402-pay-retry flow works in integration
**Depends on**: Phase 6
**Requirements**: (integration of PAY-01 through PAY-08 and ACL-01 through ACL-05)
**Success Criteria** (what must be TRUE):
  1. An unlisted pubkey uploading a blob receives 402, submits valid Cashu proof on retry, and the upload succeeds
  2. The HEAD /upload preflight returns 402 for an unlisted pubkey but never consumes a Cashu proof
  3. Mirror, media upload, and delete endpoints all enforce the same payment gate as blob upload
  4. No write handler reads the request body before completing the access and payment checks
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 4 → 5 → 6 → 7

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Config Foundation | v1.0 | 1/1 | Complete | 2026-02-24 |
| 2. Access Logic | v1.0 | 1/1 | Complete | 2026-02-24 |
| 3. Endpoint Wiring | v1.0 | 1/1 | Complete | 2026-02-24 |
| 4. Payment Config + Types | v1.1 | 0/? | Not started | - |
| 5. Access Control + Cache TTL | v1.1 | 0/? | Not started | - |
| 6. Payment Middleware | v1.1 | 0/? | Not started | - |
| 7. Handler Wiring | v1.1 | 0/? | Not started | - |
