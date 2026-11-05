import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, getMeta, isBlocked } from "../storage/metadata.ts";
import { buildNip94, clientNip94Tags } from "../nip94.ts";
import { sha256Hex, errorResponse, jsonResponse, isValidSha256 } from "../util.ts";
import { checkAccess } from "../middleware/access.ts";
import { paymentGate } from "../middleware/payment-gate.ts";

/**
 * BUD-02: PUT /upload — Upload a blob
 *
 * Requires Nostr auth with t=upload.
 * BUD-11: the auth event must have an `x` tag matching the blob hash, which is
 * checked before the body is read when the client sends X-SHA-256.
 * Returns a BlobDescriptor: 201 if newly stored, 200 if it already existed.
 */
export async function handleBlobUpload(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  const declaredHash = request.headers.get("X-SHA-256");
  if (declaredHash !== null && !isValidSha256(declaredHash)) {
    return errorResponse("Invalid X-SHA-256 header", 400);
  }

  // Validate auth
  const auth = await validateAuth(request, {
    verb: "upload",
    sha256: declaredHash ?? undefined,
    requireHash: true,
    serverUrl: config.serverUrl,
  });
  if (!auth.authorized || !auth.pubkey) {
    return errorResponse(auth.error || "Unauthorized", 401);
  }

  // Access control — GATE-01: runs after auth, before body read
  const access = await checkAccess(storage, auth.pubkey, "upload");
  let paidForBytes = 0; // tracks Content-Length used for pricing (0 = no payment path)
  if (!access.allowed) {
    if (access.requiresPayment) {
      const cl = request.headers.get("Content-Length");
      const fileSizeBytes = cl ? parseInt(cl, 10) : NaN;
      if (isNaN(fileSizeBytes)) {
        return errorResponse("Content-Length required for payment calculation", 411);
      }
      const gate = await paymentGate(request, storage, fileSizeBytes);
      if (gate) return gate;
      paidForBytes = fileSizeBytes;
      // null = proof valid, fall through to body read
    } else {
      return errorResponse(access.reason, 403);
    }
  }

  // Read body
  const body = await request.arrayBuffer();

  // Verify actual body size does not exceed Content-Length used for payment pricing
  if (paidForBytes > 0 && body.byteLength > paidForBytes) {
    return errorResponse("Body size exceeds Content-Length used for payment", 400);
  }

  // Check size limit
  if (body.byteLength > config.maxUploadSize) {
    return errorResponse(
      `File too large. Maximum size is ${config.maxUploadSize} bytes`,
      413,
    );
  }

  const data = new Uint8Array(body);

  // Compute SHA-256
  const hash = sha256Hex(data);

  if (declaredHash !== null && declaredHash !== hash) {
    return errorResponse(`X-SHA-256 does not match the request body, which is ${hash}`, 409);
  }

  // Batch auth events (e.g. nsyte) may include multiple x tags — accept if ANY matches
  if (auth.event) {
    const xTags = auth.event.tags.filter((t) => t[0] === "x");
    if (!xTags.some((t) => t[1] === hash)) {
      return errorResponse(
        `Hash mismatch: uploaded blob SHA-256 is ${hash}, not found in auth event x tags`,
        401,
      );
    }
  }

  // Check if blocked
  if (await isBlocked(storage, hash)) {
    return errorResponse("This content has been blocked", 403);
  }

  // Determine content type
  const contentType =
    request.headers.get("X-Content-Type") ||
    request.headers.get("Content-Type") ||
    "application/octet-stream";

  const clientTags = auth.event ? clientNip94Tags(auth.event.tags) : undefined;
  const alreadyStored = await getMeta(storage, hash) !== null;

  // Store blob
  if (!await storage.put(storage.blobPath(hash), data, contentType)) {
    return errorResponse("Storage unavailable; please retry", 503);
  }

  // Update metadata and index in parallel (independent storage paths)
  const now = Math.floor(Date.now() / 1000);
  const [meta] = await Promise.all([
    addOwner(storage, hash, auth.pubkey, data.byteLength, contentType, clientTags),
    addToIndex(storage, auth.pubkey, {
      sha256: hash,
      size: data.byteLength,
      type: contentType,
      uploaded: now,
    }),
  ]);

  const url = storage.blobUrl(hash, meta.type);
  const descriptor: BlobDescriptor = {
    url,
    sha256: hash,
    size: meta.size,
    type: meta.type,
    uploaded: meta.uploaded,
    nip94: buildNip94(url, meta.type, hash, meta.size, meta.nip94),
  };

  return jsonResponse(descriptor, alreadyStored ? 200 : 201);
}
