/// <reference lib="deno.ns" />
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { LightningConfig, ValidationResult } from "../types.ts";

// Module-level used-payment-hash cache — fast-reject optimization (best-effort).
// LND lookup is the authoritative check. Capped like spentSecrets in proof-validator.ts.
const USED_CACHE_MAX = 100_000;
const usedPaymentHashes = new Map<string, true>();

/** Reset used-payment-hash cache — test isolation only */
export function _resetLightningCacheForTesting(): void {
  usedPaymentHashes.clear();
}

/**
 * Load Lightning config from environment variables.
 * Returns null if not configured (graceful degradation to Cashu-only).
 */
export function loadLightningConfig(): LightningConfig | null {
  const endpoint = Deno.env.get("LND_REST_URL");
  const macaroon = Deno.env.get("LND_INVOICE_MACAROON");
  if (!endpoint || !macaroon) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), macaroon };
}

/**
 * Create a bolt11 invoice via LND REST API.
 * Returns the bolt11 payment request string, or null on failure.
 */
export async function createInvoice(
  amountSats: number,
  config: LightningConfig,
): Promise<string | null> {
  try {
    const res = await fetch(`${config.endpoint}/v1/invoices`, {
      method: "POST",
      headers: {
        "Grpc-Metadata-macaroon": config.macaroon,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        value: String(amountSats),
        memo: "blssm",
        expiry: "600",
      }),
    });
    if (!res.ok) {
      console.warn(`[lightning] LND invoice creation failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.payment_request ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lightning] LND unreachable during invoice creation: ${msg}`);
    return null;
  }
}

/**
 * Validate a Lightning payment by preimage.
 *
 * Flow:
 * 1. Validate hex preimage format (64 hex chars = 32 bytes)
 * 2. Fast-reject via usedPaymentHashes cache
 * 3. Compute payment_hash = sha256(preimage_bytes)
 * 4. LND REST lookup by payment hash
 * 5. Verify state === "SETTLED" and amount >= required
 * 6. Record payment hash in used cache
 */
export async function validateLightningPayment(
  preimageHex: string,
  requiredSats: number,
  config: LightningConfig,
): Promise<ValidationResult> {
  // Step 1: Validate hex preimage format
  if (!/^[0-9a-f]{64}$/i.test(preimageHex)) {
    return { valid: false, reason: "invalid_preimage" };
  }

  // Step 2: Compute payment hash
  const preimageBytes = hexToBytes(preimageHex);
  const paymentHash = bytesToHex(sha256(preimageBytes));

  // Step 3: Fast-reject via cache
  if (usedPaymentHashes.has(paymentHash)) {
    return { valid: false, reason: "preimage_already_used" };
  }

  // Step 4: LND REST lookup by payment hash
  // LND expects base64url-encoded r_hash in the URL
  const hashBytes = hexToBytes(paymentHash);
  const rHashUrl = base64UrlEncode(hashBytes);

  let invoiceData: { state?: string; value?: string };
  try {
    const res = await fetch(
      `${config.endpoint}/v1/invoice/${rHashUrl}`,
      {
        headers: { "Grpc-Metadata-macaroon": config.macaroon },
      },
    );
    if (res.status === 404) {
      return { valid: false, reason: "invoice_not_found" };
    }
    if (!res.ok) {
      console.warn(`[lightning] LND lookup failed: ${res.status}`);
      return { valid: false, reason: "lnd_unreachable", status: 503 };
    }
    invoiceData = await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lightning] LND unreachable during lookup: ${msg}`);
    return { valid: false, reason: "lnd_unreachable", status: 503 };
  }

  // Step 5: Verify settled + amount
  if (invoiceData.state !== "SETTLED") {
    return { valid: false, reason: "invoice_not_settled" };
  }

  const paidSats = parseInt(invoiceData.value ?? "0", 10);
  if (paidSats < requiredSats) {
    return { valid: false, reason: "insufficient_amount" };
  }

  // Step 6: Record in used cache
  if (usedPaymentHashes.size >= USED_CACHE_MAX) {
    const oldest = usedPaymentHashes.keys().next().value;
    if (oldest !== undefined) usedPaymentHashes.delete(oldest);
  }
  usedPaymentHashes.set(paymentHash, true);

  return { valid: true };
}

/** Base64url-encode a Uint8Array (no padding) */
function base64UrlEncode(bytes: Uint8Array): string {
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
