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
const PUB_BLACKLISTED = "b".repeat(64);
const PUB_WHITELISTED = "c".repeat(64);
const PUB_BOTH = "d".repeat(64); // on both whitelist and blacklist
const PUB_UNLISTED = "e".repeat(64); // not on any list

// ---------------------------------------------------------------------------
// Public mode tests — ACL-05 backward compat (updated signature)
// ---------------------------------------------------------------------------

Deno.test("ACL-05 compat: public mode, clean pubkey, action=upload → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: public mode, blacklisted pubkey, action=upload → denied, reason contains 'blacklisted'", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [], blacklist: [PUB_BLACKLISTED] });
  const result = await checkAccess(storage, PUB_BLACKLISTED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
  }
});

Deno.test("ACL-05 compat: public mode, whitelisted pubkey, action=upload → allowed (whitelist is no-op in plain public)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [PUB_WHITELISTED], blacklist: [] });
  const result = await checkAccess(storage, PUB_WHITELISTED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: public mode, pubkey on both lists, action=upload → denied (blacklist wins)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [PUB_BOTH], blacklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
  }
});

// ---------------------------------------------------------------------------
// Private mode tests — ACL-05 backward compat (updated signature)
// ---------------------------------------------------------------------------

Deno.test("ACL-05 compat: private mode, whitelisted pubkey, action=upload → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [PUB_WHITELISTED], blacklist: [] });
  const result = await checkAccess(storage, PUB_WHITELISTED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05 compat: private mode, clean pubkey, action=upload → denied, user-facing reason", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.length > 0, true);
  }
});

Deno.test("ACL-05 compat: private mode, blacklisted-only pubkey, action=upload → denied", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [], blacklist: [PUB_BLACKLISTED] });
  const result = await checkAccess(storage, PUB_BLACKLISTED, "upload");
  assertEquals(result.allowed, false);
});

// ---------------------------------------------------------------------------
// Public+payments mode tests (NEW — ACL-01, ACL-02, ACL-03, ACL-04)
// ---------------------------------------------------------------------------

Deno.test("ACL-01: public+payments, config has payments:true → mode is active (config normalizes correctly)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, true);
});

Deno.test("ACL-02: public+payments, whitelisted pubkey, action=upload → allowed:true (no payment required)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [PUB_WHITELISTED], blacklist: [] });
  const result = await checkAccess(storage, PUB_WHITELISTED, "upload");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-03: public+payments, blacklisted pubkey, action=upload → denied with reason 'blacklisted' (NOT requiresPayment)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [PUB_BLACKLISTED] });
  const result = await checkAccess(storage, PUB_BLACKLISTED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
    // Must NOT have requiresPayment set — blacklist is a hard deny, not a payment gate
    assertEquals((result as { requiresPayment?: unknown }).requiresPayment, undefined);
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=upload → denied with requiresPayment:true, reason='payment_required'", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.requiresPayment, true);
    assertEquals(result.reason, "payment_required");
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=mirror → denied with requiresPayment:true (mirror also gated)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "mirror");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.requiresPayment, true);
    assertEquals(result.reason, "payment_required");
  }
});

Deno.test("ACL-04: public+payments, unlisted pubkey, action=delete → allowed:true (delete always free)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_UNLISTED, "delete");
  assertEquals(result.allowed, true);
});

Deno.test("ACL-03 edge: public+payments, pubkey on both lists, action=upload → denied 'blacklisted' (blacklist wins over whitelist)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [PUB_BOTH], blacklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH, "upload");
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
    assertEquals((result as { requiresPayment?: unknown }).requiresPayment, undefined);
  }
});

// ---------------------------------------------------------------------------
// Normalizer tests (NEW — payments field edge cases)
// ---------------------------------------------------------------------------

Deno.test("Normalizer: payments field missing → defaults to false (no console.warn)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [], blacklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});

Deno.test("Normalizer: payments=true, public=true → payments:true retained", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: true, whitelist: [], blacklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, true);
});

Deno.test("Normalizer: payments=true, public=false → payments forced to false (console.warn fires)", async () => {
  _resetAccessCacheForTesting();
  const warnMessages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnMessages.push(args.join(" ")); };
  try {
    const storage = makeStorage({ public: false, payments: true, whitelist: [], blacklist: [] });
    const cache = await loadAccessConfig(storage);
    assertEquals(cache.config.payments, false);
    assertEquals(warnMessages.some((m) => m.includes("payments")), true);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("Normalizer: payments='string' → defaults to false", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: "yes", whitelist: [], blacklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});

Deno.test("Normalizer: payments=null → defaults to false", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, payments: null, whitelist: [], blacklist: [] });
  const cache = await loadAccessConfig(storage);
  assertEquals(cache.config.payments, false);
});
