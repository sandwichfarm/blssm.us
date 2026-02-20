import type { Config, BlobDescriptor } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { validateAuth } from "../auth/nostr.ts";
import { addOwner, addToIndex, isBlocked } from "../storage/metadata.ts";
import { sha256Hex, errorResponse, jsonResponse } from "../util.ts";

/**
 * BUD-05: PUT /media — Upload media (store as-is)
 *
 * In a full implementation, this would process/optimize media.
 * Since Bunny Edge Scripting has no image/video processing libraries,
 * we store the blob as-is (which is spec-compliant) and return the
 * blob descriptor with the original URL.
 *
 * Auth required with t=media.
 */
export async function handleMedia(
  request: Request,
  storage: StorageClient,
  config: Config,
): Promise<Response> {
  // Validate auth — BUD-05 uses verb "media"
  const auth = await validateAuth(request, {
    verb: "media",
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

  if (body.byteLength > config.maxUploadSize) {
    return errorResponse(
      `File too large. Maximum size is ${config.maxUploadSize} bytes`,
      413,
    );
  }

  const data = new Uint8Array(body);
  const hash = sha256Hex(data);

  // Validate hash against auth event x tag if present
  if (auth.event) {
    const xTag = auth.event.tags.find((t) => t[0] === "x");
    if (xTag && xTag[1] !== hash) {
      return errorResponse(
        `Hash mismatch: uploaded blob SHA-256 is ${hash}, auth event specifies ${xTag[1]}`,
        400,
      );
    }
  }

  if (await isBlocked(storage, hash)) {
    return errorResponse("This content has been blocked", 403);
  }

  const contentType =
    request.headers.get("X-Content-Type") ||
    request.headers.get("Content-Type") ||
    "application/octet-stream";

  // Extract NIP-94 metadata from auth event
  let nip94: string[][] | undefined;
  if (auth.event) {
    const nip94Tags = auth.event.tags.filter(
      (t) => t.length >= 2 && !["t", "x", "expiration", "server"].includes(t[0]),
    );
    if (nip94Tags.length > 0) {
      nip94 = nip94Tags;
    }
  }

  // Store as-is (no media processing in edge runtime)
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

  // Return blob descriptor — same as regular upload since we store as-is
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
