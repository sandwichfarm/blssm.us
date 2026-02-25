# Milestones

## v1.0 Access Control (Shipped: 2026-02-24)

**Phases completed:** 3 phases, 3 plans, 4 tasks
**Timeline:** 2026-02-20 → 2026-02-24 (4 days)
**Git range:** `35677ec` → `fbd1ad8`
**Files changed:** 8 (277 insertions)

**Key accomplishments:**
- `AccessConfig` type and `loadAccessConfig()` with 60s TTL cache, pubkey validation, and safe public-mode defaults
- `checkAccess()` decision function with TDD — 8-case matrix covering all public/private mode combinations
- Access control wired into all 4 gated write handlers (PUT /upload, /mirror, /media, HEAD /upload) before body consumption
- Non-gated endpoints (PUT /report, GET/HEAD blobs) verified untouched
- 22/22 requirements satisfied, 0 tech debt

**Delivered:** Pubkey-based publish access control with public/private mode toggle, whitelist, and blacklist — composable with future payment system.

**Archive:** `milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`, `milestones/v1.0-MILESTONE-AUDIT.md`

---

