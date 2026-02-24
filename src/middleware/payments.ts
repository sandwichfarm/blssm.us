import { PaymentRequest } from "@cashu/cashu-ts";
import { computeSatPrice } from "./price-feed.ts";
import type { PricingConfig } from "../types.ts";

/**
 * BUD-07: Build a 402 Payment Required response with NUT-18 encoded X-Cashu header.
 *
 * Headers only, no JSON body (strict BUD-07 compliance per user decision).
 * X-Lightning is omitted until Lightning verification is wired (user decision).
 * Fresh quote generated per request — stateless, no caching of quotes.
 */
export function buildPaymentRequired(
  fileSizeBytes: number,
  acceptedMintUrls: string[],
  btcUsdPrice: number,
  pricingConfig: PricingConfig,
): Response {
  const satAmount = computeSatPrice(fileSizeBytes, btcUsdPrice, pricingConfig);

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

  const encoded = paymentRequest.toEncodedRequest(); // "creqA..." prefix

  return new Response(null, {
    status: 402,
    headers: {
      "X-Cashu": encoded,
      "Cache-Control": "no-store",
    },
  });
}
