# Technology Stack

**Analysis Date:** 2026-02-24

## Languages

**Primary:**
- TypeScript 5.9.3 - All backend and SPA source code

**Secondary:**
- JavaScript - Build scripts and configuration files

## Runtime

**Environment:**
- Deno v2.x - Backend server runtime
- Bun - SPA build and package manager

**Package Managers:**
- Deno (with JSR imports) - Backend dependencies
- Bun - SPA/Frontend dependencies
- Lockfiles: `deno.lock` (backend), `bun.lock` (SPA)

## Frameworks

**Core:**
- Bunny EdgeScript SDK (`@bunny.net/edgescript-sdk`) - HTTP server runtime on Bunny CDN edge network
- Svelte 5.45.2 - SPA framework for frontend UI
- Vite 7.3.1 - SPA build bundler and dev server

**Styling:**
- Tailwind CSS 4.2.0 - Utility-first CSS framework for SPA

**Build/Dev:**
- ESBuild v0.20.1 - Backend bundler (via Deno)
- esbuild-deno-loader 0.11.1 - Deno-aware ESBuild plugin
- Svelte preprocessor + Vite plugin - Svelte component compilation
- @tailwindcss/vite 4.2.0 - Tailwind integration in Vite

**Type Checking:**
- TypeScript compiler - Static type checking
- svelte-check 4.3.4 - Svelte template type validation

## Key Dependencies

**Cryptography & Hashing:**
- @noble/hashes 1.6.1 - SHA-256 hashing for blob content and event IDs
- @noble/curves/secp256k1 1.8.1 - Schnorr signature verification for Nostr events

**HTTP & Utilities:**
- Node standard library (process module) - Environment variable access
- Deno standard library (via JSR) - Path utilities, bytes, encoding

**Frontend:**
- @sveltejs/vite-plugin-svelte 6.2.1 - Svelte in Vite integration
- @tsconfig/svelte 5.0.6 - TypeScript configuration for Svelte
- @types/node 24.10.1 - Node.js type definitions (for dev)

## Configuration

**Environment:**
Environment variables are loaded at runtime in `src/main.ts`:
- `BUNNY_STORAGE_PASSWORD` - Storage zone API password (required)
- `BUNNY_STORAGE_HOSTNAME` - Storage zone hostname, e.g., `storage.bunnycdn.com` (required)
- `BUNNY_STORAGE_USERNAME` - Storage zone username (required)
- `BUNNY_CDN_HOSTNAME` - Public CDN hostname for blob URLs, e.g., `myzone.b-cdn.net` (required)
- `SERVER_URL` - Public Blossom server URL for auth validation (required)
- `MAX_UPLOAD_SIZE` - Maximum upload size in bytes (optional, default: 104857600 = 100MB)
- `BUNNY_SPA_STORAGE_PASSWORD` - SPA storage zone password (optional)
- `BUNNY_SPA_STORAGE_HOSTNAME` - SPA storage zone hostname (optional)
- `BUNNY_SPA_STORAGE_USERNAME` - SPA storage zone username (optional)

**Build Configuration:**
- Backend: `deno.json` - Deno config with tasks, imports, compiler options
- Backend: `build.ts` - ESBuild bundling script for server code
- SPA: `vite.config.ts` - Vite bundler config with Svelte and Tailwind plugins
- SPA: `svelte.config.js` - Svelte preprocessor config
- SPA: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` - TypeScript configurations
- SPA: `package.json` - NPM scripts (dev, build, preview, check)

## Platform Requirements

**Development:**
- Deno 2.x runtime installed
- Bun runtime installed
- Node.js compatible environment (for Bun)
- Text editor with TypeScript/Svelte support

**Production:**
- Bunny CDN EdgeScript platform (via Bunny Scripting API)
- Bunny Storage zones (for blob storage and SPA hosting)
- Bunny CDN zones (for public blob delivery)

**Deployment:**
Backend deployed via GitHub Actions workflow (`release-on-bunny.yml`):
- Deno type checking with `deno task check`
- Bundling with `deno task build` → outputs `dist/server.js`
- Published to Bunny EdgeScript script ID 65595 via BunnyWay action

SPA deployed via GitHub Actions workflow (`deploy-spa.yml`):
- Bun installation and build
- Deployed to Bunny Storage via `ayeressian/bunnycdn-storage-deploy@v2.4.3`

---

*Stack analysis: 2026-02-24*
