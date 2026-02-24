# Phase 7: Handler Wiring - Research

**Researched:** 2026-02-25
**Domain:** TypeScript handler wiring, paymentGate() integration, BUD-07 retry flow, Deno test patterns
**Confidence:** HIGH — all middleware already exists in the repo; this phase wires known pieces

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Pricing without body
- Use `Content-Length` request header to determine file size for sat price calculation
- If `Content-Length` is missing, return 411 Length Required (don't guess or fall back)
- For mirror: read the small JSON body `{ url: string }` to extract URL, then HEAD the remote URL to get `Content-Length` for pricing
- SC4 exception for mirror: reading a tiny JSON body before payment check is acceptable — SC4's intent is preventing large binary body buffering, not metadata reads

#### Retry proof flow
- Client sends Cashu proof token in `X-Cashu` request header on retry (symmetric with 402 response's `X-Cashu` header)
- Shared `paymentGate()` function used by all handlers — extracts `X-Cashu` header, validates proof or returns 402
- `paymentGate()` is self-contained: loads payment config (mints, pricing, BTC price) internally, matching `checkAccess()` pattern
- Mint unreachable during proof validation → pass through 503 + Retry-After to client (never accept unverified proofs, don't waste client's spent proof)

#### HEAD /upload and HEAD /media
- Both HEAD preflights return 402 with X-Cashu pricing header for unlisted pubkeys (client discovers price without uploading)
- HEAD /media mirrors HEAD /upload behavior exactly — consistent payment gate across all preflights
- HEAD 402 pricing: Claude's discretion on how to handle unknown file size (minimum price, omit amount, etc.)
- If client mistakenly sends X-Cashu proof header on HEAD, ignore it silently — HEAD never consumes proofs

#### Report endpoint
- PUT /report (BUD-09) is always free — no payment gate, no access check
- Even blacklisted pubkeys can submit reports (event signature is sufficient validation)
- Report is explicitly exempt from Phase 7 wiring — "five write handlers" = four handlers + report exemption confirmation

### Claude's Discretion
- HEAD 402 pricing approach (minimum price vs omit amount vs other)
- Exact `paymentGate()` function signature and return type
- How to structure integration tests for the full 402-pay-retry flow
- Error response formatting details beyond what's specified

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-01 | Operator can configure accepted Cashu mints, payment amount, and unit in config/payment.json | Already implemented in `payment-config.ts` — `loadPaymentConfig()` returns mints and amounts |
| PAY-02 | Payment config loads from Bunny Storage with configurable TTL cache | Already implemented in `payment-config.ts` — same pattern as access config |
| PAY-03 | Missing payment config defaults safely (payments disabled, no 402s) | Already implemented — `paymentsEnabled()` returns false when mints.length === 0 |
| PAY-04 | Server returns BUD-07 compliant 402 with NUT-18 encoded X-Cashu header when payment required | Already implemented in `payments.ts` — `buildPaymentRequired()` builds correct response |
| PAY-06 | Server validates Cashu payment proof by calling mint swap endpoint (double-spend safe) | Already implemented in `proof-validator.ts` — `validateCashuPayment()` calls NUT-03 swap |
| PAY-07 | Server returns 400 + X-Reason header when payment proof is invalid, expired, or from untrusted mint | Already implemented in `proof-validator.ts` — `buildPaymentError()` returns correct response |
| PAY-08 | 402 responses include Cache-Control: no-store to prevent CDN caching | Already in `buildPaymentRequired()` — this phase must preserve it in all 402 paths |
| ACL-01 | Operator can enable public+payments mode via payments field in access config | Already implemented in `access.ts` |
| ACL-02 | In public+payments mode, whitelisted pubkeys upload free (no 402) | Already implemented in `checkAccess()` — returns `{ allowed: true }` for whitelisted |
| ACL-03 | In public+payments mode, blacklisted pubkeys are denied (403, not 402) | Already implemented in `checkAccess()` — blacklist checked first |
| ACL-04 | In public+payments mode, unlisted pubkeys receive 402 payment required | Already implemented in `checkAccess()` — returns `{ requiresPayment: true }` |
| ACL-05 | Existing public and private modes work unchanged (backward compatible) | Already implemented in `checkAccess()` — this phase must not disturb existing branches |
</phase_requirements>

## Summary

Phase 7 is a pure wiring phase. All payment logic (buildPaymentRequired, validateCashuPayment, buildPaymentError, computeSatPrice, loadPricingConfig, startPriceFeedCron) and all access logic (checkAccess) are fully implemented and tested from Phases 4-6. The only thing this phase does is connect those pieces to the five write handlers that currently have stub 402 responses.

The central pattern is a `paymentGate()` helper function — modeled after `checkAccess()` — that all handlers call after access check returns `requiresPayment: true`. The function reads `X-Cashu` from the request headers: if present, it validates the proof (returning null on success or a Response on failure); if absent, it returns a fresh 402 with NUT-18 encoded pricing. The function loads payment config and BTC price internally, keeping handlers thin.

The price-feed cron (`startPriceFeedCron`) also needs wiring into `main.ts` — the function exists and is exported but was intentionally left unwired per Plan 06-01 comments. This is the last unwired piece.

**Primary recommendation:** Create `src/middleware/payment-gate.ts` with `paymentGate()` that encapsulates the full 402-or-validate decision, then replace stubs in each handler in a single pass. Keep each handler file change minimal (< 10 lines each).

## Standard Stack

### Core (all already in use — no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@cashu/cashu-ts` | 3.5.0 | Cashu token decode, proof validation via NUT-03 swap | Already in deno.json; used by proof-validator.ts |
| `@std/toml` | jsr:^1.0.0 | Parse TOML pricing config | Already in deno.json; used by price-feed.ts |
| `jsr:@std/assert` | (jsr resolved) | Deno test assertions | Already used in all *.test.ts files |

### Supporting (internal — already built)

| Module | Purpose | When to Use |
|--------|---------|-------------|
| `src/middleware/payments.ts` | `buildPaymentRequired()` — builds 402 response | When access check returns requiresPayment and no X-Cashu header |
| `src/middleware/proof-validator.ts` | `validateCashuPayment()`, `buildPaymentError()` — validates X-Cashu header proof | When client sends X-Cashu on retry |
| `src/middleware/price-feed.ts` | `loadPricingConfig()`, `readBtcUsdPrice()`, `startPriceFeedCron()` | Pricing; cron started in main.ts |
| `src/middleware/payment-config.ts` | `loadPaymentConfig()`, `paymentsEnabled()` | Load accepted mints + amounts |
| `src/middleware/access.ts` | `checkAccess()` — already wired | Already in all handlers |

**Installation:** No new packages — all dependencies are present.

## Architecture Patterns

### Recommended File Structure (changes only)

```
src/
├── middleware/
│   ├── payment-gate.ts       # NEW — paymentGate() shared helper
│   ├── payment-gate.test.ts  # NEW — unit tests for paymentGate()
│   ├── payments.ts           # EXISTING — buildPaymentRequired() (no change)
│   └── proof-validator.ts    # EXISTING — validateCashuPayment() (no change)
├── handlers/
│   ├── blob-upload.ts        # MODIFY — replace stub 402 with paymentGate() call
│   ├── mirror.ts             # MODIFY — replace stub 402 + add URL HEAD for pricing
│   ├── media.ts              # MODIFY — replace stub 402 with paymentGate() call
│   ├── upload-check.ts       # MODIFY — replace stub 402 with paymentGate() (HEAD variant)
│   └── blob-delete.ts        # NO CHANGE — delete is already always free
└── main.ts                   # MODIFY — wire startPriceFeedCron()
```

### Pattern 1: paymentGate() — Self-Contained Payment Decision

**What:** A single function called by all handlers after `checkAccess()` returns `requiresPayment: true`. It reads X-Cashu from request headers, decides 402 or validate, and returns `Response | null` (null = payment accepted, proceed; Response = stop, return this to client).

**Modeled after:** `checkAccess()` in `src/middleware/access.ts` — same self-contained config loading, same Response-or-null discriminated return.

**Signature (Claude's discretion):**
```typescript
// src/middleware/payment-gate.ts
export async function paymentGate(
  request: Request,
  storage: StorageClient,
  fileSizeBytes: number,
  pricePath: string,
): Promise<Response | null>
```

- Returns `null` → proof valid, handler proceeds to body read and upload
- Returns `Response` → 402 (no proof), 400/503 (bad proof), return directly from handler

**Internal flow:**
```typescript
// 1. Load payment config (mints, amounts)
const { config } = await loadPaymentConfig(storage);
if (!paymentsEnabled(config)) return null; // payments disabled globally

// 2. Load pricing and BTC price
const { mints: mintUrls, pricing } = await loadPricingConfig(/* tomlPath */);
const btcUsd = await readBtcUsdPrice(pricePath);
if (btcUsd === null) {
  // Price feed stale — fail open or closed? (Claude's discretion)
  // Recommendation: fail open (return null, allow upload) to avoid blocking users
  // when price feed is temporarily unavailable
  return null;
}

// 3. Check for proof on retry
const cashuToken = request.headers.get("X-Cashu");
const mintList = config.mints.map((m) => m.url);
const requiredSats = computeSatPrice(fileSizeBytes, btcUsd, pricing);

if (!cashuToken) {
  // No proof: issue 402 with price quote
  return buildPaymentRequired(fileSizeBytes, mintList, btcUsd, pricing);
}

// 4. Validate proof
const result = await validateCashuPayment(cashuToken, mintList, requiredSats);
if (!result.valid) {
  return buildPaymentError(result);
}

return null; // proof accepted
```

**Example handler integration (blob-upload.ts):**
```typescript
// Access control — existing (unchanged)
const access = await checkAccess(storage, auth.pubkey, "upload");
if (!access.allowed) {
  if (access.requiresPayment) {
    const fileSizeBytes = parseInt(request.headers.get("Content-Length") ?? "", 10);
    if (!fileSizeBytes || isNaN(fileSizeBytes)) {
      return errorResponse("Content-Length required for payment calculation", 411);
    }
    const gate = await paymentGate(request, storage, fileSizeBytes, config.pricePath);
    if (gate) return gate; // 402 or error — stop
    // null = payment accepted — fall through to body read
  } else {
    return errorResponse(access.reason, 403);
  }
}

// Read body — only reached after payment gate passes
const body = await request.arrayBuffer();
```

### Pattern 2: Mirror Handler — Remote HEAD for Pricing

Mirror reads a small JSON body `{ url: string }` before the payment gate. This is the approved SC4 exception (reading tiny metadata, not a large binary). Then HEADs the remote URL to get Content-Length for pricing.

```typescript
// MIRROR ONLY — read JSON body first (SC4 exception approved in CONTEXT.md)
let body: { url: string };
try {
  body = await request.json();
} catch {
  return errorResponse("Invalid JSON body", 400);
}
if (!body.url || typeof body.url !== "string") {
  return errorResponse("Missing 'url' field", 400);
}

// Access control
const access = await checkAccess(storage, auth.pubkey, "mirror");
if (!access.allowed) {
  if (access.requiresPayment) {
    // HEAD remote URL to get file size for pricing
    let remoteSize = 0;
    try {
      const headResp = await fetch(body.url, { method: "HEAD" });
      const cl = headResp.headers.get("Content-Length");
      remoteSize = cl ? parseInt(cl, 10) : 0;
    } catch {
      // HEAD failed — use 0 (1-sat floor applies)
    }
    const gate = await paymentGate(request, storage, remoteSize, config.pricePath);
    if (gate) return gate;
  } else {
    return errorResponse(access.reason, 403);
  }
}

// Now fetch the actual blob (existing code unchanged)
const remoteResp = await fetch(body.url);
```

### Pattern 3: HEAD Preflight — 402 Without Consuming Proof

HEAD `/upload` and HEAD `/media` must return 402 for unlisted pubkeys but NEVER consume a proof (client uses preflight only to discover the price).

```typescript
// In handleUploadCheck — access check
if (access.requiresPayment) {
  // HEAD preflights: always return 402, never validate X-Cashu
  // (even if client sends X-Cashu, ignore it — HEAD never consumes proofs)
  const fileSizeBytes = parseInt(request.headers.get("X-Content-Length") ?? "", 10);
  // For HEAD: if no size known, use 0 (1-sat floor applies via buildPaymentRequired)
  const effectiveSize = isNaN(fileSizeBytes) ? 0 : fileSizeBytes;

  // Build 402 directly — skip paymentGate() (HEAD variant doesn't validate)
  const { config: payConfig } = await loadPaymentConfig(storage);
  const { mints: mintUrls, pricing } = await loadPricingConfig(/* tomlPath */);
  const btcUsd = await readBtcUsdPrice(config.pricePath);
  if (btcUsd !== null && paymentsEnabled(payConfig)) {
    const mintList = payConfig.mints.map((m) => m.url);
    const priceResp = buildPaymentRequired(effectiveSize, mintList, btcUsd, pricing);
    // HEAD response: copy headers, no body (Response constructor handles null body)
    return new Response(null, {
      status: 402,
      headers: priceResp.headers,
    });
  }
  // Payments disabled or price unavailable: fall through
}
```

**Alternative:** `paymentGate()` takes an `ignoreProof: boolean` flag (HEAD path). This is cleaner but adds complexity to a shared function. Planner's call.

### Pattern 4: startPriceFeedCron Wiring in main.ts

`startPriceFeedCron()` is already implemented in `price-feed.ts` and exported. The comment in that file explicitly says "Phase 7 will wire this." Just needs:

```typescript
// src/main.ts — after config and storage creation
import { startPriceFeedCron } from "./middleware/price-feed.ts";

const PRICE_PATH = "/tmp/btc-price.json";
startPriceFeedCron(PRICE_PATH);
```

And `config.pricePath` should be set (or `PRICE_PATH` passed directly to `paymentGate()`).

### Pattern 5: Config.pricePath — Thread the Price Path

`paymentGate()` needs `pricePath` to call `readBtcUsdPrice()`. Options:
1. Add `pricePath: string` to the `Config` interface and read from env (or hardcode constant)
2. Pass `PRICE_PATH` constant defined in `main.ts` and imported by handlers

Recommendation: hardcode as module constant in `payment-gate.ts` (`const PRICE_PATH = "/tmp/btc-price.json"`) to avoid threading through Config. This matches the self-contained pattern.

### Anti-Patterns to Avoid

- **Reading body before payment gate (SC4 violation):** Only mirror gets the approved exception for its tiny JSON body. All other handlers must call `paymentGate()` before `request.arrayBuffer()`.
- **Using paymentGate() in HEAD preflights:** HEAD never validates proofs. Use a separate code path or `ignoreProof` flag.
- **Calling validateCashuPayment on every request regardless of access check:** Only call when `access.requiresPayment === true`. Public/whitelist/delete paths bypass entirely.
- **Missing 411 for absent Content-Length:** Don't fall back to 0 on PUT upload/media — if Content-Length is missing, return 411 per CONTEXT.md decision.
- **Double-consuming proofs:** Never call `validateCashuPayment` more than once per request. The proof is spent on first call; a second call on the same token will get `proof_already_spent`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 402 response construction | Custom NUT-18 encoding | `buildPaymentRequired()` in `payments.ts` | Already tested, NUT-18 compliant |
| Cashu proof validation | Custom swap endpoint call | `validateCashuPayment()` in `proof-validator.ts` | Already handles decode, trust, amount, swap, spent cache |
| Payment error responses | Custom X-Reason headers | `buildPaymentError()` in `proof-validator.ts` | Already handles 400/503 + Retry-After |
| Sat price calculation | Custom math | `computeSatPrice()` in `price-feed.ts` | Already has 1-sat floor, correct formula |
| BTC price reading | Re-fetch at request time | `readBtcUsdPrice()` in `price-feed.ts` | Cron keeps it fresh; per-request fetch violates Phase 6 design |
| Payment config loading | Inline `getJson` + normalize | `loadPaymentConfig()` in `payment-config.ts` | Already has TTL cache, normalization, paymentsEnabled() |

**Key insight:** Every piece is built. Phase 7 is glue, not construction.

## Common Pitfalls

### Pitfall 1: Calling paymentGate() When Payments Are Globally Disabled
**What goes wrong:** If `paymentsEnabled(payConfig)` is false but access check returns `requiresPayment: true` (shouldn't happen, but defensive coding), calling `buildPaymentRequired()` with empty mints would produce a 402 with no mints — unhelpful.
**Why it happens:** `checkAccess()` checks `access.config.payments` (the access.json flag), but `payment-config.ts` has its own `paymentsEnabled()` check on mints count. These can diverge if misconfigured.
**How to avoid:** `paymentGate()` should call `paymentsEnabled(payConfig)` and short-circuit with `null` (allow) if payments are disabled in payment.json, even if access check said `requiresPayment`.
**Warning signs:** 402 responses with empty X-Cashu mint lists.

### Pitfall 2: Content-Length vs X-Content-Length Headers
**What goes wrong:** PUT handlers use `Content-Length` (standard HTTP); HEAD /upload uses `X-Content-Length` (Blossom BUD-06 convention). Mixing them up causes wrong pricing.
**Why it happens:** BUD-06 HEAD preflight passes metadata in custom X- headers to avoid body; PUT handlers have actual Content-Length set by client.
**How to avoid:** PUT blob-upload reads `Content-Length`; HEAD upload-check reads `X-Content-Length`. Mirror HEADs the remote URL for its Content-Length.
**Warning signs:** HEAD preflight pricing based on wrong size.

### Pitfall 3: paymentGate() Called in Delete Handler
**What goes wrong:** Delete is always free in public+payments mode (per ACL-04 decision). `checkAccess()` already returns `{ allowed: true }` for delete, so `requiresPayment` is never true for delete. If someone adds a payment gate call to delete anyway, it adds unnecessary network calls.
**Why it happens:** Copy-paste from upload handler pattern.
**How to avoid:** Leave `blob-delete.ts` unchanged — it already has correct behavior. Confirm in code review.
**Warning signs:** Delete handler importing payment-gate.ts.

### Pitfall 4: HEAD Preflights Consuming Proofs
**What goes wrong:** If HEAD /upload or HEAD /media processes an X-Cashu header and calls `validateCashuPayment()`, the proof is consumed (NUT-03 swap is irreversible). The client's proof is lost and they cannot retry the actual PUT upload.
**Why it happens:** Code sharing temptation — reusing `paymentGate()` without considering HEAD semantics.
**How to avoid:** HEAD handlers must never call `validateCashuPayment()`. Either skip paymentGate() entirely on HEAD paths, or add `ignoreProof: true` flag.
**Warning signs:** HEAD response time spikes (mint network calls); client reports spending proofs without successful uploads.

### Pitfall 5: Mirror — HEAD Failure Blocking the Entire Flow
**What goes wrong:** If the remote URL doesn't support HEAD or returns an error, the payment gate has no Content-Length to price against.
**Why it happens:** Remote servers are not required to implement HEAD or return Content-Length.
**How to avoid:** Wrap remote HEAD in try/catch; on failure default `remoteSize = 0` (1-sat floor applies). This is the correct degradation: client pays 1 sat minimum, not blocked entirely.
**Warning signs:** Mirror requests failing with 502 before payment step.

### Pitfall 6: Price Path — Stale or Missing BTC Price
**What goes wrong:** `readBtcUsdPrice()` returns null if the file doesn't exist yet (server just started, cron hasn't fired). Calling `computeSatPrice()` with null or 0 BTC price causes division issues.
**Why it happens:** Race condition: `startPriceFeedCron()` fires immediately but is async. First requests may arrive before first tick completes.
**How to avoid:** `paymentGate()` should handle `btcUsd === null` explicitly. Decision (Claude's discretion): fail open (return null, allow upload free) or use a hardcoded fallback price. Failing open is safer for UX; the operator's mints still validate proofs.
**Warning signs:** 500 errors or division-by-zero on startup.

### Pitfall 7: deno.ns Reference Directive
**What goes wrong:** `payment-gate.ts` calls `readBtcUsdPrice()` which calls `Deno.readTextFile`. Without `/// <reference lib="deno.ns" />`, TypeScript type-checking fails.
**Why it happens:** The project uses `"lib": ["esnext", "dom"]` in compilerOptions — Deno globals not in scope by default.
**How to avoid:** Add `/// <reference lib="deno.ns" />` at top of `payment-gate.ts` (same pattern as `price-feed.ts`, `proof-validator.ts`).
**Warning signs:** `deno check` errors like "Cannot find name 'Deno'".

## Code Examples

Verified patterns from existing codebase:

### checkAccess() Pattern (ACCESS.TS — model for paymentGate())
```typescript
// Source: src/middleware/access.ts
export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
  action: AccessAction,
  ttlMs?: number,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage, ttlMs);
  // ... returns { allowed: true } or { allowed: false, reason, requiresPayment? }
}
```

### Existing Stub to Replace (BLOB-UPLOAD.TS)
```typescript
// Current stub — replace this block
if (access.requiresPayment) {
  return new Response(JSON.stringify({ message: "payment_required" }), {
    status: 402,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
```

### Target Pattern After Replacement
```typescript
// Replace stub with paymentGate() call
if (access.requiresPayment) {
  const cl = request.headers.get("Content-Length");
  const fileSizeBytes = cl ? parseInt(cl, 10) : NaN;
  if (isNaN(fileSizeBytes)) {
    return errorResponse("Content-Length required", 411);
  }
  const gate = await paymentGate(request, storage, fileSizeBytes);
  if (gate) return gate;
  // null = proof valid — fall through
}
```

### buildPaymentRequired() Signature (PAYMENTS.TS)
```typescript
// Source: src/middleware/payments.ts
export function buildPaymentRequired(
  fileSizeBytes: number,
  acceptedMintUrls: string[],
  btcUsdPrice: number,
  pricingConfig: PricingConfig,
): Response
// Returns: 402 + X-Cashu (NUT-18 encoded) + Cache-Control: no-store
```

### validateCashuPayment() Signature (PROOF-VALIDATOR.TS)
```typescript
// Source: src/middleware/proof-validator.ts
export async function validateCashuPayment(
  tokenHeader: string,
  acceptedMintUrls: string[],
  requiredAmountSats: number,
): Promise<ValidationResult>
// Returns: { valid: true } or { valid: false, reason, status? }
```

### loadPricingConfig() Signature (PRICE-FEED.TS)
```typescript
// Source: src/middleware/price-feed.ts
export async function loadPricingConfig(
  tomlPath: string,
): Promise<{ mints: string[]; pricing: PricingConfig }>
// Note: loadPricingConfig reads from filesystem (Deno.readTextFile)
// payment-gate.ts should decide the TOML path — recommend hardcoded constant
```

### startPriceFeedCron() (PRICE-FEED.TS — wire into main.ts)
```typescript
// Source: src/middleware/price-feed.ts
// Comment: "This function is intentionally called at server startup in Phase 7"
export function startPriceFeedCron(pricePath: string): void
// Fire-and-forget: calls tick() immediately, then setInterval(tick, 300_000)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Stub 402 JSON body `{ message: "payment_required" }` | Headers-only BUD-07 402 with NUT-18 X-Cashu | Phase 7 replaces all stubs | Full spec compliance |
| No pricing (stub returns 402 without amount) | Dynamic sat price from Content-Length + BTC feed | Phase 7 wires pricing | Clients know exact amount to pay |
| Price feed exists but not started | `startPriceFeedCron()` called in main.ts | Phase 7 | BTC price file available for paymentGate() |

**Known cashu-ts v3 quirk (HIGH confidence — documented in STATE.md):**
- `cashu-ts v3` exports `Wallet`/`Mint` not `CashuWallet`/`CashuMint`; rollup `.d.ts` wraps exports requiring `@ts-ignore`
- Already handled in `proof-validator.ts` — `paymentGate.ts` should import from `proof-validator.ts`, not directly from cashu-ts

## Open Questions

1. **TOML config path for paymentGate()**
   - What we know: `loadPricingConfig(tomlPath: string)` accepts a path; `price-feed.ts` examples use `"config/payment.toml"`
   - What's unclear: Whether this path should be hardcoded in payment-gate.ts or threaded through Config
   - Recommendation: Hardcode `const PRICING_TOML_PATH = "config/payment.toml"` in payment-gate.ts (same hardcoding pattern as `PAYMENT_CACHE_TTL_MS` in payment-config.ts)

2. **HEAD pricing for unknown file size**
   - What we know: CONTEXT.md says "Claude's discretion on how to handle unknown file size (minimum price, omit amount, etc.)"
   - What's unclear: Whether to pass `0` (triggers 1-sat floor) or some other sentinel
   - Recommendation: Pass `0` to `buildPaymentRequired()` — `computeSatPrice(0, ...)` returns `Math.max(1, 0) = 1` sat, which is honest (minimum discoverable price)

3. **paymentGate() when btcUsd price is null (server startup race)**
   - What we know: `readBtcUsdPrice()` returns null if file missing; `startPriceFeedCron()` fires immediately but is async
   - What's unclear: Policy on "fail open vs fail closed" when price feed unavailable
   - Recommendation: Fail open (return `null` from paymentGate, allow upload) — avoids blocking users on startup; mint still validates proofs cryptographically

4. **paymentGate() return type for the 411 case**
   - What we know: 411 Length Required is the specified response for missing Content-Length
   - What's unclear: Should paymentGate() handle 411 internally or should the handler check Content-Length before calling paymentGate()?
   - Recommendation: Handler checks Content-Length before calling paymentGate() — keeps paymentGate() signature simple (it always has a valid fileSizeBytes when called)

## Sources

### Primary (HIGH confidence)
- `src/middleware/payments.ts` — `buildPaymentRequired()` implementation, verified 402 shape
- `src/middleware/proof-validator.ts` — `validateCashuPayment()`, `buildPaymentError()` implementation
- `src/middleware/price-feed.ts` — `loadPricingConfig()`, `readBtcUsdPrice()`, `startPriceFeedCron()` with Phase 7 comment
- `src/middleware/payment-config.ts` — `loadPaymentConfig()`, `paymentsEnabled()` implementation
- `src/middleware/access.ts` — `checkAccess()` as design model for `paymentGate()`
- `src/handlers/blob-upload.ts` — current stub to replace, confirmed ordering (auth → access → stub)
- `src/handlers/mirror.ts` — current stub, body-before-access-check (already structured correctly)
- `src/handlers/media.ts` — current stub, same pattern as blob-upload
- `src/handlers/upload-check.ts` — HEAD stub, X-Content-Length usage
- `src/handlers/blob-delete.ts` — already no payment gate needed
- `.planning/phases/07-handler-wiring/07-CONTEXT.md` — all locked decisions
- `.planning/STATE.md` — cashu-ts v3 quirks, deno.ns reference directive requirement

### Secondary (MEDIUM confidence)
- `deno.json` — confirmed `@cashu/cashu-ts@3.5.0`, no new deps needed
- Existing tests (`deno test --allow-write --allow-read src/middleware/`) — 80 passing, baseline confirmed

### Tertiary (LOW confidence)
- None — all critical facts verified from codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps, existing modules confirmed working
- Architecture: HIGH — paymentGate() pattern directly modeled on checkAccess()
- Pitfalls: HIGH — identified from actual codebase reading + decision log in STATE.md

**Research date:** 2026-02-25
**Valid until:** Stable — code doesn't change until Phase 7 executes
