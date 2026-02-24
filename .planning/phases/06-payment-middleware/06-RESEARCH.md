# Phase 6: Payment Middleware - Research

**Researched:** 2026-02-24
**Domain:** Cashu ecash proof verification, NUT-18/NUT-24 HTTP 402, BUD-07, dynamic BTC/USD pricing
**Confidence:** HIGH (specs verified directly; cashu-ts API confirmed from source)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### 402 Response Shape
- Headers only, strict BUD-07 compliance — no JSON body
- X-Cashu header with NUT-18 encoded payment request, amount based on file size
- Omit X-Lightning header entirely until Lightning is actually wired up (no stub)
- Fresh quote generated per request — stateless, no caching of quotes
- Always include Cache-Control: no-store

#### Mint Trust & Config
- Accepted mints configured in a TOML config file
- Support multiple accepted mints — client proofs from any configured mint are valid
- Config file holds mint list with URLs and optional metadata

#### Proof Validation Flow
- When mint is unreachable during verification: reject with 503 + Retry-After header — never accept unverified proofs
- Local cache of redeemed proof secrets for fast-reject of known-spent proofs before calling mint swap endpoint
- Mint swap endpoint is the authoritative double-spend check

#### Dynamic Pricing
- USD cost basis: operator sets cost_per_gb_usd, profit_margin_pct, and slippage_premium_pct in TOML config
- BTC/USD price fetched from dual sources (CoinGecko + exchange API like Coinbase/Kraken), averaged when both available, fallback to whichever is up
- Price feed runs on a 5-minute cron, writes to a static file that the server reads — no per-request API calls
- Final sat price = (file_size_gb × cost_per_gb_usd × (1 + margin) × (1 + slippage)) / btc_usd_price × 100_000_000
- Minimum charge: 1 sat floor regardless of file size

### Claude's Discretion
- Whether to advertise accepted mint URLs in the X-Cashu NUT-18 payment request (based on spec expectations)
- Overpayment handling (accept as tip vs reject vs return change)
- Where in the request flow proof validation happens (inline header on upload vs separate endpoint) — based on BUD-07 spec
- Price feed cron implementation details (systemd timer, internal scheduler, etc.)
- TOML config file location and naming convention

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-04 | Server returns BUD-07 compliant 402 with NUT-18 encoded X-Cashu header when payment required | NUT-24 spec confirms X-Cashu = creqA-prefixed CBOR-encoded PaymentRequest; cashu-ts PaymentRequest.toEncodedRequest() does encoding |
| PAY-05 | Server returns BOLT-11 formatted X-Lightning header alongside X-Cashu in 402 response (stub) | CONTEXT.md decision: omit X-Lightning entirely until Lightning wired — PAY-05 is superseded by user decision |
| PAY-06 | Server validates Cashu payment proof by calling mint swap endpoint (double-spend safe) | NUT-03 POST /v1/swap invalidates inputs atomically; double-spend prevented by mint state machine |
| PAY-07 | Server returns 400 + X-Reason header when payment proof is invalid, expired, or from untrusted mint | NUT-24 spec: 400 for wrong mint/unit/amount; existing X-Reason pattern from upload-check.ts |
| PAY-08 | 402 responses include Cache-Control: no-store to prevent CDN caching | Already present in existing Phase 5 402 stubs; confirmed BUD-07 requirement |
</phase_requirements>

## Summary

This phase replaces the minimal Phase 5 402 stubs with full BUD-07-compliant payment middleware. The core work has three distinct sub-problems: (1) constructing a BUD-07 compliant 402 response with a NUT-18 encoded X-Cashu header containing a freshly computed sat price, (2) validating incoming cashuB tokens from clients against accepted mints via the NUT-03 swap endpoint, and (3) running a background price feed cron that fetches BTC/USD from two sources and writes a static file.

The BUD-07 spec (github.com/hzrd149/blossom/blob/master/buds/07.md) requires a 402 response with one or more X-{payment_method} headers. NUT-24 (github.com/cashubtc/nuts/blob/main/24.md) defines the X-Cashu header as a NUT-18 payment request encoded as `creqA` + base64url(CBOR(PaymentRequest)). The user decision supersedes PAY-05: no X-Lightning header until Lightning is wired.

Proof validation MUST use the NUT-03 swap endpoint (POST /v1/swap), not NUT-07 checkstate. Swap is the authoritative double-spend check because it atomically invalidates inputs. NUT-07 checkstate only reads state and is not a sufficient spending check on its own. The cashu-ts library (npm:@cashu/cashu-ts, current version 3.5.0) exports a `PaymentRequest` class and `CashuWallet.checkProofsStates()`, but the server does NOT need CashuWallet for the happy path — it calls the mint's HTTP API directly.

**Primary recommendation:** Import cashu-ts for PaymentRequest encoding and token decoding only. Call the mint's /v1/swap endpoint directly (via fetch) for double-spend-safe validation. Implement CBOR encoding via cashu-ts internals rather than a standalone CBOR library to avoid drift from the spec.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @cashu/cashu-ts | 3.5.0 (npm) | PaymentRequest encoding (NUT-18), cashuB token decoding | Official Cashu TypeScript library; exports PaymentRequest class with toEncodedRequest() |
| @noble/curves | 1.8.1 (already in deno.json) | secp256k1 point ops for hash_to_curve Y computation (NUT-07) | Already a project dependency; audited, Deno-compatible |
| @noble/hashes | 1.6.1 (already in deno.json) | SHA-256 for hash_to_curve domain separator computation | Already a project dependency |
| @std/toml | 1.0.x (jsr:) | Parse TOML config file for mint list and pricing params | Stabilized in Deno std library July 2024; zero-dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Deno.cron (unstable) | Built-in | 5-minute price feed cron | Use if Deno.cron is available; otherwise use setInterval fallback |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| cashu-ts PaymentRequest | Hand-roll CBOR + base64url | cashu-ts already implements NUT-18 encoding; hand-rolling risks spec drift |
| NUT-03 swap for validation | NUT-07 checkstate only | checkstate is read-only — does NOT consume the proof, enabling double-spend |
| @std/toml for config | JSON config (already used for payment.json) | User decision specified TOML config; @std/toml is stable and zero-dep |
| Deno.cron for price feed | setInterval | Deno.cron requires --unstable-cron flag; setInterval in main.ts startup is simpler and works in production |

**Installation:**
```bash
# Add to deno.json imports
"@cashu/cashu-ts": "npm:@cashu/cashu-ts@3.5.0",
"@std/toml": "jsr:@std/toml@^1.0.0"
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── middleware/
│   ├── payments.ts          # REPLACE: BUD-07 402 response builder + proof validator
│   ├── payment-config.ts    # KEEP: existing TOML/JSON config loader (extend for TOML)
│   └── price-feed.ts        # NEW: BTC/USD price cron + static file reader
├── config/
│   └── payment.toml         # NEW: mint list + pricing params (operator edits)
```

### Pattern 1: 402 Response with NUT-18 X-Cashu Header
**What:** Build a fresh NUT-24 compliant 402 response for every unauthenticated upload request
**When to use:** When `checkAccess()` returns `{ allowed: false, requiresPayment: true }`

The 402 response replaces the Phase 5 stub in `handleBlobUpload` and `handleUploadCheck`:

```typescript
// Source: NUT-24 spec + cashu-ts PaymentRequest API
import { PaymentRequest } from "npm:@cashu/cashu-ts@3.5.0";

export function buildPaymentRequired(
  fileSizeBytes: number,
  acceptedMintUrls: string[],
  btcUsdPrice: number,
  pricingConfig: PricingConfig,
): Response {
  const satAmount = computeSatPrice(fileSizeBytes, btcUsdPrice, pricingConfig);

  const paymentRequest = new PaymentRequest(
    /* transport */ [],      // empty = in-band via X-Cashu header (NUT-24 pattern)
    /* id       */ undefined,
    /* amount   */ satAmount,
    /* unit     */ "sat",
    /* mints    */ acceptedMintUrls,
    /* description */ undefined,
    /* singleUse */ true,    // each quote is single-use
  );

  const encoded = paymentRequest.toEncodedRequest(); // returns "creqA..." string

  return new Response(null, {
    status: 402,
    headers: {
      "X-Cashu": encoded,
      "Cache-Control": "no-store",
    },
  });
}
```

**Note on PaymentRequest constructor parameter order** (verified from source):
`new PaymentRequest(transport?, id?, amount?, unit?, mints?, description?, singleUse?, nut10?)`

### Pattern 2: Proof Validation via NUT-03 Swap
**What:** Validate a submitted cashuB token by calling the issuing mint's /v1/swap endpoint
**When to use:** When an upload request arrives with an X-Cashu header containing a cashuB token

```typescript
// Source: NUT-03 spec (cashubtc.github.io/nuts/03/)
// The swap endpoint atomically invalidates inputs — this IS the double-spend check

export async function validateCashuToken(
  tokenHeader: string,
  acceptedMintUrls: string[],
  requiredAmountSats: number,
): Promise<ValidationResult> {
  // Step 1: Decode cashuB token
  let decoded: Token;
  try {
    decoded = getDecodedToken(tokenHeader); // from cashu-ts
  } catch {
    return { valid: false, reason: "invalid_token_encoding" };
  }

  // Step 2: Check mint is trusted
  if (!acceptedMintUrls.includes(decoded.mint)) {
    return { valid: false, reason: "untrusted_mint" };
  }

  // Step 3: Check unit
  if (decoded.unit !== "sat") {
    return { valid: false, reason: "wrong_unit" };
  }

  // Step 4: Check amount >= required
  const totalSats = decoded.proofs.reduce((sum, p) => sum + p.amount, 0);
  if (totalSats < requiredAmountSats) {
    return { valid: false, reason: "insufficient_amount" };
  }

  // Step 5: Fast-reject via local spent-secrets cache
  if (anyProofInSpentCache(decoded.proofs)) {
    return { valid: false, reason: "proof_already_spent" };
  }

  // Step 6: Call mint swap to consume proofs (authoritative double-spend check)
  const swapResult = await callMintSwap(decoded.mint, decoded.proofs);
  if (!swapResult.ok) {
    if (swapResult.mintUnreachable) {
      return { valid: false, reason: "mint_unreachable", status: 503 };
    }
    return { valid: false, reason: "proof_invalid_or_spent" };
  }

  // Step 7: Record secrets in local cache
  addProofsToSpentCache(decoded.proofs);

  return { valid: true };
}
```

**Why swap instead of checkstate:** NUT-07 checkstate is read-only and returns UNSPENT/PENDING/SPENT. Two concurrent requests could both see UNSPENT and both proceed. NUT-03 swap is atomic — the mint invalidates inputs in the same operation as issuing new outputs. This is the authoritative double-spend prevention mechanism.

**What to do with swap outputs:** The server requests new blinded outputs (change) as part of the swap. The simplest approach is to use the cashu-ts `CashuWallet.swap()` helper which handles the blinded message generation. However, for a stateless server without a persistent wallet, the outputs can be donated/burned (discarded) — the proof consumption is what matters for double-spend prevention. The decision on this is marked as Claude's discretion (overpayment handling).

### Pattern 3: Dynamic Pricing Computation
**What:** Translate file size bytes into a sat amount using configurable USD pricing
**When to use:** Every time a 402 response is constructed

```typescript
// Source: User decisions in CONTEXT.md
export interface PricingConfig {
  cost_per_gb_usd: number;
  profit_margin_pct: number;  // e.g. 0.20 = 20%
  slippage_premium_pct: number; // e.g. 0.05 = 5%
}

export function computeSatPrice(
  fileSizeBytes: number,
  btcUsdPrice: number,
  config: PricingConfig,
): number {
  const GB = 1024 ** 3;
  const fileSizeGb = fileSizeBytes / GB;
  const usdCost = fileSizeGb
    * config.cost_per_gb_usd
    * (1 + config.profit_margin_pct)
    * (1 + config.slippage_premium_pct);
  const sats = Math.ceil((usdCost / btcUsdPrice) * 100_000_000);
  return Math.max(1, sats); // 1 sat floor
}
```

### Pattern 4: Dual-Source Price Feed Cron
**What:** Fetch BTC/USD from CoinGecko and Coinbase, write to a static JSON file every 5 minutes
**When to use:** Run at server startup; server reads the static file on each 402 construction

```typescript
// Source: CoinGecko and Coinbase public API docs

// CoinGecko free endpoint (no key required, 30 req/min, ~1-5 min cache)
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
// Coinbase spot price (no auth required)
const COINBASE_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

export async function fetchBtcUsdPrice(): Promise<number | null> {
  const [geckoResult, coinbaseResult] = await Promise.allSettled([
    fetchCoinGecko(),
    fetchCoinbase(),
  ]);

  const prices: number[] = [];
  if (geckoResult.status === "fulfilled" && geckoResult.value != null) {
    prices.push(geckoResult.value);
  }
  if (coinbaseResult.status === "fulfilled" && coinbaseResult.value != null) {
    prices.push(coinbaseResult.value);
  }

  if (prices.length === 0) return null; // both failed
  return prices.reduce((a, b) => a + b, 0) / prices.length; // average
}

// Cron: update every 5 minutes, write to static file
// Implementation choice (Claude's discretion): setInterval at startup
// Deno.cron requires --unstable-cron flag and is Deno Deploy-specific
function startPriceFeedCron(pricePath: string) {
  const run = async () => {
    const price = await fetchBtcUsdPrice();
    if (price != null) {
      await Deno.writeTextFile(pricePath, JSON.stringify({ btc_usd: price, updated: Date.now() }));
    }
  };
  run(); // immediate first fetch
  setInterval(run, 5 * 60 * 1000); // 5 min
}
```

### Pattern 5: TOML Config Parsing
**What:** Parse operator's payment.toml config for mint URLs and pricing params
**When to use:** At server startup; cached for the duration of the run

```typescript
// Source: @std/toml stabilized July 2024
import { parse } from "jsr:@std/toml@^1.0.0";

const raw = await Deno.readTextFile("config/payment.toml");
const config = parse(raw);
// config.mints = [{ url: "https://mint.example.com" }, ...]
// config.pricing.cost_per_gb_usd = 0.02
```

**TOML config file shape:**
```toml
[[mints]]
url = "https://mint.minibits.cash/Bitcoin"

[[mints]]
url = "https://mint.coinos.io"

[pricing]
cost_per_gb_usd = 0.02
profit_margin_pct = 0.20
slippage_premium_pct = 0.05
```

### Anti-Patterns to Avoid
- **Using NUT-07 checkstate as the only validation:** Read-only; two concurrent requests both see UNSPENT and double-spend. Always swap.
- **Caching 402 responses at CDN:** The Bunny CDN will cache 402 responses unless `Cache-Control: no-store` is set. The Phase 5 stubs already set this — never remove it.
- **Per-request BTC/USD price fetches:** CoinGecko has a 30 req/min free tier. At any non-trivial upload volume this will rate-limit. Always use the cron-to-static-file pattern.
- **Accepting proofs without amount check:** A client could submit 1 sat token for a 1 GB upload. Always verify `total_proof_amount >= required_sat_price` before calling swap.
- **Trusting the mint URL from the token without checking against accepted list:** cashuB tokens self-declare their mint URL. Always verify it is in `acceptedMintUrls` before calling that mint.
- **JSON body in 402 response:** BUD-07 specifies headers only. The Phase 5 stubs include a JSON body — the Phase 6 replacement must use `null` body with `status: 402`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| NUT-18 CBOR encoding | Custom CBOR + base64url encode | cashu-ts `PaymentRequest.toEncodedRequest()` | Spec has complex field-name mappings (single-char keys i/a/u/s/m/d/t); CBOR encoding has edge cases |
| cashuB token decoding | Custom base64url + CBOR decoder | cashu-ts `getDecodedToken()` | cashuB is CBOR-based (v4 tokens); field mappings are non-obvious |
| hash_to_curve (NUT-00) | Raw secp256k1 point math | `@noble/curves` (already in project) + implement domain separator | `ProjectivePoint.fromHex()` throws on off-curve points — use try/catch loop |

**Key insight:** The cashu-ts library's `PaymentRequest` class is the only stable TypeScript implementation of NUT-18 encoding. Manually implementing CBOR with the correct single-character field mappings is error-prone and has no test coverage advantage.

## Common Pitfalls

### Pitfall 1: NUT-03 Swap Requires Blinded Outputs (BlindedMessages)
**What goes wrong:** The /v1/swap endpoint requires BOTH inputs (proofs) AND outputs (blinded messages) in the request body. A server without a running wallet has no keypair to generate valid blinded messages.
**Why it happens:** NUT-03 is designed for wallet-to-wallet swaps, not server-side consumption.
**How to avoid:** Use cashu-ts `CashuWallet` with a throwaway keyset to generate the blinded messages for the swap, OR use the mint's melt endpoint (NUT-05 POST /v1/melt/quote + POST /v1/melt/bolt11) to "pay" a zero-value invoice — but this requires Lightning. The simplest approach: instantiate a `CashuWallet` for the specific mint URL, call `wallet.receive(token)` which internally calls swap and returns new proofs. The server can discard these new proofs (or accumulate them). This is the recommended "server wallet" pattern.
**Warning signs:** 400 error from mint with "invalid outputs" message.

### Pitfall 2: cashu-ts is a Wallet Library — Not All APIs Are Server-Safe
**What goes wrong:** `CashuWallet` expects to be initialized with `loadMint()` which performs network calls on every instantiation. If you create a new `CashuWallet` per request, you pay a network round-trip per 402 validation.
**Why it happens:** cashu-ts was designed for client wallets, not server-side middleware.
**How to avoid:** Cache a `CashuWallet` instance per mint URL in a module-level Map. Call `loadMint()` once at startup (or lazily on first use). Reuse across requests.
**Warning signs:** Slow proof validation latency; mint /v1/info called on every request.

### Pitfall 3: Payment Config in TOML vs Existing JSON Pattern
**What goes wrong:** The existing `payment-config.ts` loads from `config/payment.json` via `storage.getJson()` (Bunny Storage). The new TOML config is an operator file on disk (not Bunny Storage).
**Why it happens:** Two different config surfaces with different loading mechanisms.
**How to avoid:** Keep `config/payment.json` for the existing `PaymentConfig` type (mints/amounts as JSON via Bunny Storage). Add a separate `config/payment.toml` (or `config/pricing.toml`) on the local filesystem for the new pricing params. Do NOT merge the two loading patterns.
**Warning signs:** Compiler errors trying to call `Deno.readTextFile` inside a Bunny storage path; confusion between `PaymentConfig.mints` (existing) and TOML `[[mints]]` (new).

**Resolution:** The user decision specifies "TOML config file" for accepted mints and pricing. This likely means the TOML file replaces (or supplements) the existing `payment.json`. The planner should clarify whether: (a) payment.json is retired and TOML takes over entirely, or (b) TOML is a new file alongside the existing JSON. Given the project is Bunny edge-deployed, a local file is also edge-specific. The planner should default to keeping the existing `payment.json` for the mints list (already loaded) and adding a TOML file only for the new pricing parameters (cost_per_gb_usd, etc.) which are operator-specific and fit the TOML convention better.

### Pitfall 4: File Size Unknown at HEAD /upload Stage
**What goes wrong:** HEAD /upload is the pre-flight check and does NOT have the file body. The sat price computation requires file size. The HEAD 402 response cannot compute a precise price.
**Why it happens:** HEAD /upload doesn't include a body; X-Content-Length header is optional.
**How to avoid:** If `X-Content-Length` header is present, use it for pricing. If absent, return a base price (e.g., price for 1 byte, or minimum 1 sat). The HEAD 402 is only a signal — the actual validation happens on PUT /upload where the body is present.
**Warning signs:** HEAD 402 returning wildly different amounts than PUT 402 for the same upload.

### Pitfall 5: Spent-Proof Cache Race Condition
**What goes wrong:** The local spent-proof cache is module-level in-memory state. On a stateless edge deployment (multiple isolates), two concurrent requests for the same proof on different isolates will both miss the local cache and both call swap.
**Why it happens:** Bunny edge functions run in isolated V8 contexts; no shared memory between instances.
**How to avoid:** This is explicitly noted in STATE.md as the reason local tracking is insufficient. The NUT-03 swap endpoint is the authoritative check — the local cache is only a fast-reject optimization. Design the cache as best-effort: it prevents redundant swap calls on the same isolate but does NOT guarantee globally-unique proof consumption. The mint's swap endpoint is the source of truth.
**Warning signs:** Thinking the local cache is the only double-spend prevention layer.

### Pitfall 6: cashuB vs cashuA Token Format
**What goes wrong:** cashu-ts v3.x handles both cashuA (v3, JSON-based) and cashuB (v4, CBOR-based) tokens. Clients may send either format.
**Why it happens:** cashuB (v4) is the newer format; some older clients still use v3.
**How to avoid:** Use `getDecodedToken()` which handles both formats automatically. Don't attempt manual prefix detection.
**Warning signs:** "Invalid token" errors when receiving v3 tokens from older clients.

## Code Examples

Verified patterns from official sources:

### NUT-18 Payment Request Encoding
```typescript
// Source: cashu-ts PaymentRequest class (github.com/cashubtc/cashu-ts)
import { PaymentRequest } from "npm:@cashu/cashu-ts@3.5.0";

// Constructor signature (verified from source):
// new PaymentRequest(transport?, id?, amount?, unit?, mints?, description?, singleUse?, nut10?)
const req = new PaymentRequest(
  [],              // transport: empty = in-band (X-Cashu header pattern per NUT-24)
  undefined,       // id: optional payment id
  satAmount,       // amount in sats
  "sat",           // unit
  mintUrls,        // mints: string[] of accepted mint URLs
  undefined,       // description
  true,            // singleUse: true per CONTEXT.md (fresh quote per request)
);
const encoded = req.toEncodedRequest(); // "creqA..." prefix + CBOR + base64url
// Set as header: "X-Cashu": encoded
```

### cashuB Token Decoding
```typescript
// Source: cashu-ts README + npm package
import { getDecodedToken } from "npm:@cashu/cashu-ts@3.5.0";

// Returns: { mint: string, unit?: string, proofs: Proof[], memo?: string }
// Handles both cashuA (v3 JSON) and cashuB (v4 CBOR) formats
const token = getDecodedToken(xCashuHeader);
// token.mint  — the mint URL
// token.unit  — "sat" or other unit
// token.proofs — array of { id, amount, secret, C }
```

### NUT-07 checkstate request (for local fast-reject optimization only)
```typescript
// Source: NUT-07 spec (cashubtc.github.io/nuts/07/)
// Y = hash_to_curve(proof.secret) compressed hex — used for checkstate Ys field
// This is a read-only check; NOT a substitute for NUT-03 swap

// hash_to_curve per NUT-00:
// 1. msg_hash = SHA256("Secp256k1_HashToCurve_Cashu_" || secret_utf8)
// 2. Loop counter=0,1,2,...:
//    candidate = SHA256(msg_hash || counter_le_u32)
//    Y = secp256k1.ProjectivePoint.fromHex("02" + bytesToHex(candidate))
//    if no throw → valid point, return Y.toRawBytes(true) as compressed hex
```

### NUT-03 Swap via CashuWallet (recommended approach)
```typescript
// Source: cashu-ts CashuWallet API
import { CashuWallet, CashuMint, getDecodedToken } from "npm:@cashu/cashu-ts@3.5.0";

// Cache wallets per mint URL (avoid re-calling loadMint on every request)
const walletCache = new Map<string, CashuWallet>();

async function getOrCreateWallet(mintUrl: string): Promise<CashuWallet> {
  if (!walletCache.has(mintUrl)) {
    const mint = new CashuMint(mintUrl);
    const wallet = new CashuWallet(mint);
    await wallet.loadMint(); // one-time network call
    walletCache.set(mintUrl, wallet);
  }
  return walletCache.get(mintUrl)!;
}

// Validate + consume a cashuB token:
async function consumeToken(token: string, mintUrl: string): Promise<Proof[]> {
  const wallet = await getOrCreateWallet(mintUrl);
  // wallet.receive() decodes token, calls /v1/swap, returns new proofs
  return await wallet.receive(token);
}
```

### Dual-Source BTC/USD Price Fetch
```typescript
// CoinGecko free endpoint — no API key required (30 req/min limit)
async function fetchCoinGecko(): Promise<number | null> {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data?.bitcoin?.usd === "number" ? data.bitcoin.usd : null;
}

// Coinbase spot price — no auth required
async function fetchCoinbase(): Promise<number | null> {
  const res = await fetch(
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const price = parseFloat(data?.data?.amount);
  return isNaN(price) ? null : price;
}
```

### TOML Config Parsing
```typescript
// Source: @std/toml stabilized v1.0.0 (July 2024) per jsr.io/@std/toml
import { parse } from "jsr:@std/toml@^1.0.0";

const raw = await Deno.readTextFile("config/payment.toml");
const config = parse(raw) as {
  mints: Array<{ url: string }>;
  pricing: {
    cost_per_gb_usd: number;
    profit_margin_pct: number;
    slippage_premium_pct: number;
  };
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| cashuA (v3) JSON token format | cashuB (v4) CBOR token format | cashu-ts 2.x → 3.x | v4 is space-efficient; `getDecodedToken()` handles both |
| Manual NUT-07 checkstate as proof of payment | NUT-03 swap as authoritative consumption | Always spec-correct; now clarified | checkstate was never sufficient for double-spend prevention |
| cashu-ts 2.x (legacy CashuWallet API) | cashu-ts 3.x (new builder API, same core methods) | 2024 → 2025 | Migration guide at cashu-ts/blob/main/migration-1.0.0.md; `CashuWallet` still present but Wallet builder recommended for new code |

**Deprecated/outdated:**
- `cashu-ts 2.x`: `getDecodedToken` was the v2 API; v3 still exports it from legacy path. Use `getDecodedToken` from the top-level export (confirmed present in v3.x index).
- X-Lightning stub (PAY-05): User decision supersedes requirement — omit entirely until Lightning is wired.

## Open Questions

1. **Where does proof validation happen in the request flow?**
   - What we know: BUD-07 says submit proof via X-Cashu header on the actual request (not a separate endpoint); NUT-24 confirms in-band payment via retry with cashuB token in X-Cashu header
   - What's unclear: Should validation be on PUT /upload only, or also on HEAD /upload pre-flight?
   - Recommendation: HEAD /upload MUST NOT consume proof (it's a pre-flight). Validation happens only on PUT /upload (and PUT /mirror). HEAD /upload with an X-Cashu token should be ignored or return 200 with the price quote.

2. **CashuWallet `receive()` vs direct /v1/swap call**
   - What we know: `wallet.receive(token)` calls /v1/swap internally; direct HTTP call requires generating blinded outputs (complex)
   - What's unclear: cashu-ts v3 may have renamed `receive()` to `ReceiveBuilder` pattern
   - Recommendation: Use `CashuWallet.receive()` from the legacy API path (still present in v3.x per migration guide); verify method name against cashu-ts v3 docs before coding

3. **Overpayment handling (marked Claude's Discretion)**
   - What we know: NUT-03 swap always consumes the full token value and issues change; the server receives "change" proofs from the swap
   - Recommendation: Accept overpayment as a tip — discard the change proofs. This is the simplest stateless approach and matches how most NUT-24 implementations work.

4. **TOML file location (marked Claude's Discretion)**
   - What we know: Existing configs are in `config/` directory within Bunny Storage; TOML is a local file
   - Recommendation: `config/payment.toml` — consistent with existing config directory convention. Since this is a local-disk file (pricing params), it should be read with `Deno.readTextFile` at startup, not via the Bunny storage client.

5. **Deno.cron vs setInterval for price feed**
   - What we know: `Deno.cron` requires `--unstable-cron` flag; works in Deno Deploy but is unstable in self-hosted Deno
   - Recommendation: Use `setInterval` at server startup for portability. If the project moves to Deno Deploy, migrate to `Deno.cron`. The current deploy target (Bunny edge functions / standard Deno) favors `setInterval`.

## Sources

### Primary (HIGH confidence)
- github.com/hzrd149/blossom/blob/master/buds/07.md — BUD-07 spec: 402 headers, X-Cashu/X-Lightning format, 400 error + X-Reason
- github.com/cashubtc/nuts/blob/main/24.md — NUT-24 spec: X-Cashu header format, NUT-18 field requirements for HTTP 402, client submission, 400 validation errors
- github.com/cashubtc/nuts/blob/main/18.md — NUT-18 spec: PaymentRequest fields (i/a/u/s/m/d/t), CBOR encoding, "creqA" prefix format, transport types
- github.com/cashubtc/nuts/blob/main/07.md — NUT-07 spec: checkstate endpoint, Y value computation, state values (UNSPENT/PENDING/SPENT)
- github.com/cashubtc/nuts/blob/main/03.md — NUT-03 spec: swap endpoint (/v1/swap), atomic double-spend prevention
- github.com/cashubtc/nuts/blob/main/00.md — NUT-00 spec: hash_to_curve algorithm, domain separator "Secp256k1_HashToCurve_Cashu_", counter loop
- github.com/cashubtc/cashu-ts (src/index.ts, src/model/PaymentRequest.ts) — PaymentRequest class API: constructor params, toEncodedRequest(), fromEncodedRequest()
- jsr.io/@std/toml — @std/toml v1.0.0 stabilized July 2024; parse() function

### Secondary (MEDIUM confidence)
- docs.coingecko.com simple/price endpoint — free tier confirmed no-key, 30 req/min, returns `{ bitcoin: { usd: number } }`
- gist.github.com/3ba119b621a1573e19e75cc118ef5350 — Coinbase v2 API `GET /v2/prices/BTC-USD/spot` confirmed no-auth, returns `{ data: { amount: string } }`
- cashu-ts README + v3.x exports — `getDecodedToken`, `CashuWallet`, `CashuMint` confirmed present; `checkProofsStates` confirmed on CashuWallet

### Tertiary (LOW confidence)
- cashu-ts `CashuWallet.receive()` availability in v3.x — v3 has builder pattern; `receive()` may be on new `Wallet` class, not `CashuWallet`. Must verify against cashu-ts v3 migration guide before coding.
- Deno.cron stability — listed as unstable behind `--unstable-cron`; behavior in production non-Deploy Deno unclear.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — cashu-ts exported API verified from source files; @std/toml stabilization confirmed; @noble/curves already in project
- Architecture: HIGH — NUT-24 + BUD-07 specs directly fetched and verified; pattern confirmed against existing project handler patterns
- Pitfalls: HIGH — double-spend pitfall (checkstate vs swap) verified from spec; cashu-ts wallet caching from API analysis; TOML vs JSON distinction from codebase analysis
- Pricing API: MEDIUM — CoinGecko and Coinbase endpoints confirmed no-auth; rate limits from docs; integration pattern is standard fetch

**Research date:** 2026-02-24
**Valid until:** 2026-03-24 (cashu-ts is actively maintained; check for breaking changes in 3.x → 4.x before coding)
