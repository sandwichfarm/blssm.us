# Phase 3: Endpoint Wiring - Research

**Researched:** 2026-02-24
**Domain:** Handler integration — wiring `checkAccess()` into gated write handlers in the existing Deno/Bunny EdgeScript codebase
**Confidence:** HIGH

## Summary

Phase 3 is narrow, additive integration work. The entire access control infrastructure (`loadAccessConfig`, `checkAccess`, `AccessResult`) exists and is tested. Phase 3 only wires `checkAccess()` into the correct handlers in the correct position (after auth, before body read) and verifies that non-gated endpoints are untouched.

Five handlers need a two-line insertion: `handleBlobUpload`, `handleMirror`, `handleMedia` (PUT handlers), and `handleUploadCheck` (which serves both HEAD /upload and HEAD /media). `handleUploadCheck` is the most complex case because its auth check is currently optional (auth header present = validate, absent = pass). The access check must be conditioned on the same optional-auth path. `handleReport` and blob retrieval handlers (`handleBlobGet`) are explicitly NOT gated per GATE-06 and GATE-07.

The response for a denied request is a JSON body with a `message` field and HTTP status 403 — matching the existing `errorResponse(reason, 403)` utility already used throughout the codebase. This is not 401. The only open question is whether `handleUploadCheck` should return the access denial via the `X-Reason` header (consistent with its existing denial pattern) or as a full JSON body (consistent with GATE-08 for other handlers). The requirement says "403 with JSON error body" which suggests `errorResponse()` is correct, but `handleUploadCheck` currently returns `null` bodies with `X-Reason` headers. Research recommendation: use the `X-Reason` header for HEAD responses since clients cannot read HEAD bodies.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| GATE-01 | Access control gates PUT /upload (BUD-02) | `handleBlobUpload` in `src/handlers/blob-upload.ts`: insert `checkAccess()` after `validateAuth()`, before `request.arrayBuffer()` |
| GATE-02 | Access control gates PUT /mirror (BUD-04) | `handleMirror` in `src/handlers/mirror.ts`: insert `checkAccess()` after `validateAuth()`, before `request.json()` |
| GATE-03 | Access control gates PUT /media (BUD-05) | `handleMedia` in `src/handlers/media.ts`: insert `checkAccess()` after `validateAuth()`, before `request.arrayBuffer()` |
| GATE-04 | Access control gates HEAD /upload preflight (BUD-06) | `handleUploadCheck` in `src/handlers/upload-check.ts`: access check inside the `if (authHeader)` block, after auth validation succeeds |
| GATE-05 | Access control gates HEAD /media preflight | Same `handleUploadCheck` handler (router routes both HEAD /upload and HEAD /media to it) |
| GATE-06 | PUT /report is NOT gated by access control | `handleReport` in `src/handlers/report.ts`: no changes needed — verify by inspection |
| GATE-07 | All GET/HEAD blob retrieval remains public (no access control) | `handleBlobGet` in `src/handlers/blob-get.ts`: no changes needed — verify by inspection |
| GATE-08 | Denied requests return 403 with JSON error body, not 401 | `errorResponse(access.reason, 403)` — uses existing utility; HEAD endpoints use `X-Reason` header since HEAD responses have no body |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `checkAccess` | Phase 2 output | Access decision function | Already implemented in `src/middleware/access.ts` |
| `AccessResult` | Phase 2 output | Return type for access decisions | Already exported from `src/middleware/access.ts` |
| `errorResponse` | existing | Creates `{ message }` JSON response with status | Already used by all handlers for error cases |
| Deno test (`Deno.test`) | built-in | Test framework for handler-level tests | Confirmed working — Phase 2 tests pass in `~11ms` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jsr:@std/assert` | existing (jsr) | `assertEquals` for test assertions | All test files in this project use it |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline `checkAccess()` in each handler | Router-level middleware | Router runs before auth; no pubkey available at router level. Handler-level is the only correct position. |
| JSON body for HEAD 403 denial | `X-Reason` header | HEAD responses discard bodies per HTTP spec. `handleUploadCheck` already uses `X-Reason` for all its denials — consistency demands the same for access denial on HEAD. |

**Installation:**
No new packages required.

## Architecture Patterns

### Recommended Project Structure

No new files required. Modifications are additive changes to existing handlers:

```
src/
├── handlers/
│   ├── blob-upload.ts   # ADD: checkAccess() between validateAuth and arrayBuffer
│   ├── mirror.ts        # ADD: checkAccess() between validateAuth and request.json
│   ├── media.ts         # ADD: checkAccess() between validateAuth and arrayBuffer
│   ├── upload-check.ts  # ADD: checkAccess() inside the if(authHeader) block
│   ├── report.ts        # NO CHANGE — GATE-06: not gated
│   └── blob-get.ts      # NO CHANGE — GATE-07: retrieval is public
├── middleware/
│   └── access.ts        # NO CHANGE — Phase 2 complete
└── router.ts            # NO CHANGE — routing unchanged
```

### Pattern 1: Access Check in PUT Handlers (GATE-01, GATE-02, GATE-03)

**What:** Insert two lines after auth success and before body read in `handleBlobUpload`, `handleMirror`, and `handleMedia`.

**When to use:** Any PUT handler that gates on pubkey identity.

**Example (for handleBlobUpload):**
```typescript
// Source: project codebase src/handlers/blob-upload.ts + Phase 2 research
import { checkAccess } from "../middleware/access.ts";

export async function handleBlobUpload(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  // Validate auth
  const auth = await validateAuth(request, {
    verb: "upload",
    serverUrl: config.serverUrl,
  });
  if (!auth.authorized || !auth.pubkey) {
    return errorResponse(auth.error || "Unauthorized", 401);
  }

  // Access control (GATE-01, GATE-08): runs after auth, before body read
  const access = await checkAccess(storage, auth.pubkey);
  if (!access.allowed) {
    return errorResponse(access.reason, 403);
  }

  // Read body — only reached if access is granted
  const body = await request.arrayBuffer();
  // ... rest of handler unchanged
}
```

The same two-line block applies identically to `handleMirror` (before `request.json()`) and `handleMedia` (before `request.arrayBuffer()`).

### Pattern 2: Access Check in handleUploadCheck (GATE-04, GATE-05)

**What:** `handleUploadCheck` already has an optional-auth code path. Access check must live INSIDE the `if (authHeader)` block, after `auth.authorized` is confirmed.

**When to use:** HEAD preflight endpoints where auth is optional.

**Example:**
```typescript
// Source: project codebase src/handlers/upload-check.ts — current structure
import { checkAccess } from "../middleware/access.ts";

export async function handleUploadCheck(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  // Validate auth if present
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const auth = await validateAuth(request, {
      verb: "upload",
      serverUrl: config.serverUrl,
    });
    if (!auth.authorized) {
      return new Response(null, {
        status: 403,
        headers: { "X-Reason": auth.error || "Invalid authorization" },
      });
    }
    // GATE-04/GATE-05: access check when auth was provided and is valid
    // HEAD responses have no body — use X-Reason header (consistent with handler's existing pattern)
    if (auth.pubkey) {
      const access = await checkAccess(storage, auth.pubkey);
      if (!access.allowed) {
        return new Response(null, {
          status: 403,
          headers: { "X-Reason": access.reason },
        });
      }
    }
  }

  // ... rest of handler unchanged
}
```

### Pattern 3: No-Change Verification for Non-Gated Endpoints

**What:** GATE-06 and GATE-07 require that `handleReport` and `handleBlobGet` are explicitly NOT modified. Verification is by inspection + negative tests confirming these endpoints still accept denied pubkeys.

**When to use:** Any time a requirement says a thing must NOT happen.

### Anti-Patterns to Avoid

- **Adding access check before auth validation:** Access check requires `auth.pubkey`, which only exists after `validateAuth()` succeeds. The order is always: auth → access → body.
- **Adding access check to the router:** `route()` in `router.ts` runs before any handler and has no pubkey. Access must happen inside each individual handler.
- **Returning 401 for access denial:** `checkAccess()` denials are always 403. The pubkey is authenticated; they are forbidden. Never use 401 for `!access.allowed`.
- **Modifying `handleReport` or `handleBlobGet`:** GATE-06 and GATE-07 are hard requirements. These handlers must not be touched.
- **Adding access check when auth is absent in `handleUploadCheck`:** If no `Authorization` header is present, there is no pubkey to check against. No-auth preflight requests must still pass through.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Access decision | Custom inline if/else logic in each handler | `checkAccess(storage, auth.pubkey)` | Phase 2 implemented the full decision tree with all edge cases; duplicating it creates divergence risk |
| Error response body | Custom JSON construction | `errorResponse(access.reason, 403)` | Existing utility; matches all other handler error patterns |
| Test mocking | Custom StorageClient mock per test file | Same `makeStorage(configJson)` factory pattern from `access.test.ts` | Copy the proven pattern; tests are consistent |

**Key insight:** Phase 3 has zero new logic to write. Every piece is already built. The work is purely integration: call the right functions in the right order.

## Common Pitfalls

### Pitfall 1: Treating HEAD Response Bodies as Accessible

**What goes wrong:** Developer uses `errorResponse(access.reason, 403)` for the HEAD /upload and HEAD /media access denial, expecting clients to read the JSON body.

**Why it happens:** The requirement says "403 with JSON error body" (GATE-08) and `errorResponse()` creates a JSON body. But HTTP clients discard HEAD response bodies.

**How to avoid:** `handleUploadCheck` already uses `X-Reason` header for ALL its error responses. Access denial from `checkAccess()` in `handleUploadCheck` must follow the same convention: `new Response(null, { status: 403, headers: { "X-Reason": access.reason } })`.

**Warning signs:** Handler returns a body from a HEAD endpoint; clients cannot read it.

### Pitfall 2: Access Check Outside the Optional-Auth Block

**What goes wrong:** In `handleUploadCheck`, developer moves the access check outside the `if (authHeader)` block and calls `checkAccess()` even when no auth header was provided.

**Why it happens:** Treating access check as unconditional looks cleaner. But without an auth header, there is no pubkey to check.

**How to avoid:** `checkAccess()` requires a valid hex-64 pubkey. Without auth, there is no pubkey. The access check must remain inside the `if (authHeader)` block, only when auth succeeds.

**Warning signs:** `checkAccess()` is called with an undefined or empty string pubkey.

### Pitfall 3: Body Already Consumed Before Access Check

**What goes wrong:** `checkAccess()` insertion is placed after `request.arrayBuffer()` or `request.json()` in `handleBlobUpload`, `handleMirror`, or `handleMedia`.

**Why it happens:** Grep-and-insert approach without reading surrounding context carefully.

**How to avoid:** Read each handler fully before editing. In all three PUT handlers, the body read is the first line after auth. The access check insertion goes between the auth block and the body read.

**Warning signs:** Denied requests show request body bytes transferred in network logs; server consumed the body before rejecting.

### Pitfall 4: Import Missing from Handler

**What goes wrong:** `checkAccess` is called but not imported, causing a TypeScript/Deno compile error at `deno check`.

**Why it happens:** Forgetting to add the import when inserting the access check.

**How to avoid:** Each modified handler needs `import { checkAccess } from "../middleware/access.ts";` added to its import block. Four handlers need this import; verify each one.

**Warning signs:** `deno check src/main.ts` fails with "checkAccess is not defined."

## Code Examples

Verified patterns from the project codebase:

### Import Line to Add to Each Gated Handler

```typescript
// Source: src/middleware/access.ts (Phase 2 output)
import { checkAccess } from "../middleware/access.ts";
```

### Access Check Block for PUT Handlers

```typescript
// Source: Phase 2 research pattern — satisfies GATE-01/02/03 and GATE-08
const access = await checkAccess(storage, auth.pubkey);
if (!access.allowed) {
  return errorResponse(access.reason, 403);
}
```

### Access Check Block for HEAD Preflight Handler

```typescript
// Source: handleUploadCheck existing pattern (null body + X-Reason) — satisfies GATE-04/05
if (auth.pubkey) {
  const access = await checkAccess(storage, auth.pubkey);
  if (!access.allowed) {
    return new Response(null, {
      status: 403,
      headers: { "X-Reason": access.reason },
    });
  }
}
```

### Test Mock Pattern (copy from access.test.ts)

```typescript
// Source: src/middleware/access.test.ts — proven mock factory
function makeStorage(configJson: unknown): StorageClient {
  return {
    getJson: async (_path: string) => {
      if (_path === "config/access.json") return configJson as Awaited<ReturnType<StorageClient["getJson"]>>;
      return null;
    },
  } as unknown as StorageClient;
}
```

### Deno Test Command for Handler Tests

```bash
# Run a specific test file
deno test src/handlers/blob-upload.test.ts

# Run all tests
deno test src/

# Run full type check
deno check src/main.ts
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| No access control on write handlers | `checkAccess()` after auth, before body read | Denied pubkeys rejected before body consumption |
| 401 for all auth/access denials | 403 for access denials, 401 for auth failures | Correct HTTP semantics; clients know the difference |
| HEAD error body | X-Reason header | Clients can read the denial reason from HEAD responses |

**No deprecated patterns in this phase.** This is new integration work on a greenfield feature.

## Open Questions

1. **GATE-08 vs HEAD response body for `handleUploadCheck`**
   - What we know: GATE-08 says "denied requests return 403 with JSON error body." `handleUploadCheck` currently returns `new Response(null, ...)` with `X-Reason` headers for ALL its error paths — no JSON body for any denial.
   - What's unclear: Whether GATE-08 applies to HEAD endpoints (where response bodies are discarded by HTTP) or only to PUT endpoints.
   - Recommendation: Use `X-Reason` header for HEAD access denials (consistent with existing handler pattern; HEAD bodies are unreadable). Apply JSON body only to PUT denials. Document this explicitly in the plan to prevent confusion.

2. **Test file location and naming convention**
   - What we know: The only existing test file is `src/middleware/access.test.ts`. No handler-level test files exist yet.
   - What's unclear: Whether tests should be per-handler (`blob-upload.test.ts`) or consolidated (`endpoint-wiring.test.ts`).
   - Recommendation: Mirror the existing pattern — one test file per handler under test. For Phase 3 that means `src/handlers/blob-upload.test.ts`, `src/handlers/mirror.test.ts`, `src/handlers/media.test.ts`, and `src/handlers/upload-check.test.ts`. Tests for non-gated endpoints can be integration-style assertions in a single `src/handlers/non-gated.test.ts`.

## Sources

### Primary (HIGH confidence)

- `src/handlers/blob-upload.ts` — exact handler code; identified insertion point between auth and `arrayBuffer()`
- `src/handlers/mirror.ts` — exact handler code; identified insertion point between auth and `request.json()`
- `src/handlers/media.ts` — exact handler code; identified insertion point between auth and `arrayBuffer()`
- `src/handlers/upload-check.ts` — exact handler code; optional-auth structure confirmed; X-Reason pattern confirmed
- `src/handlers/report.ts` — confirmed no auth middleware; GATE-06 verified (no changes needed)
- `src/handlers/blob-get.ts` — confirmed no auth middleware on GET/HEAD blob retrieval; GATE-07 verified
- `src/middleware/access.ts` — `checkAccess()` and `AccessResult` exports confirmed from Phase 2
- `src/router.ts` — routing confirmed: HEAD /upload and HEAD /media both route to `handleUploadCheck`
- `src/util.ts` — `errorResponse(message, status)` utility confirmed; returns `{ message }` JSON body
- `.planning/REQUIREMENTS.md` — GATE-01 through GATE-08 verbatim
- `deno test` run — confirmed test infrastructure works, `~11ms` for 8 tests

### Secondary (MEDIUM confidence)

- HTTP spec: HEAD response bodies are discarded; clients cannot read them (informs X-Reason decision)

### Tertiary (LOW confidence)

None — all findings backed by direct codebase inspection.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all infrastructure exists
- Architecture: HIGH — direct analysis of all six handler files; insertion points verified
- Pitfalls: HIGH — derived from direct reading of the code that will be modified

**Research date:** 2026-02-24
**Valid until:** Stable indefinitely — no external dependencies; all internal project logic
