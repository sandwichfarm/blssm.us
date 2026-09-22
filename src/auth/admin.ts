import type { NostrEvent } from "../types.ts";
import { computeEventId, verifySignature } from "./schnorr.ts";
import { errorResponse, sha256Hex } from "../util.ts";
import { readLimitedBody } from "../http-body.ts";

export const MODERATION_ADMIN_PUBKEY =
  "e771af0b05c8e95fcdf6feb3500544d2fb1ccd384788e9f490bb3ee28e8ed66f";

/** Validate a fresh NIP-98 authorization bound to this exact request. */
export async function validateNip98Admin(
  request: Request,
  expectedPubkey: string,
): Promise<Response | null> {
  const reject = () =>
    errorResponse("Valid moderation administrator authorization required", 401);
  const header = request.headers.get("Authorization");
  if (!header || header.length > 16_384 || !header.startsWith("Nostr ")) {
    return reject();
  }

  let event: NostrEvent;
  try {
    const body: unknown = JSON.parse(atob(header.slice(6)));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reject();
    }
    const value = body as Record<string, unknown>;
    if (
      typeof value.id !== "string" || !/^[0-9a-f]{64}$/.test(value.id) ||
      typeof value.pubkey !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.pubkey) ||
      typeof value.sig !== "string" || !/^[0-9a-f]{128}$/.test(value.sig) ||
      value.kind !== 27235 || typeof value.created_at !== "number" ||
      !Number.isSafeInteger(value.created_at) ||
      typeof value.content !== "string" ||
      !Array.isArray(value.tags) || !value.tags.every((tag) =>
        Array.isArray(tag) && tag.length > 0 && tag.every((part) =>
          typeof part === "string"
        )
      )
    ) return reject();
    event = value as unknown as NostrEvent;
  } catch {
    return reject();
  }

  if (
    event.pubkey !== expectedPubkey ||
    Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 60
  ) return reject();

  const exactTag = (name: string, expected: string): boolean => {
    const tags = event.tags.filter((tag) => tag[0] === name);
    return tags.length === 1 && tags[0].length === 2 && tags[0][1] === expected;
  };
  if (!exactTag("u", request.url) || !exactTag("method", request.method)) {
    return reject();
  }
  if (computeEventId(event) !== event.id || !verifySignature(event)) {
    return reject();
  }

  const payloadTags = event.tags.filter((tag) => tag[0] === "payload");
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (mutation) {
    const timeTags = event.tags.filter((tag) => tag[0] === "created_at_ms");
    if (
      timeTags.length !== 1 || timeTags[0].length !== 2 ||
      !/^\d{13}$/.test(timeTags[0][1]) ||
      Math.floor(Number(timeTags[0][1]) / 1000) !== event.created_at
    ) return reject();
  }
  if (mutation || payloadTags.length > 0) {
    try {
      const bytes = await readLimitedBody(request.clone());
      if (!exactTag("payload", sha256Hex(bytes))) return reject();
    } catch {
      return reject();
    }
  }
  return null;
}

/** Production entry point: moderation authority belongs only to the configured owner. */
export function validateModerationAdmin(
  request: Request,
): Promise<Response | null> {
  return validateNip98Admin(request, MODERATION_ADMIN_PUBKEY);
}
