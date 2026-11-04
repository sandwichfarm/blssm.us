/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "./schnorr.ts";
import { validateAuth } from "./nostr.ts";
import type { NostrEvent } from "../types.ts";

const SECRET = "1".padStart(64, "0");

const NOW = Math.floor(Date.now() / 1000);
const EXPIRATION = ["expiration", String(NOW + 3600)];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function signedEvent(tags: string[][], content = "test"): NostrEvent {
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: bytesToHex(schnorr.getPublicKey(SECRET)),
    kind: 24242,
    created_at: NOW,
    tags,
    content,
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, SECRET));
  return event;
}

const requestWithToken = (token: string) =>
  new Request("https://blssm.us/upload", {
    method: "PUT",
    headers: { Authorization: `Nostr ${token}` },
  });

const signedRequest = (tags: string[][]) => requestWithToken(btoa(JSON.stringify(signedEvent(tags))));

const requestWithServerTags = (serverTags: string[][]) =>
  signedRequest([["t", "upload"], EXPIRATION, ...serverTags]);

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

const expirationCases: Array<[string, string[][], string]> = [
  ["missing", [], "Missing 'expiration' tag"],
  ["in the past", [["expiration", String(NOW - 1)]], "Auth event has expired"],
  ["not a number", [["expiration", "soon"]], "Auth event has expired"],
  ["partly a number", [["expiration", `${NOW + 3600}abc`]], "Auth event has expired"],
  ["without a value", [["expiration"]], "Auth event has expired"],
];

for (const [name, tags, error] of expirationCases) {
  Deno.test(`validateAuth expiration: rejects ${name}`, async () => {
    const result = await validateAuth(signedRequest([["t", "upload"], ...tags]), { verb: "upload" });
    eq(result.authorized, false);
    eq(result.error, error);
  });
}

Deno.test("validateAuth x tag: any of several tags can match the implied hash", async () => {
  const request = signedRequest([["t", "delete"], EXPIRATION, ["x", HASH_B], ["x", HASH_A]]);
  eq((await validateAuth(request, { verb: "delete", sha256: HASH_A })).authorized, true);
});

Deno.test("validateAuth x tag: rejects a token for other hashes", async () => {
  const request = signedRequest([["t", "delete"], EXPIRATION, ["x", HASH_B]]);
  const result = await validateAuth(request, { verb: "delete", sha256: HASH_A });
  eq(result.error, "Hash mismatch in 'x' tag");
});

Deno.test("validateAuth x tag: an implied hash requires an x tag", async () => {
  const request = signedRequest([["t", "delete"], EXPIRATION]);
  eq((await validateAuth(request, { verb: "delete", sha256: HASH_A })).error, "Missing 'x' tag");
});

Deno.test("validateAuth x tag: requireHash needs a tag even with no hash to compare", async () => {
  const without = signedRequest([["t", "upload"], EXPIRATION, ["x"]]);
  eq((await validateAuth(without, { verb: "upload", requireHash: true })).error, "Missing 'x' tag");
  const withTag = signedRequest([["t", "upload"], EXPIRATION, ["x", HASH_A]]);
  eq((await validateAuth(withTag, { verb: "upload", requireHash: true })).authorized, true);
});

Deno.test("validateAuth encoding: accepts unpadded base64url", async () => {
  // These characters force "-" or "_" into the encoded token
  const event = signedEvent([["t", "upload"], EXPIRATION], "~~~???>>>");
  const token = btoa(JSON.stringify(event)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  eq(/[-_]/.test(token), true);
  const result = await validateAuth(requestWithToken(token), { verb: "upload" });
  eq(result.error, undefined);
  eq(result.authorized, true);
});

Deno.test("validateAuth encoding: still accepts standard base64", async () => {
  const event = signedEvent([["t", "upload"], EXPIRATION], "~~~???>>>");
  const result = await validateAuth(requestWithToken(btoa(JSON.stringify(event))), { verb: "upload" });
  eq(result.authorized, true);
});

for (const [name, body] of [
  ["null", null],
  ["no tags", { kind: 24242, created_at: NOW }],
  ["tags that are not arrays", { kind: 24242, created_at: NOW, tags: ["t"] }],
  ["created_at that is not a number", { kind: 24242, created_at: "now", tags: [] }],
] as const) {
  Deno.test(`validateAuth malformed: rejects ${name} without throwing`, async () => {
    const result = await validateAuth(requestWithToken(btoa(JSON.stringify(body))), { verb: "upload" });
    eq(result.authorized, false);
    eq(result.error, "Malformed auth event");
  });
}
