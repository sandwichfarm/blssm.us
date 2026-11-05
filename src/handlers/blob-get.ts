import type { Config } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { getMeta } from "../storage/metadata.ts";
import { isBlocked } from "../storage/metadata.ts";
import { errorResponse, EMPTY_SHA256 } from "../util.ts";

/**
 * BUD-01: GET/HEAD /<sha256> — Retrieve a blob
 *
 * Supports:
 * - Content-Type from metadata
 * - Range requests (forwarded to Bunny Storage)
 * - Optional file extension in path (e.g. /<sha256>.png)
 * - HEAD returns headers only
 */
export async function handleBlobGet(
  request: Request,
  storage: StorageClient,
  _config: Config,
): Promise<Response> {
  const url = new URL(request.url);
  // The hash may only be followed by a file extension, which doesn't affect the response
  const pathMatch = url.pathname.match(/^\/([0-9a-f]{64})(\.[A-Za-z0-9]+)?$/);
  if (!pathMatch) {
    return errorResponse("Invalid hash", 400);
  }
  const sha256 = pathMatch[1];

  // Check if blocked
  if (await isBlocked(storage, sha256)) {
    return errorResponse("Blob has been blocked", 403);
  }

  // Empty files (0 bytes) have a well-known hash — serve directly without fetching
  if (sha256 === EMPTY_SHA256) {
    const meta = await getMeta(storage, sha256);
    const contentType = meta?.type || "application/octet-stream";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": "0",
      "X-Content-Type": contentType,
      "X-SHA-256": sha256,
      "Cache-Control": "no-store",
    };

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(new ArrayBuffer(0), { status: 200, headers });
  }

  // Get metadata
  const meta = await getMeta(storage, sha256);
  if (!meta) {
    return errorResponse("Blob not found", 404);
  }

  // For HEAD requests, return headers without body
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": meta.type || "application/octet-stream",
        "Content-Length": meta.size.toString(),
        "X-Content-Type": meta.type || "application/octet-stream",
        "X-SHA-256": sha256,
      },
    });
  }

  // GET — proxy from Bunny Storage, which handles any Range itself
  const range = request.headers.get("Range");
  const blobResp = await storage.get(
    storage.blobPath(sha256),
    range ? { Range: range } : undefined,
  );
  if (!blobResp) {
    return errorResponse("Blob data not found", 404);
  }
  if (blobResp.status === 416) {
    await blobResp.body?.cancel();
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": blobResp.headers.get("Content-Range") ?? `bytes */${meta.size}` },
    });
  }
  if (!blobResp.ok) {
    await blobResp.body?.cancel();
    return errorResponse("Blob storage unavailable; please retry", 503);
  }

  const headers = new Headers();
  headers.set("Content-Type", meta.type || "application/octet-stream");
  headers.set("X-Content-Type", meta.type || "application/octet-stream");
  headers.set("X-SHA-256", sha256);
  headers.set("Cache-Control", "no-store");
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
    const value = blobResp.headers.get(name);
    if (value) headers.set(name, value);
  }

  // 206 for a satisfied Range; 200 if storage chose to send the whole blob
  return new Response(blobResp.body, { status: blobResp.status, headers });
}
