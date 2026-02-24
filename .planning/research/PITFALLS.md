# Pitfalls Research

**Domain:** Blossom server access control — Nostr pubkey whitelist/blacklist with payment system composition
**Researched:** 2026-02-24
**Confidence:** MEDIUM (Blossom ecosystem is young and sparsely documented; pitfalls derived from BUD spec analysis, reference implementation review, and established edge/auth patterns)

---

## Critical Pitfalls

### Pitfall 1: npub vs hex pubkey format mismatch in config

**What goes wrong:**
The config file (`access.json`) stores pubkeys in human-readable npub (bech32) format by mistake, but the auth system delivers `event.pubkey` in raw 64-character hex. The comparison always fails silently — whitelisted users get 403, blacklisted users get through.

**Why it happens:**
Nostr UIs display npub everywhere. Operators copy-paste from their client. The NIP-19 spec explicitly states: "bech32 encodings are NOT to be used inside NIP-01 event formats." Kind 24242 events always carry hex pubkeys. This inconsistency is invisible at config write time and silent at runtime.

**How to avoid:**
- Define the config schema explicitly: pubkeys MUST be lowercase 64-character hex strings.
- Add a startup validation that checks every entry in `whitelist` and `blacklist` matches `/^[0-9a-f]{64}$/`. Log a warning and reject the config if any entry fails.
- In the config file comments, document this constraint and provide an example hex value.

**Warning signs:**
- All whitelisted users consistently receive 403 despite correct pubkeys in their Nostr events.
- The operator reports "it worked before" after copy-pasting a pubkey from a Nostr client UI.
- Blacklisted pubkeys continue to upload successfully.

**Phase to address:** Config schema definition phase — enforce the hex-only constraint before the first config read is written.

---

### Pitfall 2: Wrong 4xx response code when access is denied — 401 vs 403

**What goes wrong:**
Returning 401 when the pubkey is authenticated but not permitted (blacklisted or not whitelisted) causes Blossom clients to re-prompt for authentication rather than surfacing the correct "you are not allowed" error. The distinction:
- **401 Unauthorized** = identity not established (missing or invalid auth event)
- **403 Forbidden** = identity established, but access denied by policy

If access control runs before or mixes with auth failure handling and returns 401 for policy denials, clients will loop on auth retries.

**Why it happens:**
Auth and access control are conceptually similar. Developers conflate "not allowed" with "not authenticated." The BUD-02 spec says servers "MAY reject an upload for any reason and SHOULD respond with the appropriate HTTP 4xx status code" — leaving the distinction to implementer judgment.

**How to avoid:**
- Enforce a strict status code contract in the codebase: 401 only from `validateAuth` failure, 403 from access control policy denial.
- Document the distinction in comments adjacent to the access check.
- Test explicitly: an authenticated blacklisted user must receive 403, not 401.

**Warning signs:**
- Nostr clients keep prompting for re-auth when a blacklisted user tries to upload.
- Logs show valid auth followed by 401 responses.

**Phase to address:** Access control implementation phase — establish status code contract before wiring access checks to endpoints.

---

### Pitfall 3: Access control check runs after body is consumed

**What goes wrong:**
On `PUT /upload` the body is read into memory (`request.arrayBuffer()`) before the access control check runs. A blacklisted or non-whitelisted user causes the server to ingest their potentially large upload, compute its hash, and then reject them. This wastes storage API calls and memory, and creates a DoS surface on the edge worker.

**Why it happens:**
The existing upload flow reads the body to compute the SHA-256 before checking blocked hashes. Access control is added "alongside" the blocked content check rather than before the body read.

**How to avoid:**
- Run the pubkey access control check immediately after auth validation succeeds, before reading the request body.
- Order: Auth validation → Access control check → Body read → Hash computation → Blocked content check.
- The `HEAD /upload` (BUD-06) pre-flight endpoint should also apply access control before any other work.

**Warning signs:**
- Rejected users consume bandwidth and trigger storage API calls in logs.
- Access control check appears after `request.arrayBuffer()` in the upload handler.

**Phase to address:** Upload handler modification phase — restructure the check order as the first code change.

---

### Pitfall 4: Logic inversion in mode/list precedence

**What goes wrong:**
The three operating modes have non-obvious rule ordering:
- Public + no payments: blacklist bans, whitelist ignored.
- Public + payments: paid = allowed, whitelist = free pass, blacklist = banned regardless of payment.
- Private: whitelist only, blacklist and payments both ignored.

A common mistake is to check whitelist first in all modes and short-circuit to "allowed," bypassing the blacklist in "public + payments" mode. A blacklisted user who is also whitelisted (possibly from a stale whitelist entry) gets through.

**Why it happens:**
Whitelist-as-bypass feels intuitive ("if explicitly allowed, skip further checks"). But in the payment mode, the blacklist is meant to be an absolute ban, even for previously-trusted users. This requires blacklist to be checked before whitelist in that mode.

**How to avoid:**
- Implement the logic as an explicit decision tree, not a series of early returns:
  1. If blacklisted → 403 (all modes except private, where blacklist is ignored).
  2. If whitelisted → allowed (free pass in payment mode, only path in private mode).
  3. If public mode and no payments → allowed.
  4. If public mode and payments → check payment status.
- Write the rules as a truth table in a comment block next to the implementation.
- Test every cell of the matrix: blacklisted+whitelisted, blacklisted+paid, whitelisted+unpaid, etc.

**Warning signs:**
- Blacklisted users can upload if they also appear on the whitelist.
- The condition logic has early returns before the blacklist check.

**Phase to address:** Access control logic implementation — write the truth table before writing code.

---

### Pitfall 5: Config cache not invalidating across warm isolate instances

**What goes wrong:**
The existing `blocked.json` pattern uses a module-level variable with a 60-second TTL cache. This works correctly within a single V8 isolate instance but does NOT propagate to other warm isolate instances on different edge nodes. After editing `access.json` in Bunny Storage, some requests (hitting instance A) see the old config for up to 60 seconds, while others (hitting instance B, which just cold-started) see the new config immediately. This can cause an operator to believe a pubkey has been banned when they are still uploading through a different edge node.

**Why it happens:**
The TTL cache pattern is reasonable for read performance within a single isolate. Edge deployments run multiple isolated instances globally. Module-level variables are isolate-local — they cannot share state.

**How to avoid:**
- Document this behavior clearly: the 60-second TTL is per-instance, not global. Config changes take up to 60 seconds to fully propagate across all active instances.
- Do not design any feature that assumes instantaneous config propagation.
- For banning urgent abusers, document the expected delay window explicitly.
- Match the TTL of the new `access.json` cache to the existing `blocked.json` TTL for consistency.

**Warning signs:**
- After banning a pubkey, the operator reports they are still uploading intermittently.
- The behavior varies by request — same client sometimes allowed, sometimes blocked.

**Phase to address:** Config loading implementation — mirror the blocked.json pattern and document the propagation delay.

---

### Pitfall 6: BUD-06 pre-flight (`HEAD /upload`) not enforcing access control

**What goes wrong:**
Access control is added to `PUT /upload` but not to `HEAD /upload` (BUD-06 pre-flight check). A blacklisted client can probe the server, confirm a file would be accepted, and then attempt the actual upload. More critically: any BUD-06-aware client will call HEAD first — if HEAD returns 200, the client sends the body. If HEAD allows but PUT denies, the client's UX is broken (it wasted bandwidth sending a body to a guaranteed rejection).

**Why it happens:**
BUD-06 is often implemented as a lighter "echo" of the upload check. Access control is added to the main handler and the preflight is overlooked.

**How to avoid:**
- Apply the same access control middleware to both `HEAD /upload` and `PUT /upload`, and to `HEAD /media` and `PUT /media`.
- The BUD-06 spec explicitly states the endpoint "MAY accept an upload authorization event" and should respond with 401/403 for access failures — this is the documented intent.
- Write a single `checkAccess(pubkey, config)` function used identically by both handlers.

**Warning signs:**
- `HEAD /upload` returns 200 for a blacklisted pubkey, but `PUT /upload` returns 403.
- Access control code is duplicated between preflight and upload handlers with inconsistent conditions.

**Phase to address:** Endpoint modification phase — implement as a shared function called from all gated endpoints.

---

### Pitfall 7: Mirror endpoint excluded from access control

**What goes wrong:**
`PUT /mirror` (BUD-04) is a write endpoint that stores a remote blob into the server by URL. If access control is applied to `/upload` and `/media` but not `/mirror`, a blacklisted or non-whitelisted pubkey can use mirror to store content on the server. The server also makes an outbound HTTP request for the remote blob, which creates an SSRF surface if the caller is unauthorized.

**Why it happens:**
Mirror is often considered an "admin" or "rare" operation. Developers focus access control on the primary upload paths and treat mirror as less critical.

**How to avoid:**
- Include `/mirror` explicitly in the list of gated write endpoints in the PROJECT.md requirements — it already is. Ensure the implementation matches.
- The SSRF risk (server fetching an attacker-controlled URL) is a secondary reason mirror access should be tightly controlled.

**Warning signs:**
- Access control tests cover `/upload` and `/media` but have no test for `/mirror`.
- `/mirror` handler calls storage before calling an access check.

**Phase to address:** Endpoint modification phase — add access check before the outbound fetch in the mirror handler.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcode `public: true` in access config until payments are wired | Shipping faster | Silent behavior change when payments are wired later — previously "public" becomes "public + payments" with undefined whitelist behavior | Never — define all three config fields explicitly from day one |
| Skip validation of config JSON shape on load | Simpler loading code | Malformed config silently treated as empty lists — all users blocked or all users allowed | Never — validate and log on load |
| Single `allowedPubkeys` list instead of separate whitelist/blacklist | Fewer config keys | Cannot express "ban specifically" — removing from allowed list is ambiguous when public mode is toggled | Only if private-mode-only is the permanent use case |
| Cache TTL of 0 (always fetch config) | Config changes take effect immediately | Storage API called on every request, significant latency added to all writes | Never in production — use 60s TTL matching blocked.json |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Bunny Storage config read | Treating a missing `access.json` as an error | Treat missing file as "default open" (public mode, empty lists) — match the blocked.json pattern where missing = empty |
| Payment middleware composition | Calling payment check before access control | Access control runs first; a blacklisted pubkey should never reach the payment check |
| Nostr auth pubkey field | Trusting `event.pubkey` without verifying the signature first | The existing `validateAuth` already verifies signature before returning pubkey — access control MUST only run after `validateAuth` succeeds |
| Bunny CDN response caching | CDN caching a 403 response from a blocked pubkey | Responses based on auth header content must set `Cache-Control: no-store` — all 4xx responses from gated endpoints should already bypass CDN cache |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Loading access.json on every request without caching | High latency on all write endpoints, storage API quota exhaustion | Use same 60s TTL in-memory cache pattern as blocked.json | Day 1 at any load — every request hits Bunny Storage |
| Storing pubkey lists as arrays and doing linear scan per request | Acceptable at < 100 entries, noticeable at 1000+ | Convert list to `Set<string>` on load, do O(1) lookup | When whitelist or blacklist exceeds ~500 entries |
| Loading whitelist and blacklist in separate storage fetches | Two sequential round-trips per config refresh | Store both in single `access.json` — one fetch for the entire access config | All the time — unnecessary latency |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Running access control before auth validation | Attacker submits unsigned event, pubkey field is attacker-controlled, bypasses access check | Always run `validateAuth` first; only extract pubkey from a validated auth result |
| Logging full pubkey + "blocked" in production without rate limiting | Log flooding by attacker cycling pubkeys | Log access denials at WARN level with deduplication or rate limiting |
| Treating whitelist as implicit trust for all future actions | Whitelisted users bypass blacklist check in payment mode | Blacklist check must happen before whitelist check in modes where blacklist applies |
| Config JSON written without atomic replacement on Bunny Storage | Partial write creates malformed JSON, all access decisions fail open or closed | Write is a single PUT to Bunny Storage API — it is atomic by design; the risk is invalid JSON, not partial write. Validate JSON before writing. |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Returning generic 403 with no message when blacklisted | User cannot distinguish "server down" from "you are banned" | Include JSON body: `{"message": "Access denied", "reason": "pubkey not permitted"}` |
| Returning 403 with no explanation when in private mode and user is not whitelisted | Legitimate users think the server is broken | Include reason in error body: `{"message": "This server requires explicit access. Contact the operator."}` |
| Returning 402 before checking if pubkey is blacklisted | Blacklisted user gets a payment prompt instead of a ban message | Check blacklist before checking payment status |
| Config change not reflected for 60 seconds (TTL cache) | Operator adds a pubkey to whitelist, user tries immediately and gets 403 | Document the propagation delay; advise operators to wait 60+ seconds after config edits |

---

## "Looks Done But Isn't" Checklist

- [ ] **Access control on mirror:** `/mirror` endpoint applies the same access check as `/upload` — verify with a test using a blacklisted pubkey against PUT /mirror.
- [ ] **Access control on media preflight:** `HEAD /media` applies access control — verify HEAD /media returns 403 for blacklisted pubkey, not 200.
- [ ] **Access control on upload preflight:** `HEAD /upload` applies access control — verify HEAD /upload returns 403 for blacklisted pubkey.
- [ ] **Blacklist-wins-over-whitelist in payment mode:** A pubkey that is both whitelisted and blacklisted gets 403 in public+payments mode — verify with explicit test.
- [ ] **Hex format enforcement:** Config load rejects or warns on npub-format entries — verify by placing a test npub in the config.
- [ ] **Missing config file is safe:** When `access.json` does not exist in Bunny Storage, behavior matches the configured default (public or private) — verify by deleting the file.
- [ ] **Report endpoint is not gated:** `PUT /report` (BUD-09) remains accessible to all authenticated users regardless of whitelist/blacklist — verify by attempting a report from a blacklisted pubkey.
- [ ] **Payment check is unreachable for blacklisted pubkeys:** A blacklisted pubkey with a valid payment proof still gets 403 — verify that access control runs before payment verification.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Pubkeys in wrong format in access.json | LOW | Edit access.json: convert all npub entries to hex using a converter, re-upload to Bunny Storage, wait 60s for cache expiry |
| Wrong status codes returning 401 for policy denials | MEDIUM | Fix the specific handler code, redeploy — stateless edge means no data migration needed |
| Access control body read order wrong (body consumed before access check) | MEDIUM | Refactor handler to reorder checks, redeploy — no state to migrate |
| Logic inversion (blacklist bypassed by whitelist) | HIGH | Requires careful logic rewrite, thorough matrix testing, redeploy — security bug, treat as urgent |
| Missing config cache (every request hits storage) | LOW | Add cache module mirroring blocked.json pattern, redeploy |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| npub vs hex pubkey format mismatch | Config schema definition | Unit test: load config with npub entry, assert validation error |
| Wrong 4xx status codes (401 vs 403) | Access control implementation | Integration test: valid auth + blacklisted pubkey = 403, not 401 |
| Body consumed before access check | Upload handler modification | Code review: `checkAccess()` call must appear before `request.arrayBuffer()` |
| Logic inversion in mode/list precedence | Access control logic implementation | Matrix test: all combinations of whitelist/blacklist/payment/mode |
| Config cache not propagating across instances | Config loading implementation | Documentation review: TTL delay documented in operator guide |
| BUD-06 preflight not enforcing access control | Endpoint wiring phase | Integration test: HEAD /upload with blacklisted pubkey returns 403 |
| Mirror endpoint excluded from access control | Endpoint wiring phase | Integration test: PUT /mirror with blacklisted pubkey returns 403 |

---

## Sources

- [BUD-07 Payment Required spec](https://github.com/hzrd149/blossom/blob/master/buds/07.md) — MEDIUM confidence (via WebFetch)
- [BUD-02 Upload and management spec](https://github.com/hzrd149/blossom/blob/master/buds/02.md) — MEDIUM confidence (via WebFetch)
- [BUD-06 Upload requirements spec](https://github.com/hzrd149/blossom/blob/master/buds/06.md) — MEDIUM confidence (via WebFetch)
- [NIP-19 bech32-encoded entities — hex-only for protocol fields](https://nips.nostr.com/19) — HIGH confidence (official NIP spec)
- [NIP-98 HTTP Auth server validation requirements](https://github.com/nostr-protocol/nips/blob/master/98.md) — HIGH confidence (official NIP spec)
- [khatru Blossom access control — RejectUpload hook pattern](https://khatru.nostr.technology/core/blossom) — MEDIUM confidence (reference framework docs)
- [Bunny CDN caching vulnerability — authenticated response caching risk](https://httptoolkit.com/blog/bunny-cdn-caching-vulnerability/) — HIGH confidence (published security research)
- [Bunny EdgeScript limits — 128MB per isolate, stateless instances](https://docs.bunny.net/docs/edge-scripting-limits) — HIGH confidence (official Bunny docs)
- [Deno isolate cloud — module-level state is isolate-local, not shared globally](https://deno.com/blog/anatomy-isolate-cloud) — HIGH confidence (official Deno blog)
- [OWASP Broken Access Control — 401 vs 403 distinction, whitelist bypass patterns](https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/) — HIGH confidence (OWASP official)
- blssm.us codebase: `/home/sandwich/Develop/blssm.us/src/storage/metadata.ts` — TTL cache pattern for blocked.json (existing implementation, direct inspection)
- blssm.us codebase: `/home/sandwich/Develop/blssm.us/src/auth/nostr.ts` — auth validation flow (existing implementation, direct inspection)
- blssm.us codebase: `/home/sandwich/Develop/blssm.us/src/handlers/blob-upload.ts` — body read order (existing implementation, direct inspection)

---
*Pitfalls research for: Blossom server access control (whitelist/blacklist + payment composition)*
*Researched: 2026-02-24*
