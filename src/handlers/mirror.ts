import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, isBlocked } from "../storage/metadata.ts";
import { sha256Hex, errorResponse, jsonResponse, isValidSha256 } from "../util.ts";

/**
 * BUD-04: PUT /mirror — Mirror a blob from a remote URL
 *
 * Request body is JSON: { url: string }
 * Fetches the remote URL, computes SHA-256, stores blob.
 * Requires Nostr auth with t=upload.
 * If auth event has `x` tag, fetched blob hash must match.
 */
export async function handleMirror(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  // Validate auth
  const auth = await validateAuth(request, {
    verb: "upload",
    serverUrl: config.serverUrl,
  });
  if (!auth.authorized || !auth.pubkey) {
    return errorResponse(auth.error || "Unauthorized", 401);
  }

  // Parse request body
  let body: { url: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return errorResponse("Missing 'url' field", 400);
  }

  // Fetch the remote blob
  let remoteResp: Response;
  try {
    remoteResp = await fetch(body.url);
  } catch {
    return errorResponse("Failed to fetch remote URL", 502);
  }

  if (!remoteResp.ok) {
    return errorResponse(`Remote server returned ${remoteResp.status}`, 502);
  }

  // Read body
  const remoteData = new Uint8Array(await remoteResp.arrayBuffer());

  // Check size limit
  if (remoteData.byteLength > config.maxUploadSize) {
    return errorResponse(
      `Remote file too large. Maximum size is ${config.maxUploadSize} bytes`,
      413,
    );
  }

  // Compute SHA-256
  const hash = sha256Hex(remoteData);

  // Validate hash if auth event specifies `x` tag
  if (auth.event) {
    const xTag = auth.event.tags.find((t) => t[0] === "x");
    if (xTag && xTag[1] !== hash) {
      return errorResponse(
        `Hash mismatch: mirrored blob SHA-256 is ${hash}, auth event specifies ${xTag[1]}`,
        400,
      );
    }
  }

  // Check if blocked
  if (await isBlocked(storage, hash)) {
    return errorResponse("This content has been blocked", 403);
  }

  // Determine content type from remote response
  const contentType =
    remoteResp.headers.get("Content-Type") || "application/octet-stream";

  // Store blob
  await storage.put(storage.blobPath(hash), remoteData, contentType);

  // Update metadata
  const meta = await addOwner(storage, hash, auth.pubkey, remoteData.byteLength, contentType);

  // Update pubkey index
  await addToIndex(storage, auth.pubkey, {
    sha256: hash,
    size: remoteData.byteLength,
    type: contentType,
    uploaded: meta.uploaded,
  });

  // Return blob descriptor
  const descriptor: BlobDescriptor = {
    url: storage.blobUrl(hash),
    sha256: hash,
    size: remoteData.byteLength,
    type: contentType,
    uploaded: meta.uploaded,
  };

  return jsonResponse(descriptor);
}
