/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import {
  validateTokenStructure,
  isProofSpent,
  addToSpentCache,
  _resetSpentCacheForTesting,
  buildPaymentError,
} from "./proof-validator.ts";

// ---------------------------------------------------------------------------
// validateTokenStructure — pure function tests (no network)
// ---------------------------------------------------------------------------

Deno.test("validateTokenStructure: rejects untrusted mint", () => {
  const decoded = {
    mint: "https://mint.b.com",
    unit: "sat",
    proofs: [{ amount: 10, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: false, reason: "untrusted_mint" });
});

Deno.test("validateTokenStructure: rejects wrong unit", () => {
  const decoded = {
    mint: "https://mint.a.com",
    unit: "usd",
    proofs: [{ amount: 10, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: false, reason: "wrong_unit" });
});

Deno.test("validateTokenStructure: rejects insufficient amount", () => {
  const decoded = {
    mint: "https://mint.a.com",
    unit: "sat",
    proofs: [{ amount: 5, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: false, reason: "insufficient_amount" });
});

Deno.test("validateTokenStructure: accepts valid structure", () => {
  const decoded = {
    mint: "https://mint.a.com",
    unit: "sat",
    proofs: [{ amount: 10, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: true });
});

Deno.test("validateTokenStructure: accepts overpayment as tip", () => {
  const decoded = {
    mint: "https://mint.a.com",
    unit: "sat",
    proofs: [{ amount: 20, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: true });
});

// ---------------------------------------------------------------------------
// Spent-proof cache tests
// ---------------------------------------------------------------------------

Deno.test("isProofSpent: returns false for unknown secret", () => {
  _resetSpentCacheForTesting();
  assertEquals(isProofSpent(["unknownsecret"]), false);
});

Deno.test("isProofSpent: returns true after addToSpentCache", () => {
  _resetSpentCacheForTesting();
  addToSpentCache(["secret1", "secret2"]);
  assertEquals(isProofSpent(["secret1"]), true);
  assertEquals(isProofSpent(["secret2"]), true);
  assertEquals(isProofSpent(["secret3"]), false);
});

Deno.test("_resetSpentCacheForTesting: reset clears cache", () => {
  addToSpentCache(["secret_to_clear"]);
  _resetSpentCacheForTesting();
  assertEquals(isProofSpent(["secret_to_clear"]), false);
});

// ---------------------------------------------------------------------------
// buildPaymentError tests
// ---------------------------------------------------------------------------

Deno.test("buildPaymentError: returns 400 with X-Reason for untrusted_mint", () => {
  const response = buildPaymentError({ valid: false, reason: "untrusted_mint" });
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("X-Reason"), "untrusted_mint");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("buildPaymentError: returns 503 with Retry-After for mint_unreachable", () => {
  const response = buildPaymentError({
    valid: false,
    reason: "mint_unreachable",
    status: 503,
  });
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("X-Reason"), "mint_unreachable");
  assertEquals(response.headers.get("Retry-After"), "30");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});
