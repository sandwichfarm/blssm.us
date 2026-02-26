/// <reference lib="deno.ns" />
import { assertEquals, assertExists } from "jsr:@std/assert";
import { PaymentRequest } from "@cashu/cashu-ts";
import { buildPaymentRequired } from "./payments.ts";
import type { PricingConfig } from "../types.ts";

const TEST_PRICING: PricingConfig = {
  cost_per_gb_usd: 0.02,
  profit_margin_pct: 0.20,
  slippage_premium_pct: 0.05,
};

const BTC_USD_PRICE = 100_000;
const FILE_SIZE_1GB = 1024 * 1024 * 1024;
const ACCEPTED_MINTS = ["https://mint.example.com"];

Deno.test("returns 402 status", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  assertEquals(response.status, 402);
});

Deno.test("includes X-Cashu header starting with creqA", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  const xCashu = response.headers.get("X-Cashu");
  assertExists(xCashu);
  assertEquals(xCashu.startsWith("creqA"), true);
});

Deno.test("includes Cache-Control: no-store", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("does NOT include X-Lightning header when no bolt11 provided", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  assertEquals(response.headers.get("X-Lightning"), null);
});

Deno.test("includes X-Lightning header when bolt11 provided", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
    "lnbc100n1...",
  );
  assertEquals(response.headers.get("X-Lightning"), "lnbc100n1...");
});

Deno.test("omits X-Lightning when bolt11 is undefined", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
    undefined,
  );
  assertEquals(response.headers.get("X-Lightning"), null);
});

Deno.test("has null body", async () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  assertEquals(await response.text(), "");
});

Deno.test("does NOT include Content-Type header", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  assertEquals(response.headers.get("Content-Type"), null);
});

Deno.test("omits X-Cashu when no mints provided (lightning-only 402)", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    [],  // no mints
    BTC_USD_PRICE,
    TEST_PRICING,
    "lnbc100n1...",
  );
  assertEquals(response.status, 402);
  assertEquals(response.headers.get("X-Cashu"), null);
  assertEquals(response.headers.get("X-Lightning"), "lnbc100n1...");
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("lightning-only 402 still has Cache-Control", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    [],  // no mints
    BTC_USD_PRICE,
    TEST_PRICING,
    "lnbc200n1...",
  );
  assertEquals(response.headers.get("Cache-Control"), "no-store");
});

Deno.test("X-Cashu header is decodable with correct amount, unit, mints", () => {
  const response = buildPaymentRequired(
    FILE_SIZE_1GB,
    ACCEPTED_MINTS,
    BTC_USD_PRICE,
    TEST_PRICING,
  );
  const xCashu = response.headers.get("X-Cashu");
  assertExists(xCashu);

  const decoded = PaymentRequest.fromEncodedRequest(xCashu);
  assertExists(decoded.amount);
  assertEquals(decoded.amount > 0, true);
  assertEquals(decoded.unit, "sat");
  assertExists(decoded.mints);
  assertEquals(decoded.mints.includes("https://mint.example.com"), true);
});
