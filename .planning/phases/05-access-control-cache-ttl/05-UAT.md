---
status: complete
phase: 05-access-control-cache-ttl
source: [05-01-SUMMARY.md, 05-02-SUMMARY.md]
started: 2026-02-24T16:00:00Z
updated: 2026-02-24T16:15:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Public+payments mode activation
expected: Setting `"payments": true` alongside `"public": true` in access config enables public+payments mode. checkAccess returns `requiresPayment: true` for unlisted pubkeys on upload/mirror actions.
result: pass

### 2. Whitelisted pubkey bypasses payment
expected: In public+payments mode, a whitelisted pubkey calling checkAccess with action="upload" gets `allowed: true` — no payment required, free upload.
result: pass

### 3. Blacklisted pubkey gets 403 not 402
expected: In public+payments mode, a blacklisted pubkey gets `allowed: false` with reason "blacklisted" — NOT `requiresPayment`. Blacklist always takes priority over payment routing.
result: pass

### 4. Delete action always free in payments mode
expected: In public+payments mode, an unlisted pubkey with action="delete" gets `allowed: true` — delete is free even when upload/mirror would require payment.
result: pass

### 5. Existing public mode unchanged
expected: With `public: true, payments: false` (or payments absent), checkAccess behaves exactly as before — all pubkeys allowed, no payment signals.
result: pass

### 6. Private mode unchanged
expected: With `public: false`, checkAccess behaves exactly as before — only whitelisted pubkeys allowed, blacklisted denied. payments field is irrelevant.
result: pass

### 7. Private + payments=true invariant
expected: Setting `payments: true` with `public: false` triggers a console.warn and forces payments to false. Private mode never has payment routing.
result: pass

### 8. Handler 402 response on requiresPayment
expected: blob-upload, mirror, and media handlers return HTTP 402 with `Cache-Control: no-store` and `{"message":"payment_required"}` body when checkAccess returns requiresPayment.
result: pass

### 9. HEAD /upload 402 response
expected: upload-check handler returns HTTP 402 with `X-Reason: payment_required` header and no body when requiresPayment is true (BUD-06 HEAD compliance).
result: pass

### 10. Cache TTL is configurable
expected: loadAccessConfig, loadPaymentConfig, and isBlocked all accept an optional `ttlMs` parameter. When omitted, they default to 60s. When provided, they use the custom TTL.
result: pass

## Summary

total: 10
passed: 10
issues: 0
pending: 0
skipped: 0

## Gaps

[none yet]
