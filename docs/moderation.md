# Moderation

Open `/admin` and sign in with the Nostr browser extension or a remote signer (bunker URI). Only `npub1uac67zc9er54ln0kl6e4qp2y6ta3enfcg7ywnayshvlw9r5w6ehsqq99rx` is authorized. There is no shared admin password or private key entry field. Every API request is signed, including reads.

## Operator controls

- **Manual review** (default): reports enter the inbox without automatic blocking.
- **Trusted reporters**: new reports signed by one of the configured public keys automatically block their referenced hash. Enter npub or hex keys in the GUI.
- **All reports**: every valid signed report automatically blocks its referenced hash.

Saving a policy affects new submissions. **Apply saved policy to pending** processes existing reports and reconciles failed cache purges. It runs in small resumable batches.

Blocking denies retrieval, upload, and mirroring. It retains bytes and metadata so an operator can reverse the decision. Both `/<hash>` and `/blobs/<prefix>/<hash>` enforce the same decision; changes purge CDN copies. New retrieval responses use `no-store`. Previously saved/downloaded browser copies cannot be recalled. Unblocking cannot restore a blob that was physically deleted before this feature.

**Allow hash** removes the effective block, including a legacy `config/blocked.toml` entry, without rewriting that file. Unblocking from a report also protects the hash against automation by default. Protection can be toggled independently; while protected, manual access state wins regardless of new reports. Re-enabling automation does not replay old reports over the operator's decision; later reports may act. Direct hash controls also work for hashes with no reports.

Dismiss/reopen changes the report review state, not blob access. All reports concerning a hash show its current access state. A dismissed report remains dismissed even if another report blocks the hash. A processing-failure indicator means the receipt was saved but an automatic operation or cache purge needs retrying.

The table shows received time, category, reporter, hash, review status, and **actual PoW bits** (leading zero bits in the verified event ID). The nonce's requested difficulty is not trusted. Signed reports need not meet a minimum PoW; low-PoW reports remain visible for spam review. The browser loads cursor batches, deduplicates legacy/current receipts, then computes global statistics, filters, and ordering; it shows progress until the scan finishes. Statistics refer to the loaded report collection (including protected hashes represented by reports), not every stored blob.

## Automation API

All endpoints require [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md) from the owner key: kind `27235`, current `created_at` (within 60 seconds), exact `u` URL including query, and exact `method`. Mutations also require the exact body SHA-256 in `payload` and a signed `created_at_ms` tag containing the 13-digit timestamp consistent with `created_at`. Use a unique nonce for each new request. Retries with an already recorded authorization return 409; sign a fresh request to retry a failed operation.

| Endpoint | Result |
| --- | --- |
| `GET /admin/session` | Authorized public key |
| `GET /admin/reports?cursor=...` | At most 25 hydrated reports, policy, `nextCursor`, storage-file `scanTotal`; follow cursors to completion and deduplicate by report ID |
| `PUT /admin/moderation` | Save `{mode: "manual" \| "trusted" \| "all", trustedReporters: [hex]}` |
| `PUT /admin/hashes/<sha256>` | Set `{blocked, automationProtected, reason}` |
| `PUT /admin/reports/<id>` | Set `{status: "pending" \| "reviewed" \| "dismissed", reason, sha256}`; hash identifies legacy receipts |
| `POST /admin/moderation/process` | Process one batch using `{cursor?}`; returns processed/blocked/skipped/failed counts and `nextCursor` |

The report list API's optional status/sort/page controls and statistics apply **within the returned scan batch**. To sort/filter the entire queue, follow every cursor and aggregate first, as the admin GUI does. Refresh to discover reports submitted during a scan; the object store does not provide transactional snapshots. Body sizes are limited to 64 KiB. Administrative responses and blob retrievals are not cacheable.

## Persistence and recovery

- `moderation/reports/<event-id>.json`: signed receipt plus server receipt time and measured PoW; retrying the event preserves its existing receipt.
- `moderation/policies/<signed-ms>-<authorization-id>.json`: versioned policies.
- `moderation/controls/<hash>/<signed-ms>-<authorization-id>.json`: versioned manual access/protection decisions.
- `moderation/automatic/<hash>/<receipt-ms>-<report-id>.json`: automatic block markers, independent of manual records.
- `moderation/reviews/<report-id>/<signed-ms>-<authorization-id>.json`: versioned review decisions.
- `moderation/processing/<report-id>.json`: retry-needed state.
- `moderation/audit/<authorization-id>.json`: actor, request, start/completion state, and result.

Newest signed versions win deterministically, so delayed duplicate operations cannot overwrite newer protections. Automatic markers use original server receipt time, so retrying old reports cannot supersede later operator decisions. Existing `reports/<hash>.json` arrays and single-object policy/control/review records remain readable. The live legacy TOML blocklist remains authoritative unless explicitly overridden for a hash.

`BUNNY_API_KEY` must be available to the edge script for CDN invalidation (the existing deployment provides it). A failed purge leaves the block/control recorded and returns an error or pending receipt; processing retries purge independently of the current policy. Manual operations whose response failed should be refreshed and retried with a new signature if necessary.

Storage reads fail visibly on outages rather than treating them as empty queues or unblocked hashes. Hydration concurrency and batch sizes are bounded. Bunny directory enumeration is still a full listing (16 MiB limit), and historical per-hash report files are limited to 4 MiB on read. A database/index migration is needed if directory or legacy-file sizes exceed those limits; totals are never silently truncated.

## Verification

```sh
deno task check
deno test -A src/
deno task build
cd spa
node --test tests/*.test.mjs
npm run check
npm run build
```

Browser fixture evidence lives under `.omx/artifacts/admin/`. Fixture login uses an ephemeral test identity; it does not establish possession of the real operator's key.
