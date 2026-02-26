/// <reference lib="deno.ns" />
import process from "node:process";
import { fetchBtcUsdPrice, setPriceCache } from "../middleware/price-feed.ts";
import { validateAdminKey } from "../middleware/admin-auth.ts";

/**
 * POST /admin/refresh-price
 *
 * Secret-key-gated endpoint that an external cron hits every 5 min.
 * Fetches BTC price, updates the in-memory cache + process.env, and
 * fire-and-forget upserts the env var via Bunny API so cold-start
 * isolates get a fresh price.
 */
export async function handleAdminRefreshPrice(
  request: Request,
): Promise<Response> {
  // --- Auth ---
  const authError = validateAdminKey(request);
  if (authError) return authError;

  // --- Fetch price ---
  const price = await fetchBtcUsdPrice();
  if (price === null) {
    return new Response(JSON.stringify({ error: "price fetch failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Update current isolate
  process.env["BTC_USD_PRICE"] = String(price);
  setPriceCache(price);

  // Fire-and-forget: upsert env var via Bunny API for cold-start isolates
  const bunnyApiKey = process.env["BUNNY_API_KEY"];
  const scriptId = process.env["BUNNY_SCRIPT_ID"];
  if (bunnyApiKey && scriptId) {
    upsertBunnyEnvVar(bunnyApiKey, scriptId, "BTC_USD_PRICE", String(price))
      .catch((err) =>
        console.warn("[admin-refresh-price] Bunny API upsert failed:", err)
      );
  }

  return new Response(
    JSON.stringify({ btc_usd: price, updated: new Date().toISOString() }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Upsert a Bunny EdgeScript environment variable. */
async function upsertBunnyEnvVar(
  apiKey: string,
  scriptId: string,
  name: string,
  value: string,
): Promise<void> {
  const res = await fetch(
    `https://api.bunny.net/compute/script/${scriptId}/variables`,
    {
      method: "PUT",
      headers: {
        "AccessKey": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Name: name,
        DefaultValue: value,
        Required: false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Bunny API ${res.status}: ${await res.text()}`);
  }
}
