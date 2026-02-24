/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { checkAccess, _resetAccessCacheForTesting } from "./access.ts";
import type { StorageClient } from "../storage/client.ts";

// ---------------------------------------------------------------------------
// Minimal mock StorageClient — returns a pre-configured getJson result
// ---------------------------------------------------------------------------

function makeStorage(configJson: unknown): StorageClient {
  return {
    getJson: async (_path: string) => {
      // Simulate returning the access config
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

// ---------------------------------------------------------------------------
// Public mode tests (ACL-01, ACL-02, ACL-03)
// ---------------------------------------------------------------------------

Deno.test("ACL-01: public mode, clean pubkey → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN);
  assertEquals(result.allowed, true);
});

Deno.test("ACL-02: public mode, blacklisted pubkey → denied, reason contains 'blacklisted'", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [], blacklist: [PUB_BLACKLISTED] });
  const result = await checkAccess(storage, PUB_BLACKLISTED);
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
  }
});

Deno.test("ACL-03: public mode, whitelisted pubkey → allowed (whitelist has no effect)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [PUB_WHITELISTED], blacklist: [] });
  const result = await checkAccess(storage, PUB_WHITELISTED);
  assertEquals(result.allowed, true);
});

Deno.test("ACL-02 edge: public mode, pubkey on BOTH lists → denied (blacklist wins)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: true, whitelist: [PUB_BOTH], blacklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH);
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.includes("blacklisted"), true);
  }
});

// ---------------------------------------------------------------------------
// Private mode tests (ACL-04, ACL-05, ACL-06)
// ---------------------------------------------------------------------------

Deno.test("ACL-04: private mode, whitelisted pubkey → allowed", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [PUB_WHITELISTED], blacklist: [] });
  const result = await checkAccess(storage, PUB_WHITELISTED);
  assertEquals(result.allowed, true);
});

Deno.test("ACL-05: private mode, clean pubkey → denied, reason is user-facing", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [], blacklist: [] });
  const result = await checkAccess(storage, PUB_CLEAN);
  assertEquals(result.allowed, false);
  if (!result.allowed) {
    assertEquals(result.reason.length > 0, true);
  }
});

Deno.test("ACL-06: private mode, blacklisted-only pubkey → denied (blacklist irrelevant, not whitelisted)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [], blacklist: [PUB_BLACKLISTED] });
  const result = await checkAccess(storage, PUB_BLACKLISTED);
  assertEquals(result.allowed, false);
});

Deno.test("ACL-04 edge: private mode, pubkey on BOTH lists → allowed (whitelist wins)", async () => {
  _resetAccessCacheForTesting();
  const storage = makeStorage({ public: false, whitelist: [PUB_BOTH], blacklist: [PUB_BOTH] });
  const result = await checkAccess(storage, PUB_BOTH);
  assertEquals(result.allowed, true);
});
