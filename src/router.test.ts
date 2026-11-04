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

function authHeader(tags: string[][]): string {
  const secret = "1".padStart(64, "0");
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    kind: 24242,
    created_at: now,
    tags: [["t", "upload"], ["expiration", String(now + 3600)], ...tags],
    content: "test",
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, secret));
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** Run `fn` against an in-memory stand-in for Bunny Storage */
async function withFakeStorage<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const files = new Map<string, Uint8Array>();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
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
    Authorization: authHeader([["server", "cdn.example.com"]]),
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
  eq(response.status, 200);
  const descriptor = await response.json();
  eq(descriptor.sha256, hash);
  eq(descriptor.url, `https://blssm.test/blobs/${hash.slice(0, 2)}/${hash}`);
});
