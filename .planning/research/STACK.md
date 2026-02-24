# Stack Research

**Domain:** Blossom server access control (Nostr pubkey-based whitelist/blacklist)
**Researched:** 2026-02-24
**Confidence:** MEDIUM

---

## Context: This Is an Additive Research File

This file covers only what is needed to add publish access control to the existing blssm.us Blossom server. The existing stack (TypeScript, Deno, Bunny EdgeScript, @noble/curves, @noble/hashes) is already established and documented in `.planning/codebase/STACK.md`. This research focuses on **patterns and precedents** from the Nostr/Blossom ecosystem specifically for pubkey-based access control.

---

## Key Finding: No BUD Spec Defines Access Control Config

After reviewing all 11 BUD specifications (BUD-00 through BUD-10), **no BUD defines a standard for how servers should implement or configure pubkey-based access control**. The specs define:

- **What HTTP status codes to return** (401, 403) and **why** (missing vs. invalid/rejected auth)
- **That servers MAY reject uploads for any reason** (BUD-02: "Servers may reject uploads for any reason")
- **The `X-Reason` header** (BUD-06) for human-readable rejection messages
- **BUD-06**: Servers MUST return 401 when auth is absent and required; 403 when auth is provided but rejected

Access control enforcement is explicitly left to server operators. Configuration format is not standardized. This is intentional — Blossom is a spec for protocol behavior, not server policy.

**Confidence:** HIGH (verified directly from BUD-02 and BUD-06 source at github.com/hzrd149/blossom)

---

## What the Ecosystem Actually Uses

### Pattern 1: JSON Config File with Pubkey Arrays (PRIMARY PATTERN)

The dominant pattern across Blossom implementations is a flat JSON config file loaded by the server with a pubkey array and a boolean mode flag.

**Established by:** umbrel-blob-box (hzrd149's own reference implementation for UmbrelOS)

```json
{
  "whitelist": [
    "266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5"
  ],
  "maxFileSize": 104857600,
  "allowAnonymous": false
}
```

**Confidence:** HIGH — verified from `hzrd149/umbrel-blob-box` README and config format, same author as Blossom spec.

Key field semantics in the wild:
- `whitelist` — array of hex pubkeys allowed to upload
- `allowAnonymous` — boolean; true means public mode (no auth required), false means private/restricted
- No `blacklist` field found in reference implementations — denylist is generally handled by the absence from a whitelist in private mode

**Implication for this project:** The project plan calls for both whitelist AND blacklist. This is a superset of what reference implementations do. The config schema is project-defined; the ecosystem convention is JSON in a predictable file path.

### Pattern 2: YAML Config with Rule-Based Pubkey Matching

**Established by:** hzrd149/blossom-server (the TypeScript reference server)

```yaml
upload:
  requireAuth: true
  requirePubkeyInRule: false

rules:
  - type: image/*
    expiration: 1 week
    pubkeys: [pubkey1, pubkey2]
```

More expressive but more complex. Pubkeys appear inline in storage rules, not as a top-level access gate. This pattern allows per-MIME-type pubkey restrictions — overkill for blssm.us.

**Confidence:** MEDIUM — verified from `config.example.yml` in `hzrd149/blossom-server` repository.

**Implication for this project:** Do NOT adopt this pattern. The project needs a simple public/private + whitelist/blacklist toggle. YAML adds a dependency and the rule-based model creates combinatorial complexity.

### Pattern 3: In-Memory Map at Handler Level (Khatru/Go ecosystem)

```go
var allowedUsers = map[string]bool{
  "pubkey1": true,
}

bl.RejectUpload = func(ctx context.Context, auth *nostr.Event, size int, ext string) (bool, string, int) {
  if auth == nil || !allowedUsers[auth.PubKey] {
    return true, "unauthorized", 403
  }
  return false, "", 0
}
```

This is the Go/Khatru pattern (hook-based, in-process). Not directly applicable to the TypeScript/Deno runtime but the **logic model is identical**: extract `auth.PubKey` after Nostr event validation, check against an in-memory set, return 403 if not found.

**Confidence:** HIGH — verified from khatru.nostr.technology documentation.

**Implication for this project:** The logic pattern directly maps to the existing codebase. After `validateAuth()` returns `auth.pubkey`, the access control check is: `if (config.public && !blocklist.has(pubkey)) OR (whitelist.has(pubkey))`.

---

## Recommended Stack for This Milestone

No new libraries are needed. The implementation uses only existing project dependencies.

### Core Technologies (Unchanged)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| TypeScript | 5.9.3 | All implementation | Existing project language |
| Deno | 2.x | Runtime | Existing runtime — Bunny EdgeScript |
| @noble/hashes | 1.6.1 | SHA-256 | Already used for blob hashing, no new dep needed |
| @noble/curves | 1.8.1 | Schnorr sig verification | Already handles auth pubkey extraction |

### New Supporting Pattern (Not a Library)

| Pattern | Purpose | When to Use |
|---------|---------|-------------|
| `Set<string>` for pubkey lookup | O(1) membership test vs. `Array.includes()` O(n) | Always — use `Set` not array for blocklist/allowlist in cache |
| 60s TTL in-memory cache (existing pattern) | Avoid per-request Bunny Storage reads | Mirror the `isBlocked` pattern from `metadata.ts` |
| `config/access.json` in Bunny Storage | Persistent access control config | Matches existing `config/blocked.json` precedent |

---

## Config File Format: Recommendation

Use JSON, not YAML. Rationale:
1. JSON is already used for all config in this project (`config/blocked.json`, `app-config.json` in umbrel-blob-box)
2. No YAML parser available in Deno standard library without adding a dependency
3. JSON.parse() is a Deno builtin, zero overhead
4. The ecosystem pattern (umbrel-blob-box, umbrel, khatru configs) is JSON

**Recommended schema** for `config/access.json`:

```json
{
  "public": true,
  "whitelist": [],
  "blacklist": []
}
```

Field semantics (from PROJECT.md requirements):
- `public: true` + no payments: anyone can upload; `blacklist` bans pubkeys; `whitelist` ignored
- `public: true` + payments: paid users upload; `whitelist` = free pass (bypasses payment); `blacklist` = banned regardless
- `public: false` (private): only `whitelist` pubkeys can upload; `blacklist` ignored; payments ignored

**Confidence:** HIGH — this schema is derived from requirements + ecosystem precedent. No standard exists to conflict with.

---

## Implementation Pattern: Where to Add the Check

The access control check belongs **after `validateAuth()` succeeds and before any storage operations**, inside each gated handler. This matches both the khatru Go pattern and the existing `isBlocked()` placement in `blob-upload.ts`.

Concrete location in `handleBlobUpload`:

```typescript
// After: auth validated, pubkey extracted
// Before: body read or storage operations

const access = await getAccessConfig(storage); // cached, same TTL pattern as blocked list
const decision = checkAccess(auth.pubkey, access);
if (!decision.allowed) {
  return errorResponse(decision.reason, 403);
}
```

The `checkAccess` function is pure logic (no I/O), testable independently of storage.

**Confidence:** HIGH — this is direct extension of existing codebase patterns.

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| JSON config in Bunny Storage | YAML config | No built-in YAML parser; adds dependency; no ecosystem advantage for this use case |
| JSON config in Bunny Storage | Environment variable per pubkey | Env vars have size limits; lists of pubkeys can be long; doesn't match project constraints |
| JSON config in Bunny Storage | Nostr kind 10063 / relay-backed list | Requires relay integration, adds network dependency; far more complex than needed |
| `Set<string>` in TTL cache | Array linear scan | O(1) vs O(n) membership; pubkey sets could grow; no cost to use Set |
| Handler-level check after auth | Router-level middleware | Requires passing access config through router; existing pattern is handler-level; simpler |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| YAML for config | No Deno stdlib YAML parser without adding dependency; JSON already established in project | JSON (`config/access.json`) |
| Web of Trust (WoT) graph traversal | Requires external relay connection; complex; out of scope for this milestone | Direct pubkey list in config |
| NIP-05 / DNS-based identity resolution | Async lookup per request; adds latency and external dependency; not needed | Raw hex pubkey in config |
| Database (SQLite, etc.) | Unavailable in Bunny EdgeScript/Deno runtime without embedding; overkill | JSON files in Bunny Storage |
| Array.includes() for pubkey lookup | O(n) scan; makes no difference for small lists but grows poorly | `new Set(config.whitelist)` in cache |
| Per-request Bunny Storage reads for access config | High latency on every upload | TTL cache (60s) — same as `isBlocked()` pattern |

---

## Stack Patterns by Mode

**If public mode (`public: true`), no payments wired:**
- Read `access.json` once per TTL window
- Check `blacklist` Set — deny if found
- Whitelist is irrelevant (ignored per spec)
- Allow everyone else

**If public mode (`public: true`), payments wired in future:**
- Check `blacklist` — deny if found
- Check `whitelist` — allow if found (free pass, no payment)
- Otherwise: defer to payment middleware (existing `verifyLightningPayment` stub)

**If private mode (`public: false`):**
- Check `whitelist` — allow if found
- Deny everyone else (returns 403)
- Blacklist and payments are not consulted

**Access control check MUST run after `validateAuth()`** — pubkey is only available after Nostr kind 24242 event is validated. There is no access control for unauthenticated requests: auth failure returns 401 before access control is evaluated.

---

## Version Compatibility

No new packages introduced. The existing dependency set is sufficient:

| Existing Package | Role in Access Control | Notes |
|-----------------|----------------------|-------|
| Deno stdlib (JSR) | JSON parsing, fetch | `JSON.parse()` builtin — no extra import |
| @noble/curves secp256k1 1.8.1 | Schnorr verification in auth | Already extracts `pubkey` from kind 24242 |
| Bunny EdgeScript SDK | HTTP runtime | No changes needed |

---

## Sources

- `github.com/hzrd149/blossom/blob/master/buds/02.md` — BUD-02: "Servers may reject uploads for any reason" (HIGH confidence — official spec)
- `github.com/hzrd149/blossom/blob/master/buds/06.md` — BUD-06: 401 vs 403 semantics, `X-Reason` header (HIGH confidence — official spec)
- `github.com/hzrd149/umbrel-blob-box` — JSON config format with `whitelist` + `allowAnonymous` (HIGH confidence — reference implementation by spec author)
- `github.com/hzrd149/blossom-server/blob/master/config.example.yml` — YAML rule-based config with optional `pubkeys` per rule (MEDIUM confidence — official implementation, different pattern)
- `khatru.nostr.technology/core/blossom` — Go hook pattern: `RejectUpload` with `auth.PubKey` check (HIGH confidence — documented API)
- `.planning/codebase/STACK.md` — Existing project stack (HIGH confidence — codebase analysis)
- `.planning/codebase/ARCHITECTURE.md` — Existing `isBlocked()` cache pattern (HIGH confidence — codebase analysis)
- `github.com/nostr-protocol/nips` — Reviewed NIP-B7, NIP-96 for access control patterns: neither defines server-side access control config (MEDIUM confidence — WebSearch + WebFetch verification)

---

*Stack research for: blssm.us Blossom server — publish access control milestone*
*Researched: 2026-02-24*
