/// <reference lib="deno.ns" />
// @ts-ignore — cashu-ts d.ts has rollup-wrapped exports; runtime exports are correct
import { Wallet, Mint } from "@cashu/cashu-ts";
import type { StorageClient } from "../storage/client.ts";
import type { LightningConfig } from "../types.ts";
import { validateAdminKey } from "../middleware/admin-auth.ts";
import { loadLightningConfig, createInvoice } from "../middleware/lightning-validator.ts";
import { getOrCreateWallet } from "../middleware/proof-validator.ts";

/** Shape of an inbox proof file */
interface InboxEntry {
  mint: string;
  proofs: Array<{ id: string; amount: number; secret: string; C: string }>;
  totalSats: number;
}

/** Per-mint sweep result */
interface SweepResult {
  mint: string;
  sats: number;
  fee: number;
  status: "success";
}

interface SweepSkipped {
  mint: string;
  totalSats: number;
  reason: string;
}

interface SweepError {
  mint: string;
  error: string;
}

/** Response shape */
interface SweepResponse {
  swept: SweepResult[];
  skipped: SweepSkipped[];
  errors: SweepError[];
}

/** Dependency injection for testing */
export interface SweepDeps {
  loadLnConfig?: () => LightningConfig | null;
  createLnInvoice?: (amountSats: number, config: LightningConfig) => Promise<string | null>;
  getThreshold?: () => number;
  /** Override wallet melt operations for testing */
  meltProofs?: (
    wallet: ReturnType<typeof getOrCreateWallet> extends Promise<infer T> ? T : never,
    bolt11: string,
    // deno-lint-ignore no-explicit-any
    proofs: any[],
  ) => Promise<{ paid: boolean; change?: Array<{ id: string; amount: number; secret: string; C: string }> }>;
}

/**
 * POST /admin/sweep
 *
 * Melts accumulated Cashu proofs from the inbox to the operator's LND node.
 * Only processes mints where accumulated value >= SWEEP_THRESHOLD_SATS.
 */
export async function handleAdminSweep(
  request: Request,
  storage: StorageClient,
  deps?: SweepDeps,
): Promise<Response> {
  // --- Auth ---
  const authError = validateAdminKey(request);
  if (authError) return authError;

  // --- Load LN config ---
  const getLnConfig = deps?.loadLnConfig ?? loadLightningConfig;
  const lnConfig = getLnConfig();
  if (!lnConfig) {
    return new Response(
      JSON.stringify({ error: "lightning not configured (LND_REST_URL / LND_INVOICE_MACAROON missing)" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // --- Config ---
  const threshold = deps?.getThreshold?.() ?? parseInt(Deno.env.get("SWEEP_THRESHOLD_SATS") ?? "1000", 10);
  const createLn = deps?.createLnInvoice ?? createInvoice;

  // --- Load inbox files ---
  const inboxFiles = await storage.list("wallet/inbox");
  if (inboxFiles.length === 0) {
    return new Response(
      JSON.stringify({ swept: [], skipped: [], errors: [] } satisfies SweepResponse),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // --- Aggregate proofs by mint ---
  const mintMap = new Map<string, { proofs: InboxEntry["proofs"]; totalSats: number; files: string[] }>();

  for (const file of inboxFiles) {
    const entry = await storage.getJson<InboxEntry>(file);
    if (!entry || !entry.mint || !entry.proofs) continue;

    const existing = mintMap.get(entry.mint);
    if (existing) {
      existing.proofs.push(...entry.proofs);
      existing.totalSats += entry.totalSats;
      existing.files.push(file);
    } else {
      mintMap.set(entry.mint, {
        proofs: [...entry.proofs],
        totalSats: entry.totalSats,
        files: [file],
      });
    }
  }

  // --- Sweep each mint ---
  const result: SweepResponse = { swept: [], skipped: [], errors: [] };

  for (const [mintUrl, data] of mintMap) {
    // Skip if below threshold
    if (data.totalSats < threshold) {
      result.skipped.push({ mint: mintUrl, totalSats: data.totalSats, reason: "below_threshold" });
      continue;
    }

    try {
      // Create self-pay invoice on our LND node
      const bolt11 = await createLn(data.totalSats, lnConfig);
      if (!bolt11) {
        result.errors.push({ mint: mintUrl, error: "invoice_creation_failed" });
        continue;
      }

      let meltResult: { paid: boolean; change?: Array<{ id: string; amount: number; secret: string; C: string }> };

      if (deps?.meltProofs) {
        // Test path — skip real wallet creation
        // deno-lint-ignore no-explicit-any
        meltResult = await deps.meltProofs(null as any, bolt11, data.proofs);
      } else {
        // Production path — get cashu wallet for this mint and melt
        const wallet = await getOrCreateWallet(mintUrl);
        // deno-lint-ignore no-explicit-any
        const quote = await (wallet as any).createMeltQuoteBolt11(bolt11);
        // deno-lint-ignore no-explicit-any
        meltResult = await (wallet as any).meltProofsBolt11(quote, data.proofs);
      }

      if (!meltResult.paid) {
        result.errors.push({ mint: mintUrl, error: "melt_failed: payment not settled" });
        continue;
      }

      // Delete consumed inbox files
      for (const file of data.files) {
        await storage.delete(file);
      }

      // Save any change proofs back as a new inbox file
      if (meltResult.change && meltResult.change.length > 0) {
        const changeSats = meltResult.change.reduce((s, p) => s + p.amount, 0);
        const changeKey = `wallet/inbox/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
        await storage.putJson(changeKey, {
          mint: mintUrl,
          proofs: meltResult.change,
          totalSats: changeSats,
        });
      }

      const fee = data.totalSats - data.totalSats; // fee is absorbed; actual fee tracking would need quote details
      result.swept.push({ mint: mintUrl, sats: data.totalSats, fee, status: "success" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ mint: mintUrl, error: `melt_failed: ${msg}` });
    }
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
