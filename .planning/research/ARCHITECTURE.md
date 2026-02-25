# Architecture Research

**Domain:** Blossom/Nostr blob server — BUD-07 payment middleware, public+payments mode, configurable cache TTL
**Researched:** 2026-02-24
**Confidence:** HIGH (direct codebase analysis + verified BUD-07 spec)

## Standard Architecture

### System Overview (v1.1 — with payment layer wired)

```
Incoming HTTP Request
        |
        v
┌───────────────────────────────────────────────────────────────┐
│                      Router (src/router.ts)                    │
│  CORS preflight short-circuits here (OPTIONS → 204)            │
├───────────────────────────────────────────────────────────────┤
│                     Handler Layer                              │
│  ┌──────────┐  ┌────────┐  ┌────────┐  ┌──────────────────┐  │
│  │ /upload  │  │/mirror │  │ /media │  │ /list, /delete   │  │
│  └────┬─────┘  └───┬────┘  └───┬────┘  └────────┬─────────┘  │
│       │            │           │                 │            │
│  [1] validateAuth ─┴───────────┴─────────────────┘            │
│       |                                                        │
│  [2] checkAccess(storage, pubkey)                              │
│       |── { allowed: true }           → continue              │
│       |── { allowed: false, reason }  → 403                   │
│       |── { requiresPayment: true }   → [3]                   │
│       |                                                        │
│  [3] verifyPaymentProof(request)     (NEW — replaces stub)    │
│       |── proof valid                → continue               │
│       |── no proof present           → paymentRequired() 402  │
│       |── proof invalid              → 400 + X-Reason         │
│       |                                                        │
│  [4] isBlocked(storage, hash)        (content hash check)     │
│       |                                                        │
│  [5] Business logic                                            │
├───────────────────────────────────────────────────────────────┤
│                     Config & Cache Layer                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  loadAccessConfig(storage, ttl)                          │ │
│  │  Module-level cache — TTL from config/access.json field  │ │
│  │  TTL=0 → always fresh (no cache)                         │ │
│  └──────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────┤
│                     Storage & Metadata Layer                   │
│  ┌────────────────────┐  ┌────────────────────────────────┐   │
│  │  Bunny Storage API │  │ Config files (JSON in storage) │   │
│  │  (blob data, meta) │  │ blocked.json, access.json      │   │
│  └────────────────────┘  └────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Status | Responsibility | Location |
|-----------|--------|----------------|----------|
| Router | Existing | Dispatch by method+path, apply CORS | `src/router.ts` |
| Auth (validateAuth) | Existing | Extract pubkey from Nostr kind 24242, verify Schnorr sig | `src/auth/nostr.ts` |
| Access Control (checkAccess) | Modified | Check pubkey against whitelist/blacklist, signal payment requirement | `src/middleware/access.ts` |
| Payment 402 Builder (paymentRequired) | Existing | Return 402 with X-Lightning/X-Cashu headers | `src/middleware/payments.ts` |
| Payment Verifier (verifyPaymentProof) | NEW | Validate Cashu token or Lightning preimage from request header | `src/middleware/payments.ts` |
| Payment Config (loadPaymentConfig) | NEW | Load payment amount/lnurl from config/payment.json | `src/middleware/payments.ts` |
| Config Cache (loadAccessConfig) | Modified | TTL-configurable module-level cache; TTL=0 bypasses cache | `src/middleware/access.ts` |
| Content Blocking | Existing | Check blob hash against blocked list | `src/storage/metadata.ts` |
| Handlers | Modified | Orchestrate auth → access → payment → business logic | `src/handlers/` |

## Recommended Project Structure (v1.1 delta)

```
src/
├── middleware/
│   ├── cors.ts           # Unchanged
│   ├── payments.ts       # MODIFIED: add verifyPaymentProof(), loadPaymentConfig()
│   └── access.ts         # MODIFIED: add requiresPayment path, TTL from config
├── handlers/
│   ├── blob-upload.ts    # MODIFIED: add payment gate between access check and body read
│   ├── blob-delete.ts    # MODIFIED: add payment gate (if payment config covers delete)
│   ├── blob-list.ts      # MODIFIED: add payment gate (if payment config covers list)
│   ├── mirror.ts         # MODIFIED: add payment gate
│   ├── media.ts          # MODIFIED: add payment gate
│   ├── upload-check.ts   # MODIFIED: return 402 instead of 403 when payment required
│   └── ...               # report.ts stays ungated
├── types.ts              # MODIFIED: add PaymentConfig, extend AccessConfig with cacheTtl
└── util.ts               # Unchanged
config/
├── access.json           # MODIFIED: add cacheTtl field (seconds, 0 = no cache)
└── payment.json          # NEW: payment amount, unit, lnurl
```

### What Is NOT New Files

- `payments.ts` already exists — it gets new exported functions, not a new file
- `access.ts` already exists — TTL becomes configurable, not a new cache module
- `payment.json` is a new Bunny Storage config file, not a source file

## Architectural Patterns

### Pattern 1: Auth → Access → Payment Proof → Business Logic

**What:** Four sequential gates before business logic. Each gate can short-circuit with the appropriate error response. Order is fixed by data dependencies.

**When to use:** All gated write endpoints (upload, mirror, media, delete, list).

**Trade-offs:** Every request incurs two async config reads (access config + potentially payment config), both cached. The payment proof check is local (crypto operation on the request header), not a network call.

**Example:**
```typescript
// Inside each gated handler:
const auth = await validateAuth(request, { verb: "upload", serverUrl: config.serverUrl });
if (!auth.authorized || !auth.pubkey) {
  return errorResponse(auth.error || "Unauthorized", 401);
}

const access = await checkAccess(storage, auth.pubkey);
if (!access.allowed) {
  if (access.requiresPayment) {
    const paymentConfig = await loadPaymentConfig(storage);
    // Check if client already sent proof
    const proofResult = await verifyPaymentProof(request);
    if (!proofResult.valid) {
      return proofResult.badProof
        ? new Response(null, { status: 400, headers: { "X-Reason": proofResult.error } })
        : paymentRequired(paymentConfig); // 402
    }
    // proof valid — continue to business logic
  } else {
    return errorResponse(access.reason, 403);
  }
}

// Read body, business logic...
```

### Pattern 2: requiresPayment Signal on AccessResult

**What:** `checkAccess()` returns a discriminated union with a `requiresPayment` flag on the deny path. The handler reads this flag to decide between 403 and 402 responses. The access function itself does NOT call payment verification — it only signals intent.

**When to use:** Public+payments mode — unlisted pubkeys get 402, not 403.

**Trade-offs:**
- Pro: Payment verification stays in payments.ts; access logic stays in access.ts. No cross-module calls.
- Pro: The `requiresPayment` field already exists as a reserved field on `AccessResult` in v1.0. Activating it requires no type change.
- Con: Each handler must handle the requiresPayment branch explicitly.

**Example:**
```typescript
// access.ts — updated checkAccess for public+payments mode
if (cache.config.publicPayments) {
  if (cache.blacklist.has(pubkey)) {
    return { allowed: false, reason: "pubkey is blacklisted" };
  }
  if (cache.whitelist.has(pubkey)) {
    return { allowed: true }; // free pass
  }
  return { allowed: false, reason: "Payment required", requiresPayment: true }; // 402 path
}
```

### Pattern 3: Configurable TTL via access.json cacheTtl Field

**What:** The `cacheTtl` field in `config/access.json` overrides the hard-coded 60s TTL. TTL=0 means always-fresh (bypass cache entirely). The `loadAccessConfig` function reads this field on every cache miss to recalculate the next expiry.

**When to use:** Operators who need rapid config changes (e.g., emergency blacklist update) set TTL=0. Operators who want performance keep the default (60s or omit the field).

**Trade-offs:**
- Pro: No code change required to adjust TTL — config file edit is sufficient.
- Pro: TTL=0 is a clean escape hatch without deploying new code.
- Con: TTL=0 means one Bunny Storage HTTP call per request on every gated endpoint. Acceptable for low-traffic servers; not recommended for high-traffic.
- Con: The TTL is stored IN the config being cached. On the first read after a TTL change, the old TTL governs the last interval. This is unavoidable and acceptable.

**Example:**
```typescript
// access.ts — TTL from config
const ttlMs = typeof config.cacheTtl === "number"
  ? config.cacheTtl * 1000
  : ACCESS_CACHE_TTL_DEFAULT_MS;

accessCache = {
  config,
  whitelist: new Set(config.whitelist),
  blacklist: new Set(config.blacklist),
  expires: ttlMs === 0 ? 0 : now + ttlMs, // 0 = always expired
};

// On next call:
if (accessCache && accessCache.expires > 0 && now < accessCache.expires) {
  return accessCache; // cache hit
}
// else: fetch fresh
```

### Pattern 4: Payment Config Loaded from Bunny Storage

**What:** Payment amount, unit, and LNURL live in `config/payment.json`, not env vars. Loaded with its own TTL cache, same pattern as access config.

**When to use:** Operator needs to change payment amount without a code deploy or env var update.

**Trade-offs:**
- Pro: Consistent with access.json pattern — same file-based config model.
- Pro: Amounts can change without redeployment.
- Con: One more config file to manage; minimal overhead since it uses the same cache pattern.

**Example:**
```json
// config/payment.json
{
  "amount": 1000,
  "unit": "sat",
  "lnurl": "LNURL1..."
}
```

```typescript
// payments.ts — loadPaymentConfig
let paymentCache: { info: PaymentInfo; expires: number } | null = null;

export async function loadPaymentConfig(storage: StorageClient): Promise<PaymentInfo> {
  const now = Date.now();
  if (paymentCache && now < paymentCache.expires) return paymentCache.info;
  const raw = await storage.getJson<PaymentInfo>("config/payment.json");
  const info = raw ?? { amount: 0, unit: "sat" };
  paymentCache = { info, expires: now + PAYMENT_CACHE_TTL_MS };
  return info;
}
```

## Data Flow

### Request Flow: Public+Payments Mode (the new path)

```
PUT /upload (unlisted pubkey, no payment proof)
    |
    v
validateAuth() → pubkey extracted
    |
    v
checkAccess(storage, pubkey)
  config: { public: true, publicPayments: true, whitelist: [...], blacklist: [...] }
  pubkey not in whitelist, not in blacklist
  → { allowed: false, requiresPayment: true }
    |
    v
Handler: requiresPayment === true
    |
    v
verifyPaymentProof(request)
  X-Cashu / X-Lightning header absent
  → { valid: false, badProof: false }
    |
    v
loadPaymentConfig(storage)
  → { amount: 1000, unit: "sat", lnurl: "LNURL1..." }
    |
    v
paymentRequired({ amount: 1000, unit: "sat", lnurl: "LNURL1..." })
  → 402 response with X-Lightning header
    |
    v
Client pays invoice, retries PUT with X-Lightning: <preimage>
    |
    v
verifyPaymentProof(request)
  Hashes preimage with SHA-256
  Checks hash against known invoice hash
  → { valid: true }
    |
    v
Business logic (store blob, metadata, index)
    |
    v
200 + BlobDescriptor
```

### Request Flow: Whitelisted Pubkey (payment bypassed)

```
PUT /upload (whitelisted pubkey)
    |
checkAccess() → { allowed: true }  (whitelist fast-path)
    |
Business logic immediately
    |
200 + BlobDescriptor
```

### Access Config Schema (config/access.json — v1.1 additions)

```json
{
  "public": true,
  "publicPayments": false,
  "whitelist": ["hex64pubkey..."],
  "blacklist": ["hex64pubkey..."],
  "cacheTtl": 60
}
```

Field semantics:
- `public`: existing field — true = public mode, false = private mode
- `publicPayments`: NEW — true activates public+payments mode (unlisted users → 402)
- `cacheTtl`: NEW — seconds to cache this config; 0 = no cache; omit = 60s default
- `whitelist`: existing — always free pass in all modes
- `blacklist`: existing — always denied in public and public+payments modes

### Access Policy Decision Matrix (v1.1 complete)

```
Mode              | Pubkey state    | Decision      | Status
------------------|-----------------|---------------|-------
public            | blacklisted     | DENY          | 403
public            | whitelisted     | ALLOW         |
public            | neither         | ALLOW         |
public+payments   | blacklisted     | DENY          | 403
public+payments   | whitelisted     | ALLOW (free)  |
public+payments   | neither, paid   | ALLOW         |
public+payments   | neither, no pay | PAYMENT REQ   | 402
private           | whitelisted     | ALLOW         |
private           | not whitelisted | DENY          | 403
```

### Payment Proof Verification Flow

```
verifyPaymentProof(request):
    |
    ├─ X-Cashu header present?
    │    → validateCashuToken(token)
    │       MEDIUM confidence — requires NUT-24 token parsing
    │       Cashu token is self-contained proof, no network call needed
    │       Returns { valid: true } or { valid: false, badProof: true, error: "..." }
    │
    └─ X-Lightning header present?
         → verifyLightningPreimage(preimage)
            Hash preimage with SHA-256
            Compare to stored invoice hash (from config/payment.json or in-flight store)
            Returns { valid: true } or { valid: false, badProof: true, error: "..." }

    No payment header:
         → { valid: false, badProof: false }  (prompt client with 402)
```

### Configurable TTL Data Flow

```
loadAccessConfig(storage):
    |
    ├─ accessCache exists AND expires > 0 AND now < expires?
    │    → return cached config (cache hit)
    │
    └─ cache miss (stale, empty, or TTL=0):
         → storage.getJson("config/access.json")
         → normalizeAccessConfig(raw)
         → read cacheTtl from normalized config
         → set expires = cacheTtl === 0 ? 0 : now + (cacheTtl * 1000)
         → store in module-level accessCache
         → return config
```

## New vs Modified Components

### New Components

| Component | Location | What It Does |
|-----------|----------|--------------|
| `verifyPaymentProof(request)` | `src/middleware/payments.ts` | Reads X-Cashu/X-Lightning from request headers, validates proof |
| `loadPaymentConfig(storage)` | `src/middleware/payments.ts` | Loads + caches config/payment.json (amount, unit, lnurl) |
| `config/payment.json` | Bunny Storage | Operator-editable payment amount and LNURL |
| `PaymentConfig` type | `src/types.ts` | Shape of config/payment.json |

### Modified Components

| Component | Location | What Changes |
|-----------|----------|--------------|
| `AccessConfig` type | `src/types.ts` | Add `publicPayments?: boolean`, `cacheTtl?: number` |
| `normalizeAccessConfig()` | `src/middleware/access.ts` | Parse new fields, apply defaults |
| `loadAccessConfig()` | `src/middleware/access.ts` | Read cacheTtl from config, use it to set expires |
| `checkAccess()` | `src/middleware/access.ts` | Add public+payments branch returning `requiresPayment: true` |
| Gated handlers (5) | `src/handlers/` | Add payment gate: check requiresPayment, call verifyPaymentProof/paymentRequired |
| `handleUploadCheck()` | `src/handlers/upload-check.ts` | Return 402 (not 403) when access returns requiresPayment |

### Untouched Components

- `src/router.ts` — no changes needed
- `src/auth/nostr.ts`, `src/auth/schnorr.ts` — no changes
- `src/storage/client.ts`, `src/storage/metadata.ts` — no changes
- `src/middleware/cors.ts` — no changes
- `paymentRequired()` in payments.ts — already correct, just needs to be called

## Build Order

Dependencies drive order. Each step can only begin when its inputs exist.

```
Step 1: Type definitions (src/types.ts)
  - Add PublicPayments to AccessConfig (publicPayments, cacheTtl fields)
  - Add PaymentConfig interface
  - No file deps within project
  ↓

Step 2: loadPaymentConfig() in payments.ts
  - New function, no deps on step 3+
  - Can be written and tested independently
  ↓

Step 3: verifyPaymentProof() in payments.ts
  - Depends on: types from step 1
  - Cashu: validate self-contained token (no network)
  - Lightning: hash preimage with SHA-256 (Web Crypto API), compare to stored hash
  ↓

Step 4: Access config TTL changes in access.ts
  - Modify normalizeAccessConfig() to parse cacheTtl
  - Modify loadAccessConfig() to apply TTL from config
  - Modify checkAccess() to return requiresPayment: true in public+payments branch
  - Depends on: updated AccessConfig type from step 1
  ↓

Step 5: Wire payment gate into each handler
  - Handler reads access.requiresPayment
  - Calls verifyPaymentProof() — if proof present and valid, continue
  - Calls loadPaymentConfig() + paymentRequired() if no proof
  - Depends on: steps 2, 3, 4
  Priority order:
    a. blob-upload.ts  (core write path, most important)
    b. upload-check.ts (preflight must mirror upload policy)
    c. mirror.ts
    d. media.ts
    e. blob-delete.ts
    f. blob-list.ts
  ↓

Step 6: Tests
  - Unit tests for verifyPaymentProof() (valid cashu, valid lightning, missing, invalid)
  - Unit tests for checkAccess() public+payments mode (extend existing test file)
  - Integration: full 402 → pay → retry flow (can be manual or simulated)
```

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Handler → checkAccess | Direct function call | Returns AccessResult discriminated union |
| Handler → verifyPaymentProof | Direct function call, request passed | Reads X-Cashu/X-Lightning headers |
| Handler → loadPaymentConfig | Direct function call | Only called when requiresPayment=true |
| Handler → paymentRequired | Direct function call | Returns 402 Response |
| checkAccess → loadAccessConfig | Internal call | cacheTtl sourced from config itself |
| Access Middleware → Storage | storage.getJson("config/access.json") | TTL-cached |
| Payment Middleware → Storage | storage.getJson("config/payment.json") | TTL-cached (60s fixed) |

### External Integration Points

| Service | How Used | Confidence |
|---------|----------|------------|
| Bunny Storage | config/payment.json read via StorageClient.getJson() | HIGH — identical to access.json pattern |
| Lightning Network | verifyLightningPreimage: hash preimage with SHA-256, compare to expected hash. No outbound call to LN node required for BOLT-11 preimage verification. | HIGH — preimage verification is local crypto |
| Cashu mint | Cashu token is self-contained proof (NUT-24). Verification is local if using offline proof format. If mint check is required, needs outbound fetch to mint. Scope decision needed. | MEDIUM — depends on implementation choice |

### BUD-07 Spec Compliance Notes

Based on spec analysis (HIGH confidence from direct spec read):

- 402 response: already implemented in `paymentRequired()` — correct
- `X-Lightning` header on 402: already implemented in `paymentRequired()` — correct
- `X-Cashu` header on 402: `paymentRequired()` currently only sets X-Lightning — needs X-Cashu added if Cashu is supported
- Client proof: X-Lightning = preimage string; X-Cashu = serialized cashuB token
- Invalid proof: 400 + X-Reason header (not 401, not 403) — handlers must implement this branch
- HEAD cannot carry proof: HEAD /upload returning 402 is valid signal; client must proceed to PUT

## Anti-Patterns

### Anti-Pattern 1: Calling Payment Verification Inside checkAccess

**What people do:** Have checkAccess call verifyPaymentProof so callers get a simple allowed/denied result.

**Why it's wrong:** checkAccess needs the request object to read payment headers. The function signature is `(storage, pubkey)` — adding request would couple it to HTTP concerns and break the clean abstraction. It also prevents payment verification from being called only when needed.

**Do this instead:** checkAccess returns `{ requiresPayment: true }` as a signal. The handler calls verifyPaymentProof separately. This preserves the existing clean function signature and keeps concerns separated.

### Anti-Pattern 2: Hard-Coding Payment Amount in Code

**What people do:** Put the sats amount in an env var or a constant in payments.ts.

**Why it's wrong:** Operators need to change prices without redeployment. Env vars on Bunny EdgeScript require a redeployment of the script.

**Do this instead:** Read amount from config/payment.json via loadPaymentConfig(), following the same pattern as access.json.

### Anti-Pattern 3: Calling loadPaymentConfig on Every Request

**What people do:** Call loadPaymentConfig at the top of every handler even when access returns allowed: true.

**Why it's wrong:** Whitelisted pubkeys and public mode requests never need payment config. Loading it unconditionally wastes a Bunny Storage round-trip (even if cached, it's still a cache lookup + function call overhead per request).

**Do this instead:** Call loadPaymentConfig only inside the `requiresPayment === true` branch, which is entered only when access denies due to payment requirement.

### Anti-Pattern 4: Verifying Lightning Preimage Against Wrong Hash

**What people do:** Store a single "current invoice hash" and compare all preimages against it.

**Why it's wrong:** Lightning invoices are single-use. If multiple users are paying simultaneously, only the first preimage would match. All subsequent payers would be rejected with "invalid preimage" even after valid payment.

**Do this instead:** For a stateless edge deployment, Cashu tokens are a much better fit than Lightning invoices. Cashu tokens are self-contained proofs that do not require knowing which specific invoice was paid. Lightning verification requires per-request invoice tracking which is not possible without external state.

### Anti-Pattern 5: TTL=0 as Default

**What people do:** Set TTL=0 by default thinking it is safest.

**Why it's wrong:** TTL=0 means one Bunny Storage HTTP call per request on every gated endpoint. Under any load this becomes the dominant latency cost. Storage API calls add 50-200ms each.

**Do this instead:** Default to 60s when cacheTtl is absent. Document TTL=0 as an emergency escape hatch.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single operator | 60s TTL is fine. Payment config loaded per cache miss only. |
| Small community | Same. Cashu tokens preferred over Lightning for stateless verification. |
| High write traffic | Keep TTL at 60s. Lightning per-invoice tracking becomes impossible without external state. Cashu is the right choice. |
| Large scale | Lists in access.json become unwieldy. Out of scope for this milestone. |

## Sources

- Direct codebase analysis: `src/middleware/payments.ts`, `src/middleware/access.ts`, `src/types.ts`, `src/handlers/blob-upload.ts`, `src/handlers/upload-check.ts` — HIGH confidence
- BUD-07 specification (fetched from GitHub): 402 status, X-Lightning/X-Cashu headers, proof via preimage/token, 400+X-Reason for invalid proof — HIGH confidence
- `.planning/PROJECT.md` — v1.1 requirements, constraints, out-of-scope decisions — HIGH confidence (authoritative)
- `.planning/codebase/ARCHITECTURE.md` — existing layer documentation — HIGH confidence

---
*Architecture research for: BUD-07 payment middleware, public+payments mode, configurable cache TTL*
*Researched: 2026-02-24*
