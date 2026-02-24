# Phase 4: Payment Config + Types - Research

**Researched:** 2026-02-24
**Domain:** TypeScript type definitions, JSON config schema design, config normalization patterns
**Confidence:** HIGH

## Summary

Phase 4 is a pure type and schema definition phase. No new runtime logic is wired into request handling — the goal is to define `PaymentConfig` and `CacheConfig` TypeScript interfaces in `src/types.ts`, write normalization functions following the established `normalizeAccessConfig()` pattern, and establish the operator-facing JSON schema for `config/payment.json` and `config/cache.json`.

The codebase already provides a complete template for this work. `src/middleware/access.ts` implements exactly the pattern to replicate: raw JSON loaded via `storage.getJson<unknown>()`, normalized through a pure function that handles `null`, malformed, and partial inputs, cached in a module-level variable with a TTL, and exported for consumers. The only new elements are the domain concepts (mints-as-objects, per-action amounts, per-cache TTLs) and the 1-second floor on TTL=0.

Note: STATE.md contains an earlier decision noting `cacheTtl lives in config/access.json`. This was overridden by the CONTEXT.md discussion on 2026-02-24 which locked `config/cache.json` as a separate file. CONTEXT.md is authoritative for this phase.

**Primary recommendation:** Mirror `normalizeAccessConfig()` exactly for both `normalizePaymentConfig()` and `normalizeCacheConfig()`. No new libraries needed. All logic is pure TypeScript data transformation.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Config schema design**
- Mints specified as array of objects: `[{"url": "https://mint.example.com", ...}]` — allows optional per-mint fields later
- Per-action payment amounts: separate fields for upload, mirror (delete is always free)
- Unit is always satoshis — no configurable unit field
- Delete operations never require payment (encourages storage cleanup)

**Default & fallback behavior**
- Missing payment.json = payments disabled, no 402s issued
- Empty file or malformed JSON = same as missing (payments disabled, no warning needed)
- Missing fields filled with defaults: missing amount defaults to 0 (free), missing mints defaults to empty array
- Amount of 0 = free, no 402 issued for that action
- Empty mints array (even with amounts set) = payments disabled entirely (can't verify proofs without mints)

**Cache TTL placement**
- Separate config/cache.json file for all cache settings
- Per-cache TTLs: separate fields for access, payment, and blocked caches (e.g., accessTtl, paymentTtl, blockedTtl)
- TTL=0 means very short (1 second floor) — not true zero, avoids hammering Bunny Storage on burst traffic
- Missing config/cache.json defaults to 60 seconds for all caches (backward compatible with current hardcoded behavior)

**Config validation rules**
- Invalid mint entries: skip with console warning, use remaining valid mints (matches current pubkey validation pattern)
- Mint URL validation: format check only (valid HTTPS URL), no network probing during config load
- Invalid amounts (negative or non-integer): reject entire payment config, disable payments, warn loudly
- Cache TTL values: clamp to valid range (negative → 0/floor, above max → cap)

### Claude's Discretion

- Exact TypeScript type structure and naming conventions
- Config normalization function implementation details
- Max TTL cap value
- Whether mint objects include any optional fields beyond URL in initial implementation

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PAY-01 | Operator can configure accepted Cashu mints, payment amount, and unit in config/payment.json | `PaymentConfig` interface + `normalizePaymentConfig()` function enable this; `StorageClient.getJson()` already handles the Bunny Storage fetch |
| PAY-02 | Payment config loads from Bunny Storage with configurable TTL cache (same pattern as access config) | Existing `loadAccessConfig()` pattern with module-level cache variable is the direct template; TTL comes from `CacheConfig.paymentTtl` |
| PAY-03 | Missing payment config defaults safely (payments disabled, no 402s) | `normalizePaymentConfig(null)` must return a disabled-payments default; the `paymentsEnabled()` helper checks `mints.length > 0` |
| CACHE-01 | Operator can set cache TTL via config (including TTL=0 for always-fresh) | `CacheConfig` interface with `accessTtl`, `paymentTtl`, `blockedTtl` fields; TTL=0 maps to 1-second floor via `clampTtl()` |
| CACHE-02 | Configurable TTL applies to both access config and blocked hash caches | `normalizeCacheConfig()` exports a `CacheConfig` that both `access.ts` and `metadata.ts` will consume in later phases; Phase 4 defines the type, wiring is Phase 5+ |
</phase_requirements>

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript (Deno) | strict mode | Interface definitions, type narrowing | Project already uses strict TS; no new library needed |
| Deno std assert | jsr:@std/assert | Test assertions | Used in `access.test.ts`; consistent test pattern |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None needed | — | This phase is pure type/schema work | No parsing libs; `JSON.parse` via `StorageClient.getJson<unknown>` already handles deserialization |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written normalizer | zod / valibot | Zod adds 10KB+ to bundle; not in project; normalizer pattern is already established and consistent |
| Per-field URL validation library | Custom regex | A simple `new URL(s).protocol === 'https:'` suffices for format-only check; no library needed |

**Installation:**

No new packages required. All work is pure TypeScript within the existing Deno project.

---

## Architecture Patterns

### Recommended Project Structure

Phase 4 adds the following files/changes to the existing structure:

```
src/
├── types.ts                        # ADD: PaymentConfig, CacheConfig, MintEntry interfaces
├── middleware/
│   ├── access.ts                   # NO CHANGE in Phase 4 (TTL wiring is Phase 5)
│   ├── payment-config.ts           # ADD: normalizePaymentConfig(), paymentsEnabled(), loadPaymentConfig() stub
│   └── cache-config.ts             # ADD: normalizeCacheConfig(), loadCacheConfig() stub
config/                             # (runtime, in Bunny Storage — not in repo)
├── payment.json                    # NEW operator config file
└── cache.json                      # NEW operator config file
```

### Pattern 1: The normalizeAccessConfig() Template

**What:** Pure function converts `unknown` (raw JSON or null) into a typed, validated config with safe defaults. Module-level cache variable with TTL expiry. Export loader function that uses cache.

**When to use:** Every config file that gets loaded from Bunny Storage.

**Example (existing pattern from `src/middleware/access.ts`):**

```typescript
// Source: src/middleware/access.ts (existing codebase)

const DEFAULT_ACCESS_CONFIG: AccessConfig = {
  public: true,
  whitelist: [],
  blacklist: [],
};

function normalizeAccessConfig(raw: unknown): AccessConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_ACCESS_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    public: typeof r.public === "boolean" ? r.public : true,
    whitelist: filterPubkeys(r.whitelist, "whitelist"),
    blacklist: filterPubkeys(r.blacklist, "blacklist"),
  };
}

const ACCESS_CACHE_TTL_MS = 60_000;

interface AccessCache {
  config: AccessConfig;
  whitelist: Set<string>;
  blacklist: Set<string>;
  expires: number;
}

let accessCache: AccessCache | null = null;

export async function loadAccessConfig(storage: StorageClient): Promise<AccessCache> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) return accessCache;
  const raw = await storage.getJson<unknown>("config/access.json");
  const config = normalizeAccessConfig(raw);
  accessCache = { config, whitelist: new Set(config.whitelist), blacklist: new Set(config.blacklist), expires: now + ACCESS_CACHE_TTL_MS };
  return accessCache;
}
```

### Pattern 2: PaymentConfig Normalization (new, follows template)

**What:** Same shape as access normalization but for payment config. Key addition: `paymentsEnabled()` derived helper.

**When to use:** Any code that needs to know if payments are active.

**Example (recommended implementation):**

```typescript
// src/types.ts additions

/** A single accepted Cashu mint */
export interface MintEntry {
  url: string;
  // Optional per-mint fields reserved for future phases
}

/** Per-action payment amounts (satoshis). 0 = free. */
export interface PaymentAmounts {
  upload: number;   // sats required for PUT /upload
  mirror: number;   // sats required for PUT /mirror
  // delete is always free by design
}

/** Payment configuration from config/payment.json */
export interface PaymentConfig {
  mints: MintEntry[];
  amounts: PaymentAmounts;
}

/** Cache TTL configuration from config/cache.json (milliseconds) */
export interface CacheConfig {
  accessTtl: number;   // TTL for access config cache
  paymentTtl: number;  // TTL for payment config cache
  blockedTtl: number;  // TTL for blocked-hashes cache
}
```

```typescript
// src/middleware/payment-config.ts

const DEFAULT_PAYMENT_AMOUNTS: PaymentAmounts = { upload: 0, mirror: 0 };
const DEFAULT_PAYMENT_CONFIG: PaymentConfig = { mints: [], amounts: { ...DEFAULT_PAYMENT_AMOUNTS } };

/** Returns true if payments are active (mints list non-empty) */
export function paymentsEnabled(config: PaymentConfig): boolean {
  return config.mints.length > 0;
}

/** Validate a mint entry URL — HTTPS format check only, no network probe */
function isValidMintUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeMints(raw: unknown): MintEntry[] {
  if (!Array.isArray(raw)) return [];
  const result: MintEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      console.warn(`[payment] Skipping invalid mint entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isValidMintUrl(e.url)) {
      console.warn(`[payment] Skipping mint with invalid URL: "${String(e.url).substring(0, 60)}"`);
      continue;
    }
    result.push({ url: e.url as string });
  }
  return result;
}

function normalizeAmounts(raw: unknown): PaymentAmounts | null {
  // Invalid amounts → return null → caller disables payments entirely
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYMENT_AMOUNTS };
  const r = raw as Record<string, unknown>;

  for (const field of ["upload", "mirror"] as const) {
    const val = r[field];
    if (val !== undefined) {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        console.warn(`[payment] Invalid amount for "${field}": ${JSON.stringify(val)} — disabling payments`);
        return null; // reject entire payment config
      }
    }
  }

  return {
    upload: typeof r.upload === "number" && Number.isInteger(r.upload) && r.upload >= 0 ? r.upload : 0,
    mirror: typeof r.mirror === "number" && Number.isInteger(r.mirror) && r.mirror >= 0 ? r.mirror : 0,
  };
}

export function normalizePaymentConfig(raw: unknown): PaymentConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PAYMENT_CONFIG };
  const r = raw as Record<string, unknown>;

  const amounts = normalizeAmounts(r.amounts);
  if (amounts === null) {
    // Invalid amounts → payments disabled entirely
    return { ...DEFAULT_PAYMENT_CONFIG };
  }

  return {
    mints: normalizeMints(r.mints),
    amounts,
  };
}
```

### Pattern 3: CacheConfig Normalization with 1-Second Floor

**What:** Normalize cache TTL values. TTL=0 maps to 1000ms (1-second floor). Negative clamps to floor. Max cap prevents runaway TTLs.

**Example (recommended implementation):**

```typescript
// src/middleware/cache-config.ts

const DEFAULT_CACHE_TTL_MS = 60_000;  // 60 seconds — matches current hardcoded behavior
const TTL_FLOOR_MS = 1_000;           // 1 second minimum (TTL=0 maps here)
const TTL_CAP_MS = 86_400_000;        // 24 hours maximum (Claude's discretion: reasonable cap)

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  accessTtl: DEFAULT_CACHE_TTL_MS,
  paymentTtl: DEFAULT_CACHE_TTL_MS,
  blockedTtl: DEFAULT_CACHE_TTL_MS,
};

/** Clamp a raw TTL value (seconds from JSON) to valid ms range */
function clampTtl(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CACHE_TTL_MS;
  const ms = Math.round(raw) * 1_000;  // JSON values are seconds, internal is ms
  return Math.min(Math.max(ms, TTL_FLOOR_MS), TTL_CAP_MS);
}

export function normalizeCacheConfig(raw: unknown): CacheConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CACHE_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    accessTtl:  r.accessTtl  !== undefined ? clampTtl(r.accessTtl)  : DEFAULT_CACHE_TTL_MS,
    paymentTtl: r.paymentTtl !== undefined ? clampTtl(r.paymentTtl) : DEFAULT_CACHE_TTL_MS,
    blockedTtl: r.blockedTtl !== undefined ? clampTtl(r.blockedTtl) : DEFAULT_CACHE_TTL_MS,
  };
}
```

**Note on TTL units:** The CONTEXT.md says "TTL=0 means very short (1 second floor)". The JSON config values should be in **seconds** (human-readable for operators). Internal code uses milliseconds consistent with `Date.now()`. The normalizer does the `* 1000` conversion.

### Anti-Patterns to Avoid

- **Hardcoding TTL inside the cache modules:** Access.ts currently has `const ACCESS_CACHE_TTL_MS = 60_000` hardcoded. Phase 4 defines the types — Phase 5+ will wire `CacheConfig` into these modules to replace the hardcoded constant. Do NOT change `access.ts` TTL wiring in Phase 4.
- **Network probing mints during config load:** Validation is format-only (`new URL(s).protocol === 'https:'`). Never `fetch()` a mint URL during `normalizePaymentConfig()`.
- **Throwing on malformed config:** All normalizers must catch errors and return safe defaults. An invalid `payment.json` must silence payments, not crash the server.
- **Conflating `paymentsEnabled` with amount > 0:** The enabled check is `mints.length > 0` only. An amount of 0 with valid mints is valid (free with proof required for some future use). The primary gate is mints presence.
- **Putting CacheConfig loading inside access.ts directly:** Keep `cache-config.ts` as its own module. Both `access.ts` and `metadata.ts` will import from it in Phase 5 — it must be standalone.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON schema validation | Custom validator | Follow existing normalizer pattern | Zod/ajv not in project; normalizer pattern is proven and consistent |
| URL parsing | Custom regex | `new URL(s)` built-in | Handles edge cases (ports, IPv6, punycode) correctly |
| Config caching | Custom cache class | Module-level variable + `expires: number` | Exact pattern already used in `access.ts` and `metadata.ts`; consistent, testable |

**Key insight:** Every pattern needed for this phase already exists in the codebase. This phase is about extension, not invention.

---

## Common Pitfalls

### Pitfall 1: TTL=0 Means "Never Cache" but Storage Has Latency

**What goes wrong:** Operator sets `accessTtl: 0` expecting every request to be fresh, but a true 0ms TTL causes every single request to hit Bunny Storage, which has ~50-100ms latency and rate limits at scale.

**Why it happens:** "0 = off" is a common convention in caching systems, but the CONTEXT.md decision was "TTL=0 = very short (1 second floor)" specifically to prevent burst hammering.

**How to avoid:** Apply `TTL_FLOOR_MS = 1_000` in `clampTtl()`. When raw value is 0 (or negative), return 1000, not 0.

**Warning signs:** If a test asserts `normalizeCacheConfig({accessTtl: 0}).accessTtl === 0`, the test is wrong per the spec. The correct assertion is `=== 1000`.

### Pitfall 2: Payment Config "Disabled" Ambiguity

**What goes wrong:** Code checks `config.amounts.upload > 0` to determine if payment is required, but misses the case where mints array is empty (valid amounts but no mints = payments disabled entirely).

**Why it happens:** It's intuitive to check amounts, but the CONTEXT.md rule is: "Empty mints array = payments disabled entirely (can't verify proofs without mints)."

**How to avoid:** Always use `paymentsEnabled(config)` which checks `config.mints.length > 0`. Amount checks are secondary (for determining the required amount once enabled is confirmed).

**Warning signs:** A payment config with `{mints: [], amounts: {upload: 100, mirror: 50}}` should result in `paymentsEnabled() === false`.

### Pitfall 3: Amount Validation Rejects the Whole Config

**What goes wrong:** Only the invalid field is removed, leaving a partial config where some actions are paid and others have unknown amounts.

**Why it happens:** Field-level error handling feels more precise, but the CONTEXT.md rule is explicit: "Invalid amounts → reject entire payment config, disable payments."

**How to avoid:** In `normalizeAmounts()`, return `null` on any invalid amount value. The caller (`normalizePaymentConfig`) treats `null` as "disable entirely" and returns `DEFAULT_PAYMENT_CONFIG`.

**Warning signs:** A config with `{mints: [...], amounts: {upload: -5, mirror: 10}}` must produce `paymentsEnabled() === false`, not a partial config with only `mirror` payment enabled.

### Pitfall 4: STATE.md vs CONTEXT.md Contradiction on cacheTtl Location

**What goes wrong:** Developer reads STATE.md which says "cacheTtl lives in config/access.json" and implements it there.

**Why it happens:** STATE.md was written during initial roadmap planning (before the Phase 4 discussion). CONTEXT.md was written during the detailed phase discussion and supersedes the earlier decision.

**How to avoid:** Cache config goes in `config/cache.json` as a separate file (CONTEXT.md is authoritative). The access.ts TTL wiring from the hardcoded constant to `CacheConfig` values is Phase 5+ work.

---

## Code Examples

Verified patterns from existing codebase:

### StorageClient.getJson<unknown> — returns null on missing file

```typescript
// Source: src/storage/client.ts (existing)
async getJson<T>(path: string): Promise<T | null> {
  const resp = await this.get(path);
  if (!resp) return null;
  try {
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}
```

This means `storage.getJson<unknown>("config/payment.json")` returns `null` for both missing files AND malformed JSON — both cases are already handled identically by the normalizer.

### Module-level cache with TTL — exact pattern to replicate

```typescript
// Source: src/storage/metadata.ts (existing)
let blockedCache: { hashes: Set<string>; expires: number } | null = null;
const BLOCKED_CACHE_TTL_MS = 60_000;

export async function isBlocked(storage: StorageClient, sha256: string): Promise<boolean> {
  const now = Date.now();
  if (blockedCache && now < blockedCache.expires) {
    return blockedCache.hashes.has(sha256);
  }
  const config = (await storage.getJson<BlockedConfig>("config/blocked.json")) || { hashes: [] };
  blockedCache = { hashes: new Set(config.hashes), expires: now + BLOCKED_CACHE_TTL_MS };
  return blockedCache.hashes.has(sha256);
}
```

### filterPubkeys() skip-and-warn pattern — replicate for mint entries

```typescript
// Source: src/middleware/access.ts (existing)
function filterPubkeys(list: unknown, fieldName: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry: unknown) => {
    if (typeof entry !== "string" || !isValidPubkey(entry)) {
      console.warn(
        `[access] Skipping invalid pubkey in config.${fieldName}: "${String(entry).substring(0, 30)}"`,
      );
      return false;
    }
    return true;
  });
}
```

The mint validation follows this same warn-and-skip approach (for invalid mint entries), with the exception that invalid _amounts_ reject the whole config rather than skipping (per CONTEXT.md decision).

### Deno test pattern — for new test files

```typescript
// Source: src/middleware/access.test.ts (existing)
/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { checkAccess, _resetAccessCacheForTesting } from "./access.ts";

// Reset module-level cache between tests
Deno.test("PAY-03: missing payment config → payments disabled", async () => {
  // ...
});
```

Phase 4 test files should follow this exact pattern. Each new module with a module-level cache should export a `_resetXxxCacheForTesting()` function.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded TTL constants in each module | CacheConfig type loaded from config/cache.json | Phase 4 (defines type) → Phase 5 (wires into modules) | Operators can tune cache behavior without code changes |
| PaymentInfo as a response-only type (existing `PaymentInfo` in types.ts) | PaymentConfig as an operator-facing config type | Phase 4 | Separates "what the server says in a 402 response" from "what the operator configures" |

**Deprecated/outdated:**
- The existing `PaymentInfo` interface in `src/types.ts` is for 402 response headers (BUD-07 output). It should NOT be confused with the new `PaymentConfig` which is operator input. Both coexist.

---

## Open Questions

1. **TTL JSON units: seconds or milliseconds?**
   - What we know: CONTEXT.md says "TTL=0 means very short (1 second floor)" using "seconds" language
   - What's unclear: Whether the JSON file should store `{"accessTtl": 60}` (seconds) or `{"accessTtl": 60000}` (milliseconds)
   - Recommendation: Use **seconds** in the JSON config (more human-readable for operators). The normalizer converts to ms internally with `* 1000`. Document this clearly in code comments.

2. **Max TTL cap value (Claude's Discretion)**
   - What we know: CONTEXT.md leaves the max cap to Claude's discretion
   - Recommendation: Use `86_400_000` ms (24 hours). This prevents operators from accidentally setting a multi-day TTL that causes stale configs to persist across deployments. A 24-hour max is large enough for any real use case.

3. **MintEntry optional fields**
   - What we know: CONTEXT.md says "allows optional per-mint fields later" but leaves initial implementation to discretion
   - Recommendation: Phase 4 `MintEntry` includes only `url: string`. Keep it minimal. Future phases add optional fields when needed (no speculative additions).

---

## Sources

### Primary (HIGH confidence)

- `/home/sandwich/Develop/blssm.us/src/middleware/access.ts` — Canonical normalizer pattern, cache module structure, skip-and-warn validation
- `/home/sandwich/Develop/blssm.us/src/storage/metadata.ts` — Second example of module-level cache with TTL (blockedCache)
- `/home/sandwich/Develop/blssm.us/src/types.ts` — Existing type structure, `PaymentInfo` vs new `PaymentConfig` distinction
- `/home/sandwich/Develop/blssm.us/src/middleware/access.test.ts` — Test pattern: `/// <reference lib="deno.ns" />`, `jsr:@std/assert`, module-level cache reset export
- `/home/sandwich/Develop/blssm.us/.planning/phases/04-payment-config-types/04-CONTEXT.md` — Locked user decisions

### Secondary (MEDIUM confidence)

- CONTEXT.md `decisions` section — Phase boundary and behavior rules are comprehensive; no external verification needed since this is internal design not library behavior

### Tertiary (LOW confidence)

None — all findings are from direct codebase inspection.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; existing Deno + TypeScript strict mode
- Architecture: HIGH — direct pattern extraction from existing `access.ts` and `metadata.ts`
- Pitfalls: HIGH — derived from explicit CONTEXT.md decisions and observed codebase patterns
- TTL unit convention: MEDIUM — recommended seconds-in-JSON is a design choice, not verified against any standard

**Research date:** 2026-02-24
**Valid until:** 2026-03-26 (stable internal design; no external dependencies to go stale)
