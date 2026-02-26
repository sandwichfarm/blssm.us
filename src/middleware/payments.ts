import { PaymentRequest } from "@cashu/cashu-ts";
import { computeSatPrice } from "./price-feed.ts";
import type { PricingConfig } from "../types.ts";

/**
 * BUD-07: Build a 402 Payment Required response with NUT-18 encoded X-Cashu header.
 *
 * Headers only, no JSON body (strict BUD-07 compliance per user decision).
 * X-Lightning header included when a bolt11 invoice is provided.
 * Fresh quote generated per request — stateless, no caching of quotes.
 */
export function buildPaymentRequired(
  fileSizeBytes: number,
  acceptedMintUrls: string[],
  btcUsdPrice: number,
  pricingConfig: PricingConfig,
  bolt11?: string,
): Response {
  const satAmount = computeSatPrice(fileSizeBytes, btcUsdPrice, pricingConfig);

  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };

  // Only include X-Cashu when mints are configured (skip in lightning-only mode)
  if (acceptedMintUrls.length > 0) {
    // NUT-18 PaymentRequest encoding (verified constructor param order from cashu-ts source):
    // new PaymentRequest(transport?, id?, amount?, unit?, mints?, description?, singleUse?, nut10?)
    const paymentRequest = new PaymentRequest(
      [],               // transport: empty = in-band via X-Cashu header (NUT-24 pattern)
      undefined,        // id: no payment id needed
      satAmount,        // amount in sats
      "sat",            // unit
      acceptedMintUrls, // mints: string[] of accepted mint URLs
      undefined,        // description
      true,             // singleUse: true (fresh quote per request, per user decision)
    );
    headers["X-Cashu"] = paymentRequest.toEncodedRequest(); // "creqA..." prefix
  }

  if (bolt11) {
    headers["X-Lightning"] = bolt11;
  }

  return new Response(null, { status: 402, headers });
}
