# Project Research Summary

**Project:** blssm.us v1.1 — BUD-07 Payment Middleware + Configurable Cache TTL
**Domain:** Stateless Blossom blob server (Bunny EdgeScript / Deno) with payment-gated uploads
**Researched:** 2026-02-24
**Confidence:** HIGH (stack and architecture), MEDIUM (pitfalls — BUD-07 ecosystem is sparse)

## Executive Summary

blssm.us v1.1 adds a BUD-07-compliant payment layer to an existing, fully-shipped v1.0 Blossom server. The server runs on Bunny EdgeScript (a Deno-compatible edge runtime) and uses Bunny Storage as its only persistent store. The recommended approach is a surgical additive milestone: no new npm dependencies, no new architectural layers, no changes to the router or auth systems. The three features — public+payments access mode, Cashu payment verification, and configurable cache TTL — all fit cleanly into the existing middleware and config-cache patterns already established in v1.0.

The central decision of this milestone is treating Cashu (NUT-24 / BUD-07) as the primary payment method, with Lightning deferred. This is the correct choice for a stateless edge runtime: Cashu tokens are self-contained bearer instruments whose double-spend protection can be delegated entirely to the issuing mint via the NUT-07 checkstate API. Lightning payment verification, by contrast, requires the server to have issued the BOLT-11 invoice and stored its payment hash — impossible on a stateless edge worker without an external LN node or provider API.

The dominant risk in this milestone is security, not implementation complexity. Four pitfalls are operationally catastrophic if shipped wrong: Cashu token replay (no mint checkstate call), accepting Cashu tokens from any mint (self-minted tokens), 402 responses being cached by Bunny CDN (paying clients permanently blocked), and the checkAccess semantic change failing to wire the 402 path correctly. Each has a clear prevention strategy and all must be verified with explicit tests before the milestone is considered complete.

## Key Findings

### Recommended Stack

No new npm packages are required for this milestone. The existing stack — `@noble/curves@1.8.1`, `@noble/hashes@1.6.1`, and Deno's built-in `fetch` and `atob` APIs — covers all three features. Cashu NUT-07 Y-value computation uses `secp256k1.hashToCurve` from `@noble/curves`. Lightning preimage verification uses `sha256` from `@noble/hashes`. Payment config is loaded from Bunny Storage via the existing `StorageClient.getJson()` pattern.

One low-confidence detail: the Cashu `hash_to_curve` algorithm (NUT-09) may be domain-separated and not match secp256k1's standard `hashToCurve`. This must be verified against the NUT-09 spec during implementation before writing Y-value computation.

**Core technologies:**
- `@noble/curves@1.8.1` (existing): `hash_to_curve(proof.secret)` for NUT-07 Y values — already in `deno.json`, no install needed
- `@noble/hashes@1.6.1` (existing): SHA-256 for Lightning preimage verification — already in `deno.json`
- Deno `fetch` (built-in): outbound call to mint's `/v1/checkstate` — identical usage to existing Bunny Storage calls
- `atob` + `JSON.parse` (built-in Web APIs): decode cashuB base64url token — no library needed

### Expected Features

**Must have (table stakes — BUD-07 compliance):**
- 402 response with correct X-Cashu header encoding a NUT-18 payment request (amount, unit, accepted mints) — current stub is non-spec
- Cashu token validation on retry: call mint `/v1/checkstate` to confirm proofs UNSPENT, then melt/swap to prevent replay
- 400 + X-Reason header on invalid payment proof (token spent, wrong mint, wrong amount)
- `public+payments` mode in `access.json` via explicit opt-in flag (`"payments": true`) — unlisted pubkeys get 402, whitelisted get free pass, blacklisted get 403
- `config/payment.json` in Bunny Storage with operator-configurable amount, unit, and accepted mint list
- Configurable cache TTL (`cacheTtl` field in `config/access.json`) including TTL=0 for always-fresh reads

**Should have (differentiators):**
- Cashu as the primary payment method — privacy-preserving ecash, no user tracking, aligns with Nostr/Blossom censorship-resistance ethos; first BUD-07 compliant server with working Cashu
- Whitelist as payment bypass — composing access and payment in one config (whitelisted = free, unlisted = 402, blacklisted = 403)
- TTL=0 for instant config propagation — emergency escape hatch for operators changing mints or banning pubkeys
- Pluggable payment verification architecture — `verifyCashuPayment` and `verifyLightningPayment` as separate exports, easy to extend

**Defer (v1.x or v2+):**
- Lightning support via external provider API (NWC, LNbits) — requires operator infrastructure decision; stateless edge cannot issue invoices
- Per-mint amount configuration
- BOLT-12 offers
- Subscription / recurring payment state (requires external state management)
- Read-side payment gating (breaks CDN caching, out of scope per PROJECT.md)

### Architecture Approach

The v1.1 architecture is an additive extension to the existing four-gate request pipeline: router → handler → middleware (auth, access, payment) → storage. A new gate is inserted between the access check and business logic: `verifyPaymentProof(request)`. The key design decision is separation of concerns — `checkAccess()` returns a `requiresPayment: true` signal on the `AccessResult` type (already reserved in v1.0) but does not call the payment verifier. Handlers read this signal and invoke payment middleware separately, keeping `checkAccess(storage, pubkey)` free of HTTP concerns.

**Major components:**
1. `checkAccess()` (modified in `access.ts`) — adds `public+payments` branch returning `{ allowed: false, requiresPayment: true }` for unlisted pubkeys; blacklist check always runs first
2. `verifyPaymentProof(request)` (new in `payments.ts`) — reads X-Cashu/X-Lightning headers, dispatches to appropriate verifier, returns discriminated union result
3. `loadPaymentConfig(storage)` (new in `payments.ts`) — TTL-cached load of `config/payment.json`; called only when `requiresPayment === true`
4. `paymentRequired(paymentConfig)` (rewritten in `payments.ts`) — emits spec-compliant 402 with NUT-18 encoded X-Cashu header; must set `Cache-Control: no-store`
5. Gated handlers (5 files in `src/handlers/`) — add payment gate between access check and body read; HEAD handlers signal 402 but never consume proof

**Build order:** types.ts → loadPaymentConfig → verifyPaymentProof → access.ts TTL + payment branch → wire handlers (blob-upload first, then upload-check, mirror, media, delete, list) → tests

### Critical Pitfalls

1. **Cashu token replay across edge isolates** — Module-level in-memory sets are isolate-local; lost on restart; useless across Bunny EdgeScript nodes. Always call the mint's `/v1/checkstate` (NUT-07) before accepting, then melt/swap the proof. There is no safe alternative. Treat this as a hard requirement before writing any verification logic.

2. **402 response cached by Bunny CDN** — Bunny CDN can and will cache 4xx responses. A cached 402 means paying clients are permanently blocked until cache expiry. Set `Cache-Control: no-store` on `paymentRequired()` as the very first task in the payment middleware phase — one line, catastrophic if missed.

3. **Cashu token from attacker-controlled mint** — Without validating the token's mint URL against `config/payment.json`'s accepted mint list, an attacker self-mints tokens on a controlled mint and gets free access. The `PaymentConfig` type must include `cashuMints: string[]`. Reject any token whose mint is not in the list before any mint API call.

4. **`checkAccess` semantic change fails to wire 402 path** — If payment middleware is added at the handler level without updating `checkAccess` to return `requiresPayment: true`, unlisted pubkeys in public+payments mode still receive 403, never 402. The access function must be updated first, before any handler wiring.

5. **Mode transition — existing `public: true` configs silently become payment-gated** — If public+payments mode is inferred from the presence of `payment.json` rather than an explicit opt-in flag, operators upgrading to v1.1 will find all non-whitelisted users receiving 402 without any config change. Require an explicit `"payments": true` field. Treat its absence as no payment gate, regardless of what other config files exist.

## Implications for Roadmap

Based on research, the dependency graph drives a clear four-phase structure. Each phase is a prerequisite for the next.

### Phase 1: Config Schema + Types

**Rationale:** All subsequent work depends on correct type definitions and config schema. The `AccessConfig.payments` opt-in flag must exist before any access logic is changed. The `PaymentConfig` type with `cashuMints: string[]` must exist before any payment verification code is written. Defining `DEFAULT_PAYMENT_CONFIG` here addresses the missing-config pitfall at the foundation.

**Delivers:** Updated `types.ts` with `PaymentConfig` (including `cashuMints: string[]`) and extended `AccessConfig` (adding `payments?: boolean`, `cacheTtl?: number`); `config/access.json` and `config/payment.json` schemas documented; `DEFAULT_PAYMENT_CONFIG` constant defined with safe fallback.

**Addresses:** `PaymentConfig` type, `config/payment.json` schema, `AccessConfig.payments` opt-in field, `cacheTtl` field

**Avoids:** Mode transition pitfall (Pitfall 10), payment config missing pitfall (Pitfall 9)

### Phase 2: Access Control + Cache TTL

**Rationale:** `checkAccess()` must emit the `requiresPayment: true` signal before any handler can use it. Configurable TTL is a self-contained change in `access.ts` with no downstream dependencies. Both changes live in the same file and ship together. The blacklist-first check order must be explicitly tested here before any payment wiring proceeds.

**Delivers:** `checkAccess()` extended with public+payments mode decision matrix; `loadAccessConfig()` reads `cacheTtl` from config; TTL=0 always-fresh behavior with last-known-good fallback on storage errors; full ACL matrix tests including blacklist-beats-whitelist in payment mode.

**Addresses:** public+payments mode, configurable cache TTL, `checkAccess` semantic correctness

**Avoids:** Access layer semantic change pitfall (Pitfall 3), blacklist check order pitfall (Pitfall 6), TTL=0 storage exhaustion pitfall (Pitfall 5)

### Phase 3: Payment Middleware

**Rationale:** With correct types and a working access layer, payment verification can be implemented in isolation and tested independently before touching any handler. This is the highest-risk phase — it requires external mint API calls, token format parsing, and correct NUT-07 interaction. The NUT-09 `hash_to_curve` algorithm must be verified against the spec at the start of this phase before writing Y-value computation.

**Delivers:** `loadPaymentConfig()` with TTL cache; `verifyCashuPayment()` with NUT-07 mint checkstate call and allowed-mint validation; rewritten `paymentRequired()` with NUT-18 X-Cashu header and `Cache-Control: no-store`; unit tests for all verification paths (valid token, spent token, wrong mint, missing proof).

**Addresses:** Cashu token verification, correct 402 response format, 400 + X-Reason error path

**Avoids:** Cashu token replay (Pitfall 1), CDN caching of 402 (Pitfall 4), unvalidated mint URL (Pitfall 8), incomplete Lightning verifier (Pitfall 2)

### Phase 4: Handler Wiring + Integration

**Rationale:** The final phase wires the payment gate into all five affected handlers once the middleware is fully tested. Handler order: blob-upload first (core write path), then upload-check (preflight must mirror upload policy), then mirror, media, delete, list. The HEAD/PUT distinction must be enforced explicitly — upload-check returns 402 to signal payment requirement but must never call `verifyPaymentProof`.

**Delivers:** All five write handlers gated with payment check; HEAD endpoints signal 402 but do not consume proofs; integration tests covering the full 402 → pay → retry flow and the "looks done but isn't" checklist from PITFALLS.md.

**Addresses:** All P1 features wired end-to-end

**Avoids:** HEAD payment verification pitfall (Pitfall 7)

### Phase Ordering Rationale

- Types before logic: every downstream file imports from `types.ts`; incorrect types cascade into all modules
- Access before payment: handlers check `access.requiresPayment` before calling payment middleware; if access is wrong, payment never fires
- Middleware before handlers: testing payment verification in isolation gives faster feedback and cleaner unit tests
- Handlers last: handler wiring is mechanical once all dependencies are correct; most files touched but lowest logic risk

### Research Flags

Phases needing spec verification during planning or implementation:

- **Phase 3 (Payment Middleware):** NUT-09 `hash_to_curve` exact algorithm — LOW confidence. Verify against `cashubtc/nuts/blob/main/09.md` before writing Y-value computation. The `@noble/curves` package is correct; the calling convention may differ from standard secp256k1 `hashToCurve`.
- **Phase 3 (Payment Middleware):** Cashu proof consumption strategy — confirm whether `POST /v1/checkstate` (NUT-07, read-only) or `POST /v1/swap` (NUT-03, atomic consume) is the correct endpoint for a server receiving payment. PITFALLS.md says "melt or swap"; clarify during implementation.

Phases with standard patterns (skip research-phase):

- **Phase 1 (Config Schema + Types):** Pure TypeScript type definitions following existing patterns — no research needed.
- **Phase 2 (Access Control + Cache TTL):** Direct extension of existing `checkAccess()` at a pre-defined seam; TTL is a constant replacement. Well-understood.
- **Phase 4 (Handler Wiring):** Mechanical wiring following established handler patterns; no novel patterns required.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No new packages. Existing `@noble/curves`, `@noble/hashes`, and `fetch` confirmed sufficient. Only LOW-confidence detail: exact NUT-09 hash_to_curve calling convention. |
| Features | HIGH | BUD-07 and NUT-24 specs fetched directly. Existing codebase inspected. `requiresPayment` reserved field confirmed. Cashu/Lightning asymmetry well-understood. Feature priority matrix explicit in FEATURES.md. |
| Architecture | HIGH | Direct codebase analysis. Build order confirmed from dependency graph. All modification points identified. Existing patterns (StorageClient, config cache, discriminated union result types) directly applicable to all new components. |
| Pitfalls | MEDIUM | BUD-07 ecosystem is sparse; no reference BUD-07 implementation exists for comparison. Cashu replay and CDN caching pitfalls are well-sourced (Deno isolate docs, Bunny CDN security research). Lightning pitfalls are spec-derived. Mode transition pitfall is reasoning-based. |

**Overall confidence:** HIGH for Cashu path. MEDIUM for Lightning path (deferred, stub must remain returning false).

### Gaps to Address

- **NUT-09 hash_to_curve exact algorithm:** Must verify `cashubtc/nuts/blob/main/09.md` during Phase 3 before writing Y-value computation. Risk: using the wrong calling convention produces incorrect Y values, causing all Cashu token validations to fail at the mint.
- **Cashu proof consumption endpoint:** Clarify NUT-03 (swap) vs. NUT-07 checkstate-only vs. NUT-05 (melt) for server-receiver use case. Wrong choice either fails to prevent replay (checkstate-only without subsequent consumption) or introduces unnecessary complexity.
- **Lightning path commitment:** The `verifyLightningPayment` stub must remain returning false unconditionally. Do not ship a partial implementation. Document this explicitly in code comments so future developers understand the stub is intentional, not an oversight.
- **`cacheTtl` config file location:** ARCHITECTURE.md places it in `config/access.json`; FEATURES.md suggests `config/payment.json`. Resolve during Phase 1 schema definition — single location, documented.

## Sources

### Primary (HIGH confidence)
- `github.com/hzrd149/blossom/blob/master/buds/07.md` — BUD-07: 402 flow, X-Cashu/X-Lightning headers, proof headers on retry, 400+X-Reason
- `github.com/cashubtc/nuts/blob/main/24.md` — NUT-24: server 402 payment request format, client cashuB token on retry
- `github.com/cashubtc/nuts/blob/main/07.md` — NUT-07: POST /v1/checkstate, Y = hash_to_curve(secret), UNSPENT/SPENT/PENDING states
- `github.com/cashubtc/nuts/blob/main/18.md` — NUT-18: payment request encoding (base64url JSON, `creqA` prefix)
- `github.com/lightning/bolts/blob/master/11-payment-encoding.md` — BOLT-11: preimage/payment_hash relationship
- blssm.us codebase: `src/middleware/payments.ts`, `src/middleware/access.ts`, `src/types.ts`, `src/storage/metadata.ts`, `src/handlers/blob-upload.ts` — direct inspection
- `.planning/PROJECT.md` — authoritative v1.1 requirements and out-of-scope decisions
- `deno.com/blog/anatomy-isolate-cloud` — module-level state is isolate-local, not shared across edge nodes

### Secondary (MEDIUM confidence)
- `github.com/cashubtc/xcashu` — X-Cashu reference implementation (inspected)
- `402fordummies.dev` — NUT-24 flow diagram; confirms 5-step handshake
- `npm registry` — `@cashu/cashu-ts@3.5.0` confirmed wallet-focused; unnecessary for server-side verification
- `voltage.cloud/blog/lightning-payments-pre-images-hashes` — preimage verification requires known payment hash
- `httptoolkit.com/blog/bunny-cdn-caching-vulnerability/` — Bunny CDN caching of auth-dependent responses (security research)

### Tertiary (LOW confidence)
- NUT-09 (`cashubtc/nuts/blob/main/09.md`) — `hash_to_curve` exact algorithm: NOT verified during research; flagged for Phase 3 implementation

---
*Research completed: 2026-02-24*
*Ready for roadmap: yes*
