import type { Config } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { isBlocked } from "../storage/metadata.ts";
import { errorResponse, isValidSha256 } from "../util.ts";
import { checkAccess } from "../middleware/access.ts";
import { loadPaymentConfig, paymentsEnabled } from "../middleware/payment-config.ts";
import { loadPricingConfig, readBtcUsdPrice } from "../middleware/price-feed.ts";
import { buildPaymentRequired } from "../middleware/payments.ts";

/**
 * BUD-06: HEAD /upload — Upload pre-flight check
 *
 * Checks request headers:
 * - X-SHA-256: blob hash
 * - X-Content-Length: blob size in bytes
 * - X-Content-Type: blob MIME type
 * - Authorization: optional Nostr auth event
 *
 * Returns 200 if upload would be accepted, or appropriate error with X-Reason header.
 */
export async function handleUploadCheck(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  // Validate auth if present
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const auth = await validateAuth(request, {
      verb: "upload",
      serverUrl: config.serverUrl,
    });
    if (!auth.authorized) {
      return new Response(null, {
        status: 403,
        headers: { "X-Reason": auth.error || "Invalid authorization" },
      });
    }

    // Access control — GATE-04/GATE-05: check after auth succeeds
    // HEAD responses have no body — use X-Reason header (consistent with handler pattern)
    if (auth.pubkey) {
      const access = await checkAccess(storage, auth.pubkey, "upload");
      if (!access.allowed) {
        if (access.requiresPayment) {
          // HEAD preflights: always return 402, never validate X-Cashu
          // Even if client sends X-Cashu, ignore it — HEAD never consumes proofs
          const { config: payConfig } = await loadPaymentConfig(storage);
          if (paymentsEnabled(payConfig)) {
            const { pricing } = await loadPricingConfig("config/payment.toml");
            const btcUsd = await readBtcUsdPrice("/tmp/btc-price.json");
            if (btcUsd !== null) {
              // Use X-Content-Length for file size (BUD-06 convention for HEAD preflight)
              const sizeStr = request.headers.get("X-Content-Length");
              const effectiveSize = sizeStr ? parseInt(sizeStr, 10) : 0;
              const finalSize = isNaN(effectiveSize) ? 0 : effectiveSize;
              // 0 bytes → computeSatPrice returns 1 sat (floor), minimum discoverable price
              const priceResp = buildPaymentRequired(finalSize, payConfig.mints.map(m => m.url), btcUsd, pricing);
              // HEAD response: copy headers, null body (HTTP HEAD spec)
              return new Response(null, {
                status: 402,
                headers: priceResp.headers,
              });
            }
          }
          // Payments disabled or price unavailable: fall through (fail open)
        } else {
          return new Response(null, {
            status: 403,
            headers: { "X-Reason": access.reason },
          });
        }
      }
    }
  }

  // Check X-Content-Length
  const contentLengthStr = request.headers.get("X-Content-Length");
  if (contentLengthStr) {
    const size = parseInt(contentLengthStr, 10);
    if (isNaN(size)) {
      return new Response(null, {
        status: 400,
        headers: { "X-Reason": "Invalid X-Content-Length header" },
      });
    }
    if (size > config.maxUploadSize) {
      return new Response(null, {
        status: 413,
        headers: {
          "X-Reason": `File too large. Maximum size is ${config.maxUploadSize} bytes`,
          "X-Max-Upload-Size": config.maxUploadSize.toString(),
        },
      });
    }
  }

  // Check X-SHA-256
  const sha256 = request.headers.get("X-SHA-256");
  if (sha256) {
    if (!isValidSha256(sha256)) {
      return new Response(null, {
        status: 400,
        headers: { "X-Reason": "Invalid X-SHA-256 header" },
      });
    }
    if (await isBlocked(storage, sha256)) {
      return new Response(null, {
        status: 403,
        headers: { "X-Reason": "This content has been blocked" },
      });
    }
  }

  return new Response(null, {
    status: 200,
    headers: {
      "X-Max-Upload-Size": config.maxUploadSize.toString(),
    },
  });
}
