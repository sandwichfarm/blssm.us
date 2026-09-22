import type { Config, NostrEvent } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { addReport } from "../storage/metadata.ts";
import { computeEventId, verifySignature } from "../auth/schnorr.ts";
import { errorResponse, isValidSha256, jsonResponse } from "../util.ts";
import {
  applyReportPolicy,
  type ModerationReport,
  readJson,
} from "../storage/moderation.ts";
import { readLimitedBody } from "../http-body.ts";

/**
 * BUD-09: PUT /report — Report content
 *
 * Accepts a NIP-56 (kind 1984) moderation event.
 * The event must reference a blob hash via an `x` tag.
 * Validates the event signature and stores the report.
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

  // Find the x tag referencing a blob hash
  const xTag = event.tags.find((t) => t[0] === "x");
  if (!xTag || !xTag[1]) {
    return errorResponse("Missing 'x' tag with blob hash", 400);
  }
  const sha256 = xTag[1];

  if (!isValidSha256(sha256)) {
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

  // Store report (even if blob doesn't exist — report can pre-date upload)
  try {
    if (!await addReport(storage, sha256, event)) {
      return errorResponse("Report storage unavailable; please retry", 503);
    }
  } catch {
    return errorResponse("Report storage unavailable; please retry", 503);
  }

  try {
    const report = await readJson<ModerationReport>(
      storage,
      `moderation/reports/${event.id}.json`,
    );
    if (report && await applyReportPolicy(storage, report) === "blocked") {
      if (
        !await storage.putJson(`moderation/processing/${event.id}.json`, {
          failed: false,
        })
      ) throw new Error("Processing result unavailable");
      return jsonResponse({
        message: "Report received; content blocked by moderation policy",
        reportId: event.id,
        status: "blocked",
      });
    }
  } catch {
    // Receipt is durable. The admin queue can retry automation without losing the report.
    await storage.putJson(`moderation/processing/${event.id}.json`, {
      failed: true,
    }).catch(() => false);
    return jsonResponse({
      message:
        "Report saved for review; automatic processing will need a retry",
      reportId: event.id,
      status: "pending",
      automationError: true,
    }, 202);
  }
  return jsonResponse({
    message: "Report received for review",
    reportId: event.id,
    status: "pending",
  });
}
