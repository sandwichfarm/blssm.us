/// <reference lib="deno.ns" />
import process from "node:process";
import { timingSafeEqual } from "node:crypto";
import { fetchBtcUsdPrice, setPriceCache } from "../middleware/price-feed.ts";

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
  const adminKey = process.env["ADMIN_KEY"];
  if (!adminKey) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const provided = request.headers.get("X-Admin-Key") ?? "";
  if (!constantTimeEqual(adminKey, provided)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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

/** Constant-time string comparison to prevent timing attacks on the admin key. */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
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
