# blssm.us — Blossom Server

## What This Is

A Blossom server (BUD-compliant blob storage) using Nostr for authentication, running on Bunny CDN EdgeScript. Supports blob upload, retrieval, deletion, listing, mirroring, media upload, content reporting, and pubkey-based publish access control with whitelist/blacklist.

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
- ✓ Access control config from Bunny Storage (config/access.json) — v1.0
- ✓ Public/private mode toggle — v1.0
- ✓ Whitelist by hex pubkey — v1.0
- ✓ Blacklist by hex pubkey — v1.0
- ✓ Access control gates all write endpoints except /report — v1.0
- ✓ 60s TTL cache for access config — v1.0
- ✓ Safe defaults on missing config (public mode, empty lists) — v1.0
- ✓ Invalid pubkey warn-and-skip validation — v1.0

### Active

- [ ] BUD-07 payment middleware with pluggable verification (402 + X-Cashu/X-Lightning headers)
- [ ] Public+payments mode: whitelist = free pass, blacklist = banned, others → 402
- [ ] Configurable cache TTL (including TTL=0 for always-fresh reads)

### Out of Scope

- Read-side access control — breaks CDN caching, conflicts with Blossom public-read philosophy
- Admin UI — operators are technical enough to edit JSON or use API
- Admin API for managing pubkey lists — config file works, defer to future milestone
- Per-endpoint granularity — same rules for all gated write endpoints; unnecessary complexity
- Invite codes — over-engineering for current needs
- NIP-05 / Web of Trust verification — adds external dependencies
- npub format support in config — protocol uses hex; accepting npub creates silent failure risk

## Current Milestone: v1.1 Payments & Cache

**Goal:** Wire BUD-07 payment verification into the access control flow and make config caching configurable.

**Target features:**
- BUD-07 compliant payment middleware (402 response, X-Cashu/X-Lightning headers, payment proof validation)
- Public+payments access mode (whitelist = free, blacklist = banned, unlisted = pay)
- Configurable cache TTL with TTL=0 option for instant config changes

## Context

- Blossom server running on Bunny CDN EdgeScript (Deno runtime)
- All persistent state lives in Bunny Storage as JSON files
- Config pattern established: `config/access.json` and `config/blocked.json` with 60s TTL cache
- Auth extracts pubkey from Nostr kind 24242 events before handlers run
- Payment middleware exists as framework (`src/middleware/payments.ts`) but `verifyLightningPayment` returns false
- Access control shipped in v1.0 — config loading, decision function, and handler wiring all complete
- 8 Deno tests cover full ACL decision matrix (public/private × whitelist/blacklist combinations)

## Constraints

- **Runtime**: Bunny EdgeScript (Deno) — no filesystem, no database, only Bunny Storage API
- **Config storage**: Must use Bunny Storage (same as blocked.json pattern)
- **Auth dependency**: Pubkey is only available after Nostr auth validation succeeds
- **Stateless**: Edge deployment, no in-memory state beyond TTL caches

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Config in Bunny Storage, not env vars | Lists can be long, env vars have size limits, matches existing blocked.json pattern | ✓ Good — works well, same TTL cache pattern |
| Gate write endpoints only | Reads should remain public per Blossom philosophy | ✓ Good — clean separation |
| Compose with payments, don't implement them | Payment verification is separate concern, keep access control focused | ✓ Good — v1.0 ships clean without payment coupling |
| Warn-and-skip for invalid pubkeys | Invalid entries logged and excluded, valid entries preserved | ✓ Good — no all-or-nothing fallback |
| Default to public mode on missing config | Safe open default matches Blossom server behavior | ✓ Good — backward compatible |
| Set<string> in AccessCache | O(1) membership lookup vs array iteration | ✓ Good — clean and fast |
| AccessResult co-located in access.ts | Promote to types.ts only if multiple modules need it | ✓ Good — single consumer pattern |
| PUT: JSON error body, HEAD: X-Reason header | HTTP spec compliance — HEAD responses have no body | ✓ Good — correct per spec |
| Access gate inside if(authHeader) for preflight | Unauthenticated preflight has no pubkey to check | ✓ Good — avoids type error and false denial |

---
*Last updated: 2026-02-24 after v1.1 milestone start*
