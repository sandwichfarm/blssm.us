# Codebase Concerns

**Analysis Date:** 2026-02-24

## Tech Debt

**Unimplemented Payment Verification:**
- Issue: Lightning payment preimage verification is stubbed and always returns false
- Files: `src/middleware/payments.ts` (lines 43-50)
- Impact: BUD-07 payment gate functionality is non-functional. Any deployment relying on payment gating will reject all payments
- Fix approach: Implement SHA-256 hash verification against payment hashes from Lightning node or payment provider API. Requires integration with LN node or Cashu/payment service provider.

**Missing Media Processing in BUD-05:**
- Issue: Media upload endpoint stores content as-is without optimization or processing
- Files: `src/handlers/media.ts` (lines 10-14, 78-79)
- Impact: Large media files bypass optimization, increasing storage costs and bandwidth usage. Bunny Edge Scripting runtime lacks image/video processing libraries
- Fix approach: Either implement lightweight FFmpeg/ImageMagick processing via external service call, or accept raw storage as spec-compliant baseline and document limitation

**No Test Coverage:**
- Issue: Zero automated tests across entire codebase
- Files: No test files found (no `*.test.ts` or `*.spec.ts` files)
- Impact: Regressions go undetected until production. Auth logic, storage operations, and cryptographic signature verification have no automated safeguards
- Fix approach: Create test suite using Deno's built-in testing framework. Prioritize: auth validation, signature verification, storage operations, edge cases in blob list pagination

**Deprecated Query Parameters in BUD-02 List:**
- Issue: `since` and `until` query parameters are deprecated but still supported
- Files: `src/handlers/blob-list.ts` (lines 12-13, 37-44)
- Impact: API surface larger than necessary. Clients may rely on deprecated params, making migration harder
- Fix approach: Document deprecation timeline. Plan removal in next major version. Consider sending deprecation headers (Sunset, Deprecation)

## Security Considerations

**Unvalidated Remote URL Fetching in BUD-04:**
- Risk: Mirror endpoint fetches arbitrary URLs without validation. No SSRF (Server-Side Request Forgery) protection
- Files: `src/handlers/mirror.ts` (lines 44, 54)
- Current mitigation: Size limit check (lines 57-62)
- Recommendations:
  - Add URL whitelist/blacklist for restricted domains (e.g., internal IPs: 127.0.0.1, 10.0.0.0/8, 169.254.0.0/16)
  - Validate URL scheme (HTTP/HTTPS only, no file://, gopher://)
  - Add timeout for remote fetch (prevent slowloris attacks)
  - Rate-limit mirror operations per pubkey to prevent abuse
  - Consider requiring explicit auth tag `mirror` verb (already done) but add rate limiting

**Implicit Trust in Storage Client Response Status:**
- Risk: Storage operations check only status code, not actual completion
- Files: `src/storage/client.ts` (lines 34, 63)
- Current mitigation: Status code checking (201 for PUT, 200 for DELETE)
- Recommendations:
  - Add retry logic with exponential backoff for transient failures
  - Validate response headers (Content-Length, ETag) match expectations
  - Add circuit breaker for cascading storage failures

**Weak Nonce/Timestamp Protection:**
- Risk: Auth events validated with only 60s clock skew tolerance. No nonce/challenge mechanism
- Files: `src/auth/nostr.ts` (lines 50-52)
- Current mitigation: 60s grace period for clock differences, expiration tag required
- Recommendations:
  - Consider per-request nonce/challenge if replay attacks are concern
  - Log suspicious auth patterns (repeated pubkeys from different IPs, timing anomalies)
  - Consider request signing (not just auth event signing)

**No Rate Limiting:**
- Risk: No per-pubkey, per-IP, or global rate limiting on any endpoint
- Files: `src/router.ts` (entire routing)
- Impact: Attackers can DOS storage, exhaust quotas, spam upload/list operations
- Fix approach: Implement rate limiting middleware using pubkey (from auth) or IP address. Consider token bucket algorithm. Integrate with Bunny CDN rate limiting if available.

**Missing Audit Logging:**
- Risk: No logging of sensitive operations (auth failures, content blocks, deletions)
- Files: `src/router.ts` (line 83 only catches error to console)
- Impact: Security incidents and policy violations undetectable
- Fix approach: Log all operations with: timestamp, pubkey (if auth), operation type, result, IP address. Include in CloudWatch or centralized logging

## Performance Bottlenecks

**Synchronous Metadata Reads for Blocked Content Check:**
- Problem: Every GET/HEAD request checks blocked list, involving full metadata load and linear scan
- Files: `src/handlers/blob-get.ts` (lines 35), `src/handlers/blob-list.ts`, `src/storage/metadata.ts` (lines 131-139)
- Cause: 60s TTL on in-memory cache means cache misses every minute under continuous load
- Improvement path:
  - Increase cache TTL to 5-10 minutes (tradeoff: slower block list updates)
  - Pre-load blocked list in background periodically
  - Use Bloom filter for faster membership testing (trade memory for speed)
  - Consider edge-level caching if Bunny supports it

**Unbounded Blob List Pagination:**
- Problem: No cursor validation - if cursor doesn't exist, returns entire list from that point
- Files: `src/handlers/blob-list.ts` (lines 50-54)
- Cause: findIndex returns -1 on miss, slice(-1 + 1) returns full array
- Impact: Client with stale cursor gets all blobs, creating large response
- Improvement path: Validate cursor exists before pagination. Return error if cursor not found rather than full list fallback

**Full Index Load for Single Entry Removal:**
- Problem: removeFromIndex loads entire index, filters, re-saves. Inefficient for sparse lists
- Files: `src/storage/metadata.ts` (lines 93-103)
- Cause: No index key-based deletion, only full document operations
- Impact: O(n) operation per deletion. At scale (thousands of blobs per user), this degrades
- Improvement path: Consider separate storage per index entry, or implement index versioning with tombstones

**Repeated Storage Metadata Reads on Concurrent Operations:**
- Problem: Concurrent blob uploads with deduplication can race on addOwner
- Files: `src/handlers/blob-upload.ts` (lines 86-94), `src/storage/metadata.ts` (lines 23-46)
- Cause: No locking or atomic read-modify-write on metadata
- Impact: Two simultaneous uploads of same hash may both add same owner twice
- Improvement path: Use storage-level locking (if Bunny supports), or implement optimistic concurrency with version checks, or accept duplicates and deduplicate on read

## Race Conditions & Data Consistency

**Concurrent Metadata Mutations Not Atomic:**
- Issue: addOwner reads metadata, modifies in memory, writes back. Two concurrent requests can interleave
- Files: `src/storage/metadata.ts` (lines 15-47)
- Scenario: User A and User B both upload same hash simultaneously
  1. Both read meta (no owners)
  2. Both create meta with [A] and [B]
  3. Last write wins, one owner is lost
- Mitigation: Data loss is only partial (one owner kept), but duplicates silently lost
- Fix approach: Implement optimistic concurrency (version field in metadata), or use storage-provided conditional writes (If-Match headers)

**Parallel Delete Operations:**
- Issue: removeOwner and removeFromIndex run in Promise.all but are not transactional
- Files: `src/handlers/blob-delete.ts` (lines 48-51)
- Scenario: If removeFromIndex succeeds but removeOwner fails mid-operation, index is corrupted
- Mitigation: Current error handling in router catches and returns 500, but metadata state is inconsistent
- Fix approach: Implement rollback logic or two-phase commit pattern for cross-storage operations

## Fragile Areas

**Signature Verification Exception Swallowing:**
- Files: `src/auth/schnorr.ts` (lines 21-26)
- Why fragile: Try-catch silently returns false on any exception. Cryptographic library updates could change exception types, hiding bugs
- Safe modification: Log exception type before returning false. Add unit tests covering various exception scenarios
- Test coverage: No tests for schnorr verification edge cases

**Blob Path Sharding Assumption:**
- Files: `src/storage/client.ts` (lines 85-93, 95-98), used by all handlers
- Why fragile: Assumes first 2 chars of SHA-256 are good shard key. No validation that storage actually uses this structure
- Safe modification: Verify sharding scheme matches Bunny Storage configuration. If changed, requires data migration
- Test coverage: No tests verifying path construction

**NIP-94 Metadata Tag Filtering:**
- Files: `src/handlers/blob-upload.ts` (lines 73-75), `src/handlers/media.ts` (lines 70-72)
- Why fragile: Hardcoded list of protocol tags to exclude. Future spec changes (new required tags) will silently include unintended metadata
- Safe modification: Make tag filter list configurable or use allowlist instead of blocklist
- Test coverage: No tests for edge cases (empty nip94, malformed tags)

**Response Status Code Assumptions:**
- Files: `src/storage/client.ts` (lines 34, 44, 54, 63) - assumes 201, 200, 404 for success/failure
- Why fragile: Bunny Storage API changes could return different status codes. No retry on transient errors (5xx)
- Safe modification: Add comprehensive status code handling, distinguish between permanent (404) and transient errors (5xx)
- Test coverage: No tests for non-standard HTTP responses

## Scaling Limits

**In-Memory Cache Limited to Single Edge Instance:**
- Current capacity: Blocked list cache fits in memory, 60s TTL per instance
- Limit: Each Bunny Edge instance has own cache. Cache misses multiply across fleet
- Scaling path: Use distributed cache (Redis) or implement cache warming from storage on startup

**Synchronous Storage Operations Block Request Thread:**
- Current capacity: Bunny Edge Scripting can handle ~1000 req/s per region with 50-100ms avg storage latency
- Limit: Each request blocks until all storage operations complete. Cascading storage failures block entire server
- Scaling path: Implement async queue for metadata writes (return 202 Accepted), batch operations, add circuit breaker

**Linear Scan for Blob List Cursor:**
- Current capacity: Lists up to 1000 items efficiently
- Limit: At 100k+ blobs per user, findIndex becomes O(n) scan
- Scaling path: Index entries by cursor (pre-computed checkpoints), or sort/page by timestamp instead of arbitrary cursor

**No Sharding of User Indices:**
- Current capacity: Single JSON file per user's blob index
- Limit: 1 million+ blobs per user causes massive JSON files
- Scaling path: Implement paginated indices, range-based sharding, or blob list database

## Dependencies at Risk

**Noble Cryptography Libraries:**
- Risk: Two critical dependencies (@noble/curves, @noble/hashes) on single maintainer
- Impact: Auth and signature verification depend entirely on these libraries
- Migration plan:
  - Option 1: Use browser/Node built-in crypto APIs if Deno runtime supports (likely better maintained)
  - Option 2: Pin versions strictly, audit code quarterly
  - Current: Using v1.8.1 (curves) and v1.6.1 (hashes) - monitor for security updates

**Bunny Edge Scripting Runtime:**
- Risk: Proprietary runtime with limited debugging. Storage API subject to change
- Impact: Core functionality depends on Bunny API stability
- Mitigation: Maintain abstraction layer in StorageClient to ease migration

## Missing Critical Features

**Blob Expiration/TTL:**
- Problem: No way to auto-delete blobs after N days. Indefinite storage for all uploads
- Impact: Long-term cost growth, requires manual cleanup
- Blocks: Time-limited sharing, temporary uploads, test data cleanup

**User Quotas:**
- Problem: No per-user storage quota enforcement
- Impact: Single user can fill entire storage zone, DOSing service
- Blocks: Fair resource allocation, preventing abuse

**Batch Operations:**
- Problem: No batch upload/delete (each operation single round-trip)
- Impact: 1000 item operation requires 1000 API calls
- Blocks: Efficient bulk operations, client batch workflows

**Webhook/Event Stream:**
- Problem: No push notifications on upload/delete events
- Impact: Clients must poll for updates
- Blocks: Real-time sync, cache invalidation, downstream integrations

## Test Coverage Gaps

**Authentication & Authorization:**
- What's not tested: Nostr event validation edge cases (clock skew, expiration boundaries, malformed base64, invalid signatures, tag parsing)
- Files: `src/auth/nostr.ts`, `src/auth/schnorr.ts`
- Risk: Auth bypass or unexpected rejections undetected until production
- Priority: High

**Storage Client Resilience:**
- What's not tested: Network failures, timeout handling, retries, non-standard status codes
- Files: `src/storage/client.ts`
- Risk: Silent failures, cascading timeouts
- Priority: High

**Concurrent Operations:**
- What's not tested: Race conditions on metadata mutations, concurrent blob uploads, index corruption
- Files: `src/storage/metadata.ts`, `src/handlers/blob-upload.ts`, `src/handlers/blob-delete.ts`
- Risk: Data loss, index corruption under load
- Priority: High

**Blob List Pagination:**
- What's not tested: Cursor validity, time-range filtering, limit boundaries, empty lists
- Files: `src/handlers/blob-list.ts`
- Risk: Incorrect pagination results, information leaks
- Priority: Medium

**NIP-94 Metadata Handling:**
- What's not tested: Malformed tags, empty metadata, tag filtering edge cases
- Files: `src/handlers/blob-upload.ts`, `src/handlers/media.ts`
- Risk: Silent metadata loss, spec violations
- Priority: Medium

**Error Handling & Edge Cases:**
- What's not tested: Empty uploads, oversized files, invalid content types, blocking status checks
- Files: All handlers
- Risk: Unhandled edge cases cause 500 errors
- Priority: Medium

---

*Concerns audit: 2026-02-24*
