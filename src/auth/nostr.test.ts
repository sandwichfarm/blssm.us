/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "./schnorr.ts";
import { validateAuth } from "./nostr.ts";
import type { NostrEvent } from "../types.ts";

const SECRET = "1".padStart(64, "0");

function requestWithServerTags(serverTags: string[][]): Request {
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: bytesToHex(schnorr.getPublicKey(SECRET)),
    kind: 24242,
    created_at: now,
    tags: [["t", "upload"], ["expiration", String(now + 3600)], ...serverTags],
    content: "test",
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, SECRET));
  return new Request("https://blssm.us/upload", {
    method: "PUT",
    headers: { Authorization: `Nostr ${btoa(JSON.stringify(event))}` },
  });
}

const check = (tags: string[][], serverUrl = "https://blssm.us") =>
  validateAuth(requestWithServerTags(tags), { verb: "upload", serverUrl });

const accepted: Array<[string, string[][]]> = [
  ["no server tag", []],
  ["bare domain", [["server", "blssm.us"]]],
  ["this server listed after another", [["server", "cdn.example.com"], ["server", "blssm.us"]]],
  ["full URL", [["server", "https://blssm.us"]]],
  ["full URL with trailing slash", [["server", "https://blssm.us/"]]],
  ["uppercase domain", [["server", "BLSSM.US"]]],
];

for (const [name, tags] of accepted) {
  Deno.test(`validateAuth server tag: accepts ${name}`, async () => {
    const result = await check(tags);
    eq(result.error, undefined);
    eq(result.authorized, true);
  });
}

const rejected: Array<[string, string[][]]> = [
  ["another domain", [["server", "cdn.example.com"]]],
  ["only other domains", [["server", "a.example.com"], ["server", "b.example.com"]]],
  ["subdomain of this server", [["server", "cdn.blssm.us"]]],
  ["domain that merely starts with this one", [["server", "blssm.us.example.com"]]],
  ["URL on another host", [["server", "https://blssm.us.example.com"]]],
  ["tag without a value", [["server"]]],
];

for (const [name, tags] of rejected) {
  Deno.test(`validateAuth server tag: rejects ${name}`, async () => {
    const result = await check(tags);
    eq(result.authorized, false);
    eq(result.error, "Server URL mismatch");
  });
}

Deno.test("validateAuth server tag: tolerates whitespace and a bare domain in SERVER_URL", async () => {
  const tags = [["server", "blssm.us"]];
  eq((await check(tags, "https://blssm.us ")).authorized, true);
  eq((await check(tags, "blssm.us")).authorized, true);
});
