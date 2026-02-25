/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any
// @ts-ignore — cashu-ts d.ts has rollup-wrapped exports; runtime exports are correct
import { getDecodedToken, Wallet, Mint } from "@cashu/cashu-ts";
import type { ValidationResult } from "../types.ts";

// Type aliases using 'any' since cashu-ts d.ts wraps exports in a declare block
// that TypeScript doesn't resolve via named imports. Runtime behaviour is correct.
type CashuWallet = InstanceType<typeof Wallet>;
type CashuMintInstance = InstanceType<typeof Mint>;

// Module-level wallet cache — one Wallet per mint URL (avoid loadMint per request)
const walletCache = new Map<string, CashuWallet>();

// Module-level spent-proof cache — fast-reject optimization (best-effort, not authoritative)
// The mint's NUT-03 swap endpoint is the authoritative double-spend check.
// Capped to prevent unbounded memory growth; evicts oldest entries when full.
const SPENT_CACHE_MAX = 100_000;
const spentSecrets = new Map<string, true>();

/** Reset spent-proof cache and wallet cache — test isolation only */
export function _resetSpentCacheForTesting(): void {
  spentSecrets.clear();
  walletCache.clear();
}

/** Check if any proof secret is in the local spent cache */
export function isProofSpent(secrets: string[]): boolean {
  return secrets.some((s) => spentSecrets.has(s));
}

/** Record proof secrets as spent in local cache, evicting oldest if at capacity */
export function addToSpentCache(secrets: string[]): void {
  for (const s of secrets) {
    if (spentSecrets.has(s)) continue;
    if (spentSecrets.size >= SPENT_CACHE_MAX) {
      // Map iterates in insertion order — first key is the oldest
      const oldest = spentSecrets.keys().next().value;
      if (oldest !== undefined) spentSecrets.delete(oldest);
    }
    spentSecrets.set(s, true);
  }
}

/**
 * Validate decoded token structure (pure function, no network).
 * Checks: mint trust, unit, amount sufficiency.
 */
export function validateTokenStructure(
  decoded: { mint: string; unit?: string; proofs: Array<{ amount: number; secret: string }> },
  acceptedMintUrls: string[],
  requiredAmountSats: number,
): ValidationResult {
  // Step 1: Mint trust
  if (!acceptedMintUrls.includes(decoded.mint)) {
    return { valid: false, reason: "untrusted_mint" };
  }

  // Step 2: Unit check
  if (decoded.unit && decoded.unit !== "sat") {
    return { valid: false, reason: "wrong_unit" };
  }

  // Step 3: Amount sufficiency (overpayment accepted as tip)
  const totalSats = decoded.proofs.reduce((sum, p) => sum + p.amount, 0);
  if (totalSats < requiredAmountSats) {
    return { valid: false, reason: "insufficient_amount" };
  }

  return { valid: true };
}

/**
 * Get or create a cached CashuWallet for a mint URL.
 * CashuWallet.loadMint() is called once per mint (lazy init).
 */
async function getOrCreateWallet(mintUrl: string): Promise<CashuWallet> {
  let wallet = walletCache.get(mintUrl);
  if (!wallet) {
    const mint = new Mint(mintUrl) as unknown as CashuMintInstance;
    wallet = new Wallet(mint) as unknown as CashuWallet;
    await wallet.loadMint(); // one-time network call per mint
    walletCache.set(mintUrl, wallet);
  }
  return wallet;
}

/**
 * Validate and consume a Cashu payment token.
 *
 * Full validation flow:
 * 1. Decode cashuB/cashuA token (getDecodedToken handles both formats)
 * 2. Check mint is trusted (in acceptedMintUrls)
 * 3. Check unit is "sat"
 * 4. Check amount >= required
 * 5. Fast-reject via local spent-proof cache
 * 6. Call CashuWallet.receive() which internally calls NUT-03 /v1/swap (authoritative double-spend check)
 * 7. Record secrets in spent cache
 *
 * Returns ValidationResult. On success, proofs are CONSUMED (cannot be reused).
 */
export async function validateCashuPayment(
  tokenHeader: string,
  acceptedMintUrls: string[],
  requiredAmountSats: number,
): Promise<ValidationResult> {
  // Step 1: Decode token
  // deno-lint-ignore no-explicit-any
  let decoded: any;
  try {
    decoded = getDecodedToken(tokenHeader);
  } catch {
    return { valid: false, reason: "invalid_token_encoding" };
  }

  // Steps 2-4: Structure validation (pure)
  const structureResult = validateTokenStructure(decoded, acceptedMintUrls, requiredAmountSats);
  if (!structureResult.valid) return structureResult;

  // Step 5: Fast-reject via local spent cache
  // deno-lint-ignore no-explicit-any
  const secrets = decoded.proofs.map((p: any) => p.secret as string);
  if (isProofSpent(secrets)) {
    return { valid: false, reason: "proof_already_spent" };
  }

  // Step 6: Consume via CashuWallet.receive() → NUT-03 swap
  try {
    const wallet = await getOrCreateWallet(decoded.mint);
    // wallet.receive() calls /v1/swap internally, consuming the proofs
    // Returns new proofs — we discard them (overpayment accepted as tip)
    await wallet.receive(tokenHeader);
  } catch (err: unknown) {
    // Distinguish mint-unreachable from invalid proof
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("fetch") ||
      msg.includes("network") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("timeout")
    ) {
      // Mint unreachable: 503 + Retry-After (never accept unverified proofs)
      return { valid: false, reason: "mint_unreachable", status: 503 };
    }
    return { valid: false, reason: "proof_invalid_or_spent" };
  }

  // Step 7: Record in local spent cache
  addToSpentCache(secrets);

  return { valid: true };
}

/**
 * Build an error Response for failed payment validation.
 * Uses X-Reason header per BUD-07/existing project pattern.
 * Always includes Cache-Control: no-store.
 */
export function buildPaymentError(result: ValidationResult): Response {
  const status = result.status ?? 400;
  const headers: Record<string, string> = {
    "X-Reason": result.reason ?? "payment_error",
    "Cache-Control": "no-store",
  };

  // 503: mint unreachable — add Retry-After
  if (status === 503) {
    headers["Retry-After"] = "30";
  }

  return new Response(null, { status, headers });
}
