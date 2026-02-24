# Phase 2: Access Logic - Research

**Researched:** 2026-02-24
**Domain:** Pure access control decision function — pubkey vs whitelist/blacklist in public/private mode
**Confidence:** HIGH

## Summary

Phase 2 is narrow in scope: implement `checkAccess(storage, pubkey)` as a pure decision function that consumes the `AccessCache` already built by Phase 1's `loadAccessConfig()`. No new types, no new caching logic, no new storage patterns are needed. All infrastructure was deliberately built in Phase 1 to make this phase straightforward.

The core logic is a small decision tree over two boolean dimensions: `config.public` (mode) and membership in `whitelist`/`blacklist` (Set<string>). The requirements intentionally simplify the v1 logic: in public mode the blacklist is the only active gate; in private mode the whitelist is the only gate. The two lists never interact in v1 — they apply in mutually exclusive modes. The v2 payment composition is explicitly deferred.

The one non-obvious design constraint is the return type. `checkAccess()` must return a typed result object (`{ allowed: true }` or `{ allowed: false, reason: string }`) rather than a plain boolean, so handlers can attach the reason to the 403 body. A secondary field `requiresPayment?: true` must be reserved for v2 payment composition without coupling to the current stub.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| ACL-01 | In public mode, any authenticated pubkey can publish unless blacklisted | Decision tree: `config.public && !blacklist.has(pubkey)` → allow |
| ACL-02 | In public mode, blacklisted pubkeys receive 403 Forbidden | Decision tree: `config.public && blacklist.has(pubkey)` → deny with reason |
| ACL-03 | In public mode, whitelist is ignored (no effect) | Decision tree: whitelist check only in private branch; v1 has no public+whitelist shortcut |
| ACL-04 | In private mode, only whitelisted pubkeys can publish | Decision tree: `!config.public && whitelist.has(pubkey)` → allow |
| ACL-05 | In private mode, non-whitelisted pubkeys receive 403 Forbidden | Decision tree: `!config.public && !whitelist.has(pubkey)` → deny with reason |
| ACL-06 | In private mode, blacklist is ignored (no effect) | Decision tree: blacklist check only in public branch |
| ACL-07 | Access check runs after auth validation but before request body is read | Caller contract: handlers call `checkAccess()` immediately after `validateAuth()` succeeds, before `request.arrayBuffer()` |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript (Deno) | existing | Return type definition for `AccessResult` | Already the project language; no new dependency |
| `Set<string>` (built-in) | built-in | O(1) pubkey membership test | Pre-built in `AccessCache` by Phase 1; no work needed |

### Supporting

None. Phase 2 adds no new dependencies. It consumes `loadAccessConfig()` from `src/middleware/access.ts` (Phase 1 output) and the `StorageClient` type that is already threaded through every handler.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Typed result object `{ allowed, reason }` | Plain boolean return | Boolean loses the denial reason; handlers would need a separate call to get the reason. Typed object is the established pattern in this codebase (`AuthResult` does the same). |
| Single `checkAccess()` in access.ts | Separate policy module | Overkill — the logic is ~15 lines. Keeping it in access.ts alongside `loadAccessConfig()` is cohesive. |

**Installation:**
No new packages required.

## Architecture Patterns

### Recommended Project Structure

```
src/middleware/
└── access.ts    # Phase 1: loadAccessConfig() — DONE
                 # Phase 2: checkAccess() — ADD HERE
```

`checkAccess()` is added to the same `access.ts` file. It is a pure function over the `AccessCache` returned by `loadAccessConfig()`. No new files are created.

### Pattern 1: Typed Result Object

**What:** `checkAccess()` returns `AccessResult` — a discriminated union with `allowed: true` or `allowed: false, reason: string`.

**When to use:** Any function that can succeed or fail with structured failure information. This is already the pattern used by `AuthResult` in `src/types.ts`.

**Example:**
```typescript
// Source: codebase pattern — AuthResult in src/types.ts
interface AccessResult {
  allowed: true;
} | {
  allowed: false;
  reason: string;
  requiresPayment?: true; // reserved for v2 — not used in Phase 2
}

export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage);

  if (cache.config.public) {
    // Public mode: blacklist gates, whitelist is ignored (ACL-01, ACL-02, ACL-03)
    if (cache.blacklist.has(pubkey)) {
      return { allowed: false, reason: "pubkey is blacklisted" };
    }
    return { allowed: true };
  } else {
    // Private mode: whitelist gates, blacklist is ignored (ACL-04, ACL-05, ACL-06)
    if (cache.whitelist.has(pubkey)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "This server requires explicit access. Contact the operator." };
  }
}
```

### Pattern 2: Caller Contract — Access Before Body Read

**What:** Every gated handler must call `checkAccess()` immediately after `validateAuth()` returns successfully and before calling `request.arrayBuffer()`.

**When to use:** Always — this is ACL-07 and also a DoS mitigation (see Pitfalls).

**Example:**
```typescript
// Inside a gated handler (e.g., handleBlobUpload):
const auth = await validateAuth(request, { verb: "upload", serverUrl: config.serverUrl });
if (!auth.authorized || !auth.pubkey) {
  return errorResponse(auth.error || "Unauthorized", 401);
}

const access = await checkAccess(storage, auth.pubkey);  // BEFORE arrayBuffer()
if (!access.allowed) {
  return errorResponse(access.reason, 403);
}

// Only now read the body:
const body = await request.arrayBuffer();
```

### Anti-Patterns to Avoid

- **Checking whitelist in public mode:** ACL-03 says whitelist has no effect in public mode. Do not add a whitelist fast-path in the public branch — it complicates the logic and mis-states the policy.
- **Checking blacklist in private mode:** ACL-06 says blacklist is ignored in private mode. Do not add a blacklist check in the private branch — it would incorrectly block users who are on the whitelist AND were previously on a stale blacklist.
- **Returning a boolean:** Loses the reason string needed for the 403 body. Handlers must be able to pass `access.reason` directly to `errorResponse()`.
- **Calling `checkAccess()` after `request.arrayBuffer()`:** Violates ACL-07 and creates a DoS surface. Blacklisted pubkeys can flood the server with large upload bodies.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| O(1) pubkey lookup | Linear scan over `config.whitelist` array | `AccessCache.whitelist` / `.blacklist` (Set<string>) — already built in Phase 1 | Phase 1 built the Sets precisely to avoid this. Using the array directly would regress performance. |
| Config loading | Re-implement TTL cache in checkAccess | Call `loadAccessConfig(storage)` — it returns AccessCache | loadAccessConfig already has the 60s TTL, null-safety, and normalization. |

**Key insight:** Phase 1 was designed so Phase 2 is purely a decision function. The only work in Phase 2 is the if/else tree — all infrastructure is already in place.

## Common Pitfalls

### Pitfall 1: Whitelist-in-Public-Mode Confusion

**What goes wrong:** Developer adds `if (cache.whitelist.has(pubkey)) return { allowed: true }` at the top of the public branch as an "optimization." This appears harmless but is explicitly wrong per ACL-03 (whitelist has no effect in public mode) and sets a trap for v2 payment composition where the whitelist IS used as a free-pass but only in conjunction with payments.

**Why it happens:** The whitelist feels like it should always mean "allowed." The mode-specific semantics are non-obvious.

**How to avoid:** Structure the decision tree as two completely separate branches — one for public mode, one for private mode — with no shared logic between them. Comment each branch with the requirement IDs it satisfies.

**Warning signs:** The whitelist check appears before the mode check.

### Pitfall 2: Wrong Status Code — 401 vs 403

**What goes wrong:** `checkAccess()` returning a result that leads the caller to return 401 instead of 403 for policy denials. 401 means "authenticate," 403 means "authenticated but forbidden."

**Why it happens:** Auth and access feel similar. Developers conflate them.

**How to avoid:** The `AccessResult` type carries only `reason`, not an HTTP status code. The handler ALWAYS uses 403 when `!access.allowed`. This is a caller contract, not a function contract — but it must be documented clearly.

**Warning signs:** Any handler code that branches on `access.allowed` and sometimes returns 401.

### Pitfall 3: Body Read Before Access Check (ACL-07 Violation)

**What goes wrong:** `checkAccess()` is placed after `request.arrayBuffer()` in the handler. Denied users cause the server to consume their upload body before rejecting them.

**Why it happens:** Existing handler code reads the body early. Access check is inserted "nearby" rather than at the correct position before the body read.

**How to avoid:** In Phase 2, `checkAccess()` is only the function definition. The insertion into handlers is Phase 3 work. But the caller contract must be established now in documentation and the function signature must not require any body data.

**Warning signs:** `checkAccess()` signature includes any body or hash parameter.

### Pitfall 4: requiresPayment Field Leaked to v1 Logic

**What goes wrong:** The `requiresPayment?: true` field on `AccessResult` is used in v1 Phase 2 logic, causing handlers to see `allowed: false, requiresPayment: true` and return 402 instead of 403, even though the payment stub always returns false.

**Why it happens:** Developer anticipates v2 and wires the payment path prematurely.

**How to avoid:** In Phase 2, `requiresPayment` is a reserved field on the type only. It MUST NOT be set in any return statement within `checkAccess()` in v1. The v1 function only ever returns `{ allowed: true }` or `{ allowed: false, reason: string }`.

**Warning signs:** Any code path in `checkAccess()` that sets `requiresPayment: true`.

## Code Examples

Verified patterns from project codebase:

### Full checkAccess() Implementation (v1)

```typescript
// Source: decision matrix from .planning/research/ARCHITECTURE.md
// Satisfies: ACL-01, ACL-02, ACL-03, ACL-04, ACL-05, ACL-06

export type AccessResult =
  | { allowed: true }
  | { allowed: false; reason: string; requiresPayment?: true };

export async function checkAccess(
  storage: StorageClient,
  pubkey: string,
): Promise<AccessResult> {
  const cache = await loadAccessConfig(storage);

  if (cache.config.public) {
    // Public mode (ACL-01, ACL-02, ACL-03):
    // - Blacklist bans unconditionally
    // - Whitelist has no effect (v1 — v2 adds payment-free-pass)
    // - Everyone else is allowed
    if (cache.blacklist.has(pubkey)) {
      return { allowed: false, reason: "pubkey is blacklisted" };
    }
    return { allowed: true };
  }

  // Private mode (ACL-04, ACL-05, ACL-06):
  // - Whitelist is the only path to allowed
  // - Blacklist is ignored (irrelevant when whitelist is the gate)
  if (cache.whitelist.has(pubkey)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "This server requires explicit access. Contact the operator.",
  };
}
```

### Decision Matrix (for comment block next to implementation)

```
Mode     | Pubkey state | Decision   | Req
---------|--------------|------------|------
public   | blacklisted  | DENY  403  | ACL-02
public   | whitelisted  | ALLOW      | ACL-01, ACL-03 (whitelist no-op: allow via "not blacklisted")
public   | neither      | ALLOW      | ACL-01
private  | whitelisted  | ALLOW      | ACL-04
private  | not whitelisted | DENY 403 | ACL-05
private  | blacklisted  | DENY  403  | ACL-05 (blacklist irrelevant: denied by "not whitelisted")
```

### Handler Caller Pattern (for Phase 3 reference)

```typescript
// Source: .planning/research/ARCHITECTURE.md — Pattern 1: Auth-First, Access-Second
const auth = await validateAuth(request, { verb: "upload", serverUrl: config.serverUrl });
if (!auth.authorized || !auth.pubkey) {
  return errorResponse(auth.error || "Unauthorized", 401);
}

const access = await checkAccess(storage, auth.pubkey); // ACL-07: before arrayBuffer()
if (!access.allowed) {
  return errorResponse(access.reason, 403); // Always 403, never 401
}

const body = await request.arrayBuffer(); // Body read AFTER access check
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Boolean return from access check | Typed discriminated union `AccessResult` | Enables reason strings in 403 body without secondary calls |
| Linear scan of pubkey arrays | Pre-built `Set<string>` in `AccessCache` | O(1) lookup; already done in Phase 1 — Phase 2 just uses it |
| Inline access logic per handler | Shared `checkAccess()` function | Single source of truth; all handlers behave identically |

**Deprecated/outdated:**
- Checking access inside the router: Not viable — router runs before auth and has no pubkey. Established in ARCHITECTURE.md anti-patterns.

## Open Questions

1. **AccessResult type location: types.ts or access.ts?**
   - What we know: `AuthResult` lives in `src/types.ts` as a shared interface. `AccessCache` is currently module-private in `access.ts`.
   - What's unclear: Whether `AccessResult` should be exported from `types.ts` (for handler imports) or from `access.ts` (co-located with the function).
   - Recommendation: Export `AccessResult` from `access.ts` alongside `checkAccess()`. Handlers import both from the same module. Only promote to `types.ts` if multiple modules need the type independently.

2. **Reason string content for private-mode denial**
   - What we know: The BUD spec does not mandate error message text. The UX pitfall research recommends a human-readable message.
   - What's unclear: Whether a terse or verbose reason is more appropriate.
   - Recommendation: Use `"This server requires explicit access. Contact the operator."` for private-mode denial (user-facing, actionable). Use `"pubkey is blacklisted"` for blacklist denial (operator-diagnostic, terse). These can be changed without breaking the contract.

## Sources

### Primary (HIGH confidence)

- `/home/sandwich/Develop/blssm.us/src/middleware/access.ts` — Phase 1 output; exact `AccessCache` interface and `loadAccessConfig()` signature that Phase 2 consumes
- `/home/sandwich/Develop/blssm.us/src/types.ts` — `AuthResult` discriminated union pattern; `AccessConfig` interface
- `.planning/research/ARCHITECTURE.md` — Decision matrix, data flow, anti-patterns (codebase-specific, HIGH confidence)
- `.planning/REQUIREMENTS.md` — ACL-01 through ACL-07 verbatim
- `.planning/phases/01-config-foundation/01-01-SUMMARY.md` — Confirmed Phase 1 deliverables and Set<string> design decision

### Secondary (MEDIUM confidence)

- `.planning/research/PITFALLS.md` — Pitfall 4 (logic inversion), Pitfall 2 (401 vs 403), Pitfall 3 (body read order) — derived from BUD spec analysis and OWASP patterns

### Tertiary (LOW confidence)

None — all findings backed by project codebase or project planning documents.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; Phase 1 built all needed infrastructure
- Architecture: HIGH — direct analysis of Phase 1 output and existing codebase patterns
- Pitfalls: HIGH — derived from explicit prior pitfall research targeting this exact implementation

**Research date:** 2026-02-24
**Valid until:** Stable indefinitely — this is pure project-internal logic with no external dependencies to drift
