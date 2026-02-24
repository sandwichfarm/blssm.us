# Feature Research

**Domain:** Blossom server access control (Nostr ecosystem blob storage)
**Researched:** 2026-02-24
**Confidence:** MEDIUM — Blossom is a young protocol (2024); reference implementations exist but are sparse on access control documentation. Conclusions drawn from BUD specs, relay ecosystem analogues, and concrete server implementations (umbrel-blob-box, blossom-server, khatru, nostrcheck-server). Relay patterns (NIP-11, NIP-42) are MEDIUM-HIGH confidence via official NIPs.

---

## Context: What This Milestone Is

This milestone adds **publish access control** to an existing BUD-compliant Blossom server running on Bunny CDN EdgeScript (Deno). The server already handles auth (kind 24242), content blocking (blocked.json), and has a BUD-07 payment framework stub. The active work:

- `config/access.json` stored in Bunny Storage
- `public` boolean mode toggle
- Whitelist by hex pubkey (free pass or private-only access)
- Blacklist by hex pubkey (permanent ban)
- Three behavioral modes: public-no-payment, public-with-payment, private
- Gates write endpoints (PUT /upload, /mirror, /media) — not /report or reads

---

## Feature Landscape

### Table Stakes (Operators Expect These)

Features operators assume exist. Missing these = the server feels unfinished or unusable for real deployments.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Pubkey whitelist (allowlist) | Every Blossom/relay operator reference (umbrel-blob-box, blossom-server, khatru, myriad) implements allowlist as primary gating. It's the default mental model for "who can upload here." | LOW | Config in Bunny Storage as JSON array of hex pubkeys. Pattern established by blocked.json. |
| Pubkey blacklist (denylist) | Spam is a real problem across the Nostr ecosystem — the relay world has seen 500k spam messages/day. Operators need a ban list independent of the mode they run. | LOW | Same config file as whitelist. Already partially addressed by blocked.json (hash-based), but pubkey-level banning is distinct and expected. |
| Public/private mode toggle | Personal Blossom servers (umbrel-blob-box, myriad) are private-only by default. Community servers are public. Operators need to pick a posture without code changes. | LOW | Single boolean in access.json. Already in scope per PROJECT.md. |
| Compose cleanly with payment gate | The relay ecosystem (filter.nostr.wine, expensive-relay, nerostr) universally treats payment as an overlay on top of pubkey identity, not a replacement. Operators expect whitelist = payment bypass, not whitelist = separate system. | MEDIUM | The "has paid" check is downstream (BUD-07 stub). Access control must leave a clear seam for payment wiring without re-architecting. |
| Write-only gating (reads stay public) | Core Blossom philosophy: blobs are content-addressed and public by hash. Relay philosophy matches — retrieval is generally unrestricted. Operators who want read gating are edge cases, not the norm. | LOW | Per PROJECT.md: gate PUT /upload, /mirror, /media. Keep GET /<hash> open. This is the right default. |
| Auth-required before gate check | Kind 24242 Nostr auth is the identity layer. Access control decisions are meaningless without a verified pubkey. Every implementation (khatru, umbrel-blob-box, blossom-server) validates auth before applying rules. | LOW | Already implemented. Auth middleware runs before handlers. Pubkey available when access check runs. |
| Clear HTTP error semantics | Operators and client developers expect 401 (no/bad auth), 403 (authenticated but denied), 402 (payment required). Mixing these up breaks client UX across Nostr apps. | LOW | BUD-07 specifies 402 + X-Lightning/X-Cashu headers. 403 for blacklisted/non-whitelisted. Must be consistent. |
| /report endpoint excluded from gating | BUD-09 content reporting is specifically designed to be open — it's a governance tool for operators, not a user privilege. Restricting it defeats its purpose. | LOW | Already out of scope per PROJECT.md. Confirm in implementation. |

### Differentiators (Competitive Advantage)

Features that set this server apart. Not required by the ecosystem, but valued by operators who choose this server.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Mode-aware whitelist semantics | Other servers (umbrel-blob-box, khatru) treat whitelist as binary allow/deny. This server's three-mode system (public-no-payment: blacklist only; public-with-payment: whitelist = free pass; private: whitelist = only list) is more expressive. Operators can run a community server with VIP bypass without running a separate private server. | MEDIUM | The three-mode logic is the core design. Complexity is in making the semantics clear, not in implementation (it's conditional logic). Needs clear documentation so operators understand the composing behavior. |
| Config stored in CDN storage (not env vars) | Env vars cannot hold large pubkey lists and require redeployment to change. Bunny Storage config + TTL cache pattern (already used for blocked.json) means operators can update lists without touching deployment infrastructure. This is a real operational advantage on edge deployments. | LOW | Pattern already proven. 60s TTL cache is the right tradeoff between freshness and performance. |
| EdgeScript/Deno deployment (no infrastructure) | Most Blossom servers require a VPS, database, and process management. Running on Bunny CDN EdgeScript gives operators global CDN performance with no server management. Competitive differentiator for operators who want a managed-infrastructure Blossom server. | N/A (existing) | Not new to this milestone, but the access control must preserve this advantage by staying stateless. |
| Composable payment integration (BUD-07 seam) | Payment verification is unsolved in the Blossom ecosystem — BUD-07 exists but no widely-deployed implementations are publicly documented. This server's access control is designed to leave a clean seam where "has paid" becomes a pluggable check. Operators who want to wire Lightning or Cashu later don't face a rewrite. | MEDIUM | The composition pattern (whitelist overrides payment, blacklist overrides everything) must be explicit in code and documented. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Per-endpoint access control granularity | Operators might want "whitelist for video but open for images" or "paid for large files, free for small." Seems flexible. | Creates a combinatorial config space that's hard to reason about and error-prone to configure. The relay ecosystem (NIP-11) uses global flags precisely because per-endpoint granularity causes operator confusion and client incompatibility. For this server's scope, write endpoints are functionally equivalent from an access perspective. | Gate all write endpoints uniformly. Use file-size limits (maxUploadSize in Config) for size-based control. Per-endpoint gating is a v2+ concern if operators actually request it. |
| Admin UI for managing lists | Operators want a web UI to add/remove pubkeys without editing JSON. Reasonable UX want. | Building a correct, secure admin UI is substantial scope — authentication for the admin interface itself, UI framework, state management. For this milestone it's pure scope creep. The 80% of operators willing to edit a JSON file are the early adopter persona for a self-hosted Blossom server. | Config file editing via Bunny Storage dashboard or API. Document the config schema clearly. UI is a future milestone if operator feedback confirms the pain. |
| Dynamic config reload without cache expiry | "I want changes to take effect instantly without waiting 60 seconds." Sounds like a quality improvement. | Instant config reload on edge deployments with no shared state means either polling (more Bunny Storage API calls, cost implications) or a cache-busting mechanism that adds complexity. The 60s TTL is already proven for blocked.json. Operators can tolerate a 60s propagation delay. | Keep 60s TTL cache. Document the delay explicitly. If operators report specific scenarios where 60s is painful, address then. |
| Read-side access control | "Private bucket" semantics where only whitelisted pubkeys can fetch blobs. Requested by operators wanting true private storage. | Conflicts with the core Blossom value proposition — content-addressed blobs are meant to be publicly verifiable by hash. Read gating on a CDN also breaks caching (every request needs auth, defeating CDN edge caching). The khatru and BUD specs treat read as optional auth only for listing, not for fetching. | Keep reads public. For truly private blob storage, operators should use a different product (S3 with signed URLs, etc.). This server is for public blob serving with controlled write access. |
| Payment verification in this milestone | Operators want complete payment integration now. BUD-07 exists. | Lightning preimage verification requires a Lightning node connection or payment provider API — an external dependency that varies by operator setup. Implementing it here ties access control to a specific payment provider and makes the scope enormous. The relay ecosystem shows that "no one has successfully monetized a Nostr relay" — it's still experimental territory. | Keep the BUD-07 stub and the access control seam. The whitelist serves as "manual payment bypass" for now — operators can add paid pubkeys manually. Payment wiring is a separate milestone with its own research needed. |
| Proof-of-work gating (NIP-13 analogue) | Some relay operators use PoW to rate-limit without payment. Seems like a spam-prevention option. | Adds a verification step that no Blossom client currently generates. Client ecosystem support is essentially zero for Blossom PoW. Relay PoW works because relay clients (like Damus, Amethyst) implement it. Blossom clients don't. | Use payment or whitelist for controlled access. PoW is not viable until client ecosystem adopts it. |
| Invite code system | nostrcheck-server implements this. Gives operators a registration flow rather than manual pubkey management. | Invite codes require a redemption endpoint, state to track codes (used/unused), and a distribution mechanism — significant scope. For a stateless edge deployment, invite state would need to live in Bunny Storage and handle race conditions. | Whitelist management via config file editing is sufficient for the target operator (self-hosted, technical). Invite codes are a v2+ social feature. |

---

## Feature Dependencies

```
[Nostr Kind 24242 Auth]
    └──required-by──> [Pubkey Whitelist Check]
    └──required-by──> [Pubkey Blacklist Check]
    └──required-by──> [Payment Gate (future)]

[Pubkey Whitelist Check]
    └──enhances──> [Payment Gate (future)]
                       (whitelist = payment bypass in public+payment mode)

[access.json in Bunny Storage]
    └──required-by──> [Pubkey Whitelist Check]
    └──required-by──> [Pubkey Blacklist Check]
    └──required-by──> [Public/Private Mode Toggle]

[blocked.json TTL Cache Pattern]
    └──pattern-reused-by──> [access.json TTL Cache]

[Public/Private Mode Toggle]
    └──determines-semantics-of──> [Pubkey Whitelist Check]
    └──determines-semantics-of──> [Pubkey Blacklist Check]

[Access Control Gate]
    └──applied-to──> [PUT /upload]
    └──applied-to──> [PUT /mirror]
    └──applied-to──> [POST /media]
    └──NOT-applied-to──> [GET /<hash>]
    └──NOT-applied-to──> [PUT /report]
    └──NOT-applied-to──> [GET /list/<pubkey>]
```

### Dependency Notes

- **Auth required before whitelist/blacklist:** The pubkey is only available after kind 24242 validation. Access control cannot run before auth. This is already handled by middleware ordering.
- **access.json requires Bunny Storage client:** The existing storage client (`src/storage/client.ts`) handles this pattern. Access control uses the same client, same TTL cache pattern as blocked.json.
- **Mode toggle determines whitelist semantics:** The same whitelist list has different meanings in public vs private mode. This is logic complexity, not data complexity — the config shape stays simple, the handler logic branches on mode.
- **Payment gate enhances whitelist:** In public+payment mode, a whitelisted pubkey is treated as "has paid = true" without actual payment verification. This means the whitelist is load-bearing for payment bypass and must be checked before the payment gate.

---

## MVP Definition

### Launch With (v1 — this milestone)

Minimum viable access control that delivers the stated core value: "operator can control exactly who is allowed to publish blobs."

- [x] `config/access.json` loaded from Bunny Storage with 60s TTL cache — **foundation for all other features**
- [x] `public` boolean field in access.json — **mode toggle**
- [x] `whitelist` array of hex pubkeys in access.json — **allowlist primitive**
- [x] `blacklist` array of hex pubkeys in access.json — **denylist primitive**
- [x] Mode logic: public+no-payment → blacklist bans, whitelist ignored — **open server with bans**
- [x] Mode logic: public+payment → whitelist = free pass, blacklist = banned, others need payment — **paid server with VIP bypass**
- [x] Mode logic: private → whitelist = only allowed, blacklist ignored, payment ignored — **closed server**
- [x] Gate applied to PUT /upload, /mirror, /media — **write endpoints protected**
- [x] 403 response for denied pubkeys, 402 response deferred to payment middleware — **correct HTTP semantics**

### Add After Validation (v1.x)

Add when operators report specific friction with v1.

- [ ] Structured error responses with reason codes — trigger: operator/client debugging difficulty
- [ ] Config validation on load (malformed JSON, invalid hex pubkeys) — trigger: first operator config mistake in production
- [ ] Config schema documentation — trigger: any operator other than the primary operator uses this

### Future Consideration (v2+)

Defer until product-market fit and operator feedback confirm need.

- [ ] Payment verification wiring (BUD-07 Lightning/Cashu) — requires dedicated research milestone
- [ ] Admin UI for list management — requires operator feedback confirming JSON editing is painful
- [ ] Per-endpoint access control granularity — defer unless specific operator use case demands it
- [ ] Read-side access control — fundamentally conflicts with Blossom philosophy; only if pivot to "private blob storage" product

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| access.json config loading + TTL cache | HIGH | LOW (follows blocked.json pattern exactly) | P1 |
| Public/private mode toggle | HIGH | LOW (boolean field, conditional logic) | P1 |
| Pubkey whitelist | HIGH | LOW (array lookup) | P1 |
| Pubkey blacklist | HIGH | LOW (array lookup) | P1 |
| Mode-aware whitelist semantics (three modes) | HIGH | MEDIUM (conditional logic with documented semantics) | P1 |
| Correct HTTP error codes (403 vs 402) | MEDIUM | LOW | P1 |
| /report exclusion from gating | MEDIUM | LOW (route-level skip) | P1 |
| Config validation on load | MEDIUM | LOW | P2 |
| Payment verification wiring | HIGH | HIGH (external dependency, unsolved ecosystem problem) | P3 |
| Admin UI | MEDIUM | HIGH | P3 |
| Read-side access control | LOW | HIGH (breaks CDN caching) | Anti-feature |

**Priority key:**
- P1: Must have for this milestone
- P2: Should have, add when possible
- P3: Nice to have, future milestone

---

## Competitor Feature Analysis

| Feature | umbrel-blob-box | blossom-server (hzrd149) | nostrcheck-server | blssm.us (this project) |
|---------|-----------------|--------------------------|-------------------|------------------------|
| Pubkey whitelist | Yes (admin API + config JSON) | Yes (config.yml with requirePubkeyInRule) | Yes (DB-registered users) | Yes (access.json, static) |
| Pubkey blacklist | Not documented | Not documented | Yes (ban module) | Yes (access.json, static) |
| Public/private toggle | Yes (allowAnonymous bool) | Yes (requireAuth per endpoint) | Implicit (registration required) | Yes (public bool, explicit) |
| Payment integration | No | No | Yes (Lightning, paid uploads) | Stub only (BUD-07 framework) |
| Whitelist as payment bypass | No | No | No | Yes (differentiator) |
| Config storage | JSON file on disk | YAML file on disk | Database (PostgreSQL/SQLite) | Bunny Storage JSON (stateless edge) |
| Admin UI | Yes | Yes | Yes | No (config file editing) |
| Content reporting (BUD-09) | No | No | No | Yes (existing) |
| Edge deployment | No (VPS required) | No (VPS required) | No (VPS required) | Yes (Bunny CDN EdgeScript) |

**Key finding:** No Blossom server in the ecosystem implements the payment-bypass-via-whitelist composing semantics. The three-mode logic (public-no-payment / public-with-payment / private) is novel. This is a genuine differentiator, not feature parity.

---

## Ecosystem Patterns: What Relay Operators Want

Research into the Nostr relay ecosystem (which is more mature than Blossom and the closest analogue) reveals consistent operator priorities:

**Spam control is the #1 operator concern.** The relay network has faced 500k spam messages/day. Blacklisting is not optional — it's what operators reach for first.

**Private relays are a distinct product from public relays.** Operators who run private relays (invite-only communities, personal nodes) need clear "whitelist only" semantics. Operators who run public relays need "blacklist bans" semantics. Mixing them causes confusion.

**Payment is an overlay, not a replacement.** filter.nostr.wine, nerostr, expensive-relay all use payment to add pubkeys to a whitelist — they don't replace the whitelist concept with payment. The mental model is: "pay → get on the list → upload." This validates the composing design.

**Config complexity is an operator burden.** The relay ecosystem converged on NIP-11 global flags (auth_required, payment_required, restricted_writes) rather than per-subscription-filter access control. Simple global policies beat granular ones for operator DX.

**Auth-required before access is universal.** Every implementation (khatru RejectUpload hook, umbrel-blob-box admin API, nostrcheck-server NIP-98) validates identity before applying rules. There is no documented pattern for "access control without auth."

---

## Sources

- [BUD-02 spec — upload/delete/list auth](https://github.com/hzrd149/blossom/blob/master/buds/02.md) — MEDIUM confidence (official spec, verified)
- [BUD-07 spec — payment 402 flow](https://github.com/hzrd149/blossom/blob/master/buds/07.md) — MEDIUM confidence (official spec, verified)
- [BUD-09 spec — content reporting](https://github.com/hzrd149/blossom/blob/master/buds/09.md) — MEDIUM confidence (official spec, verified)
- [NIP-11 relay information document](https://nips.nostr.com/11) — HIGH confidence (official NIP)
- [NIP-42 client authentication](https://nips.nostr.com/42) — HIGH confidence (official NIP)
- [khatru Blossom access control — RejectUpload hook](https://khatru.nostr.technology/core/blossom) — MEDIUM confidence (official framework docs)
- [umbrel-blob-box — whitelist + allowAnonymous pattern](https://github.com/hzrd149/umbrel-blob-box) — MEDIUM confidence (reference implementation)
- [filter.nostr.wine — paid relay + NIP-42 pattern](https://nostr-wine.github.io/filter-relay/) — MEDIUM confidence (live production implementation)
- [hzrd149/awesome-blossom — server landscape](https://github.com/hzrd149/awesome-blossom) — LOW confidence (catalog only, no access control details)
- [nostrcheck-server — ban module + registration](https://github.com/quentintaranpino/nostrcheck-server/blob/main/readme.md) — LOW confidence (README only, implementation details unverified)
- [Nostr relay spam — 500k messages/day](https://github.com/Spl0itable/nostr-relay-spam-blocklist) — LOW confidence (community report, single source)
- [The Bitcoin Manual — paid relay operator experience](https://thebitcoinmanual.com/articles/paid-nostr-relay/) — LOW confidence (content inaccessible during research, summary from search result)

---

*Feature research for: Blossom server access control (blssm.us)*
*Researched: 2026-02-24*
