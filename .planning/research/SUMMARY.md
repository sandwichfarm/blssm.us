# Project Research Summary

**Project:** blssm.us — Blossom server publish access control
**Domain:** Nostr/Blossom blob server — pubkey-based write access gating
**Researched:** 2026-02-24
**Confidence:** MEDIUM-HIGH

## Executive Summary

This milestone adds pubkey-based publish access control to an existing, production BUD-compliant Blossom server running on Bunny CDN EdgeScript (Deno/TypeScript). The server already handles Nostr kind 24242 authentication, content blocking via `blocked.json`, and has a BUD-07 payment framework stub in place. The access control work is purely additive — no new libraries, no runtime changes, and no architectural shifts. The approach follows established patterns already in the codebase.

The recommended implementation stores a `config/access.json` file in Bunny Storage (matching the `blocked.json` precedent), loaded via a 60-second TTL in-memory cache, and gates write endpoints (PUT /upload, PUT /mirror, PUT /media, HEAD /upload, HEAD /media) using a `checkAccess(storage, pubkey)` function called immediately after `validateAuth()` succeeds. The three-mode logic — public-no-payment (blacklist bans, whitelist ignored), public-with-payment (whitelist = payment bypass, blacklist = unconditional ban), private (whitelist only) — is novel relative to other Blossom implementations and is this server's primary differentiator. No BUD spec defines access control config format; the schema is project-defined.

The key risks are operational and logic correctness: operators will copy npub-format pubkeys from Nostr UIs into config (when only lowercase hex is valid), the blacklist-must-beat-whitelist precedence in payment mode is non-obvious and easy to invert, and BUD-06 preflight endpoints (`HEAD /upload`, `HEAD /media`) must mirror the same access gate as their write counterparts or clients will waste bandwidth on guaranteed rejections. All risks have clear prevention strategies and are addressed by test coverage requirements identified in PITFALLS.md.

## Key Findings

### Recommended Stack

No new dependencies are required. The existing TypeScript 5.9.3 / Deno 2.x / @noble/curves 1.8.1 / @noble/hashes 1.6.1 stack is sufficient. The Bunny Storage client (`src/storage/client.ts`) already provides the JSON config loading pattern. The only new pattern is the module-level TTL cache for `access.json`, which directly mirrors the existing `blockedCache` in `src/storage/metadata.ts`.

After reviewing all BUD specifications (BUD-00 through BUD-10), the research confirmed that no BUD defines a standard for server-side access control configuration. The JSON config format (`config/access.json`) is project-defined and consistent with the dominant ecosystem pattern used by umbrel-blob-box (hzrd149's own reference implementation).

**Core technologies:**
- TypeScript 5.9.3 / Deno 2.x: existing runtime — no change
- @noble/curves secp256k1 1.8.1: Schnorr verification already extracts `pubkey` from kind 24242 events
- `Set<string>` (builtin): O(1) pubkey membership test — use instead of `Array.includes()`
- `config/access.json` in Bunny Storage: single-file config, one fetch per 60s TTL window
- Module-level TTL cache: mirror the `blockedCache` pattern exactly

### Expected Features

Research into the Blossom ecosystem (umbrel-blob-box, blossom-server, khatru, nostrcheck-server) and the more mature Nostr relay ecosystem (NIP-11, NIP-42, filter.nostr.wine, nerostr) reveals consistent operator priorities. Blacklisting is the first line of defense against spam. Public/private mode is a binary operator decision (community server vs. personal server). Payment is universally treated as an overlay on top of pubkey identity, not a replacement.

**Must have (table stakes):**
- Pubkey whitelist (allowlist) in `access.json` — every reference implementation expects this
- Pubkey blacklist (denylist) in `access.json` — spam is a production reality in the Nostr ecosystem
- Public/private mode toggle (`public` boolean) — determines the semantics of both lists
- Write-only gating (GET reads stay public) — core Blossom philosophy; CDN caching depends on it
- Auth-required before gate check — pubkey only exists after kind 24242 validation
- Correct HTTP semantics: 401 (no/bad auth), 403 (denied by policy), 402 (payment required)
- /report endpoint excluded from gating — BUD-09 is a governance tool, not a user privilege

**Should have (competitive/differentiator):**
- Mode-aware whitelist semantics (three-mode logic) — no other Blossom server does payment-bypass-via-whitelist composition; this is a genuine differentiator
- Config in CDN storage with TTL cache — operators can update access lists without redeployment; real operational advantage for edge deployments
- Clean BUD-07 seam — payment wiring remains possible without re-architecting access control

**Defer (v2+):**
- Payment verification wiring (Lightning/Cashu) — requires external dependency research, separate milestone
- Admin UI for list management — JSON file editing is sufficient for the target operator persona
- Per-endpoint access control granularity — unnecessary combinatorial complexity
- Read-side access control — fundamentally conflicts with Blossom's content-addressed blob philosophy

### Architecture Approach

The access control component (`src/middleware/access.ts`) slots into the existing handler pipeline after `validateAuth()` and before body reads, payment checks, and content blocking. The architecture is entirely in-handler rather than router-level — the router has no pubkey to check against (auth hasn't run yet), and the existing codebase already follows this handler-owns-its-policy pattern. Each gated handler calls `validateAuth()` then `checkAccess(storage, pubkey)` in sequence, then proceeds to payment/content/business logic only on success.

**Major components:**
1. `src/middleware/access.ts` (NEW) — `loadAccessConfig()` with 60s TTL cache + `checkAccess()` pure decision function
2. `config/access.json` in Bunny Storage — `{ "public": true, "whitelist": [], "blacklist": [] }` schema
3. `src/types.ts` (extend) — `AccessConfig` type definition
4. Gated handlers (modify): `blob-upload.ts`, `mirror.ts`, `media.ts`, `upload-check.ts`

**Build order within the milestone:**
1. `AccessConfig` type in `src/types.ts`
2. `loadAccessConfig()` + `checkAccess()` in `src/middleware/access.ts`
3. Integrate into `blob-upload.ts` (primary write path)
4. Integrate into `mirror.ts` and `media.ts`
5. Integrate into `upload-check.ts` (HEAD preflight endpoints)

### Critical Pitfalls

1. **npub vs hex pubkey format mismatch** — Operators copy npub from Nostr UIs; `event.pubkey` is always lowercase 64-char hex. Silent failure: whitelisted users get 403, blacklisted users pass. Avoid by validating every config entry against `/^[0-9a-f]{64}$/` on load and logging a warning for invalid entries.

2. **Logic inversion in mode/list precedence** — Checking whitelist before blacklist in payment mode allows a blacklisted+whitelisted pubkey through. The correct order is: blacklist check first (short-circuit deny in applicable modes), then whitelist, then mode policy. Write the decision matrix as a comment block before implementing, and test every cell.

3. **Access control check runs after body is consumed** — Reading `request.arrayBuffer()` before calling `checkAccess()` lets denied users consume server bandwidth and storage API calls. The check must run before body reads. Order: auth → access → body read → hash → content block.

4. **BUD-06 preflight endpoints not gated** — `HEAD /upload` and `HEAD /media` must enforce the same access control as their PUT counterparts. If preflight returns 200 for a blacklisted pubkey, BUD-06-aware clients will send the full body to a guaranteed rejection.

5. **Config cache not propagating across isolate instances** — The 60-second TTL is per edge isolate instance, not global. After editing `access.json`, config propagation takes up to 60 seconds across all active instances. This is expected behavior but must be documented explicitly so operators don't report a "ban not working" bug.

## Implications for Roadmap

Based on research, the milestone fits cleanly into three implementation phases with a clear dependency order. All phases use existing stack; none require research-phase during planning.

### Phase 1: Config Foundation

**Rationale:** Everything else depends on the config schema and cache loading. Defining the type, validating the format, and proving the TTL cache works is the enabling layer for all other work. The blocked.json pattern is the direct template — this is low-risk and fast.

**Delivers:** `AccessConfig` type, `loadAccessConfig()` with TTL cache, `checkAccess()` pure decision function, schema validation with npub-format rejection, default behavior when `access.json` is absent (public mode, empty lists).

**Addresses:** pubkey whitelist, pubkey blacklist, public/private mode toggle (all table stakes from FEATURES.md).

**Avoids:** npub vs hex pitfall (validation on load), per-request storage fetch pitfall (TTL cache), array linear scan pitfall (convert to `Set<string>` on cache population).

### Phase 2: Endpoint Wiring

**Rationale:** With `checkAccess()` tested and ready, each handler adds two lines (call + error return). The gating logic should be consistent across all four targets. Mirror must be included explicitly because it has a secondary SSRF risk if unauthorized callers can trigger outbound fetches.

**Delivers:** Access control active on PUT /upload, PUT /mirror, PUT /media, HEAD /upload, HEAD /media. All endpoints return correct HTTP status codes (403 for policy denial, distinct from 401 for auth failure).

**Implements:** Architecture Pattern 1 (auth-first, access-second, before body read) and Pattern 2 (in-handler check, not router-level).

**Avoids:** Body-consumed-before-access-check pitfall, BUD-06 preflight not gated pitfall, mirror endpoint excluded pitfall, 401-vs-403 status code conflation pitfall.

### Phase 3: Verification and Docs

**Rationale:** The three-mode logic (public-no-payment / public-with-payment / private) is novel and the logic inversion risk is HIGH severity. A systematic verification pass against the decision matrix catches logic errors before production. Operator documentation of the 60-second propagation delay and hex-only pubkey requirement prevents the highest-frequency support issues.

**Delivers:** Matrix test coverage for all mode/whitelist/blacklist combinations including edge cases (blacklisted+whitelisted, missing config file, npub in config). "Looks Done But Isn't" checklist from PITFALLS.md verified. Operator documentation for config schema, TTL delay, and pubkey format requirement.

**Avoids:** Logic inversion pitfall (matrix tests catch this), config propagation misunderstanding (documentation), report endpoint accidentally gated.

### Phase Ordering Rationale

- Config foundation must come first because `checkAccess()` is the dependency for all handler changes. Building and testing the function in isolation reduces risk in Phase 2.
- Endpoint wiring is Phase 2 not Phase 1 because each handler mod is mechanical once `checkAccess()` exists. Batching all handler changes into one phase keeps the diff reviewable.
- Verification is last because it validates the complete system, not individual components. The decision matrix test only makes sense when all three modes are wired end-to-end.
- Payment mode composition (public+payment) is explicitly out of scope for execution in this milestone but the config schema and `checkAccess()` return shape must accommodate it from Phase 1 — otherwise payment wiring in a future milestone requires a rewrite rather than a fill-in.

### Research Flags

Phases with standard, well-documented patterns (no research-phase needed):
- **Phase 1:** Config loading pattern is a direct copy of `blockedCache` in `metadata.ts`. Type definition is straightforward. No novel patterns.
- **Phase 2:** Handler modification is mechanical — add two lines per handler after `validateAuth()`. Established by existing code structure.
- **Phase 3:** Test patterns follow existing codebase conventions. Documentation is operator-facing prose.

No phase in this milestone requires `/gsd:research-phase` during planning. All patterns are established by existing codebase or well-documented BUD specs.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new dependencies. Patterns verified directly from existing codebase (`metadata.ts` blocked cache, `auth/nostr.ts` pubkey extraction). BUD specs verified from official GitHub repo. |
| Features | MEDIUM | Blossom ecosystem is young (2024). Reference implementations are sparse. Feature table stakes derived from ecosystem analogues (Nostr relays, NIP-11/42) which are MEDIUM-HIGH confidence. The three-mode logic is novel — no reference implementation to validate against. |
| Architecture | HIGH | Based on direct codebase analysis plus universal middleware ordering principles. The handler-level check pattern is already established in this codebase for auth and content blocking. |
| Pitfalls | MEDIUM | Blossom-specific pitfall documentation is sparse. Critical pitfalls (npub format, 401/403, body order, preflight) are derived from BUD spec analysis + OWASP + Bunny CDN/Deno isolate documentation (HIGH confidence sources). Logic inversion risk is derived from reasoning about the novel three-mode semantics, not from observed failure in the wild. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Three-mode payment composition behavior in public+payment mode:** The payment check stub always returns false. This means public+payment mode currently blocks everyone not on the whitelist. This is the correct interim behavior but must be explicitly documented in code comments so the next developer who wires payments understands the intent. Gap: no reference implementation to validate the whitelist-as-payment-bypass UX.

- **Bunny Storage atomic write behavior:** PITFALLS.md notes that config writes are atomic by design (single PUT). This has not been explicitly verified from Bunny Storage API documentation during this research cycle. Low risk — the concern is invalid JSON, not partial write — but worth confirming during implementation.

- **Config validation strictness:** Research recommends logging a warning for invalid hex pubkeys on load rather than hard-failing (to avoid locking out the operator if they make a typo). The exact behavior on malformed config (warn + use remaining valid entries vs. warn + fall back to defaults) should be decided during implementation based on operator experience preferences.

## Sources

### Primary (HIGH confidence)
- `github.com/hzrd149/blossom/blob/master/buds/02.md` — BUD-02 upload spec, reject-for-any-reason clause
- `github.com/hzrd149/blossom/blob/master/buds/06.md` — BUD-06 preflight spec, 401/403 semantics, X-Reason header
- `github.com/hzrd149/blossom/blob/master/buds/07.md` — BUD-07 payment 402 flow spec
- `nips.nostr.com/19` — NIP-19 bech32 entities, hex-only requirement for protocol fields
- `nips.nostr.com/11` — NIP-11 relay information document, global policy flags pattern
- `owasp.org/Top10/2025/A01_2025-Broken_Access_Control/` — 401 vs 403 distinction, whitelist bypass patterns
- `deno.com/blog/anatomy-isolate-cloud` — module-level state is isolate-local (cache propagation behavior)
- `docs.bunny.net/docs/edge-scripting-limits` — Bunny EdgeScript isolate model
- blssm.us codebase direct analysis: `src/storage/metadata.ts`, `src/auth/nostr.ts`, `src/handlers/blob-upload.ts`, `src/middleware/payments.ts`, `src/router.ts`

### Secondary (MEDIUM confidence)
- `github.com/hzrd149/umbrel-blob-box` — JSON config format with `whitelist` + `allowAnonymous` (reference implementation by spec author)
- `github.com/hzrd149/blossom-server/blob/master/config.example.yml` — YAML rule-based config (official implementation, different pattern — not recommended for this project)
- `khatru.nostr.technology/core/blossom` — Go `RejectUpload` hook pattern for access control logic
- `nips.nostr.com/42` — NIP-42 client authentication, identity layer pattern

### Tertiary (LOW confidence)
- `github.com/quentintaranpino/nostrcheck-server` — ban module + registration flow (README only, implementation details unverified)
- `github.com/Spl0itable/nostr-relay-spam-blocklist` — relay spam volume data (community report, single source)
- `httptoolkit.com/blog/bunny-cdn-caching-vulnerability/` — CDN caching of auth-dependent responses (published security research, applied by analogy)

---
*Research completed: 2026-02-24*
*Ready for roadmap: yes*
