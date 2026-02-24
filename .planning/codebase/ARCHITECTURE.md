# Architecture

**Analysis Date:** 2026-02-24

## Pattern Overview

**Overall:** Request-response handler pattern with layered middleware and metadata management

**Key Characteristics:**
- Edge-native HTTP request routing (Bunny CDN EdgeScript runtime)
- Nostr authentication via kind 24242 events with Schnorr signatures
- Content-addressable blob storage with BUD protocol compliance
- Multi-owner blob support with per-pubkey indexing
- Stateless edge deployment with persistent metadata in cloud storage
- Dual deployment: backend server on Bunny EdgeScript + frontend SPA

## Layers

**HTTP Request Routing Layer:**
- Purpose: Route incoming HTTP requests to appropriate handlers based on method and path
- Location: `src/router.ts`
- Contains: Route dispatcher with pre-compiled regex patterns (BLOB_PATH_RE, BLOB_PATH_EXACT_RE) for performance
- Depends on: Handler modules, middleware (CORS), storage client
- Used by: BunnySDK HTTP server entry point

**Authentication Layer:**
- Purpose: Validate Nostr kind 24242 auth events with cryptographic verification
- Location: `src/auth/nostr.ts`, `src/auth/schnorr.ts`
- Contains: Auth validation logic, Nostr event structure verification, Schnorr signature verification
- Depends on: @noble/curves and @noble/hashes for cryptographic operations
- Used by: All protected handlers (blob-upload, blob-delete, blob-list, mirror, media, report)

**Handler Layer:**
- Purpose: Process specific API operations (upload, download, delete, list, report, mirror, media)
- Location: `src/handlers/`
- Contains: Individual handler functions for each BUD endpoint
- Depends on: Storage client, auth layer, metadata operations, utilities
- Used by: Request router

**Storage & Metadata Layer:**
- Purpose: Manage blob data persistence, metadata, ownership tracking, and indexing
- Location: `src/storage/client.ts`, `src/storage/metadata.ts`
- Contains: Bunny Storage REST API wrapper, blob metadata CRUD, owner/index management, reporting, blocking
- Depends on: Storage client (HTTP), type definitions
- Used by: Handler layer for all storage operations

**Middleware Layer:**
- Purpose: Cross-cutting concerns like CORS headers, payment handling
- Location: `src/middleware/`
- Contains: CORS header injection, payment info responses
- Depends on: Configuration
- Used by: Router

**Configuration & Utilities:**
- Purpose: Shared helpers and configuration initialization
- Location: `src/main.ts`, `src/types.ts`, `src/util.ts`
- Contains: Environment variable loading, type definitions, encoding/decoding helpers, validation functions, response builders
- Depends on: Node.js process module, standard library
- Used by: All layers

**Frontend SPA:**
- Purpose: Serve API documentation and Blossom protocol reference
- Location: `spa/src/` (Svelte + Vite)
- Contains: Interactive endpoint reference, BUD compliance status
- Depends on: Svelte, Tailwind CSS
- Used by: Browser clients

## Data Flow

**Blob Upload Flow:**

1. Client sends `PUT /upload` with blob data + Nostr auth header
2. Router dispatches to `handleBlobUpload`
3. Handler validates Nostr auth event (kind 24242, `t=upload` tag)
4. Handler computes SHA-256 hash of blob payload
5. Handler validates hash against auth event `x` tag if present
6. Handler checks if blob SHA-256 is in blocked list (with caching)
7. Handler stores blob to Bunny Storage at `blobs/{prefix}/{sha256}`
8. Handler creates/updates metadata at `meta/{prefix}/{sha256}.json` (with owners array)
9. Handler adds entry to pubkey's index at `lists/{prefix}/{pubkey}/index.json`
10. Handler returns BlobDescriptor JSON with `url`, `sha256`, `size`, `type`, `uploaded`, optional `nip94`

**Blob Retrieval Flow:**

1. Client sends `GET /{sha256}` or `GET /{sha256}.extension`
2. Router dispatches to `handleBlobGet`
3. Handler extracts SHA-256 from path (ignoring optional extension)
4. Handler validates SHA-256 format
5. Handler checks if blob is blocked
6. Handler retrieves metadata from storage
7. If client requests JSON (Accept header), return BlobDescriptor
8. If HEAD request, return headers only (Content-Type, Content-Length, X-SHA-256)
9. If GET request, proxy blob from Bunny Storage with proper caching headers
10. Support Range requests transparently

**Blob Deletion Flow:**

1. Client sends `DELETE /{sha256}` with Nostr auth header
2. Router dispatches to `handleBlobDelete`
3. Handler validates Nostr auth event (kind 24242, `t=delete` tag)
4. Handler retrieves metadata
5. Handler verifies requesting pubkey is in owners array
6. Handler removes pubkey from owners
7. If no owners remain, delete blob and metadata
8. Remove entry from pubkey's index
9. Return 200 OK

**State Management:**
- Blob data: Persistent in Bunny Storage (CDN-backed)
- Metadata: Persistent in Bunny Storage as JSON files
- Ownership: Stored in blob metadata (owners array)
- User indexes: Per-pubkey JSON index files in Bunny Storage
- Blocking: JSON config file cached in-memory with 60s TTL (BLOCKED_CACHE_TTL_MS)
- Reports: Accumulated in per-blob report JSON files
- No database: All state is stored as files in object storage

## Key Abstractions

**BlobDescriptor:**
- Purpose: Standard response format for blob metadata
- Examples: Returned by GET with Accept: application/json, POST /upload responses
- Pattern: Immutable content-addressable identifier (SHA-256)

**BlobMeta:**
- Purpose: Internal metadata structure tracking ownership and content properties
- Pattern: Multi-owner model (owners array), stores upload timestamp, file type, NIP-94 tags

**NostrEvent:**
- Purpose: Cryptographically signed authentication envelope
- Pattern: Kind 24242 with required tags: `t` (verb), optional `x` (hash), `server`, `expiration`

**StorageClient:**
- Purpose: Abstraction over Bunny Storage REST API
- Pattern: Simple wrapper with path-building helpers (blobPath, metaPath, listPath, etc.)
- Design: Paths follow sharding pattern: `{type}/{prefix}/{...}` where prefix is first 2 chars of hash

**Metadata Operations Module:**
- Purpose: Encapsulate multi-owner ownership and index management logic
- Functions: getMeta, addOwner, removeOwner, addToIndex, removeFromIndex, getReports, addReport, isBlocked
- Pattern: Functions read state, mutate in-memory, write back atomically

## Entry Points

**Server Entry Point:**
- Location: `src/main.ts`
- Triggers: BunnySDK EdgeScript runtime initialization
- Responsibilities: Load environment configuration, instantiate storage client, register HTTP request handler

**HTTP Request Handler:**
- Location: `src/main.ts` (BunnySDK.net.http.serve callback)
- Triggers: Incoming HTTP request to edge server
- Responsibilities: Wrap request through router, apply error handling

**Router:**
- Location: `src/router.ts` (route function)
- Triggers: Called by HTTP handler for each request
- Responsibilities: Pattern match path + method, dispatch to appropriate handler, apply CORS headers

**Frontend Entry Point:**
- Location: `spa/src/main.ts`
- Triggers: Browser load of SPA
- Responsibilities: Mount Svelte App component

## Error Handling

**Strategy:** Synchronous try-catch at router level with JSON error responses

**Patterns:**
- Handler-level validation: Return errorResponse with appropriate HTTP status (400, 401, 403, 404, 413, 500)
- Router-level catch: Log error, return 500 error response
- Auth validation: Return 401 with error message
- Size validation: Return 413 Payload Too Large
- Resource not found: Return 404
- Permission denied: Return 403 (not owner)
- Malformed request: Return 400

## Cross-Cutting Concerns

**Logging:** console.error for handler exceptions only (router-level catch)

**Validation:**
- SHA-256 format: isValidSha256 using HEX64_RE regex
- Pubkey format: isValidPubkey (same regex)
- Nostr event: Comprehensive validation in validateAuth (kind, timestamps, tags, ID, signature)
- File size: Check against config.maxUploadSize

**Authentication:**
- Mechanism: Nostr kind 24242 events with Schnorr signatures
- Location: `src/auth/nostr.ts`
- Scope: Required for upload, delete, list, mirror, media, report endpoints
- GET/HEAD blob retrieval: Public (no auth required)

**CORS:**
- Applied: All responses by withCors function in router
- Headers: Allow all origins, GET/HEAD/PUT/DELETE/OPTIONS methods, Authorization and Content-Type headers
- Preflight: OPTIONS requests return 204 with CORS headers

**Content Addressing:**
- Algorithm: SHA-256 (from @noble/hashes)
- Format: 64-character lowercase hex string
- Used for: Blob identification, hash-based deduplication, deterministic URL construction

---

*Architecture analysis: 2026-02-24*
