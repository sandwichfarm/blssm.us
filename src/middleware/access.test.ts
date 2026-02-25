/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { checkAccess, _resetAccessCacheForTesting, loadAccessConfig } from "./access.ts";
import type { AccessAction } from "./access.ts";
import type { StorageClient } from "../storage/client.ts";

// ---------------------------------------------------------------------------
// Minimal mock StorageClient — returns a pre-configured getJson result
// ---------------------------------------------------------------------------

function makeStorage(configJson: unknown): StorageClient {
  return {
    getJson: async (_path: string) => {
      if (_path === "config/access.json") return configJson as Awaited<ReturnType<StorageClient["getJson"]>>;
      return null;
    },
  } as unknown as StorageClient;
}

// Valid hex-64 pubkeys for testing
const PUB_CLEAN = "a".repeat(64);
const PUB_BLOCKED = "b".repeat(64);
const PUB_ALLOWED = "c".repeat(64);
const PUB_BOTH = "d".repeat(64); // on both allowlist and blocklist
const PUB_UNLISTED = "e".repeat(64); // not on any list

// ---------------------------------------------------------------------------
// Public mode tests — ACL-05 backward compat (updated signature)
// ---------------------------------------------------------------------------

Deno.test("ACL-05 compat: public mode, clean pubkey, action=upload → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, allowlist: [], blocklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: public mode, blocked pubkey, action=upload → denied, reason contains 'blocked'", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, allowlist: [], blocklist: [PUB_BLOCKED] });
  const result = await checkAccess(storage, PUB_BLOCKED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blocked"), true);
  }
});

Deno.test("ACL-05 compat: public mode, allowlisted pubkey, action=upload → allowed (allowlist is no-op in plain public)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, allowlist: [PUB_ALLOWED], blocklist: [] });
  const result = await checkAccess(storage, PUB_ALLOWED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: public mode, pubkey on both lists, action=upload → denied (blocklist wins)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, allowlist: [PUB_BOTH], blocklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blocked"), true);
  }
});

// ---------------------------------------------------------------------------
// Private mode tests — ACL-05 backward compat (updated signature)
// ---------------------------------------------------------------------------

Deno.test("ACL-05 compat: private mode, allowlisted pubkey, action=upload → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, allowlist: [PUB_ALLOWED], blocklist: [] });
  const result = await checkAccess(storage, PUB_ALLOWED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: private mode, clean pubkey, action=upload → denied, user-facing reason", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, allowlist: [], blocklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.length > 0, true);
  }
});

Deno.test("ACL-05 compat: private mode, blocklisted-only pubkey, action=upload → denied", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, allowlist: [], blocklist: [PUB_BLOCKED] });
  const result = await checkAccess(storage, PUB_BLOCKED, "upload");
  assertEquals(result.allowed, false);
});

// ---------------------------------------------------------------------------
// Public+payments mode tests (NEW — ACL-01, ACL-02, ACL-03, ACL-04)
// ---------------------------------------------------------------------------

Deno.test("ACL-01: public+payments, config has payments:true → mode is active (config normalizes correctly)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, true);
});

Deno.test("ACL-02: public+payments, allowlisted pubkey, action=upload → allowed:true (no payment required)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [PUB_ALLOWED], blocklist: [] });
  const result = await checkAccess(storage, PUB_ALLOWED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-03: public+payments, blocked pubkey, action=upload → denied with reason 'blocked' (NOT requiresPayment)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [PUB_BLOCKED] });
  const result = await checkAccess(storage, PUB_BLOCKED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blocked"), true);
    // Must NOT have requiresPayment set — blocklist is a hard deny, not a payment gate
    assertEquals((result as { requiresPayment?: unknown }).requiresPayment, undefined);
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=upload → denied with requiresPayment:true, reason='payment_required'", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.requiresPayment, true);
    assertEquals(result.reason, "payment_required");
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=mirror → denied with requiresPayment:true (mirror also gated)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "mirror");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.requiresPayment, true);
    assertEquals(result.reason, "payment_required");
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=delete → allowed:true (delete always free)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "delete");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-03 edge: public+payments, pubkey on both lists, action=upload → denied 'blocked' (blocklist wins over allowlist)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [PUB_BOTH], blocklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blocked"), true);
    assertEquals((result as { requiresPayment?: unknown }).requiresPayment, undefined);
  }
});

// ---------------------------------------------------------------------------
// Normalizer tests (NEW — payments field edge cases)
// ---------------------------------------------------------------------------

Deno.test("Normalizer: payments field missing → defaults to false (no console.warn)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, allowlist: [], blocklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});

Deno.test("Normalizer: payments=true, public=true → payments:true retained", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, allowlist: [], blocklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, true);
});

Deno.test("Normalizer: payments=true, public=false → payments forced to false (console.warn fires)", async () => {
  _resetAccessCacheForTesting();
  const warnMessages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnMessages.push(args.join(" ")); };
  try {
    const storage = makeStorage({ public: false, payments: true, allowlist: [], blocklist: [] });
    const cache = await loadAccessConfig(storage);
    assertEquals(cache.config.payments, false);
    assertEquals(warnMessages.some((m) => m.includes("payments")), true);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("Normalizer: payments='string' → defaults to false", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: "yes", allowlist: [], blocklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});

Deno.test("Normalizer: payments=null → defaults to false", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: null, allowlist: [], blocklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});

// ---------------------------------------------------------------------------
// Cache hit path tests
// ---------------------------------------------------------------------------

Deno.test("loadAccessConfig: second call within TTL returns cached result (no extra getJson call)", async () => {
  _resetAccessCacheForTesting();
  let callCount = 0;
  const storage: StorageClient = {
    getJson: async (_path: string) => {
      callCount++;
      return { public: true, allowlist: [], blocklist: [], payments: false };
    },
  } as unknown as StorageClient;
  const first = await loadAccessConfig(storage);
  const second = await loadAccessConfig(storage);
  assertEquals(callCount, 1);
  assertEquals(first, second);
});

// ---------------------------------------------------------------------------
// filterPubkeys — non-string entries
// ---------------------------------------------------------------------------

Deno.test("filterPubkeys: non-string entries in allowlist are skipped with console.warn", async () => {
  _resetAccessCacheForTesting();
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")); };
  try {
    const storage = makeStorage({
      public: true,
      allowlist: [123, null, PUB_CLEAN],
      blocklist: [],
    });
    const cache = await loadAccessConfig(storage);
    // Only the valid hex-64 entry should survive
    assertEquals(cache.config.allowlist.length, 1);
    assertEquals(cache.config.allowlist[0], PUB_CLEAN);
    // console.warn should have fired for invalid entries
    assertEquals(warns.filter((m) => m.includes("invalid pubkey")).length, 2);
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// normalizeAccessConfig — non-null non-object raw
// ---------------------------------------------------------------------------

Deno.test("Normalizer: raw config is a number → returns defaults", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage(42);
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.public, true);
  assertEquals(cache.config.payments, false);
  assertEquals(cache.config.allowlist.length, 0);
  assertEquals(cache.config.blocklist.length, 0);
});
