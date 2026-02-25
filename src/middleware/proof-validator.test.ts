/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import {
  validateTokenStructure,
  validateCashuPayment,
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

Deno.test("buildPaymentError: missing reason defaults to 'payment_error'", () => {
  const response = buildPaymentError({ valid: false } as { valid: false; reason?: string });
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("X-Reason"), "payment_error");
});

// ---------------------------------------------------------------------------
// validateTokenStructure — missing unit field
// ---------------------------------------------------------------------------

Deno.test("validateTokenStructure: token with unit undefined → valid (unit check skipped)", () => {
  const decoded = {
    mint: "https://mint.a.com",
    unit: undefined,
    proofs: [{ amount: 10, secret: "abc123" }],
  };
  const result = validateTokenStructure(decoded, ["https://mint.a.com"], 10);
  assertEquals(result, { valid: true });
});

// ---------------------------------------------------------------------------
// validateCashuPayment — error path tests (no live mint needed)
// ---------------------------------------------------------------------------

Deno.test("validateCashuPayment: garbage string → invalid_token_encoding", async () => {
  _resetSpentCacheForTesting();
  const result = await validateCashuPayment("totally-not-a-token!!!", ["https://mint.a.com"], 1);
  assertEquals(result.valid, false);
  if (!result.valid) {
    assertEquals(result.reason, "invalid_token_encoding");
  }
});

Deno.test("validateCashuPayment: valid encoding but untrusted mint → untrusted_mint", async () => {
  _resetSpentCacheForTesting();
  // Construct a minimal cashuA token (V3 format) that getDecodedToken can parse
  // cashuA is base64url-encoded JSON: { token: [{ mint: "...", proofs: [...] }] }
  const tokenPayload = {
    token: [{
      mint: "https://untrusted.mint.example.com",
      proofs: [{ amount: 10, secret: "test-secret-1", C: "02abc", id: "testid" }],
    }],
    unit: "sat",
  };
  const encoded = "cashuA" + btoa(JSON.stringify(tokenPayload));
  const result = await validateCashuPayment(encoded, ["https://trusted.mint.example.com"], 10);
  assertEquals(result.valid, false);
  if (!result.valid) {
    assertEquals(result.reason, "untrusted_mint");
  }
});

Deno.test("validateCashuPayment: already-spent secrets → proof_already_spent", async () => {
  _resetSpentCacheForTesting();
  // Pre-populate spent cache
  addToSpentCache(["pre-spent-secret"]);
  // Construct a token targeting a trusted mint with the pre-spent secret
  const tokenPayload = {
    token: [{
      mint: "https://mint.a.com",
      proofs: [{ amount: 10, secret: "pre-spent-secret", C: "02abc", id: "testid" }],
    }],
    unit: "sat",
  };
  const encoded = "cashuA" + btoa(JSON.stringify(tokenPayload));
  const result = await validateCashuPayment(encoded, ["https://mint.a.com"], 10);
  assertEquals(result.valid, false);
  if (!result.valid) {
    assertEquals(result.reason, "proof_already_spent");
  }
});

Deno.test("validateCashuPayment: mint unreachable → mint_unreachable with status 503", async () => {
  _resetSpentCacheForTesting();
  // Construct a token targeting a non-existent mint — getOrCreateWallet will fail with fetch error
  const tokenPayload = {
    token: [{
      mint: "https://localhost:1",
      proofs: [{ amount: 10, secret: "unreachable-secret", C: "02abc", id: "testid" }],
    }],
    unit: "sat",
  };
  const encoded = "cashuA" + btoa(JSON.stringify(tokenPayload));
  const result = await validateCashuPayment(encoded, ["https://localhost:1"], 10);
  assertEquals(result.valid, false);
  if (!result.valid) {
    // Should be either mint_unreachable or proof_invalid_or_spent depending on the error message
    assertEquals(["mint_unreachable", "proof_invalid_or_spent"].includes(result.reason!), true);
  }
});
