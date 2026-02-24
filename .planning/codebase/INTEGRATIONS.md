# External Integrations

**Analysis Date:** 2026-02-24

## APIs & External Services

**Bunny CDN EdgeScript:**
- Bunny EdgeScript SDK (`@bunny.net/edgescript-sdk`) - HTTP request handler on Bunny edge network
  - Location: `src/main.ts`
  - Usage: Serves all HTTP requests via `BunnySDK.net.http.serve()`
  - Configuration: Deployed to script ID 65595 via GitHub Actions

**Content Mirroring:**
- Generic `fetch()` API - Mirror blobs from remote URLs
  - Handler: `src/handlers/mirror.ts`
  - Usage: `handleMirror()` fetches content from user-provided URL
  - No SDK, uses native fetch

## Data Storage

**Bunny Storage (REST API):**
- Primary blob and metadata storage
- Client: `src/storage/client.ts` - Custom REST API wrapper
- Connection: Configured via environment variables:
  - `BUNNY_STORAGE_HOSTNAME` - Storage API endpoint
  - `BUNNY_STORAGE_USERNAME` - Zone name
  - `BUNNY_STORAGE_PASSWORD` - API access key
- Operations:
  - PUT/GET/DELETE blobs at paths: `blobs/{prefix}/{sha256}`
  - JSON metadata at: `meta/{prefix}/{sha256}.json`
  - Pubkey indexes at: `lists/{prefix}/{pubkey}/index.json`
  - Reports at: `reports/{sha256}.json`
  - Blocked hashes config at: `config/blocked.json`

**Bunny CDN (Read-only):**
- Public blob delivery via CDN
- Configuration: `BUNNY_CDN_HOSTNAME` - public zone hostname
- Blob URLs: `https://{cdnHostname}/blobs/{prefix}/{sha256}`

**SPA Storage (Bunny Storage):**
- Separate storage zone for Single Page App assets
- Optional: `BUNNY_SPA_STORAGE_PASSWORD`, `BUNNY_SPA_STORAGE_HOSTNAME`, `BUNNY_SPA_STORAGE_USERNAME`
- Deployed via GitHub Actions using `ayeressian/bunnycdn-storage-deploy@v2.4.3`
- Handler: `src/handlers/spa.ts` - Serves SPA fallback

**File Storage:**
- All file storage goes through Bunny Storage REST API
- No local filesystem storage in production
- No external S3, Azure, or GCS integration

**Caching:**
- In-memory cache for blocked hashes only
- Location: `src/storage/metadata.ts` - `blockedCache` with 60s TTL
- No Redis, Memcached, or other external cache

## Authentication & Identity

**Nostr Protocol (NIP-26, NIP-56, NIP-94):**
- Authentication provider: Nostr events (kind 24242 for auth)
- Implementation: `src/auth/nostr.ts` - Validates Nostr auth events
  - No external Nostr relay required for authentication
  - Event validation done locally: signature verification, timestamp validation, tag validation
  - Schnorr signature verification via `@noble/curves/secp256k1`
  - SHA-256 hashing via `@noble/hashes`

**Auth Flow:**
- Clients sign Nostr events (kind 24242) offline
- Event passed in `Authorization: Nostr <base64>` header
- Server validates:
  - Kind = 24242
  - created_at timestamp (60s clock skew allowed)
  - expiration tag (if present)
  - `t` tag matches HTTP verb (get, upload, delete, list, media, mirror)
  - `x` tag matches blob hash (if provided)
  - `server` tag matches configured `SERVER_URL` (if provided)
  - Event ID matches SHA-256 of serialized event
  - Schnorr signature valid

**Authorization:**
- Per-pubkey blob ownership tracking
- Blob metadata stores list of owner pubkeys: `src/storage/metadata.ts` → `BlobMeta.owners`
- Delete operations check pubkey authorization via ownership

**Content Reporting (Moderation):**
- NIP-56 kind 1984 moderation events
- Handler: `src/handlers/report.ts`
- Reports stored but not actively enforced (framework for future use)
- No external moderation service integration

## Monitoring & Observability

**Error Tracking:**
- Not detected - no Sentry, Rollbar, or external error tracking
- Console logging only via `console.error()` in `src/router.ts`

**Logs:**
- Console output only
- Request errors logged to stdout via `console.error()`
- No external logging service (DataDog, LogRocket, CloudWatch, etc.)
- No structured logging framework

## CI/CD & Deployment

**Hosting:**
- Bunny CDN EdgeScript platform - Backend server deployment
  - Script ID: 65595
  - Runs on Bunny edge network

**CI Pipeline:**
- GitHub Actions with two workflows:
  - `release-on-bunny.yml` - Backend deployment
    - Trigger: Push to `master` branch
    - Steps: Deno type check, ESBuild bundling, Bunny script deployment
    - Uses: `denoland/setup-deno@v2`, `BunnyWay/actions/deploy-script@main`
  - `deploy-spa.yml` - SPA deployment
    - Trigger: Push to `master` or `main` when `spa/**` changes
    - Steps: Bun install, Vite build, upload to Bunny Storage
    - Uses: `oven-sh/setup-bun@v2`, `ayeressian/bunnycdn-storage-deploy@v2.4.3`

**Secrets Management:**
- GitHub Actions secrets (not specified in codebase, stored in repository settings)
  - `BUNNY_STORAGE_PASSWORD`
  - `BUNNY_STORAGE_HOSTNAME`
  - `BUNNY_STORAGE_USERNAME`
  - `BUNNY_CDN_HOSTNAME`
  - `BUNNY_SPA_STORAGE_PASSWORD`
  - `BUNNY_SPA_STORAGE_HOSTNAME`
  - `BUNNY_SPA_STORAGE_USERNAME`
  - `BUNNY_API_KEY` (for BunnyWay script deployment)

## Webhooks & Callbacks

**Incoming:**
- None - No webhook endpoints or inbound integrations

**Outgoing:**
- None - No external service callbacks or webhooks

**Content Mirroring (Pull-based):**
- `src/handlers/mirror.ts` fetches content from user-provided URLs
- Not a webhook, user explicitly requests mirror operation via PUT /mirror

## Environment Configuration

**Required env vars (no fallback):**
- `BUNNY_STORAGE_PASSWORD`
- `BUNNY_STORAGE_HOSTNAME`
- `BUNNY_STORAGE_USERNAME`
- `BUNNY_CDN_HOSTNAME`
- `SERVER_URL`

**Optional env vars (with fallback):**
- `MAX_UPLOAD_SIZE` - Defaults to 104857600 (100MB) if missing
- `BUNNY_SPA_STORAGE_PASSWORD` - Optional, disables SPA if missing
- `BUNNY_SPA_STORAGE_HOSTNAME` - Optional
- `BUNNY_SPA_STORAGE_USERNAME` - Optional

**Secrets location:**
- GitHub Actions secrets (configured in repository settings, not in .env file)
- Passed at deployment time to Bunny EdgeScript

---

*Integration audit: 2026-02-24*
