# Architecture Research

**Domain:** Blossom/Nostr blob server — access control middleware integration
**Researched:** 2026-02-24
**Confidence:** HIGH (based on direct codebase analysis + verified general middleware patterns)

## Standard Architecture

### System Overview

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
│  [2] checkAccess (NEW — access control middleware)             │
│       |                                                        │
│  [3] verifyPayment (stub — payments.ts)                        │
│       |                                                        │
│  [4] isBlocked (content hash check)                            │
│       |                                                        │
│  [5] Business logic (store blob, update metadata, etc.)        │
├───────────────────────────────────────────────────────────────┤
│                     Storage & Metadata Layer                   │
│  ┌────────────────────┐  ┌────────────────────────────────┐   │
│  │  Bunny Storage API │  │ Config files (JSON in storage) │   │
│  │  (blob data, meta) │  │ blocked.json, access.json      │   │
│  └────────────────────┘  └────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Router | Dispatch requests by method+path, apply CORS | `src/router.ts` — pattern match, delegate to handler |
| Auth (validateAuth) | Extract pubkey from Nostr kind 24242 event, verify Schnorr sig | `src/auth/nostr.ts` — returns `AuthResult` with pubkey |
| Access Control (NEW) | Check pubkey against whitelist/blacklist, enforce mode policy | `src/middleware/access.ts` — reads `config/access.json` |
| Payment Gate (stub) | Return 402 with payment info if payment required | `src/middleware/payments.ts` — `verifyLightningPayment` stub |
| Content Blocking | Check blob hash against known-bad content list | `isBlocked()` in `src/storage/metadata.ts` |
| Handlers | Execute the BUD operation (upload, mirror, delete, list, media) | `src/handlers/` — each handler owns its full flow |
| Storage Client | Abstract Bunny Storage REST API | `src/storage/client.ts` — path builders + HTTP wrappers |
| Config Cache | In-memory TTL cache for config JSON files | Module-level variable + expiry check (same as `blockedCache`) |

## Recommended Project Structure

```
src/
├── auth/
│   ├── nostr.ts          # validateAuth — kind 24242 + Schnorr verification
│   └── schnorr.ts        # Signature math
├── middleware/
│   ├── cors.ts           # CORS headers
│   ├── payments.ts       # BUD-07 402 framework (stub)
│   └── access.ts         # NEW: checkAccess — pubkey whitelist/blacklist
├── handlers/
│   ├── blob-upload.ts    # PUT /upload
│   ├── blob-delete.ts    # DELETE /{sha256}
│   ├── blob-get.ts       # GET /{sha256}
│   ├── blob-list.ts      # GET /list/{pubkey}
│   ├── mirror.ts         # PUT /mirror
│   ├── media.ts          # PUT /media
│   ├── report.ts         # PUT /report (exempt from access control)
│   ├── upload-check.ts   # HEAD /upload, HEAD /media
│   └── spa.ts            # SPA fallback
├── storage/
│   ├── client.ts         # Bunny Storage wrapper
│   └── metadata.ts       # Blob metadata CRUD + config caching
├── main.ts               # Entry point, env config, server startup
├── router.ts             # HTTP routing
├── types.ts              # Shared interfaces
└── util.ts               # Helpers, response builders
```

### Structure Rationale

- **middleware/access.ts:** Access control belongs in middleware alongside payments and CORS, not in individual handlers. A single location prevents drift where one handler forgets the check.
- **storage/metadata.ts:** Config cache logic lives here alongside the existing `blockedCache` pattern. Access config cache follows the same TTL model.

## Architectural Patterns

### Pattern 1: Auth-First, Access-Second

**What:** Auth runs first to extract the pubkey. Access control runs second to check the pubkey against the allow/deny lists. Payment check (when wired) runs third. Business logic runs last.

**When to use:** Always — access control is meaningless without knowing who is requesting. The access check is a predicate on the pubkey returned by auth.

**Trade-offs:** Every gated handler requires two async checks before doing real work. In the edge/stateless context this is acceptable because both are cached config reads (60s TTL).

**Example:**
```typescript
// Inside each gated handler (upload, mirror, media, delete, list):
const auth = await validateAuth(request, { verb: "upload", serverUrl: config.serverUrl });
if (!auth.authorized || !auth.pubkey) {
  return errorResponse(auth.error || "Unauthorized", 401);
}

const access = await checkAccess(storage, auth.pubkey);
if (!access.allowed) {
  return errorResponse(access.reason || "Forbidden", 403);
}

// payment check goes here when wired
// business logic follows
```

### Pattern 2: In-Handler Check (Not Extracted to Router)

**What:** Access control is called within each handler rather than extracted to a router-level gate.

**When to use:** This project already follows this pattern for auth and content blocking. Keeping access control in handlers maintains consistency and keeps each handler's full policy visible in one place.

**Trade-offs:**
- Pro: Each handler is self-contained and readable top-to-bottom.
- Pro: `/report` endpoint can be easily excluded — it's out of scope per PROJECT.md.
- Con: Must remember to add the check in every new gated handler.

**Example:**
```typescript
// router.ts does NOT do access control — it only dispatches:
if (path === "/upload" && method === "PUT") {
  response = await handleBlobUpload(request, storage, config);
}
// Each handler internally calls validateAuth then checkAccess
```

### Pattern 3: Module-Level TTL Cache for Config

**What:** A module-scoped variable holds the parsed config with an expiry timestamp. On each call, check if the cache is fresh. If stale, fetch from Bunny Storage and repopulate.

**When to use:** Any config loaded from Bunny Storage that is read on every request. The existing `blockedCache` in `metadata.ts` is the canonical example.

**Trade-offs:**
- Pro: Avoids one Bunny Storage HTTP call per request.
- Con: Config changes take up to TTL (60s) to propagate to a running instance.
- Con: Each edge instance has its own cache — no cross-instance coordination.

**Example:**
```typescript
// src/middleware/access.ts
let accessCache: { config: AccessConfig; expires: number } | null = null;
const ACCESS_CACHE_TTL_MS = 60_000;

async function loadAccessConfig(storage: StorageClient): Promise<AccessConfig> {
  const now = Date.now();
  if (accessCache && now < accessCache.expires) {
    return accessCache.config;
  }
  const raw = await storage.getJson<AccessConfig>("config/access.json");
  const config = raw ?? { public: true, whitelist: [], blacklist: [] };
  accessCache = { config, expires: now + ACCESS_CACHE_TTL_MS };
  return config;
}
```

## Data Flow

### Request Flow for Gated Write Endpoints

```
PUT /upload (with Nostr auth header)
    |
    v
Router.route()
    |  (dispatches — no checks here)
    v
handleBlobUpload(request, storage, config)
    |
    v
validateAuth()  ← reads Authorization header, verifies Schnorr sig
    |  returns: { authorized: true, pubkey: "abc123..." }
    |  or returns: { authorized: false, error: "..." } → 401
    v
checkAccess(storage, pubkey)  ← reads config/access.json (cached 60s)
    |  mode=public, no payment: allow unless blacklisted
    |  mode=public, payment:    allow if whitelisted OR paid (stub)
    |  mode=private:            allow only if whitelisted
    |  returns: { allowed: true }
    |  or returns: { allowed: false, reason: "Not on whitelist" } → 403
    v
verifyLightningPayment()  ← stub, always false (future wiring)
    |  (only reached in public+payment mode, skip if whitelisted)
    v
isBlocked(storage, hash)  ← reads config/blocked.json (cached 60s)
    |  returns boolean
    v
Business logic: store blob, write metadata, update index
    |
    v
jsonResponse(BlobDescriptor) → 200
```

### Access Config Schema (config/access.json)

```
{
  "public": true,          // true = public mode, false = private mode
  "whitelist": ["pubkey1", "pubkey2"],  // always-allow pubkeys
  "blacklist": ["pubkey3"]              // always-deny pubkeys
}
```

### Access Policy Decision Matrix

```
Mode     | Payment | Pubkey state    | Decision
---------|---------|-----------------|----------
public   | off     | blacklisted     | DENY (403)
public   | off     | whitelisted     | ALLOW
public   | off     | neither         | ALLOW
public   | on      | blacklisted     | DENY (403)
public   | on      | whitelisted     | ALLOW (free pass)
public   | on      | neither         | DENY (402) — requires payment
private  | any     | whitelisted     | ALLOW
private  | any     | not whitelisted | DENY (403)
```

Note: Payments are currently a stub. The access check should call `checkPaymentStatus()` as a hook point that currently returns false, so public+payment mode will block everyone not on the whitelist until payments are wired.

### Key Data Flows

1. **Config loading:** Handler call → `loadAccessConfig()` → check module cache → if stale, `storage.getJson("config/access.json")` → parse, cache with expiry.
2. **Access decision:** `checkAccess(storage, pubkey)` → load config → check blacklist first (short-circuit deny) → check whitelist → apply mode policy.
3. **Blocked content:** Happens after access check, because the hash is only known after the upload body is read. Access is about WHO, blocking is about WHAT.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single operator (current) | 60s TTL cache per edge instance, config/access.json edited manually |
| Small community (dozens of users) | Same — file editing is sufficient, TTL is acceptable lag |
| Larger deployment (hundreds of users) | Same pattern, shorter TTL optional (10s). Still no DB required. |
| Very large (thousands) | Lists in access.json become unwieldy. Would need paging or an external lookup. Out of scope. |

### Scaling Priorities

1. **First bottleneck:** Large whitelist/blacklist arrays in access.json cause slow JSON parse per cache miss. Mitigation: Use a Set for O(1) lookup after parse. The current `blockedCache` already does this (`new Set(config.hashes)`).
2. **Second bottleneck:** Cache miss on every cold-start edge instance. Not addressable in this architecture without a shared cache tier. Acceptable for this deployment scale.

## Anti-Patterns

### Anti-Pattern 1: Router-Level Access Gate

**What people do:** Check access in the router before dispatching to handlers, to avoid per-handler repetition.

**Why it's wrong:** The router runs before auth. Pubkey is only available after auth succeeds. The router has no pubkey to check against. Attempting to run auth in the router would require the router to know each endpoint's verb, duplicating the handler's auth logic.

**Do this instead:** Keep auth and access in each handler. Follow the established pattern from `handleBlobUpload` and `handleBlobDelete` where `validateAuth` is the first call.

### Anti-Pattern 2: Fetching Config on Every Request

**What people do:** Call `storage.getJson("config/access.json")` directly without a cache, assuming it is cheap.

**Why it's wrong:** Every gated request becomes at minimum two Bunny Storage HTTP round-trips (one for config, one for the actual operation). At edge latency this is tolerable once, but doubled latency on every write endpoint call degrades UX.

**Do this instead:** Use the module-level TTL cache pattern already established by `blockedCache`. One fetch per 60 seconds per edge instance.

### Anti-Pattern 3: Checking Access After Reading the Upload Body

**What people do:** Read the full request body first (to compute the hash), then check access.

**Why it's wrong:** Wastes bandwidth and CPU hashing content for users who will be denied anyway. Blacklisted pubkeys can flood the server with large uploads that get processed before rejection.

**Do this instead:** Run auth then access check before reading `request.arrayBuffer()`. Only proceed to body reading once the pubkey is confirmed allowed. (The content block check on the hash must still happen after body read — those are separate concerns.)

### Anti-Pattern 4: Coupling Access Control to Payment Logic

**What people do:** Implement access control and payment verification as a single function, since they interact in public+payment mode.

**Why it's wrong:** Payments are explicitly out of scope and the `verifyLightningPayment` stub always returns false. Coupling means the access control cannot be shipped until payments are wired.

**Do this instead:** `checkAccess()` returns a result that indicates whether payment would be required (e.g., `{ allowed: false, requiresPayment: true }`). The handler then decides whether to call `verifyLightningPayment()` separately. This keeps the components decoupled and the access check fully functional with the stub in place.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Bunny Storage | REST API via `StorageClient` | config/access.json stored here alongside blocked.json |
| Lightning Node (future) | `verifyLightningPayment()` stub in payments.ts | Not wired; checkAccess must compose cleanly with it |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Handler → Access Middleware | Direct function call `checkAccess(storage, pubkey)` | Returns typed result, no side effects |
| Access Middleware → Storage | `storage.getJson()` with module-level cache | Same TTL pattern as `isBlocked` |
| Access Middleware → Payment Gate | Handler orchestrates both; they do not call each other | Prevents coupling |
| Access Config ↔ Blocked Config | Independent files, independent caches | No shared state; can evolve separately |

## Build Order

Components have direct dependencies. Build order matters for this milestone:

```
1. AccessConfig type definition (src/types.ts)
   ↓ no deps within this project
2. loadAccessConfig() cache utility (src/middleware/access.ts)
   ↓ depends on: StorageClient, AccessConfig type
3. checkAccess() decision function (src/middleware/access.ts)
   ↓ depends on: loadAccessConfig
4. Integrate checkAccess into each handler
   ↓ depends on: checkAccess, existing validateAuth
   Handlers in priority order:
   a. blob-upload.ts  (PUT /upload — primary write path)
   b. mirror.ts       (PUT /mirror)
   c. media.ts        (PUT /media)
   d. upload-check.ts (HEAD /upload, HEAD /media — pre-flight should mirror upload policy)
   Note: report.ts is explicitly excluded per PROJECT.md scope
5. config/access.json schema + default (config documented, default: public=true, lists empty)
```

## Sources

- Direct codebase analysis: `src/router.ts`, `src/auth/nostr.ts`, `src/middleware/payments.ts`, `src/storage/metadata.ts`, `src/handlers/blob-upload.ts`, `src/handlers/mirror.ts`, `src/types.ts` — HIGH confidence
- [ASP.NET Core Middleware Order](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/?view=aspnetcore-8.0) — auth before authorization is universal middleware pipeline principle — MEDIUM confidence (different runtime, same principle)
- [Middleware Order: UseAuthentication before UseAuthorization](https://dev.to/sachin_ghatage/aspnet-core-middleware-order-explained-why-appuseauthentication-must-come-before-26je) — confirms pipeline ordering principle — MEDIUM confidence
- [Cloudflare Workers stateless edge pattern](https://developers.cloudflare.com/workers/runtime-apis/cache/) — module-level cache pattern for stateless edge workers — MEDIUM confidence (different runtime, same constraint)
- `.planning/PROJECT.md` — access control requirements, constraints, and scope — HIGH confidence (authoritative project spec)

---
*Architecture research for: Blossom server access control middleware integration*
*Researched: 2026-02-24*
