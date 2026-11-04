import type { NostrEvent, AuthResult } from "../types.ts";
import { fromBase64 } from "../util.ts";
import { computeEventId, verifySignature } from "./schnorr.ts";

/**
 * Reduce a `server` tag or SERVER_URL to a bare lowercase domain.
 * BUD-11 tags are domains only; full URLs are still accepted because existing
 * clients send them and they were the only form this server used to match.
 */
function serverDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes("://")) return normalized.replace(/\/+$/, "");
  try {
    return new URL(normalized).hostname;
  } catch {
    return normalized;
  }
}

/** Extract and validate a Nostr auth event from the Authorization header.
 *
 * Validates:
 * - kind = 24242
 * - created_at is in the past (with 60s grace)
 * - expiration tag is in the future
 * - `t` tag matches expected verb (get, upload, delete, list, media, mirror)
 * - `x` tag matches expected hash (if provided)
 * - at least one `server` tag names this server's domain (if any are present)
 * - Event ID matches SHA-256 of serialized event
 * - Schnorr signature is valid
 */
export async function validateAuth(
  request: Request,
  options: {
    verb: string;
    sha256?: string;
    serverUrl?: string;
  },
): Promise<AuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return { authorized: false, error: "Missing Authorization header" };
  }

  const match = authHeader.match(/^Nostr\s+(.+)$/i);
  if (!match) {
    return { authorized: false, error: "Invalid Authorization header format" };
  }

  let event: NostrEvent;
  try {
    const decoded = fromBase64(match[1]);
    event = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return { authorized: false, error: "Invalid base64 or JSON in Authorization header" };
  }

  // Validate kind
  if (event.kind !== 24242) {
    return { authorized: false, error: `Invalid event kind: ${event.kind}, expected 24242` };
  }

  const now = Math.floor(Date.now() / 1000);

  // Validate created_at (allow 60s clock skew)
  if (event.created_at > now + 60) {
    return { authorized: false, error: "Event created_at is in the future" };
  }

  // Validate expiration
  const expirationTag = event.tags.find((t) => t[0] === "expiration");
  if (expirationTag) {
    const expiration = parseInt(expirationTag[1], 10);
    if (expiration < now) {
      return { authorized: false, error: "Auth event has expired" };
    }
  }

  // Validate `t` tag (verb)
  const tTag = event.tags.find((t) => t[0] === "t");
  if (!tTag) {
    return { authorized: false, error: "Missing 't' (verb) tag" };
  }
  if (tTag[1] !== options.verb) {
    return { authorized: false, error: `Invalid verb: ${tTag[1]}, expected ${options.verb}` };
  }

  // Validate `x` tag (hash) if expected
  if (options.sha256) {
    const xTag = event.tags.find((t) => t[0] === "x");
    if (xTag && xTag[1] !== options.sha256) {
      return { authorized: false, error: `Hash mismatch in 'x' tag` };
    }
  }

  // BUD-11: when `server` tags are present, this server's domain must appear in at least one
  if (options.serverUrl) {
    const serverTags = event.tags.filter((t) => t[0] === "server");
    if (serverTags.length > 0) {
      const expected = serverDomain(options.serverUrl);
      const matches = serverTags.some(
        (t) => typeof t[1] === "string" && serverDomain(t[1]) === expected,
      );
      if (!matches) {
        return { authorized: false, error: `Server URL mismatch` };
      }
    }
  }

  // Verify event ID
  const computedId = computeEventId(event);
  if (computedId !== event.id) {
    return { authorized: false, error: "Invalid event ID" };
  }

  // Verify schnorr signature
  const sigValid = verifySignature(event);
  if (!sigValid) {
    return { authorized: false, error: "Invalid signature" };
  }

  return { authorized: true, pubkey: event.pubkey, event };
}
