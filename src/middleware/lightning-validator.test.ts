/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import {
  validateLightningPayment,
  createInvoice,
  loadLightningConfig,
  _resetLightningCacheForTesting,
} from "./lightning-validator.ts";
import type { LightningConfig } from "../types.ts";

const TEST_CONFIG: LightningConfig = {
  endpoint: "https://lnd.example.com",
  macaroon: "deadbeef",
};

// A valid 32-byte hex preimage (64 hex chars)
const VALID_PREIMAGE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// loadLightningConfig
// ---------------------------------------------------------------------------

Deno.test("loadLightningConfig: returns null when env vars not set", () => {
  const original = {
    url: Deno.env.get("LND_REST_URL"),
    mac: Deno.env.get("LND_INVOICE_MACAROON"),
  };
  Deno.env.delete("LND_REST_URL");
  Deno.env.delete("LND_INVOICE_MACAROON");

  const config = loadLightningConfig();
  assertEquals(config, null);

  // Restore
  if (original.url) Deno.env.set("LND_REST_URL", original.url);
  if (original.mac) Deno.env.set("LND_INVOICE_MACAROON", original.mac);
});

Deno.test("loadLightningConfig: returns config when both env vars set", () => {
  Deno.env.set("LND_REST_URL", "https://lnd.test.com/");
  Deno.env.set("LND_INVOICE_MACAROON", "abc123");

  const config = loadLightningConfig();
  assertEquals(config?.endpoint, "https://lnd.test.com"); // trailing slash stripped
  assertEquals(config?.macaroon, "abc123");

  Deno.env.delete("LND_REST_URL");
  Deno.env.delete("LND_INVOICE_MACAROON");
});

// ---------------------------------------------------------------------------
// validateLightningPayment
// ---------------------------------------------------------------------------

Deno.test("validateLightningPayment: rejects invalid preimage format (too short)", async () => {
  _resetLightningCacheForTesting();
  const result = await validateLightningPayment("abc", 100, TEST_CONFIG);
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "invalid_preimage");
});

Deno.test("validateLightningPayment: rejects invalid preimage format (non-hex)", async () => {
  _resetLightningCacheForTesting();
  const result = await validateLightningPayment(
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    100,
    TEST_CONFIG,
  );
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "invalid_preimage");
});

Deno.test("validateLightningPayment: returns invoice_not_found on 404", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request) => {
    return new Response(null, { status: 404 });
  };

  try {
    const result = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(result.valid, false);
    if (!result.valid) assertEquals(result.reason, "invoice_not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateLightningPayment: returns lnd_unreachable on network error", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  try {
    const result = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(result.valid, false);
    if (!result.valid) {
      assertEquals(result.reason, "lnd_unreachable");
      assertEquals(result.status, 503);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateLightningPayment: returns invoice_not_settled when state != SETTLED", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ state: "OPEN", value: "100" }), { status: 200 });
  };

  try {
    const result = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(result.valid, false);
    if (!result.valid) assertEquals(result.reason, "invoice_not_settled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateLightningPayment: returns insufficient_amount when paid < required", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ state: "SETTLED", value: "50" }), { status: 200 });
  };

  try {
    const result = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(result.valid, false);
    if (!result.valid) assertEquals(result.reason, "insufficient_amount");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateLightningPayment: returns valid when settled + sufficient amount", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ state: "SETTLED", value: "100" }), { status: 200 });
  };

  try {
    const result = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(result.valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateLightningPayment: rejects reused preimage", async () => {
  _resetLightningCacheForTesting();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ state: "SETTLED", value: "100" }), { status: 200 });
  };

  try {
    // First use — should succeed
    const first = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(first.valid, true);

    // Second use — should reject
    const second = await validateLightningPayment(VALID_PREIMAGE, 100, TEST_CONFIG);
    assertEquals(second.valid, false);
    if (!second.valid) assertEquals(second.reason, "preimage_already_used");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// createInvoice
// ---------------------------------------------------------------------------

Deno.test("createInvoice: returns bolt11 on success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    assertEquals(urlStr, "https://lnd.example.com/v1/invoices");
    assertEquals(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assertEquals(headers["Grpc-Metadata-macaroon"], "deadbeef");
    return new Response(JSON.stringify({ payment_request: "lnbc100n1..." }), { status: 200 });
  };

  try {
    const bolt11 = await createInvoice(100, TEST_CONFIG);
    assertEquals(bolt11, "lnbc100n1...");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("createInvoice: returns null on LND error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(null, { status: 500 });
  };

  try {
    const bolt11 = await createInvoice(100, TEST_CONFIG);
    assertEquals(bolt11, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("createInvoice: returns null on network error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  try {
    const bolt11 = await createInvoice(100, TEST_CONFIG);
    assertEquals(bolt11, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
