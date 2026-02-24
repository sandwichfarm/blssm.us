# Testing Patterns

**Analysis Date:** 2026-02-24

## Test Framework

**Runner:**
- Not configured - no test runner present in project
- Dependencies check: no jest, vitest, mocha, or test runner dependencies in `package.json` (spa)
- No test configuration files found

**Assertion Library:**
- Not applicable - no testing infrastructure

**Run Commands:**
- No test commands configured
- Available scripts in spa: `dev`, `build`, `preview`, `check`
- Type checking available: `npm run check` (runs svelte-check and tsc)

## Test File Organization

**Current Status:**
- No test files present in codebase (`*.test.ts`, `*.spec.ts`)
- No test directory structure

**Expected Pattern (if implemented):**
- Backend tests would likely be co-located: `src/handlers/blob-get.test.ts` adjacent to implementation
- Test configuration would follow Deno conventions given the backend uses Deno
- Frontend component tests would be in `spa/src/__tests__/` or alongside components

## Test Structure

**Not Currently Used**

When testing is introduced, the pattern would likely follow:
- Handlers tested independently with mock `Request`, `StorageClient`, `Config`
- Utility functions tested with input/output assertions
- Auth validation tested with various malformed Nostr events
- Storage operations tested with mock HTTP responses

## Mocking

**Framework:**
- Not applicable - no testing framework

**Expected Patterns (if implemented):**

For backend testing with mocking:
```typescript
// Handlers would need to mock:
// - Request object with headers and methods
// - StorageClient with stub methods returning test data
// - Config object with test values

// Auth validation would mock:
// - Authorization headers with valid/invalid base64
// - Nostr events with various tag combinations
// - Schnorr signature verification results

// Storage operations would mock:
// - HTTP responses from Bunny Storage API
// - JSON parsing of metadata files
```

**What to Mock (if testing added):**
- External HTTP calls to storage API (via StorageClient)
- Cryptographic operations (schnorr signature verification, SHA-256 hashing)
- Current timestamp for time-based validations

**What NOT to Mock (if testing added):**
- Response construction and HTTP status codes
- Input validation logic
- Error path handling
- TypeScript type system

## Fixtures and Factories

**Test Data:**
- Not currently used

**Expected factories (if implemented):**
```typescript
// Example Nostr event fixture
const createMockNostrEvent = (overrides?: Partial<NostrEvent>): NostrEvent => ({
  id: "1234567890abcdef...",
  pubkey: "abcdef1234567890...",
  created_at: Math.floor(Date.now() / 1000),
  kind: 24242,
  tags: [["t", "upload"]],
  content: "",
  sig: "0123456789abcdef...",
  ...overrides,
});

// Example storage response fixture
const createMockBlobMeta = (overrides?: Partial<BlobMeta>): BlobMeta => ({
  sha256: "abcdef0123456789...",
  size: 1024,
  type: "application/octet-stream",
  uploaded: Math.floor(Date.now() / 1000),
  owners: ["owner123"],
  ...overrides,
});
```

**Location:**
- Would be placed in `src/__fixtures__/` or `src/__mocks__/` directory
- Separate fixture files per module: `auth.fixtures.ts`, `storage.fixtures.ts`

## Coverage

**Requirements:**
- No coverage enforcement or targets configured
- No coverage tooling present

**Recommendation:**
- If testing added, prioritize: auth validation (security-critical), error paths, edge cases in metadata operations

## Test Types

**Unit Tests:**
- Not currently implemented
- Would test: utility functions (`sha256Hex`, `bytesToHex`, validation functions), individual handler logic in isolation

**Integration Tests:**
- Not currently implemented
- Would test: full request/response flow through handlers, storage client operations with mock HTTP, metadata consistency

**E2E Tests:**
- Not used

## Common Patterns

**If Testing Were Added:**

**Async Testing:**
```typescript
// Testing async handlers
test("handleBlobUpload rejects oversized files", async () => {
  const largeBody = new ArrayBuffer(101 * 1024 * 1024); // 101MB
  const request = new Request("http://localhost/upload", {
    method: "PUT",
    body: largeBody,
    headers: { "Authorization": "Nostr " + validAuthHeader },
  });

  const response = await handleBlobUpload(request, mockStorage, mockConfig);
  expect(response.status).toBe(413);
});
```

**Error Testing:**
```typescript
// Testing error paths
test("validateAuth rejects expired events", async () => {
  const expiredEvent = createMockNostrEvent({
    tags: [
      ["t", "upload"],
      ["expiration", Math.floor(Date.now() / 1000) - 3600], // 1 hour ago
    ],
  });

  const result = await validateAuth(mockRequest(expiredEvent), {
    verb: "upload",
  });

  expect(result.authorized).toBe(false);
  expect(result.error).toContain("expired");
});

// Testing validation with invalid inputs
test("isValidSha256 rejects non-hex strings", () => {
  expect(isValidSha256("not-hex-123")).toBe(false);
  expect(isValidSha256("xyz" + "0".repeat(61))).toBe(false);
});
```

**Mocking HTTP:**
```typescript
// Mock StorageClient for handler testing
class MockStorageClient implements Partial<StorageClient> {
  async get(path: string): Promise<Response | null> {
    if (path.includes("blob")) {
      return new Response(Buffer.from("test data"), { status: 200 });
    }
    return null;
  }

  async getJson<T>(path: string): Promise<T | null> {
    if (path.includes("meta")) {
      return { sha256: "abc", size: 100, type: "image/png" } as T;
    }
    return null;
  }
}
```

## Type Checking

**Current Status:**
- TypeScript strict mode enabled
- Type checking via `deno check` and `svelte-check`
- Run via: `npm run check` (spa) or `deno check src/main.ts` (backend)
- All files use explicit type annotations
- No implicit `any` types

**Coverage:**
- All function parameters typed
- All return types annotated
- Interfaces define data shapes explicitly
- Type imports separated from value imports

---

*Testing analysis: 2026-02-24*

## Notes

**Current testing gaps:**
- No automated tests for auth validation (security-critical functionality)
- No tests for error paths in handlers
- No tests for SHA-256 hashing and signature verification
- No tests for storage client's HTTP error handling
- No integration tests for the request routing flow

**Recommended testing priorities if adding tests:**
1. Auth validation (`validateAuth`, `verifySignature`) - security critical
2. Handler error paths (invalid input, auth failure, storage errors)
3. Metadata consistency operations (add/remove owner, index operations)
4. Utility functions (hex conversion, hash validation)
5. Request routing and HTTP response construction
