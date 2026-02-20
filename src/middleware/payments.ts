import type { Config, PaymentInfo } from "../types.ts";

/**
 * BUD-07: Payment gate middleware
 *
 * Returns a 402 Payment Required response with payment info headers.
 * This is a framework — actual payment verification logic (Lightning preimage,
 * Cashu token validation) would need to be customized per deployment.
 */
export function paymentRequired(info: PaymentInfo): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (info.lnurl) {
    headers["X-Lightning"] = info.lnurl;
  }

  headers["X-Payment-Amount"] = info.amount.toString();
  headers["X-Payment-Unit"] = info.unit;

  return new Response(
    JSON.stringify({
      message: "Payment required",
      amount: info.amount,
      unit: info.unit,
      lnurl: info.lnurl,
    }),
    {
      status: 402,
      headers,
    },
  );
}

/**
 * Verify a Lightning payment preimage.
 * The preimage's SHA-256 should match the payment hash.
 *
 * This is a placeholder — real implementation would verify
 * against a Lightning node or payment provider API.
 */
export async function verifyLightningPayment(
  preimage: string,
): Promise<boolean> {
  // TODO: Implement actual Lightning preimage verification
  // 1. Hash the preimage with SHA-256
  // 2. Check the hash against known payment hashes from your LN node
  return false;
}
