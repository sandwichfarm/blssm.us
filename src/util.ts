import { sha256 } from "@noble/hashes/sha256";

/** SHA-256 hash of a Uint8Array, returned as hex string */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** Pre-computed hex lookup table (avoids toString(16).padStart per byte) */
const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/** Convert bytes to hex string */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += HEX_TABLE[bytes[i]];
  }
  return hex;
}

/** Convert hex string to bytes */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Encode Uint8Array to base64 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 string to Uint8Array */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Shared regex for 64-char lowercase hex strings */
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Validate that a string is a 64-char lowercase hex string (SHA-256) */
export function isValidSha256(hash: string): boolean {
  return HEX64_RE.test(hash);
}

/** Validate that a string is a 64-char lowercase hex pubkey */
export function isValidPubkey(pubkey: string): boolean {
  return HEX64_RE.test(pubkey);
}

/** Get 2-char prefix for sharded storage paths */
export function prefix(hash: string): string {
  return hash.substring(0, 2);
}

/** Guess MIME type from file extension or content-type header */
export function guessMimeType(filename?: string, contentType?: string): string {
  if (contentType && contentType !== "application/octet-stream") {
    return contentType;
  }
  if (!filename) return "application/octet-stream";

  const ext = filename.split(".").pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    pdf: "application/pdf",
    json: "application/json",
    txt: "text/plain",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    wasm: "application/wasm",
  };
  return ext ? (mimeMap[ext] || "application/octet-stream") : "application/octet-stream";
}

/** Create a JSON Response with proper headers */
export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

/** Create an error JSON response */
export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ message }, status);
}
