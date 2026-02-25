# blssm.us

A [Blossom](https://github.com/hzrd149/blossom) server running on [Bunny CDN EdgeScript](https://docs.bunny.net/docs/edgescript-overview). Content-addressed blob storage with [Nostr](https://nostr.com/) authentication, access control, and CDN delivery.

## BUD Specs Implemented

| Spec | Description | Status |
|------|-------------|--------|
| [BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md) | Blob retrieval (GET/HEAD) | ✓ |
| [BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md) | Upload, deletion, listing | ✓ |
| [BUD-04](https://github.com/hzrd149/blossom/blob/master/buds/04.md) | Mirroring from remote URL | ✓ |
| [BUD-05](https://github.com/hzrd149/blossom/blob/master/buds/05.md) | Media upload | ✓ |
| [BUD-06](https://github.com/hzrd149/blossom/blob/master/buds/06.md) | Upload preflight check | ✓ |
| [BUD-07](https://github.com/hzrd149/blossom/blob/master/buds/07.md) | Payment response framework | Stub |
| [BUD-08](https://github.com/hzrd149/blossom/blob/master/buds/08.md) | NIP-94 metadata | ✓ |
| [BUD-09](https://github.com/hzrd149/blossom/blob/master/buds/09.md) | Content reporting (NIP-56) | ✓ |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PUT` | `/upload` | ✓ | Upload blob |
| `HEAD` | `/upload` | ✓ | Upload preflight check |
| `GET/HEAD` | `/<sha256>` | | Retrieve blob or descriptor |
| `DELETE` | `/<sha256>` | ✓ | Delete blob |
| `GET` | `/list/<pubkey>` | | List blobs by owner |
| `PUT` | `/mirror` | ✓ | Mirror blob from URL |
| `PUT` | `/media` | ✓ | Upload media |
| `HEAD` | `/media` | ✓ | Media preflight check |
| `PUT` | `/report` | | Report content |

Authentication uses Nostr kind 24242 events with Schnorr signature verification (`Authorization: Nostr <base64>`).

## Access Control

Operator-configurable pubkey access control via `config/access.json` in Bunny Storage:

```json
{
  "public": true,
  "whitelist": ["<hex-pubkey>", "..."],
  "blacklist": ["<hex-pubkey>", "..."]
}
```

| Mode | Behavior |
|------|----------|
| **Public** (`"public": true`) | Anyone can publish. Blacklisted pubkeys are denied. Whitelist is ignored. |
| **Private** (`"public": false`) | Only whitelisted pubkeys can publish. Blacklist is ignored. |

Config is cached with a 60-second TTL. Missing config defaults to public mode with empty lists.

## Content Blocking

Block specific blobs by SHA-256 hash via `config/blocked.json`:

```json
{
  "hashes": ["<sha256>", "..."]
}
```

Blocked blobs return 403 on retrieval and are rejected during upload.

## Development

Requires [Deno](https://deno.com/) v2.x.

```sh
deno task check   # Type check
deno task dev     # Dev server with hot reload
deno task build   # Build to dist/server.js
deno test src/    # Run tests
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUNNY_STORAGE_PASSWORD` | Yes | Bunny Storage API key |
| `BUNNY_STORAGE_HOSTNAME` | Yes | Storage zone hostname |
| `BUNNY_STORAGE_USERNAME` | Yes | Storage zone name |
| `BUNNY_CDN_HOSTNAME` | Yes | CDN pull zone hostname |
| `SERVER_URL` | Yes | Public server URL (for auth validation) |
| `MAX_UPLOAD_SIZE` | No | Max upload in bytes (default: 100MB) |
| `BUNNY_SPA_STORAGE_*` | No | Separate storage zone for SPA frontend |

## Deployment

Deploys automatically to Bunny CDN EdgeScript on push to `master` via GitHub Actions. The SPA frontend deploys separately on changes to `spa/`.

## Project Structure

```
src/
├── main.ts              # Entry point
├── router.ts            # Request routing
├── types.ts             # Type definitions
├── util.ts              # Helpers (hashing, validation, MIME)
├── auth/
│   ├── nostr.ts         # Kind 24242 event validation
│   └── schnorr.ts       # Signature verification
├── handlers/            # Endpoint handlers
├── middleware/
│   ├── access.ts        # Whitelist/blacklist access control
│   ├── cors.ts          # CORS headers
│   └── payments.ts      # Payment framework (stub)
└── storage/
    ├── client.ts        # Bunny Storage API wrapper
    └── metadata.ts      # Blob metadata & index management
```
