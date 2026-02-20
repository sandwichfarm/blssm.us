import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, isBlocked } from "../storage/metadata.ts";
import { sha256Hex, errorResponse, jsonResponse, isValidSha256 } from "../util.ts";

/**
 * BUD-02: PUT /upload — Upload a blob
 *
 * Requires Nostr auth with t=upload.
 * If auth event has `x` tag, uploaded blob hash must match.
 * Returns BlobDescriptor on success.
 */
export async function handleBlobUpload(
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

  // Read body
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return errorResponse("Empty upload body", 400);
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

  // Validate hash if auth event specifies `x` tag
  if (auth.event) {
    const xTag = auth.event.tags.find((t) => t[0] === "x");
    if (xTag && xTag[1] !== hash) {
      return errorResponse(
        `Hash mismatch: uploaded blob SHA-256 is ${hash}, auth event specifies ${xTag[1]}`,
        400,
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

  // Extract NIP-94 metadata from auth event tags (BUD-08)
  // Filter out protocol tags, keep everything else as [key, value] pairs
  let nip94: string[][] | undefined;
  if (auth.event) {
    const nip94Tags = auth.event.tags.filter(
      (t) => t.length >= 2 && !["t", "x", "expiration", "server"].includes(t[0]),
    );
    if (nip94Tags.length > 0) {
      nip94 = nip94Tags;
    }
  }

  // Store blob
  await storage.put(storage.blobPath(hash), data, contentType);

  // Update metadata and index in parallel (independent storage paths)
  const now = Math.floor(Date.now() / 1000);
  const [meta] = await Promise.all([
    addOwner(storage, hash, auth.pubkey, data.byteLength, contentType, nip94),
    addToIndex(storage, auth.pubkey, {
      sha256: hash,
      size: data.byteLength,
      type: contentType,
      uploaded: now,
    }),
  ]);

  // Return blob descriptor
  const descriptor: BlobDescriptor = {
    url: storage.blobUrl(hash),
    sha256: hash,
    size: data.byteLength,
    type: contentType,
    uploaded: meta.uploaded,
  };
  if (nip94) {
    descriptor.nip94 = nip94;
  }

  return jsonResponse(descriptor);
}
