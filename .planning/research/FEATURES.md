# Feature Research

**Domain:** BUD-07 payment middleware + public+payments access mode + configurable cache TTL (blssm.us v1.1)
**Researched:** 2026-02-24
**Confidence:** HIGH — BUD-07 spec confirmed from canonical source; NUT-24 spec confirmed from cashubtc/nuts; existing codebase inspected directly; BOLT-11 spec verified.

---

## Scope

This is a **subsequent milestone** for v1.1. The features below cover only the three new capabilities:

1. BUD-07 payment middleware with pluggable verification (402 + X-Cashu/X-Lightning headers, payment proof validation)
2. Public+payments access mode (whitelist = free pass, blacklist = banned, unlisted = 402)
3. Configurable cache TTL (including TTL=0 for always-fresh reads)

Existing capabilities (BUD-01/02/04/05/09, Nostr auth, whitelist/blacklist ACL, 60s TTL cache) are already shipped and not re-researched here.

---

## Feature Landscape

### Table Stakes (Operators Expect These)

Features a BUD-07-compliant paid Blossom server must provide. Missing these = non-conformant with the spec.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| 402 response with X-Cashu header (NUT-18 encoded) | BUD-07 spec mandates this. X-Cashu is the Cashu payment method header. NUT-24 defines what the header must contain: a NUT-18 payment request with `{ a: amount, u: unit, m: [mintUrls] }`. | MEDIUM | Existing `paymentRequired()` stub sets `X-Payment-Amount` and `X-Payment-Unit` as custom non-spec headers. Must be replaced with NUT-18 encoded X-Cashu header. The encoding is a base64url serialized payment request object. |
| 402 response with X-Lightning header (BOLT-11 invoice) | BUD-07 spec defines X-Lightning as a supported method. Header value is a BOLT-11 invoice string. | MEDIUM | Existing stub puts an LNURL in X-Lightning — wrong format. BUD-07 specifies an invoice, not a static LNURL. Server must issue a fresh invoice per request. Without an LN node or provider API, Lightning support is a stub only (correct header format, no actual verification). |
| Cashu token validation on retry | BUD-07: client retries PUT with cashuB token in X-Cashu header as payment proof. Server must validate the token is unspent and from an accepted mint. | HIGH | Token double-spend prevention requires calling the mint's swap endpoint. Cannot be done offline or locally. The mint is the sole source of truth for token state (NUT-07 token state check). Requires: accepted mint URL config, outbound fetch to mint, handling of 400 (already spent) vs success. |
| Lightning preimage validation on retry | BUD-07: client retries with 64-char hex preimage in X-Lightning header. Server must SHA-256 hash it and match against the issued invoice's payment_hash. | HIGH | Stateless edge constraint makes this hard: server must have stored the payment_hash when the invoice was issued. Bunny EdgeScript has no persistent connections and no shared state between edge invocations. Requires external LN node or provider API per verification. |
| 400 + X-Reason on invalid payment proof | BUD-07 explicitly requires this when payment proof is invalid, expired, or from a non-accepted mint. | LOW | X-Reason header pattern already established in the codebase for ACL denials on HEAD responses. Reuse the same pattern. |
| public+payments mode in access.json | The milestone requirement. Third mode beyond `public: true` and `public: false`. Decision: whitelisted = free pass (no 402), blacklisted = 403, unlisted = 402. | MEDIUM | `AccessConfig` in `types.ts` already has a comment "in public+payments mode, also skip payment" on the whitelist field. `AccessResult` already has `requiresPayment?: true` reserved. Adding `payments?: boolean` to `AccessConfig` and extending the decision matrix in `checkAccess()` is the full scope. |
| Payment configuration in Bunny Storage | Payment settings (accepted mints, amount, unit) must be operator-configurable without code changes. Stateless edge runtime has no other option. | LOW | Follows the `config/access.json` pattern exactly. New file: `config/payment.json`. Same TTL cache mechanism. New `PaymentConfig` type in `types.ts`. |
| Configurable cache TTL | The 60s hardcoded TTL in both `ACCESS_CACHE_TTL_MS` and `BLOCKED_CACHE_TTL_MS` is too slow for operators changing payment config mid-incident. TTL=0 means always-fresh. | LOW | TTL value should come from `config/payment.json` or a unified `config/server.json`. Conditional: if `ttl === 0`, skip cache check and always fetch. If `ttl > 0`, use existing cache pattern with the configured value. |

### Differentiators (Competitive Advantage)

Features that set this server apart from other Blossom implementations.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Cashu (privacy-preserving ecash) as primary payment method | Cashu tokens are bearer instruments — no user tracking, no payment correlation. Aligns with Nostr/Blossom's censorship-resistance ethos. NUT-24 is the current 2025 standard for HTTP 402 Cashu payments. | MEDIUM | No other Blossom server publicly documents Cashu payment integration. Being the first BUD-07 compliant implementation with working Cashu is a genuine differentiator. |
| Whitelist as payment bypass (composing access + payment) | Operators can give free access to trusted pubkeys, block bad actors, and charge everyone else — all in one `access.json` config. The relay ecosystem shows this is the correct mental model: "pay → get added to approved list." | LOW | The composition point is inside `checkAccess()`. When `payments` mode is active and pubkey is unlisted, return `{ allowed: false, requiresPayment: true }`. Handlers check this flag before calling `paymentRequired()`. No architectural changes needed — the seam was designed for this. |
| TTL=0 for instant config propagation | Operators managing a paid service need to change payment amounts, update accepted mints, or adjust access rules immediately. The 60s cache means an operator who just changed their Cashu mint URL has to wait a minute. TTL=0 gives instant control. | LOW | Simple conditional in the cache load function. No complex invalidation mechanism needed. The Bunny Storage fetch is fast (same CDN zone). |
| Pluggable payment verification architecture | BUD-07 explicitly supports future payment methods via new X-{method} headers. Current stub pattern (`verifyLightningPayment`) is already pluggable. Adding `verifyCashuPayment` as a parallel export maintains the pattern. | LOW | Keep `verifyLightningPayment` and `verifyCashuPayment` as separate exported functions in `src/middleware/payments.ts`. Handlers check which proof header is present in the request and call the matching verifier. Easy to add new methods later. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full Lightning node integration on-server | Lightning is widely supported by wallets; operators want Lightning payments. | Bunny EdgeScript (Deno) cannot run a Lightning node, maintain persistent channel state, or hold a wallet. Each edge invocation is stateless. Issuing invoices requires either a connected LN node (impossible on edge) or an external provider API (adds hard dependency on a third-party service). | Cashu is the correct fit for this stateless runtime. If Lightning is needed, integrate a payment provider API (LNbits, OpenNode, Strike) as a separate future milestone — it requires its own research. |
| Local double-spend prevention for Cashu (no mint call) | "Verify tokens without calling the mint to reduce latency." | Cashu tokens cannot be verified for double-spend without calling the mint. The token is cryptographically valid but the mint tracks spending state (NUT-07). Any local-only verification is insecure — a single token could be presented to concurrent requests and both would pass local checks. Bunny Storage has no atomic operations to support local tracking. | Always call the mint's swap/redemption endpoint. The latency is acceptable for an upload operation. The mint is the single source of truth. |
| Per-blob payment amounts | "Charge different amounts for large vs small files." | Requires storing payment intent per-blob, correlating payment proof to a specific blob hash across stateless edge invocations. Massive complexity increase. BUD-07 has no spec for this. No Blossom client supports it. | Flat per-upload fee is what BUD-07 assumes. Operators who want size-based pricing can use `maxUploadSize` in Config to cap blob size and charge a flat rate. |
| Storing redeemed Cashu tokens locally (anti-replay log) | "Track spent tokens in Bunny Storage to avoid calling the mint." | Bunny Storage has no atomic operations. Two concurrent requests presenting the same token would both read "not in spent list" before either writes to it — a classic race condition. This is the exact failure mode the mint's atomic swap operation prevents. | Delegate double-spend prevention entirely to the mint. It is designed for this. |
| Read-side payment gating (pay to download) | Monetize blob downloads, not just uploads. | Breaks Bunny CDN caching entirely — CDN serves cached responses before EdgeScript runs. Violates Blossom's public-read philosophy. PROJECT.md marks this explicitly out of scope. | Free reads, paid writes only. This is the correct architecture for a CDN-fronted Blossom server. |
| Subscription / recurring payment state | "One-time payment grants ongoing upload access." | Requires tracking payment state per-pubkey across stateless edge invocations. Bunny Storage has no atomic ops, no TTL on values, and no event-driven updates. Maintaining subscription state on edge is architecturally wrong. | Whitelist-based free access is the equivalent: operator adds paid pubkeys to whitelist after managing subscriptions off-server (in their own system). The Blossom server doesn't need to know how pubkeys got on the whitelist. |

---

## Feature Dependencies

```
[public+payments mode]
    └──requires──> [AccessConfig.payments field]
                       └──requires──> [config/access.json schema update]
    └──requires──> [checkAccess() decision matrix extension]
                       └──depends-on (existing)──> [loadAccessConfig()]
                       └──depends-on (existing)──> [AccessResult.requiresPayment (reserved)]

[Cashu payment verification]
    └──requires──> [PaymentConfig type]
                       └──requires──> [config/payment.json]
    └──requires──> [verifyCashuPayment(token, config)]
                       └──requires──> [outbound fetch to mint swap endpoint]
                       └──requires──> [cashuB token parsing]

[402 response (correct BUD-07 format)]
    └──requires──> [PaymentConfig loaded (amount, unit, mints)]
    └──requires──> [NUT-18 payment request encoding in X-Cashu header]
    └──replaces──> [existing paymentRequired() stub]

[Payment middleware wired into write handlers]
    └──requires──> [public+payments mode in checkAccess()]
    └──requires──> [verifyCashuPayment() implemented]
    └──depends-on (existing)──> [Nostr auth pubkey extraction]
    └──depends-on (existing)──> [AccessResult.requiresPayment flag]

[Configurable cache TTL]
    └──requires──> [TTL value in config/payment.json]
    └──modifies──> [loadAccessConfig() — replace ACCESS_CACHE_TTL_MS constant]
    └──modifies──> [isBlocked() — replace BLOCKED_CACHE_TTL_MS constant]
    └──new-behavior──> [TTL=0: skip cache, always fetch from Bunny Storage]
```

### Dependency Notes

- **public+payments mode requires checkAccess() extension:** The `requiresPayment?: true` field on `AccessResult` is already reserved in v1.0 code with an explicit comment "MUST NOT be set in any v1 return path." v1.1 is when this flag gets activated. The composition point is clear: when `payments=true` and pubkey is unlisted, return `{ allowed: false, requiresPayment: true }` instead of a hard 403.
- **Cashu verification requires external mint call:** The Bunny EdgeScript Deno runtime can make outbound HTTP requests via `fetch()`. This is the correct path. The mint URL comes from `config/payment.json`. No local anti-double-spend tracking is safe.
- **Lightning verification has a hard constraint:** Server must have issued the invoice (and stored the payment_hash) to verify a preimage. Stateless edge cannot issue invoices. Lightning support requires either a provider API (external dependency) or remains a non-verifying stub. Cashu is the v1.1 priority.
- **Configurable TTL is cross-cutting:** Both `ACCESS_CACHE_TTL_MS` (in `access.ts`) and `BLOCKED_CACHE_TTL_MS` (in `metadata.ts`) are hardcoded. A single `cacheTtlMs` value in `config/payment.json` (or a new `config/server.json`) should drive both.

---

## MVP Definition

### This Milestone (v1.1) — Launch With

Minimum to ship functional payment-gated uploads with BUD-07 compliance.

- [ ] `AccessConfig` extended with `payments?: boolean` field
- [ ] `checkAccess()` updated: when `payments=true`, unlisted pubkeys return `{ allowed: false, requiresPayment: true }`
- [ ] `PaymentConfig` type added to `types.ts` — `{ mints: string[], amount: number, unit: string, cacheTtlMs: number }`
- [ ] `config/payment.json` schema defined and documented
- [ ] `loadPaymentConfig()` with configurable TTL (same pattern as `loadAccessConfig()`)
- [ ] `verifyCashuPayment(token: string, config: PaymentConfig): Promise<boolean>` implemented — calls mint swap endpoint
- [ ] `paymentRequired(config: PaymentConfig): Response` rewritten — encodes NUT-18 payment request in X-Cashu header
- [ ] Write handlers wired: when `requiresPayment: true`, check for X-Cashu/X-Lightning proof header; if present verify; if absent return 402
- [ ] Configurable cache TTL — `ACCESS_CACHE_TTL_MS` and `BLOCKED_CACHE_TTL_MS` read from `PaymentConfig.cacheTtlMs`; TTL=0 always fetches fresh

### Add After Validation (v1.x)

- [ ] Lightning support via external provider API — add when operators request it and have LN infrastructure; requires its own research
- [ ] Per-mint amount config — allow different amounts per accepted mint if operator demand appears

### Future Consideration (v2+)

- [ ] BOLT-12 offers — more modern Lightning payment flow, better privacy than BOLT-11
- [ ] Subscription/recurring payment tracking — requires external state management system
- [ ] Read-side payments for access-controlled blobs — requires rethinking CDN architecture entirely

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| public+payments access mode | HIGH — core new capability enabling monetization | MEDIUM — extends existing checkAccess() at the reserved seam | P1 |
| PaymentConfig type + config/payment.json | HIGH — prerequisite for everything else | LOW — new type, new JSON file on Bunny Storage | P1 |
| Configurable cache TTL (including TTL=0) | MEDIUM — quality of life for paid server operators | LOW — replace constants with config value, add conditional | P1 |
| Correct X-Cashu 402 header (NUT-18 encoded) | HIGH — BUD-07 compliance; clients parse this | MEDIUM — NUT-18 serialization, replace existing stub | P1 |
| Cashu token verification (mint API call) | HIGH — without this, payment gate is unenforced | HIGH — external HTTP to mint, token parsing, error cases | P1 |
| 400 + X-Reason on invalid payment proof | MEDIUM — BUD-07 compliance for error path | LOW — X-Reason pattern already in codebase | P1 |
| Lightning preimage verification | MEDIUM — wallet ecosystem compat | HIGH — requires invoice issuance infrastructure not available on edge | P2 |
| Correct X-Lightning 402 header (BOLT-11 invoice) | LOW — format correctness without verification is incomplete | LOW — correct header format, no provider yet | P2 |

**Priority key:**
- P1: Must have for v1.1 launch
- P2: Should have, add when infrastructure supports it
- P3: Nice to have, future milestone

---

## Existing Code Audit

The following files require changes in v1.1:

| File | Current State | v1.1 Change Needed |
|------|---------------|--------------------|
| `src/middleware/payments.ts` | Stub — `paymentRequired()` sets non-spec headers (`X-Payment-Amount`, `X-Payment-Unit`); `verifyLightningPayment()` always returns false | Rewrite `paymentRequired()` for NUT-18 X-Cashu; add `verifyCashuPayment()`; fix `X-Lightning` header to use BOLT-11 invoice format |
| `src/middleware/access.ts` | Complete for v1.0 — hardcoded `ACCESS_CACHE_TTL_MS = 60_000`; no `payments` mode branch in `checkAccess()` | Add `payments` mode to decision matrix; make TTL read from `PaymentConfig.cacheTtlMs` |
| `src/types.ts` | `AccessConfig` has `public/whitelist/blacklist`; `PaymentInfo` is a minimal stub | Add `payments?: boolean` to `AccessConfig`; replace `PaymentInfo` with `PaymentConfig` type |
| `src/storage/metadata.ts` | `BLOCKED_CACHE_TTL_MS = 60_000` hardcoded | Read TTL from `PaymentConfig.cacheTtlMs`; support TTL=0 bypass |
| Write handlers (blob-upload, mirror, media) | Return 403 on denied access | Check `result.requiresPayment`; if true, call `paymentRequired()`; if request has X-Cashu/X-Lightning header, call verifier before deciding |

### Key Implementation Note: Cashu Verification Flow

The `verifyCashuPayment(cashuBToken, paymentConfig)` function:

1. Parse the `cashuB` token from the X-Cashu request header — extract mint URL and proofs
2. Verify the mint URL is in `paymentConfig.mints` — reject tokens from untrusted mints
3. Verify token amount meets `paymentConfig.amount` — reject underpayment
4. POST to `{mintUrl}/v1/swap` with the proofs — atomically redeems the token at the mint
5. If mint returns new proofs: payment valid (token was unspent and correct denomination)
6. If mint returns error: token already spent, wrong unit, or invalid — return false

The server receives new proofs from the swap. These can be discarded (simplest) or held as operator revenue (future feature). The mint handles double-spend prevention atomically — no local state needed.

### Key Implementation Note: Correct 402 Response Format

Current `paymentRequired()` output (incorrect, non-spec):
```
HTTP/1.1 402 Payment Required
X-Payment-Amount: 100
X-Payment-Unit: sat
```

Required BUD-07 output:
```
HTTP/1.1 402 Payment Required
X-Cashu: <NUT-18 encoded payment request>
```

The NUT-18 payment request in X-Cashu encodes: `{ a: amount, u: unit, m: [mintUrl1, mintUrl2] }` as a base64url-encoded JSON object (following the NUT-18 format from cashubtc/nuts).

BUD-07 example from the canonical spec:
```
X-Cashu: "creqApWF0gaNhdGVub3N0cmFheKlucHJvZmlsZTFx..."
```

Lightning example (BOLT-11 invoice, not LNURL):
```
X-Lightning: "lnbc30n1pnnmw3lpp57727jjq8zxctahfavqacy..."
```

---

## Sources

- [BUD-07 specification (canonical)](https://github.com/hzrd149/blossom/blob/master/buds/07.md) — HIGH confidence (official Blossom spec, directly fetched)
- [Cashu NUT-24: HTTP 402 payment required](https://github.com/cashubtc/nuts/blob/main/24.md) — HIGH confidence (official Cashu spec, directly fetched)
- [Cashu NUTs specifications index](https://cashubtc.github.io/nuts/) — HIGH confidence
- [NUT-07: Token state check](https://cashubtc.github.io/nuts/07/) — HIGH confidence (double-spend prevention model)
- [X-Cashu reference implementation](https://github.com/cashubtc/xcashu) — MEDIUM confidence (inspected)
- [BOLT-11 specification](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) — HIGH confidence
- [402fordummies.dev NUT-24 landing](https://402fordummies.dev/) — MEDIUM confidence
- Existing codebase: `src/middleware/payments.ts`, `src/middleware/access.ts`, `src/types.ts`, `src/storage/metadata.ts` — HIGH confidence (inspected directly)

---

*Feature research for: blssm.us v1.1 — BUD-07 payments, public+payments mode, configurable TTL*
*Researched: 2026-02-24*
