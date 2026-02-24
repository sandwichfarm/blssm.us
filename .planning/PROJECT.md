# blssm.us — Access Control

## What This Is

A Blossom server (BUD-compliant blob storage) using Nostr for authentication, running on Bunny CDN EdgeScript. This milestone adds publish access control — whitelist/blacklist by Nostr hex pubkey with a public/private mode toggle — to gate who can upload blobs.

## Core Value

The server operator can control exactly who is allowed to publish blobs, with clear rules that compose with the existing payment system.

## Requirements

### Validated

- ✓ Blob upload (BUD-02) — existing
- ✓ Blob retrieval (BUD-01) — existing
- ✓ Blob deletion (BUD-02) — existing
- ✓ Blob listing (BUD-02) — existing
- ✓ Mirror (BUD-04) — existing
- ✓ Media upload (BUD-05) — existing
- ✓ Content reporting (BUD-09) — existing
- ✓ Nostr auth (kind 24242 + Schnorr verification) — existing
- ✓ Content blocking (blocked.json) — existing
- ✓ BUD-07 payment response framework — existing (stub, not wired)

### Active

- [ ] Access control config stored in Bunny Storage (config/access.json)
- [ ] `public` boolean mode toggle
- [ ] Whitelist by hex pubkey
- [ ] Blacklist by hex pubkey
- [ ] Public + no payments: anyone publishes, blacklist bans pubkeys, whitelist ignored
- [ ] Public + payments: paid users publish, whitelist = free pass, blacklist = banned
- [ ] Private: only whitelisted pubkeys can publish, blacklist ignored, payments ignored
- [ ] Access control gates all write endpoints (PUT /upload, /mirror, /media) except /report

### Out of Scope

- Payment verification implementation — BUD-07 stub exists, wiring it is separate work
- Read-side access control — retrieval remains public
- Admin UI for managing lists — config file editing is sufficient
- Per-endpoint granularity — same rules apply to all gated write endpoints
- Dynamic config reloading without cache expiry — will use same TTL cache pattern as blocked.json

## Context

- Blossom server running on Bunny CDN EdgeScript (Deno runtime)
- All persistent state lives in Bunny Storage as JSON files
- Config pattern already established: `config/blocked.json` with 60s TTL cache
- Auth already extracts pubkey from Nostr kind 24242 events before handlers run
- Payment middleware exists as framework (`src/middleware/payments.ts`) but `verifyLightningPayment` returns false
- Access control needs to compose with future payment wiring — the "has paid" check is a downstream concern

## Constraints

- **Runtime**: Bunny EdgeScript (Deno) — no filesystem, no database, only Bunny Storage API
- **Config storage**: Must use Bunny Storage (same as blocked.json pattern)
- **Auth dependency**: Pubkey is only available after Nostr auth validation succeeds
- **Stateless**: Edge deployment, no in-memory state beyond TTL caches

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Config in Bunny Storage, not env vars | Lists can be long, env vars have size limits, matches existing blocked.json pattern | — Pending |
| Gate write endpoints only | Reads should remain public per Blossom philosophy | — Pending |
| Compose with payments, don't implement them | Payment verification is separate concern, keep access control focused | — Pending |

---
*Last updated: 2026-02-24 after initialization*
