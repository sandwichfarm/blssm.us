/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import process from "node:process";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "./auth/schnorr.ts";
import { StorageClient } from "./storage/client.ts";
import { route } from "./router.ts";
import { sha256Hex } from "./util.ts";
import type { Config, NostrEvent } from "./types.ts";

Deno.test("moderation integration: report blocks both URL forms, uploads and mirrors; unblock preserves bytes", async () => {
  const originalFetch = globalThis.fetch, key = process.env.BUNNY_API_KEY;
  process.env.BUNNY_API_KEY = "test-only";
  const files = new Map<string, Uint8Array>();
  const bytes = new TextEncoder().encode(
    "reversible moderation integration fixture",
  );
  const hash = sha256Hex(bytes);
  let purges = 0;
  const config: Config = {
    storageHostname: "storage.example.test",
    storageUsername: "test",
    storagePassword: "test",
    cdnHostname: "example.test",
    serverUrl: "https://example.test",
    maxUploadSize: 1_000_000,
  };
  const storage = new StorageClient(config);
  const secret = "2".padStart(64, "0");
  const sign = (kind: number, tags: string[][], content = "") => {
    const event: NostrEvent = {
      id: "",
      sig: "",
      pubkey: bytesToHex(schnorr.getPublicKey(secret)),
      kind,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    event.id = computeEventId(event);
    event.sig = bytesToHex(schnorr.sign(event.id, secret));
    return event;
  };
  const auth = () => ({
    Authorization: `Nostr ${
      btoa(JSON.stringify(sign(24242, [["t", "upload"], ["x", hash]])))
    }`,
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === "api.bunny.net") {
      purges++;
      return new Response("OK");
    }
    if (url.hostname === "remote.example.test") {
      return new Response(bytes, { headers: { "Content-Type": "text/plain" } });
    }
    if (url.hostname !== "storage.example.test") {
      throw new Error("Unexpected network request");
    }
    const path = url.pathname.slice("/test/".length);
    if (request.method === "PUT") {
      files.set(path, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 201 });
    }
    if (request.method !== "GET") {
      throw new Error("Moderation must not delete bytes");
    }
    if (path.endsWith("/")) {
      const entries = [
        ...new Set(
          [...files.keys()].filter((key) => key.startsWith(path)).map((key) =>
            key.slice(path.length).split("/")[0]
          ),
        ),
      ];
      return Response.json(
        entries.map((name) => ({
          ObjectName: name,
          IsDirectory: !files.has(path + name),
        })),
      );
    }
    return files.has(path)
      ? new Response(new Uint8Array(files.get(path)!))
      : new Response(null, { status: 404 });
  };
  try {
    const upload = () =>
      route(
        new Request(config.serverUrl + "/upload", {
          method: "PUT",
          headers: auth(),
          body: bytes,
        }),
        storage,
        config,
      );
    eq((await upload()).status, 200);
    await storage.putJson("moderation/policy.json", {
      mode: "all",
      trustedReporters: [],
    });
    const event = sign(1984, [["x", hash, "spam"]], "fixture report");
    const report = await route(
      new Request(config.serverUrl + "/report", {
        method: "PUT",
        body: JSON.stringify(event),
      }),
      storage,
      config,
    );
    eq(report.status, 200);
    eq((await report.json()).status, "blocked");
    eq(purges, 2);
    for (const path of [`/${hash}`, `/blobs/${hash.slice(0, 2)}/${hash}`]) {
      const response = await route(
        new Request(config.serverUrl + path),
        storage,
        config,
      );
      eq(response.status, 403);
      eq(response.headers.get("Cache-Control"), "no-store");
    }
    eq((await upload()).status, 403);
    eq(
      (await route(
        new Request(config.serverUrl + "/upload", {
          method: "HEAD",
          headers: { "X-SHA-256": hash },
        }),
        storage,
        config,
      )).status,
      403,
    );
    eq(
      (await route(
        new Request(config.serverUrl + "/mirror", {
          method: "PUT",
          headers: auth(),
          body: JSON.stringify({ url: "https://remote.example.test/fixture" }),
        }),
        storage,
        config,
      )).status,
      403,
    );
    eq(files.has(storage.blobPath(hash)), true);
    await storage.putJson(`moderation/controls/${hash}.json`, {
      blocked: false,
      automationProtected: true,
      updatedAt: Date.now(),
      actor: "test",
      reason: "restore",
    });
    for (const path of [`/${hash}`, `/blobs/${hash.slice(0, 2)}/${hash}`]) {
      const response = await route(
        new Request(config.serverUrl + path),
        storage,
        config,
      );
      eq(response.status, 200);
      eq(response.headers.get("Cache-Control"), "no-store");
      eq(new Uint8Array(await response.arrayBuffer()), bytes);
    }
    const replay = await route(
      new Request(config.serverUrl + "/report", {
        method: "PUT",
        body: JSON.stringify(event),
      }),
      storage,
      config,
    );
    eq(replay.status, 200);
    eq(
      (await route(new Request(config.serverUrl + "/" + hash), storage, config))
        .status,
      200,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.BUNNY_API_KEY;
    else process.env.BUNNY_API_KEY = key;
  }
});
