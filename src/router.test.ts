/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "./auth/schnorr.ts";
import { route } from "./router.ts";
import { StorageClient } from "./storage/client.ts";
import { sha256Hex } from "./util.ts";
import type { Config, NostrEvent } from "./types.ts";

const config: Config = {
  storageHostname: "storage.example.test",
  storageUsername: "test",
  storagePassword: "test",
  cdnHostname: "blssm.test ", // trailing space, as seen on the deployed env var
  serverUrl: "https://blssm.test",
  maxUploadSize: 1_000_000,
};
const storage = new StorageClient(config);

/** Upload body delivered in 64 KB chunks, recording how much of it the server pulled */
function chunkedUpload(chunks: number, headers: HeadersInit = {}) {
  const seen = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= chunks) return controller.close();
      seen.pulled++;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  }, { highWaterMark: 0 });
  const request = new Request(config.serverUrl + "/upload", {
    method: "PUT",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
  return { request, seen };
}

function authHeader(tags: string[][], verb = "upload"): string {
  const secret = "1".padStart(64, "0");
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    kind: 24242,
    created_at: now,
    tags: [["t", verb], ["expiration", String(now + 3600)], ...tags],
    content: "test",
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, secret));
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

const BLOB = new TextEncoder().encode("bud-11 fixture");
const BLOB_HASH = sha256Hex(BLOB);
const OTHER_HASH = "a".repeat(64);

const send = (path: string, init: RequestInit) =>
  withFakeStorage(() => route(new Request(config.serverUrl + path, init), storage, config));

const upload = (tags: string[][], headers: Record<string, string> = {}) =>
  send("/upload", {
    method: "PUT",
    headers: { Authorization: authHeader(tags), ...headers },
    body: BLOB,
  });

const mirror = (tags: string[][]) =>
  send("/mirror", {
    method: "PUT",
    headers: { Authorization: authHeader(tags) },
    body: JSON.stringify({ url: "https://remote.example.test/blob" }),
  });

const preflight = (tags: string[][], sha256?: string) =>
  send("/upload", {
    method: "HEAD",
    headers: {
      Authorization: authHeader(tags),
      ...(sha256 ? { "X-SHA-256": sha256 } : {}),
    },
  });

const del = (tags: string[][]) =>
  send(`/${BLOB_HASH}`, {
    method: "DELETE",
    headers: { Authorization: authHeader(tags, "delete") },
  });

/** Run `fn` against an in-memory stand-in for Bunny Storage */
async function withFakeStorage<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const files = new Map<string, Uint8Array>();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "remote.example.test") {
      return new Response(BLOB, { headers: { "Content-Type": "text/plain" } });
    }
    if (url.hostname !== config.storageHostname) {
      throw new Error(`Unexpected network request to ${url.hostname}`);
    }
    if (request.method === "PUT") {
      files.set(url.pathname, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 201 });
    }
    const file = files.get(url.pathname);
    return file ? new Response(new Uint8Array(file)) : new Response(null, { status: 404 });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("route: a rejected upload is read to the end before the 401 is returned", async () => {
  const { request, seen } = chunkedUpload(10);
  const response = await route(request, storage, config);
  eq(response.status, 401);
  eq(seen.pulled, 10);
});

Deno.test("route: a token for another server is also drained before its 401", async () => {
  const { request, seen } = chunkedUpload(10, {
    Authorization: authHeader([["x", "a".repeat(64)], ["server", "cdn.example.com"]]),
  });
  const response = await route(request, storage, config);
  eq(response.status, 401);
  eq((await response.json()).message, "Server URL mismatch");
  eq(seen.pulled, 10);
});

Deno.test("route: draining a rejected upload stops at maxUploadSize", async () => {
  const { request, seen } = chunkedUpload(1000);
  const response = await route(request, storage, config);
  eq(response.status, 401);
  eq(seen.pulled, Math.ceil(config.maxUploadSize / (64 * 1024)));
});

Deno.test("route: a BUD-11 scoped upload succeeds and its descriptor URL has no space", async () => {
  const bytes = new TextEncoder().encode("issue 4 fixture");
  const hash = sha256Hex(bytes);
  const response = await withFakeStorage(() =>
    route(
      new Request(config.serverUrl + "/upload", {
        method: "PUT",
        headers: {
          Authorization: authHeader([
            ["x", hash],
            ["server", "cdn.example.com"],
            ["server", "blssm.test"],
          ]),
          "Content-Type": "text/plain",
        },
        body: bytes,
      }),
      storage,
      config,
    )
  );
  eq(response.status, 201);
  const descriptor = await response.json();
  eq(descriptor.sha256, hash);
  eq(descriptor.url, `https://blssm.test/${hash}.txt`);
});

Deno.test("PUT /upload: requires an x tag", async () => {
  const response = await upload([]);
  eq(response.status, 401);
  eq((await response.json()).message, "Missing 'x' tag");
});

Deno.test("PUT /upload: accepts a matching X-SHA-256 and x tag", async () => {
  eq((await upload([["x", BLOB_HASH]], { "X-SHA-256": BLOB_HASH })).status, 201);
});

Deno.test("PUT /upload: rejects X-SHA-256 outside the token's x tags", async () => {
  eq((await upload([["x", OTHER_HASH]], { "X-SHA-256": BLOB_HASH })).status, 401);
});

Deno.test("PUT /upload: returns 409 when X-SHA-256 does not match the body", async () => {
  eq((await upload([["x", OTHER_HASH]], { "X-SHA-256": OTHER_HASH })).status, 409);
});

Deno.test("PUT /upload: rejects a body outside the token's x tags", async () => {
  eq((await upload([["x", OTHER_HASH]])).status, 401);
});

Deno.test("PUT /upload: rejects a malformed X-SHA-256", async () => {
  eq((await upload([["x", BLOB_HASH]], { "X-SHA-256": "nope" })).status, 400);
});

Deno.test("PUT /mirror: requires an x tag", async () => {
  eq((await mirror([])).status, 401);
});

Deno.test("PUT /mirror: accepts a matching x tag", async () => {
  eq((await mirror([["x", BLOB_HASH]])).status, 201);
});

Deno.test("PUT /mirror: returns 409 when the blob does not match the x tag", async () => {
  eq((await mirror([["x", OTHER_HASH]])).status, 409);
});

Deno.test("HEAD /upload: invalid auth is a 401", async () => {
  eq((await preflight([])).status, 401);
  eq((await preflight([["x", OTHER_HASH]], BLOB_HASH)).status, 401);
});

Deno.test("HEAD /upload: accepts an x tag matching X-SHA-256", async () => {
  eq((await preflight([["x", BLOB_HASH]], BLOB_HASH)).status, 200);
});

Deno.test("HEAD /upload: rejects a malformed X-SHA-256", async () => {
  eq((await preflight([["x", BLOB_HASH]], "nope")).status, 400);
});

Deno.test("DELETE: requires an x tag for the blob", async () => {
  eq((await del([])).status, 401);
  eq((await del([["x", OTHER_HASH]])).status, 401);
});

Deno.test("DELETE: any x tag can match, and the auth check then passes", async () => {
  // The blob doesn't exist in the fake storage, so passing auth reaches the 404
  eq((await del([["x", OTHER_HASH], ["x", BLOB_HASH]])).status, 404);
});
