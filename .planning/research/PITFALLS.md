# Pitfalls Research

**Domain:** BUD-07 payment middleware, public+payments access mode, and configurable cache TTL on a stateless Bunny EdgeScript Blossom server
**Researched:** 2026-02-24
**Confidence:** MEDIUM (BUD-07 ecosystem is sparse; Cashu/Lightning payment verification pitfalls derived from Cashu NUT specs, BOLT-11 spec analysis, BUD-07 spec review, and direct codebase inspection. No reference BUD-07 implementation exists to compare against.)

---

## Critical Pitfalls

### Pitfall 1: Cashu Token Replay Across Multiple Requests

**What goes wrong:**
The same cashuB token submitted in the `X-Cashu` header can be accepted by multiple requests on different edge isolates. Because BUD-07 contains no nonce or request-binding mechanism (confirmed by spec review), and because each Bunny EdgeScript isolate is stateless with no shared in-memory store, a client that pays once can reuse the same token proof for N uploads — or share the proof with other clients — until the mint marks it spent.

**Why it happens:**
The BUD-07 spec delegates replay protection entirely to the payment method's own semantics. Cashu tokens become "spent" only when the server (or a trusted party) calls the mint to melt/swap the proof. If the server only validates the token format and amount without contacting the mint, nothing marks the proof as consumed. The spec says "validate and accept" but does not define how or when to mark the proof spent. Edge workers have no shared state, so an in-memory seen-token set is isolate-local and lost on restart.

**How to avoid:**
- For Cashu: The server MUST call the mint's `/v1/checkstate` endpoint (NUT-07) to verify the proof is `UNSPENT` before accepting it, and then immediately melt or swap the token via the mint API to mark it spent. Without this mint round-trip, tokens are reusable. Accept this as a hard architectural requirement: Cashu verification requires an outbound HTTP call to the mint on every gated request.
- Document that replay protection for Cashu depends entirely on the mint interaction being completed before the 200 response is sent. If the mint call fails, do not grant access — respond 402 again.
- For Lightning: Preimage replay is less acute because payment hashes are single-use by LN protocol design, but the server must independently verify the payment hash corresponds to an invoice it issued (see Pitfall 2).

**Warning signs:**
- A single cashuB token string is submitted for two different upload requests and both succeed.
- The payment verification function returns true based solely on token format checks, without any outbound mint call.
- Logs show no HTTP calls to a mint URL during upload handling.

**Phase to address:** Payment middleware implementation — define the mint interaction contract before writing any verification logic. The mint call is not optional.

---

### Pitfall 2: Lightning Preimage Verification Requires Issued Invoice State

**What goes wrong:**
`SHA256(preimage) == payment_hash` is cryptographically verifiable without any external service. However, this check alone does not prove the user paid the correct amount to the correct server, or that the invoice was issued by this server and not recycled from a different context. The existing `verifyLightningPayment` stub returns false unconditionally. A naive implementation that simply checks `sha256(preimage)` matches some hash from the request is insufficient: the server has no record of which payment hashes it issued, for what amount, or when they expire.

**Why it happens:**
Developers see the mathematical relationship (preimage → payment_hash) and conclude that cryptographic verification is sufficient. It is not. Correct Lightning verification requires the server to know the expected payment hash before the client submits the preimage. This means either: (a) the server generated the BOLT-11 invoice via an LN node and can look up the payment hash, or (b) the server uses a payment service (NWC, LNbits, Alby) that provides a webhook or API to confirm payment settlement. There is no stateless way to verify a Lightning preimage against an unknown payment hash.

**How to avoid:**
- Choose one of two implementation strategies at the start of the phase and commit to it:
  - **LN node / payment service**: Server generates invoices via NWC or LNbits; payment settlement is confirmed via webhook or API polling. The payment hash is stored (in Bunny Storage) with amount and expiry at invoice creation time. On preimage submission, load the stored invoice, verify `sha256(preimage) == stored_payment_hash`, and confirm the invoice is marked settled by the payment service.
  - **Cashu-only for now**: Defer Lightning until a payment service integration is ready. The existing stub pattern correctly returns false; keep it that way until a full implementation exists. Do not ship a half-implemented Lightning verifier that accepts any preimage.
- Never accept a preimage submitted in `X-Lightning` unless the server has a stored record of the corresponding invoice it issued.

**Warning signs:**
- `verifyLightningPayment` accepts a preimage argument but has no way to obtain the expected payment hash.
- There is no storage write at invoice generation time to record the payment hash and amount.
- The implementation returns true based only on `sha256(preimage)` without checking it against a known hash.

**Phase to address:** Payment middleware implementation — decide on Lightning strategy (payment service vs. defer) before writing verification code. Do not ship a partial implementation.

---

### Pitfall 3: `checkAccess` Semantic Change Breaks the Existing ACL Matrix

**What goes wrong:**
The existing `checkAccess` function returns `{ allowed: true }` or `{ allowed: false, reason, requiresPayment? }`. In v1.0, `requiresPayment` is reserved and must never be set. In v1.1, the public+payments mode requires returning `{ allowed: false, requiresPayment: true }` for unlisted pubkeys instead of a hard 403. If the payment middleware is inserted into handlers independently of `checkAccess`, the two systems can diverge: `checkAccess` returns a 403 for an unlisted pubkey in public+payments mode, and the payment gate never fires. The user gets a flat 403 instead of a 402.

**Why it happens:**
The access control function and the payment gate are designed as separate concerns, but their interaction is implicit in the return type. The existing comment in `access.ts` explicitly warns "MUST NOT be set in any v1 return path," which means v1.1 must change that constraint. Developers who add payment middleware at the handler level without updating `checkAccess` produce a system where payment-eligible requests are denied before the payment check runs.

**How to avoid:**
- The access layer must be the one that signals `requiresPayment: true` for public+payments mode unlisted pubkeys. The handler then routes based on the result: `requiresPayment` → invoke payment middleware → 402 or allow; `allowed: false` without `requiresPayment` → 403.
- Update the decision matrix comment in `access.ts` as the first task of v1.1. The full matrix including the new `public+payments` mode must be documented in the code before any code is written.
- Update the existing 8 ACL tests to include the new mode, and add new tests covering: whitelisted in public+payments (free pass), blacklisted in public+payments (403 not 402), unlisted in public+payments (402).

**Warning signs:**
- The `requiresPayment` field is only set in handler code, not in `checkAccess`.
- Unlisted pubkeys in public+payments mode receive 403 (forbidden) instead of 402 (payment required).
- The ACL test matrix has no tests for the `public+payments` mode.

**Phase to address:** Access control logic update — expand `checkAccess` before wiring payment middleware to handlers.

---

### Pitfall 4: 402 Response Cached by Bunny CDN

**What goes wrong:**
Bunny CDN may cache a 402 Payment Required response and serve it to subsequent clients who have valid payment proofs. A client pays and retries, but gets the CDN-cached 402 instead of a fresh response from the edge worker. This causes a permanent failure for paid clients until the cached 402 expires.

**Why it happens:**
CDN caching behavior for non-2xx responses varies. Bunny CDN caches some 4xx responses by default unless explicitly instructed otherwise. The existing `withCors` wrapper does not set `Cache-Control` headers on 4xx responses. Auth-gated 402 responses are never safe to cache because the next request from the same URL path may carry payment proof.

**How to avoid:**
- Set `Cache-Control: no-store` on all 402 responses from the payment middleware.
- Set `Cache-Control: no-store` on all 4xx responses from gated endpoints. This is a hard requirement — a cached 402 is operationally catastrophic.
- Verify in testing that the CDN does not cache 402 responses from `/upload`, `/mirror`, `/media`.

**Warning signs:**
- Client submits payment proof on retry and receives the same 402 body they received before paying.
- CDN logs show a cache hit (HIT status) on a 402 response.
- The `paymentRequired()` function in `payments.ts` does not set `Cache-Control`.

**Phase to address:** Payment middleware implementation — add `Cache-Control: no-store` to the `paymentRequired()` response before any other work.

---

### Pitfall 5: TTL=0 Exhausts Bunny Storage API Rate Limits

**What goes wrong:**
A configurable cache TTL with a TTL=0 option means every request that touches gated logic fetches `access.json` from Bunny Storage. Under moderate load (even 10 concurrent uploads per second), this generates 600+ storage API calls per minute from the config fetch alone, in addition to the existing blocked content checks. Bunny Storage API has rate limits and per-request costs. Sustained TTL=0 under real load will trigger rate limiting, causing `loadAccessConfig` to fail or return errors, which may default to open or closed depending on error handling.

**Why it happens:**
TTL=0 is designed for operators who need instant config propagation (e.g., urgently banning a pubkey). It is a valid operator-facing feature, but the implementation must not silently exhaust storage quota under production load. Developers test TTL=0 in isolation with one request and it works fine. Under concurrent load it becomes a problem.

**How to avoid:**
- TTL=0 is valid but must be documented as "development/emergency mode only — not suitable for sustained production load."
- When TTL=0 is configured and `loadAccessConfig` fails (non-2xx from storage), the system must have a defined fallback: use last known good config (if cached, even if expired) or fail closed (deny all). Do not silently default to public mode on storage errors.
- Add a warning log when TTL=0 is active: `[access] Cache TTL is 0 — config fetched on every request. Not suitable for production load.`
- Test the error path: what happens when `storage.getJson` throws during `loadAccessConfig` with TTL=0?

**Warning signs:**
- Storage API call logs show `config/access.json` fetched on every single request.
- Bunny Storage returns 429 (rate limited) on config reads under load.
- TTL=0 is in production config with no documentation of the tradeoff.

**Phase to address:** Cache TTL implementation — define the error fallback behavior and the TTL=0 warning before shipping the feature.

---

### Pitfall 6: Blacklist Check Order in Public+Payments Mode

**What goes wrong:**
In public+payments mode, the correct decision order is: (1) blacklisted → 403, (2) whitelisted → allow free, (3) unlisted → 402. If the whitelist check runs before the blacklist check, a pubkey that appears in both lists gets a free pass instead of a ban. An operator who adds a key to the blacklist to urgently remove access, not realizing it was also in the whitelist from a previous configuration, will find the ban ineffective.

**Why it happens:**
"Whitelist means trust" is an intuitive mental model. Checking whitelist first for a fast allow path feels correct. But in the payment mode the blacklist is an absolute ban that must override all other conditions. This is the same logic-inversion pitfall documented for v1.0, now extended to a three-state outcome (allow / 402 / 403) instead of two.

**How to avoid:**
- The decision tree in `checkAccess` must check blacklist first in all non-private modes, before whitelist, before payment gate. Write this explicitly in a comment as an invariant.
- Test the intersection: a pubkey in both `whitelist` and `blacklist` in public+payments mode must receive 403, not 200 and not 402.
- The v1.0 tests already have `blacklist-wins-over-whitelist` intent; extend them to cover the payment mode variant.

**Warning signs:**
- Blacklisted pubkeys who were previously whitelisted can still upload without payment.
- The `checkAccess` function has a whitelist check that returns `{ allowed: true }` before a blacklist check.
- No test covers pubkey in both lists in public+payments mode.

**Phase to address:** Access control logic update — extend the decision matrix and tests before wiring payment middleware.

---

### Pitfall 7: HEAD /upload Must Not Accept or Return 402 for Payment

**What goes wrong:**
The BUD-07 spec explicitly states: "HEAD endpoints MUST NOT be retried with payment proof." However, if the access control layer returns `requiresPayment: true` for an unlisted pubkey, the handler might naturally emit a 402 response for `HEAD /upload`. A BUD-07-aware client that receives 402 on HEAD might interpret this incorrectly. More critically: if the upload-check handler reads a payment proof from headers and calls payment verification, it is violating the spec's intent for HEAD.

**Why it happens:**
`HEAD /upload` shares the same upload-check handler (`handleUploadCheck`) as `HEAD /media`. When payment middleware is added to gated endpoints, developers often apply it uniformly without distinguishing between HEAD (pre-flight, information only) and PUT (actual upload). The existing handler dispatch in `router.ts` routes both HEAD cases to `handleUploadCheck`.

**How to avoid:**
- `HEAD /upload` and `HEAD /media` should return 402 for unlisted pubkeys in public+payments mode, so the client knows payment will be required for the PUT. This is correct and expected.
- What must NOT happen: the HEAD handler should not attempt to verify or consume a payment proof from headers. It must only check access state and return the appropriate status.
- Do not wire payment proof verification into `handleUploadCheck`. Verification only happens in PUT handlers.
- Document this explicitly: "HEAD returns 402 to signal that payment is required; it never verifies proof."

**Warning signs:**
- `handleUploadCheck` calls `verifyLightningPayment` or reads `X-Cashu` from headers.
- A client submitting payment proof on HEAD gets a 200 instead of 402, implying the proof was consumed.

**Phase to address:** Endpoint wiring — separate pre-flight access signaling from proof verification during handler implementation.

---

### Pitfall 8: Cashu Mint Not Validated Against Configured Allowed Mints

**What goes wrong:**
The NUT-24 spec states the token MUST come from one of the mints listed in the server's payment request. If the server accepts any cashuB token regardless of which mint issued it, an attacker can create a token on a mint they control (minting tokens to themselves) and use it to pay. The server validates a real token, but the economic value is self-issued.

**Why it happens:**
The BUD-07 payment middleware in `payments.ts` has no concept of allowed mints. The `PaymentInfo` struct has `lnurl` but no `mintList`. Developers implementing Cashu verification focus on token format and amount and forget that the mint identity is what gives the token economic value.

**How to avoid:**
- The `PaymentInfo` type must be extended to include `cashuMints?: string[]` — the list of mint URLs the server will accept.
- On token verification, extract the mint URL from the cashuB token and confirm it is in the allowed list before any mint API call.
- Store the allowed mint list in `config/payment.json` (or extend `access.json`). Default to empty list = Lightning-only if not configured.
- Test with a self-issued mint token against a server configured for a different mint — must get 400.

**Warning signs:**
- The `PaymentInfo` struct has no mint URL field.
- The Cashu verification function accepts tokens without checking the issuing mint URL.
- No test verifies that a token from a non-approved mint is rejected.

**Phase to address:** Payment middleware implementation — define the allowed mint list as a configuration requirement before writing verification logic.

---

### Pitfall 9: Payment Config Missing from Bunny Storage Defaults to Broken Behavior

**What goes wrong:**
The access config pattern (`access.json` missing → public mode defaults) is well-established. Payment config (`payment.json` or payment fields in `access.json`) has no equivalent default. If payment config is missing and the server is in public+payments mode, it cannot issue a valid 402 response: there is no amount, no unit, no mint list, no LNURL. The 402 response body would be malformed or the server would throw trying to read undefined fields.

**Why it happens:**
The access config has a `DEFAULT_ACCESS_CONFIG` constant. Payment config has no equivalent. Developers focus on the happy path (payment config present and valid) and do not define safe defaults for the missing-config case in a mode that requires payment config.

**How to avoid:**
- Define `DEFAULT_PAYMENT_CONFIG` with safe values. If payment config is missing and the mode requires payment, the server must: (a) log a configuration error, and (b) either fall back to pure public mode or return a 500 with a clear operator-facing message, not a malformed 402.
- Validate payment config on load, not on first request. Fail loudly at startup time if public+payments mode is enabled but payment config is incomplete.
- The config normalization pattern from `normalizeAccessConfig` should be replicated for payment config.

**Warning signs:**
- Reading `paymentConfig.amount` throws or returns undefined when the config file is missing.
- A request to a server in public+payments mode without payment config results in a 500, not a clear error.
- No default constant defined for payment configuration.

**Phase to address:** Payment config loading — define defaults and validation before wiring any payment response logic.

---

### Pitfall 10: Mode Transition — Existing `public: true` Config Becomes `public+payments` Unintentionally

**What goes wrong:**
An operator currently running the server with `{ "public": true, "whitelist": [...], "blacklist": [...] }` will have their existing config automatically treated as public+payments mode once the payment middleware is wired, if the access config schema is extended with an optional payment field. Pubkeys in their whitelist were previously irrelevant (whitelist is a no-op in public v1.0 mode). Post-upgrade, those same whitelist entries become free-pass grants and every non-whitelisted, non-blacklisted pubkey will start getting 402 responses instead of 200.

**Why it happens:**
The mode semantics change when payment is added. The config schema evolution is backward-incompatible in its semantic effect even if it is syntactically backward-compatible. Operators who have populated the whitelist for a future use (or left over entries from testing) will see behavior changes they did not expect.

**How to avoid:**
- Add an explicit config field to enable public+payments mode: `"payments": true` (or similar). Do not infer payment mode from the presence of payment config alone.
- Without `"payments": true` in the config, the server MUST behave identically to v1.0 (public or private, no payment gate) regardless of whether payment config is present.
- Document the upgrade path clearly: operators must opt into payment mode by adding the field. Existing configs are unaffected.

**Warning signs:**
- The mode is inferred from whether a payment config file exists, rather than from an explicit config flag.
- After deploying v1.1, existing public-mode servers start returning 402 to users.
- No migration guide or changelog entry documents the new config field required to opt into payment mode.

**Phase to address:** Access config schema update — define the opt-in flag before any code touches payment mode routing.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Accept any Cashu token without mint validation | Simpler verification code | Self-issued tokens from attacker-controlled mints get free access | Never |
| Verify Lightning preimage with SHA256-only, no invoice record | No LN node required | Preimage can be from any invoice anywhere, not just this server's invoices | Never |
| Store seen Cashu tokens in module-level Set for replay detection | Instant in-memory check | Set is isolate-local, lost on restart, useless across edge nodes | Never — either use mint's checkstate or accept that replay is prevented by mint melting |
| Skip `Cache-Control: no-store` on 402 responses | One less header | CDN caches 402, paid users get permanent payment loops | Never |
| TTL=0 in production without documented tradeoff | Instant config propagation | Exhausts Bunny Storage API rate limits under load | Only in emergencies with monitoring |
| Add payment check at handler level before updating `checkAccess` | Faster initial wiring | `checkAccess` returns 403 for unlisted pubkeys, payment gate never fires | Never |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Cashu mint verification | Validating token format and amount locally without calling mint | Call mint's `/v1/checkstate` (NUT-07) to confirm proof is UNSPENT before granting access |
| Cashu mint verification | Checking state but not melting/consuming the token | After confirming UNSPENT, melt or swap the token via mint API to prevent replay |
| Lightning verification | Computing `sha256(preimage)` and comparing to a hash in the request | The server must be the one that issued the invoice and has the payment hash stored — cannot verify without prior state |
| Bunny CDN caching | Not setting Cache-Control on 402 responses | Set `Cache-Control: no-store` on all 402 and gated-endpoint 4xx responses |
| `PaymentInfo` type | Omitting allowed mint list from the struct | Extend `PaymentInfo` with `cashuMints?: string[]` and validate on every token |
| Access config migration | Assuming existing `public: true` configs are unaffected | Add explicit `"payments": true` field; treat its absence as "no payment gate" |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| TTL=0 with concurrent uploads | 429 errors from Bunny Storage on config reads | Document TTL=0 as emergency-only; default TTL to 60s; add fallback to last-known-good config | Any load > 1 req/s sustained |
| Cashu mint API call on every gated request | High latency on all gated uploads, mint becomes a bottleneck | Use TTL-cached access config so payment config is not re-fetched; mint calls are unavoidable but should not stack with config fetches | Any load > a few req/s |
| Payment proof verification inside `HEAD /upload` handler | HEAD pre-flight consumes tokens, leaving nothing for the PUT | Only verify proof in PUT/write handlers, never in HEAD | First payment attempt against a HEAD-verifying server |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Accepting Cashu tokens from any mint | Attacker self-mints tokens on a controlled mint and gets free access | Validate mint URL against operator-configured allowed mint list |
| Not contacting mint to spend/check the Cashu proof | Same token used for multiple uploads across isolates | Always call mint's `/v1/checkstate`; melt or swap after confirmation |
| Lightning preimage accepted without issued invoice record | Attacker submits SHA256 preimage of any data, fabricates payment | Server must only accept preimage matching a stored invoice hash it issued |
| 402 response without `Cache-Control: no-store` | CDN caches payment prompt; paying clients permanently blocked | Add `Cache-Control: no-store` to `paymentRequired()` response headers |
| Blacklist check after whitelist in payment mode | Blacklisted+whitelisted pubkeys bypass ban and get free access | Blacklist check must be first in all non-private modes |
| Payment gate fires before blacklist check | Blacklisted pubkey receives a payment prompt instead of a ban | `checkAccess` blacklist check must happen before `requiresPayment` is set |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| 402 body missing mint list or LNURL | Client wallet cannot determine how to pay | Include `mints`, `amount`, `unit`, and `lnurl` in 402 JSON body per NUT-24 and BUD-07 |
| `X-Reason` header missing on 400 after bad proof | Client cannot surface a human-readable error | BUD-07 requires `X-Reason` header on 400; implement it in the payment verification error path |
| No distinction in error message between "payment failed" (400) and "access denied" (403) | Users cannot tell if they need to pay differently or are banned | 400 = payment proof invalid; 403 = access policy denial; 402 = payment required; keep them semantically distinct |
| Config change from public to public+payments with no operator notice | All existing non-whitelisted users suddenly get 402 | Require explicit opt-in config flag; do not change mode implicitly on upgrade |
| TTL=0 with stale config on some edge nodes but fresh on others | Intermittent 402 vs 200 for the same user on the same request retry | Document TTL behavior; TTL=0 does not guarantee global consistency, only per-isolate freshness |

---

## "Looks Done But Isn't" Checklist

- [ ] **Cashu replay prevention:** Mint `/v1/checkstate` is called and proof is melted/swapped before granting access — verify by submitting the same cashuB token twice, second attempt must be rejected.
- [ ] **Lightning invoice state:** Server stores the payment hash at invoice creation and verifies preimage against stored hash — verify by submitting a valid SHA256 preimage that does not correspond to a server-issued invoice, must be rejected.
- [ ] **Mint validation:** Token from a non-configured mint is rejected with 400 — verify by sending a cashuB token from a different mint URL.
- [ ] **402 not cached:** CDN does not cache 402 responses — verify by checking response headers for `Cache-Control: no-store` on a 402.
- [ ] **Blacklist beats whitelist in public+payments:** Pubkey in both lists gets 403, not 200 or 402 — verify with explicit test.
- [ ] **Unlisted pubkey in public+payments gets 402, not 403:** The access check returns `requiresPayment: true` for unlisted pubkeys in this mode — verify with a pubkey absent from both lists.
- [ ] **HEAD /upload returns 402 but does not consume proof:** Submitting payment proof on HEAD does not grant access or consume the token — verify HEAD with X-Cashu header returns 402, not 200.
- [ ] **TTL=0 error fallback:** When Bunny Storage returns an error on config fetch with TTL=0, the server fails closed (or uses last known config), not silently open — verify by simulating a storage error.
- [ ] **Payment config missing is safe:** When payment config is absent and payments mode is active, server returns a clear error, not a malformed 402 — verify by deleting payment config with payments mode enabled.
- [ ] **Opt-in flag required for payment mode:** Existing `{ "public": true }` config without the new payments flag does not activate payment gating — verify by deploying v1.1 against an old config and confirming non-whitelisted users still get 200.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Cashu replay (tokens reused) | HIGH | Immediately disable Cashu payment method via config; audit which uploads came through the replay window; if mint integration is added, non-replayed tokens are still valid going forward |
| Lightning preimage accepted without invoice verification | HIGH | Disable Lightning payment method; all "verified" Lightning payments may be invalid; treat as security incident |
| 402 cached by CDN | MEDIUM | Purge CDN cache for affected paths immediately; add `Cache-Control: no-store` to `paymentRequired()` and redeploy |
| Mode transition broke existing users | MEDIUM | Roll back to previous deployment or add the explicit opt-in flag set to false; users return to normal access within one TTL window (60s) |
| TTL=0 in production causing rate limiting | LOW | Update config to non-zero TTL (e.g., 60s); redeploy; rate limiting resolves within minutes |
| Blacklist-whitelist order wrong | HIGH | Treat as security bug; fix logic and redeploy immediately; audit uploads from the affected window |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Cashu token replay | Payment middleware implementation | Integration test: same token submitted twice, second gets 400 or 402 |
| Lightning preimage without invoice state | Payment middleware implementation | Test: SHA256 preimage not matching any stored invoice is rejected |
| `checkAccess` semantic change breaks 402 path | Access control logic update | Unit test: unlisted pubkey in public+payments returns `requiresPayment: true`, not `allowed: false` with 403 |
| 402 cached by CDN | Payment middleware implementation | Header test: 402 responses contain `Cache-Control: no-store` |
| TTL=0 storage exhaustion | Cache TTL implementation | Load test: TTL=0 with 10 concurrent requests — no storage rate limiting |
| Blacklist check order in payment mode | Access control logic update | Matrix test: blacklisted+whitelisted in public+payments mode → 403, not 200 or 402 |
| HEAD /upload proof verification | Endpoint wiring | Test: HEAD with X-Cashu header returns 402, token not consumed |
| Cashu mint not validated | Payment middleware implementation | Test: token from non-configured mint URL → 400 |
| Payment config missing defaults | Payment config loading | Test: payment config absent with payments mode active → defined behavior, not 500 |
| Mode transition opt-in | Access config schema update | Deploy v1.1 against old config; confirm existing public-mode behavior unchanged |

---

## Sources

- [BUD-07 Payment Required spec](https://github.com/hzrd149/blossom/blob/master/buds/07.md) — MEDIUM confidence (via WebFetch; spec is minimal and does not define replay protection)
- [NUT-24 Cashu HTTP payment spec](https://github.com/cashubtc/nuts/blob/main/24.md) — MEDIUM confidence (via WebFetch; server verification steps not fully specified)
- [NUT-07 Token state check](https://cashubtc.github.io/nuts/07/) — HIGH confidence (official Cashu spec; defines checkstate API used for replay prevention)
- [NUT-05 Melting tokens](https://cashubtc.github.io/nuts/05/) — HIGH confidence (official Cashu spec; defines how to consume/invalidate a proof)
- [BOLT-11 Lightning invoice standard](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md) — HIGH confidence (defines preimage/payment_hash relationship)
- [Lightning preimage verification overview](https://voltage.cloud/blog/lightning-payments-pre-images-hashes) — MEDIUM confidence (explains why preimage alone is insufficient without known payment hash)
- [Bunny CDN caching behavior — authenticated response caching risk](https://httptoolkit.com/blog/bunny-cdn-caching-vulnerability/) — HIGH confidence (published security research on Bunny CDN caching)
- [Deno isolate cloud — module-level state is isolate-local](https://deno.com/blog/anatomy-isolate-cloud) — HIGH confidence (explains why in-memory seen-token sets cannot prevent cross-isolate replay)
- blssm.us codebase: `src/middleware/payments.ts` — stub verifyLightningPayment returns false unconditionally (direct inspection)
- blssm.us codebase: `src/middleware/access.ts` — existing AccessResult type, requiresPayment field, decision matrix comment (direct inspection)
- blssm.us codebase: `src/types.ts` — PaymentInfo struct missing mint list field (direct inspection)
- blssm.us codebase: `.planning/codebase/CONCERNS.md` — existing tech debt and race conditions (direct inspection)

---
*Pitfalls research for: BUD-07 payment middleware, public+payments mode, configurable cache TTL — stateless Bunny EdgeScript Blossom server*
*Researched: 2026-02-24*
