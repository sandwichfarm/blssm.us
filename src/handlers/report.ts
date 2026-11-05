import type { Config, NostrEvent } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { addReport } from "../storage/metadata.ts";
import { computeEventId, verifySignature } from "../auth/schnorr.ts";
import { errorResponse, isValidSha256, jsonResponse } from "../util.ts";
import {
  applyReportPolicy,
  type ModerationReport,
  readJson,
  reportIdFor,
} from "../storage/moderation.ts";
import { readLimitedBody } from "../http-body.ts";

/**
 * BUD-09: PUT /report — Report content
 *
 * Accepts a NIP-56 (kind 1984) moderation event.
 * The event must reference at least one blob hash via `x` tags.
 * Validates the event signature and stores one report per hash.
 */
export async function handleReport(
  request: Request,
  storage: StorageClient,
  _config: Config,
): Promise<Response> {
  // Parse request body as a Nostr event
  let body: unknown;
  try {
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readLimitedBody(request),
      ),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse("Report exceeds 64 KiB", 413);
    }
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Expected a signed Nostr event", 400);
  }
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" || !/^[0-9a-f]{64}$/.test(candidate.id) ||
    typeof candidate.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.pubkey) ||
    typeof candidate.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(candidate.sig) ||
    typeof candidate.created_at !== "number" ||
    !Number.isSafeInteger(candidate.created_at) ||
    candidate.created_at < 0 || typeof candidate.content !== "string" ||
    candidate.content.length > 16_000 ||
    !Array.isArray(candidate.tags) || candidate.tags.length > 128 ||
    !candidate.tags.every((tag) =>
      Array.isArray(tag) && tag.length > 0 && tag.length <= 16 &&
      tag.every((value) => typeof value === "string" && value.length <= 1024)
    )
  ) {
    return errorResponse("Invalid signed Nostr event fields", 400);
  }
  const event = candidate as unknown as NostrEvent;

  // Validate kind 1984
  if (event.kind !== 1984) {
    return errorResponse("Expected kind 1984 (moderation/report) event", 400);
  }

  // Find the x tags referencing blob hashes
  const hashes = [...new Set(event.tags.filter((t) => t[0] === "x").map((t) => t[1]))];
  if (hashes.length === 0 || hashes.some((hash) => !hash)) {
    return errorResponse("Missing 'x' tag with blob hash", 400);
  }
  if (!hashes.every(isValidSha256)) {
    return errorResponse("Invalid SHA-256 hash in 'x' tag", 400);
  }

  // Verify event ID
  const computedId = computeEventId(event);
  if (computedId !== event.id) {
    return errorResponse("Invalid event ID", 400);
  }

  // Verify schnorr signature
  const sigValid = await verifySignature(event);
  if (!sigValid) {
    return errorResponse("Invalid signature", 400);
  }

  // Store reports (even if a blob doesn't exist — a report can pre-date its upload)
  const reportIds = hashes.map((hash, index) => reportIdFor(event, hash, index));
  try {
    const stored = await Promise.all(
      hashes.map((hash, index) => addReport(storage, hash, event, reportIds[index])),
    );
    if (!stored.every(Boolean)) {
      return errorResponse("Report storage unavailable; please retry", 503);
    }
  } catch {
    return errorResponse("Report storage unavailable; please retry", 503);
  }

  let blocked = false;
  let automationError = false;
  for (const reportId of reportIds) {
    try {
      const report = await readJson<ModerationReport>(
        storage,
        `moderation/reports/${reportId}.json`,
      );
      if (report && await applyReportPolicy(storage, report) === "blocked") {
        if (
          !await storage.putJson(`moderation/processing/${reportId}.json`, {
            failed: false,
          })
        ) throw new Error("Processing result unavailable");
        blocked = true;
      }
    } catch {
      // Receipt is durable. The admin queue can retry automation without losing the report.
      automationError = true;
      await storage.putJson(`moderation/processing/${reportId}.json`, {
        failed: true,
      }).catch(() => false);
    }
  }

  if (automationError) {
    return jsonResponse({
      message:
        "Report saved for review; automatic processing will need a retry",
      reportId: event.id,
      status: "pending",
      automationError: true,
    }, 202);
  }
  if (blocked) {
    return jsonResponse({
      message: "Report received; content blocked by moderation policy",
      reportId: event.id,
      status: "blocked",
    });
  }
  return jsonResponse({
    message: "Report received for review",
    reportId: event.id,
    status: "pending",
  });
}
