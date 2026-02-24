# Stack Research

**Domain:** BUD-07 payment middleware + configurable cache TTL for Blossom server (Bunny EdgeScript / Deno)
**Researched:** 2026-02-24
**Confidence:** HIGH

---

## Context: Additive Milestone Research

This file supersedes the v1.0 access-control STACK.md. It covers only stack additions for the v1.1 milestone:

1. BUD-07 payment verification (Cashu NUT-24, Lightning BOLT-11)
2. Pluggable payment interface (verifier function type)
3. Configurable cache TTL (including TTL=0)

**Existing stack is unchanged** — TypeScript, Deno, Bunny EdgeScript, `@noble/curves@1.8.1`, `@noble/hashes@1.6.1`.

---

## Key Finding: No New npm Packages Required

After researching BUD-07, NUT-24, NUT-07, BOLT-11 verification, and the Bunny EdgeScript runtime constraints, the conclusion is:

**All three features can be implemented using existing dependencies.**

The reasons are detailed below per feature.

---

## Feature 1: Cashu NUT-24 Verification

### How BUD-07 + NUT-24 Cashu Verification Works

**Server 402 response** — the server sends an `X-Cashu` header containing a NUT-18 encoded payment request (CBOR + base64url, prefixed `creqA`). This tells the client which mints are accepted, what amount/unit is required.

**Client payment** — client retries the request with a `cashuB` token in the `X-Cashu` header.

**Server verification flow** (NUT-24 spec, verified from cashubtc/nuts/blob/main/24.md):
1. Decode the cashuB token from `X-Cashu` header — cashuB is `base64url(JSON)` after stripping the `cashuB` prefix.
2. Validate: mint URL is in the server's accepted mints list; unit matches; amount >= required.
3. Call the mint's NUT-07 checkstate endpoint (`POST /v1/checkstate`) with the proof Y values to confirm tokens are UNSPENT.
4. If checkstate returns UNSPENT for all proofs: accept the request.
5. If any proof is SPENT/PENDING: respond 400 with `X-Reason`.

**Y value computation** — NUT-07 requires Y = `hash_to_curve(proof.secret)`. The `hash_to_curve` operation uses secp256k1, which is `@noble/curves/secp256k1` — already in `deno.json`.

### Why cashu-ts is NOT Needed

`@cashu/cashu-ts@3.5.0` is a wallet library (minting, melting, swapping). For server-side payment receipt verification, the server only needs:

1. `base64url decode + JSON.parse` — built into Deno/Web APIs
2. `hash_to_curve(secret)` — `@noble/curves/secp256k1` already present
3. `fetch` to the mint's `/v1/checkstate` — Deno/EdgeScript `fetch` API

Adding cashu-ts would pull in cryptographic dependencies that duplicate `@noble/curves` and `@noble/hashes` already in the project. The raw HTTP approach is simpler, has no bundle size impact, and is fully verifiable against the spec.

**Confidence:** HIGH — verified against NUT-24 spec, NUT-07 spec, and cashu-ts source structure. Bunny EdgeScript already calls external Bunny Storage API via `fetch`.

### cashuB Token Decode (No Library Needed)

```typescript
// cashuB token format: "cashuB" + base64url(JSON)
function decodeCashuToken(raw: string): CashuToken | null {
  const prefix = "cashuB";
  if (!raw.startsWith(prefix)) return null;
  try {
    const json = atob(raw.slice(prefix.length).replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as CashuToken;
  } catch {
    return null;
  }
}
```

Token structure (from NUT-00/NUT-18):
```typescript
interface CashuToken {
  token: Array<{ mint: string; proofs: Proof[] }>;
  unit?: string;
  memo?: string;
}
interface Proof {
  id: string;       // keyset ID
  amount: number;
  secret: string;   // used to compute Y for NUT-07 checkstate
  C: string;        // commitment
}
```

### NUT-07 Checkstate (Raw Fetch)

```typescript
// POST {mint_url}/v1/checkstate
// Body: { "Ys": [Y1, Y2, ...] }
// Y = hashToCurve(secret).toHex()
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

function proofToY(secret: string): string {
  // hash_to_curve as per NUT-09/NUT-00
  const msg = new TextEncoder().encode(secret);
  const point = secp256k1.hashToCurve(msg);  // or manual hash-to-point per NUT-09
  return point.toHex(true); // compressed
}
```

**Note:** Verify exact `hash_to_curve` algorithm against NUT-09 during implementation — it may be a domain-separated hash, not the secp256k1 standard hashToCurve. This is a **LOW confidence detail** requiring spec verification. The pattern (use `@noble/curves`) is correct; the exact function call needs NUT-09 review.

---

## Feature 2: Lightning BOLT-11 Verification

### The Verification Model

BUD-07 says: Lightning preimage proof is provided in `X-Lightning` header. The preimage verifies payment by `sha256(preimage) == payment_hash`.

**Problem:** The server must know the payment_hash to compare. This requires either:
- The server generated the BOLT-11 invoice (it knows the hash), OR
- The server decodes the BOLT-11 invoice provided in the 402 response to extract the payment_hash

For this server, the operator configures a Lightning address/LNURL. The 402 response provides a BOLT-11 invoice URL or LNURL. The server must decode the BOLT-11 invoice it generated to extract `payment_hash` for comparison.

**Recommended approach:** Store the `payment_hash` alongside the issued invoice in Bunny Storage (keyed by request context). On payment proof submission, look up the expected hash and compare `sha256(preimage)` to it using `@noble/hashes/sha256` (already present).

This approach requires **no new npm packages** for the preimage validation itself.

**BOLT-11 invoice decode** (if the server issues invoices): the `bolt11-decoder` npm package (`~1.3.1`) is lightweight and Deno-compatible via `npm:` specifier. However, if the server delegates invoice creation entirely to an external LN node/provider and only validates preimages, no decode library is needed.

**Architecture recommendation:** Defer Lightning support to a future milestone or treat it as an operator-pluggable verifier. The Cashu path via NUT-24 is fully specifiable without external node dependencies. Lightning requires operator infrastructure (a LN node or LNURL endpoint) that is out of scope for the payment middleware itself.

**Confidence:** MEDIUM — Lightning verification approach depends on operator infrastructure decisions not yet made.

---

## Feature 3: Pluggable Payment Interface

### Design: Pure TypeScript Interface

The pluggable verifier requires no library — it is a TypeScript function type:

```typescript
// src/middleware/payments.ts (extend existing file)

/** Result from a payment verifier */
export type PaymentVerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * A payment verifier receives the proof string from the X-{method} header
 * and returns whether it constitutes valid payment.
 *
 * Implementations are responsible for any I/O (e.g., calling mint checkstate).
 */
export type PaymentVerifier = (proof: string) => Promise<PaymentVerifyResult>;

/** Registry of verifiers keyed by payment method name */
export interface PaymentVerifiers {
  cashu?: PaymentVerifier;
  lightning?: PaymentVerifier;
}
```

The `checkPayment` function in the middleware takes `PaymentVerifiers` and dispatches to the appropriate one based on which header is present.

This is a pure TypeScript design — no framework, no new dependency.

**Confidence:** HIGH — this pattern mirrors the existing `StorageClient` dependency injection already in the codebase.

---

## Feature 4: Configurable Cache TTL

### Design: Config field in access.json, no new library

The change is purely in `src/middleware/access.ts`. Replace the hardcoded constant:

```typescript
// Before (hardcoded)
const ACCESS_CACHE_TTL_MS = 60_000;

// After (configurable from config/access.json)
interface AccessConfig {
  public: boolean;
  whitelist: string[];
  blacklist: string[];
  cacheTtlMs?: number;  // undefined = 60000 default; 0 = never cache
}
```

TTL=0 means: set `expires = now - 1` in the cache object (or skip caching entirely). On every request, the TTL check `now < cache.expires` fails immediately, forcing a fresh Bunny Storage read.

No new dependency required. The existing `StorageClient.getJson()` pattern handles the fetch.

**Confidence:** HIGH — pure logic change within existing module.

---

## Recommended Stack (New Additions Only)

### Core Technologies: No Changes

The existing stack handles all three features:

| Technology | Version | Role in v1.1 | Notes |
|------------|---------|-------------|-------|
| `@noble/curves` | 1.8.1 (existing) | `hash_to_curve` for Cashu NUT-07 Y values | Already in `deno.json` |
| `@noble/hashes` | 1.6.1 (existing) | SHA-256 for Lightning preimage verification | Already in `deno.json` |
| Deno `fetch` | built-in | Call mint `/v1/checkstate` and LNURL endpoints | Used for Bunny Storage; same API |
| `atob` / `JSON.parse` | built-in | Decode cashuB base64url token | Web API, available in Deno |

### Supporting Libraries: None Required

No new npm packages should be added for this milestone.

### Development Tools: No Changes

Existing `deno check`, `deno test`, and `build.ts` workflow is unchanged.

---

## Installation

No new packages. The `deno.json` imports section is unchanged for this milestone.

If Lightning BOLT-11 decode becomes necessary in a future milestone:

```bash
# Only if operator-side invoice decode is needed later:
# deno add npm:bolt11-decoder@1.3.1
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Raw fetch to mint NUT-07 | `@cashu/cashu-ts@3.5.0` full library | If building a full Cashu wallet client (not a server verifier); cashu-ts adds ~200KB bundle for features only wallets need |
| `@noble/curves` (existing) for Y values | Custom hash-to-curve impl | Never — @noble is audited and already present |
| TypeScript interface for pluggable verifier | Strategy pattern framework | Only if the codebase grows to >10 payment methods; overkill here |
| `cacheTtlMs` in `access.json` | Separate `config/cache.json` | Only if many modules need independently tunable TTLs; one field in existing config is simpler |
| Raw fetch for NUT-07 checkstate | cashu-ts `CashuWallet.checkProofsStates` | If cashu-ts were already a dependency; avoids code; but it is not and the raw call is 10 lines |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@cashu/cashu-ts` (wallet lib) | Server only needs token decode + mint HTTP call; library is wallet-focused, ~200KB with Node.js dependencies that may conflict with Bunny EdgeScript constraints | Raw base64url decode + `fetch` to mint |
| `bolt11` npm package | Requires Node.js `Buffer` APIs not available in Deno edge runtimes; adds crypto dependency that duplicates `@noble` | `@noble/hashes/sha256` for preimage check; defer full BOLT-11 decode to future milestone |
| Global payment config in `Config` (env vars) | Payment config changes frequently (new mints, adjusted amounts); env vars require redeployment | `config/payments.json` in Bunny Storage, same TTL cache pattern as `access.json` |
| Hardcoded mint URL | Forces redeployment to change accepted mints | `config/payments.json` with `acceptedMints` array |

---

## Stack Patterns by Variant

**If Cashu-only payment verification:**
- Decode cashuB from `X-Cashu` header with `atob` + `JSON.parse`
- Validate mint URL against `config/payments.json` accepted mints
- Compute Y = `hash_to_curve(proof.secret)` with `@noble/curves/secp256k1`
- POST to `{mint_url}/v1/checkstate` with Ys
- Accept if all proofs UNSPENT; reject if any SPENT/PENDING

**If Lightning payment verification:**
- Requires operator infrastructure decision (LN node, LNURL provider)
- Preimage check: `sha256(hex_decode(preimage)) === expected_payment_hash` using `@noble/hashes/sha256`
- Expected hash must be stored server-side when invoice was issued
- Recommend deferring this to a future milestone after operator decides on LN infrastructure

**If TTL=0 (always-fresh config):**
- Access config cache sets `expires = 0` (or skips caching object entirely)
- Every write request triggers one Bunny Storage read for `config/access.json`
- Acceptable trade-off: Bunny Storage reads are fast; no in-flight state on edge

---

## Version Compatibility

No new packages. Existing compatibility is unchanged.

| Package | Version | Compatible With | Notes |
|---------|---------|-----------------|-------|
| `@noble/curves` | 1.8.1 | Deno 2.x, Bunny EdgeScript | Used for secp256k1 hash-to-curve; no Node.js APIs |
| `@noble/hashes` | 1.6.1 | Deno 2.x, Bunny EdgeScript | SHA-256 for preimage check; no Node.js APIs |

**NUT-09 hash_to_curve detail (LOW confidence):** The Cashu hash-to-curve is domain-separated and may not match secp256k1's standard `hashToCurve`. Verify NUT-09 spec (`cashubtc/nuts/blob/main/09.md`) during implementation before shipping. The `@noble/curves` low-level primitives (`secp256k1.CURVE.Fp.fromBytes` etc.) can implement any variant, but the exact algorithm must be confirmed.

---

## Payment Config: Recommended Schema

Store in `config/payments.json` in Bunny Storage, same TTL cache pattern as `access.json`:

```json
{
  "enabled": false,
  "amount": 1000,
  "unit": "sat",
  "acceptedMints": [
    "https://mint.minibits.cash/Bitcoin"
  ],
  "lnurl": "user@example.com"
}
```

Field semantics:
- `enabled`: false = payment middleware inactive (public+payments mode not yet activated)
- `amount`: satoshi amount required per upload
- `unit`: currency unit for Cashu token (matches NUT-24 `u` field)
- `acceptedMints`: array of mint URLs the server will accept tokens from
- `lnurl`: operator's Lightning address for BOLT-11 invoices (future)

Safe default when `config/payments.json` is missing: `{ enabled: false }` → payment gate disabled.

---

## Sources

- `github.com/hzrd149/blossom/blob/master/buds/07.md` — BUD-07 spec: X-Cashu, X-Lightning headers; 402/400 flow; preimage proof for Lightning (HIGH confidence — official spec, verified via WebFetch)
- `github.com/cashubtc/nuts/blob/main/24.md` — NUT-24: server sends NUT-18 payment request in X-Cashu; client sends cashuB token; server validates mint/unit/amount (HIGH confidence — official spec, verified via WebFetch)
- `github.com/cashubtc/nuts/blob/main/07.md` — NUT-07: POST /v1/checkstate with Y values; Y = hash_to_curve(secret); states: UNSPENT/PENDING/SPENT (HIGH confidence — official spec, verified via WebFetch)
- `github.com/cashubtc/nuts/blob/main/18.md` — NUT-18: payment request format "creqA" + base64url(CBOR); fields: a, u, m, nut10 (HIGH confidence — official spec, verified via WebFetch)
- `github.com/cashubtc/cashu-ts` — confirmed v3.5.0 (npm registry verified); wallet-focused library; checkProofsStates available but unnecessary for server-only verification (MEDIUM confidence — GitHub releases page + npm registry)
- `npm registry` — `@cashu/cashu-ts` latest = 3.5.0 as of 2026-02-24 (HIGH confidence — direct npm registry query)
- `402fordummies.dev` — NUT-24 flow diagram; confirms 5-step handshake; server validates mint/unit/amount/conditions (MEDIUM confidence — educational resource, consistent with spec)
- Existing codebase analysis (`src/middleware/payments.ts`, `src/middleware/access.ts`, `deno.json`) — confirmed @noble/curves and @noble/hashes already present; fetch already used for Bunny Storage (HIGH confidence — direct code review)

---

*Stack research for: blssm.us v1.1 — BUD-07 payment middleware + configurable cache TTL*
*Researched: 2026-02-24*
