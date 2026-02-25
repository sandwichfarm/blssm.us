# Coding Conventions

**Analysis Date:** 2026-02-24

## Naming Patterns

**Files:**
- Backend TypeScript: lowercase with hyphens (e.g., `blob-get.ts`, `blob-upload.ts`, `blob-delete.ts`)
- Use descriptive names indicating the handler or functionality
- Utility files: single word or compound (`util.ts`, `client.ts`, `metadata.ts`)
- Middleware/Auth modules follow component purpose naming

**Functions:**
- camelCase for all function declarations (e.g., `handleBlobGet`, `validateAuth`, `sha256Hex`, `isValidSha256`)
- Handler functions prefixed with `handle` (e.g., `handleBlobUpload`, `handleMirror`, `handleReport`)
- Validation functions prefixed with `is` (e.g., `isValidSha256`, `isValidPubkey`, `isBlocked`)
- Getter functions use `get` prefix (e.g., `getMeta`, `getIndex`, `getReports`)
- Adder/remover functions use `add`/`remove` prefix (e.g., `addOwner`, `removeOwner`, `addToIndex`)

**Variables:**
- camelCase for all variables and constants
- Constants that are truly immutable use UPPER_SNAKE_CASE with const: `BLOB_PATH_RE`, `HEX_TABLE`, `CORS_HEADERS`, `BLOCKED_CACHE_TTL_MS`
- Collection variables use plural names (e.g., `endpoints`, `buds`, `entries`, `descriptors`)
- Single-letter loop variables discouraged in favor of descriptive names

**Types:**
- PascalCase for all interface/type names (e.g., `BlobDescriptor`, `NostrEvent`, `BlobMeta`, `StorageClient`, `Config`)
- Use `interface` for object shapes, especially for API contracts and data structures
- Prefix generic type results with the domain (e.g., `AuthResult`, `StoredReport`)

## Code Style

**Formatting:**
- No formatter explicitly configured (ESLint/Prettier not in dependencies)
- Indentation: 2 spaces (observed across all files)
- Line length: varies, no strict limit observed
- Semicolons: used consistently throughout

**Linting:**
- No ESLint or Prettier configuration present
- TypeScript strict mode enabled in `tsconfig.app.json` and `deno.json`
- Type checking enforced via TypeScript compiler (checked with `deno check` and `svelte-check`)

## Import Organization

**Order:**
1. External dependencies (npm/JSR packages): `import { schnorr } from "@noble/curves/secp256k1"`
2. Type imports from external: `import type { ... } from "..."`
3. Local module types: `import type { Config } from "../types.ts"`
4. Local module functions/values: `import { getMeta } from "../storage/metadata.ts"`
5. Same-module or adjacent types/functions grouped together

**Path Aliases:**
- No path aliases configured; uses relative imports with `../` notation
- Imports use `.ts` extensions explicitly (Deno-style)

**Example import block** (from `blob-upload.ts`):
```typescript
import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, isBlocked } from "../storage/metadata.ts";
import { sha256Hex, errorResponse, jsonResponse, isValidSha256 } from "../util.ts";
```

## Error Handling

**Patterns:**
- No thrown exceptions; errors returned as Response objects with appropriate HTTP status codes
- Validation failures return `errorResponse(message, statusCode)` utility function
- Auth validation returns structured `AuthResult` object with `authorized`, `pubkey`, `error`, and `event` fields
- Try-catch blocks used only for parsing operations (JSON parsing, base64 decoding) where external data might be malformed
- When catch blocks exist, they return error objects rather than rethrowing (e.g., in `nostr.ts` auth parsing)

**Response patterns:**
```typescript
// Invalid input
return errorResponse("Invalid SHA-256 hash", 400);

// Unauthorized
return errorResponse(auth.error || "Unauthorized", 401);

// Not found
return errorResponse("Blob not found", 404);

// File too large
return errorResponse(`File too large. Maximum size is ${config.maxUploadSize} bytes`, 413);
```

## Logging

**Framework:** console (built-in)

**Patterns:**
- Minimal logging: only `console.error()` for unhandled handler errors in router
- Router wraps all handler calls in try-catch and logs errors: `console.error("Handler error:", err)`
- No debug logging, info logging, or structured logging framework used
- Errors logged only at critical failure points (top-level request handler)

## Comments

**When to Comment:**
- JSDoc comments for all exported functions and types
- Inline comments for non-obvious logic (e.g., "allow 60s clock skew", "Pre-computed hex lookup table (avoids toString(16).padStart per byte)")
- Comments explain the "why" not the "what" (code is readable enough)

**JSDoc/TSDoc:**
- Every exported function includes JSDoc with description and validation details
- JSDoc includes parameter validation requirements and HTTP response behavior
- Type interfaces include JSDoc explaining their purpose (e.g., `/** Blossom BlobDescriptor as defined in BUD-01 */`)
- Comments reference BUD specifications (BUD-01, BUD-02, etc.) when applicable

**Example** (from `blob-upload.ts`):
```typescript
/**
 * BUD-02: PUT /upload — Upload a blob
 *
 * Requires Nostr auth with t=upload.
 * If auth event has `x` tag, uploaded blob hash must match.
 * Returns BlobDescriptor on success.
 */
export async function handleBlobUpload(...)
```

## Function Design

**Size:**
- Handlers range from 25-110 lines; most stay under 80 lines
- Small utility functions: 1-30 lines (e.g., `isValidSha256`, `bytesToHex`)
- Metadata operations: 15-50 lines (e.g., `addOwner`, `removeFromIndex`)

**Parameters:**
- Handlers typically take 3 parameters: `(request: Request, storage: StorageClient, config: Config)`
- Type parameters explicitly annotated (no implicit `any`)
- Optional parameters marked with `?` in type signature
- Options objects used for configurable functions (e.g., `validateAuth` takes options object with `verb`, `sha256`, `serverUrl`)

**Return Values:**
- Handlers return `Promise<Response>` for HTTP responses
- Storage operations return specific types: `Promise<boolean>`, `Promise<T | null>`, `Promise<void>`
- Validation functions return structured result objects (e.g., `AuthResult`)
- Metadata functions return the data or null, never throw

## Module Design

**Exports:**
- Handlers export single function: `export async function handleBlobGet(...): Promise<Response>`
- Storage client exports class: `export class StorageClient { ... }`
- Utilities export multiple functions: `export function sha256Hex(...) { ... }` (one per line)
- Auth module exports functions: `export async function validateAuth(...)` and `export function computeEventId(...)`

**Barrel Files:**
- Not used; direct imports from specific modules preferred

## Svelte Frontend

**Components:**
- Single file per component (e.g., `App.svelte`)
- Script block uses `lang="ts"` for TypeScript support
- Type annotations on function parameters (e.g., `function methodColor(method: string): string`)
- Helper functions defined within script block as regular functions

**Data handling:**
- Const declarations for static data (e.g., `const endpoints = [...]`, `const buds = [...]`)
- `window.location.origin` used for runtime server URL detection
- Object literals for data structures with clear key names

**Example** (from `App.svelte`):
```typescript
<script lang="ts">
  const SERVER_URL = window.location.origin;

  const endpoints = [
    { method: "GET", path: "/<sha256>", desc: "Retrieve a blob" },
    // ...
  ];

  function methodColor(method: string): string {
    switch (method) {
      case "GET": return "text-emerald-400";
      // ...
    }
  }
</script>
```

---

*Convention analysis: 2026-02-24*
