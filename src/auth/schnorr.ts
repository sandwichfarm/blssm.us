import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "../util.ts";
import type { NostrEvent } from "../types.ts";

/** Compute the Nostr event ID (SHA-256 of the serialized event) */
export function computeEventId(event: NostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/** Verify a schnorr signature on a Nostr event */
export function verifySignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}
