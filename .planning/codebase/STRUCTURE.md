# Codebase Structure

**Analysis Date:** 2026-02-24

## Directory Layout

```
blssm.us/
├── src/                    # Backend server (Deno + BunnySDK EdgeScript)
│   ├── main.ts             # Server entry point, config loader, HTTP handler registration
│   ├── router.ts           # HTTP request routing dispatcher
│   ├── types.ts            # Shared type definitions (BlobDescriptor, NostrEvent, Config, etc.)
│   ├── util.ts             # Utility functions (hashing, encoding, validation, response builders)
│   ├── auth/               # Authentication and cryptography
│   │   ├── nostr.ts        # Nostr event validation (kind 24242, signature verification)
│   │   └── schnorr.ts      # Schnorr signature verification
│   ├── handlers/           # HTTP request handlers (one per endpoint)
│   │   ├── blob-get.ts     # BUD-01: GET/HEAD /<sha256> — Retrieve blob
│   │   ├── blob-upload.ts  # BUD-02: PUT /upload — Upload blob
│   │   ├── blob-delete.ts  # BUD-02: DELETE /<sha256> — Delete blob
│   │   ├── blob-list.ts    # BUD-02: GET /list/<pubkey> — List blobs
│   │   ├── mirror.ts       # BUD-04: PUT /mirror — Mirror from URL
│   │   ├── media.ts        # BUD-05: PUT /media — Media upload
│   │   ├── upload-check.ts # BUD-06: HEAD /upload — Pre-flight check
│   │   ├── report.ts       # BUD-09: PUT /report — Report content
│   │   └── spa.ts          # GET * — Fallback SPA server
│   ├── middleware/         # Cross-cutting concerns
│   │   ├── cors.ts         # CORS header injection
│   │   └── payments.ts     # BUD-07: Payment info responses
│   └── storage/            # Blob storage and metadata management
│       ├── client.ts       # Bunny Storage REST API wrapper
│       └── metadata.ts     # Blob metadata, ownership, indexing, blocking, reporting
├── spa/                    # Frontend SPA (Svelte + Vite)
│   ├── src/
│   │   ├── main.ts         # Svelte app entry point
│   │   ├── App.svelte      # Root component with API docs
│   │   ├── app.css         # Global styles
│   │   ├── lib/            # Reusable components (if any)
│   │   └── assets/         # Static assets
│   ├── public/             # Static files served as-is
│   ├── dist/               # Build output (generated)
│   └── package.json        # SPA dependencies
├── types/                  # TypeScript type declarations
│   └── bunny-sdk.d.ts      # BunnySDK EdgeScript type definitions
├── dist/                   # Build output for backend server
│   └── server.js           # Bundled/minified server (generated)
├── deno.json              # Deno configuration and import map
├── deno.lock              # Deno lock file
├── build.ts               # Build script (Deno + esbuild)
├── .github/               # GitHub configuration
│   └── workflows/         # CI/CD workflows
├── .planning/             # GSD planning documents
│   └── codebase/          # Codebase analysis documents
└── .gitignore             # Git ignore rules
```

## Directory Purposes

**`src/`:**
- Purpose: Backend HTTP server code for BunnySDK EdgeScript runtime
- Contains: Request routing, handlers, auth, storage abstraction, utilities
- Key files: `main.ts` (entry), `router.ts` (dispatcher), `types.ts` (schemas)

**`src/auth/`:**
- Purpose: Nostr protocol authentication and Schnorr signature cryptography
- Contains: Event validation, signature verification
- Key files: `nostr.ts` (event validation), `schnorr.ts` (crypto)

**`src/handlers/`:**
- Purpose: Request handlers for each API endpoint (one handler per route/method pair)
- Contains: BUD-compliant endpoint implementations
- Key files: `blob-get.ts`, `blob-upload.ts`, `blob-delete.ts`, `blob-list.ts`, `mirror.ts`, `media.ts`, `upload-check.ts`, `report.ts`, `spa.ts`

**`src/middleware/`:**
- Purpose: Cross-cutting concerns applied to requests/responses
- Contains: CORS, payment handling
- Key files: `cors.ts` (header injection), `payments.ts` (BUD-07)

**`src/storage/`:**
- Purpose: Data access layer for blob storage and metadata
- Contains: Bunny Storage REST API wrapper, blob/metadata/ownership/index/report operations
- Key files: `client.ts` (API wrapper), `metadata.ts` (CRUD operations)

**`spa/`:**
- Purpose: Frontend Single Page Application documentation
- Contains: Svelte components, styles, build configuration
- Key files: `src/App.svelte` (API reference UI), `package.json` (frontend deps)

**`types/`:**
- Purpose: TypeScript type declarations for external runtimes
- Contains: BunnySDK type definitions
- Key files: `bunny-sdk.d.ts`

**`dist/`:**
- Purpose: Build output directory (generated)
- Contains: Bundled server.js from esbuild
- Generated: Yes (via build.ts)
- Committed: No (in .gitignore)

**`.github/workflows/`:**
- Purpose: CI/CD automation
- Contains: GitHub Actions workflow definitions
- Key files: Deploy workflows for SPA and server

## Key File Locations

**Entry Points:**
- `src/main.ts`: Backend server initialization, config loading, BunnySDK request handler registration
- `spa/src/main.ts`: Frontend SPA mount point (Svelte mount)
- `build.ts`: Build orchestration script (run via `deno run -A build.ts`)

**Configuration:**
- `deno.json`: Deno configuration, import map, compiler options, task definitions
- `deno.lock`: Deno dependency lock file
- `types/bunny-sdk.d.ts`: TypeScript definitions for BunnySDK

**Core Logic:**
- `src/router.ts`: HTTP request dispatcher (route table, handler selection)
- `src/auth/nostr.ts`: Nostr kind 24242 event validation
- `src/storage/metadata.ts`: Blob metadata state machine (ownership, indexing, blocking)
- `src/storage/client.ts`: Bunny Storage HTTP API wrapper
- `src/types.ts`: Shared type definitions (BlobDescriptor, NostrEvent, Config, etc.)

**Utilities:**
- `src/util.ts`: Encoding (hex, base64), hashing (SHA-256), validation, response builders

**Testing:**
- None detected (no .test.ts, .spec.ts, test directory, or jest.config)

## Naming Conventions

**Files:**
- Format: `kebab-case.ts` (e.g., `blob-upload.ts`, `blob-delete.ts`)
- Handlers: `{operation}-{resource}.ts` (e.g., `blob-upload.ts`)
- Modules: Single responsibility, grouped by domain

**Directories:**
- Format: `lowercase/` (e.g., `handlers/`, `storage/`, `middleware/`)
- Domain-based organization (auth, storage, handlers, middleware)

**Functions:**
- Format: `camelCase` with descriptive names
- Handlers: `handle{Operation}` (e.g., `handleBlobUpload`, `handleBlobGet`)
- Getters: `get{Resource}` (e.g., `getMeta`, `getReports`)
- Setters: `put{Resource}` or `add{Resource}` (e.g., `putMeta`, `addOwner`)
- Validators: `is{Condition}` (e.g., `isBlocked`, `isValidSha256`)

**Variables:**
- Format: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `BLOB_PATH_RE`, `BLOCKED_CACHE_TTL_MS`)
- Types/Interfaces: `PascalCase` (e.g., `BlobDescriptor`, `NostrEvent`, `Config`)

**Types:**
- Format: `PascalCase` suffixed by type (e.g., `BlobDescriptor`, `StorageClient`, `AuthResult`)
- Interfaces: Struct-like types with properties
- Functions: Behavior contracts

## Where to Add New Code

**New Handler (Endpoint):**
- File: `src/handlers/{operation}-{resource}.ts`
- Pattern: Export async function `handle{Operation}(request, storage, config): Promise<Response>`
- Imports: Use `validateAuth`, storage operations, utility functions
- Registration: Add route pattern and handler call to `src/router.ts`

**New Storage Operation:**
- File: `src/storage/metadata.ts`
- Pattern: Export async functions for metadata operations
- Dependencies: StorageClient, type definitions
- Example pattern: `async function operation(storage, ...args) { ... }`

**New Utility Function:**
- File: `src/util.ts`
- Pattern: Pure function or helper
- Examples: Encoding, validation, response building

**New Type/Interface:**
- File: `src/types.ts`
- Pattern: Export interface or type
- Scope: Shared across multiple modules

**New Middleware:**
- File: `src/middleware/{concern}.ts`
- Pattern: Export middleware function or helper
- Usage: Applied in router or handlers

**New Frontend Component:**
- File: `spa/src/{component}.svelte`
- Pattern: Svelte component with `<script>` block for logic
- Styling: Use Tailwind CSS classes

## Special Directories

**`.planning/`:**
- Purpose: GSD codebase analysis documents
- Generated: Yes (by mappers)
- Committed: Yes (planning documents tracked)

**`.github/workflows/`:**
- Purpose: CI/CD automation scripts
- Generated: No (user-maintained)
- Committed: Yes

**`dist/` (backend):**
- Purpose: Compiled server output
- Generated: Yes (via `deno run -A build.ts`)
- Committed: No (in .gitignore)

**`spa/dist/` (frontend):**
- Purpose: Compiled SPA output
- Generated: Yes (via npm build)
- Committed: No

**`node_modules/` (spa):**
- Purpose: Frontend npm dependencies
- Generated: Yes (via npm install)
- Committed: No

**`types/`:**
- Purpose: TypeScript declaration files for external libraries
- Generated: No
- Committed: Yes (type definitions needed at build time)

## Import Organization

**Order (observed in handlers):**
- Type imports: `import type { ... } from ...`
- Runtime imports: `import { ... } from ...`
- Relative imports: `../` paths
- Absolute imports: None currently used

**Path patterns:**
- Relative: `../auth/nostr.ts`, `../storage/client.ts`
- Module resolution: Deno import map in deno.json (external packages only)

**Example (blob-upload.ts):**
```typescript
import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, isBlocked } from "../storage/metadata.ts";
import { sha256Hex, errorResponse, jsonResponse, isValidSha256 } from "../util.ts";
```

---

*Structure analysis: 2026-02-24*
