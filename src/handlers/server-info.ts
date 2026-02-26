import type { ServerInfo } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { loadAccessConfig } from "../middleware/access.ts";
import { loadPaymentConfig, paymentsEnabled } from "../middleware/payment-config.ts";
import { loadPricingConfig } from "../middleware/price-feed.ts";
import { jsonResponse } from "../util.ts";

/**
 * GET /server-info — public endpoint returning server configuration.
 * Aggregates access + payment config into a safe response.
 * Never exposes: blocklist, admin keys, storage credentials.
 */
export async function handleServerInfo(
  storage: StorageClient,
): Promise<Response> {
  const accessCache = await loadAccessConfig(storage);
  const accessConfig = accessCache.config;

  const info: ServerInfo = {
    public: accessConfig.public,
    paymentsEnabled: false,
  };

  // Private mode: include allowlist, no payment info
  if (!accessConfig.public) {
    info.allowlist = accessConfig.allowlist;
    return serverInfoResponse(info);
  }

  // Public mode: check if payments are enabled
  if (accessConfig.payments) {
    const paymentCache = await loadPaymentConfig(storage);
    const paymentConfig = paymentCache.config;

    if (paymentsEnabled(paymentConfig)) {
      info.paymentsEnabled = true;

      const fixedAmounts = paymentConfig.amounts.upload > 0 ||
        paymentConfig.amounts.mirror > 0;

      info.payment = {
        amounts: paymentConfig.amounts,
        fixedAmounts,
        mints: paymentConfig.mints.map((m) => m.url),
      };

      // Include dynamic pricing params when no fixed amounts are set
      if (!fixedAmounts) {
        const pricingResult = await loadPricingConfig("config/payment.toml");
        info.payment.pricing = pricingResult.pricing;
      }
    }
  }

  return serverInfoResponse(info);
}

function serverInfoResponse(info: ServerInfo): Response {
  return jsonResponse(info, 200, {
    "Cache-Control": "public, max-age=60",
  });
}
