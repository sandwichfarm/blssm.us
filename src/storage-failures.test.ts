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
  cdnHostname: "blssm.test",
  serverUrl: "https://blssm.test",
  maxUploadSize: 1_000_000,
};
const storage = new StorageClient(config);
const SECRET = "1".padStart(64, "0");
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET));
const BLOB = new TextEncoder().encode("storage failure fixture");
const HASH = sha256Hex(BLOB);
const PRE = HASH.slice(0, 2);
const BLOB_PATH = `/test/blobs/${PRE}/${HASH}`;
const META_PATH = `/test/meta/${PRE}/${HASH}.json`;
const INDEX_PATH = `/test/lists/${PUBKEY.slice(0, 2)}/${PUBKEY}/index.json`;

function auth(verb: string): string {
  const now = Math.floor(Date.now() / 1000);
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: PUBKEY,
    kind: 24242,
    created_at: now,
    tags: [["t", verb], ["x", HASH], ["expiration", String(now + 3600)]],
    content: "test",
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, SECRET));
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

interface Scenario {
  /** Storage paths whose writes or deletes fail */
  failing: string[];
  /** Files already in storage */
  files?: Record<string, string>;
}

/** Run a request against fake storage, returning the response and the paths actually written */
async function run(scenario: Scenario, path: string, init: RequestInit) {
  const originalFetch = globalThis.fetch;
  const files = new Map(Object.entries(scenario.files ?? {}));
  const written: string[] = [];
  globalThis.fetch = async (input, requestInit) => {
    const request = new Request(input, requestInit);
    const url = new URL(request.url);
    if (url.hostname === "remote.example.test") return new Response(BLOB);
    if (url.hostname !== config.storageHostname) {
      throw new Error(`Unexpected network request to ${url.hostname}`);
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      if (scenario.failing.includes(url.pathname)) {
        return new Response(null, { status: 500 });
      }
      written.push(url.pathname);
      if (request.method === "DELETE") {
        return new Response(null, { status: files.delete(url.pathname) ? 200 : 404 });
      }
      files.set(url.pathname, await request.text());
      return new Response(null, { status: 201 });
    }
    const file = files.get(url.pathname);
    return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
  };
  try {
    const response = await route(new Request(config.serverUrl + path, init), storage, config);
    return { response, written };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const upload = (failing: string[]) =>
  run({ failing }, "/upload", {
    method: "PUT",
    headers: { Authorization: auth("upload") },
    body: BLOB,
  });

const mirror = (failing: string[]) =>
  run({ failing }, "/mirror", {
    method: "PUT",
    headers: { Authorization: auth("upload") },
    body: JSON.stringify({ url: "https://remote.example.test/blob" }),
  });

const meta = (owners: string[]) =>
  JSON.stringify({ sha256: HASH, size: BLOB.length, type: "text/plain", uploaded: 1, owners });

const del = (failing: string[], owners: string[]) =>
  run({
    failing,
    files: {
      [BLOB_PATH]: "bytes",
      [META_PATH]: meta(owners),
      [INDEX_PATH]: JSON.stringify([{ sha256: HASH, size: 1, type: "text/plain", uploaded: 1 }]),
    },
  }, `/${HASH}`, { method: "DELETE", headers: { Authorization: auth("delete") } });

for (const [name, send] of [["upload", upload], ["mirror", mirror]] as const) {
  Deno.test(`${name}: succeeds when every write succeeds`, async () => {
    eq((await send([])).response.ok, true);
  });

  Deno.test(`${name}: a failed blob write is a 503 and records no metadata`, async () => {
    const { response, written } = await send([BLOB_PATH]);
    eq(response.status, 503);
    eq(written, []);
  });

  Deno.test(`${name}: a failed metadata write is an error`, async () => {
    eq((await send([META_PATH])).response.status, 500);
  });

  Deno.test(`${name}: a failed index write is an error`, async () => {
    eq((await send([INDEX_PATH])).response.status, 500);
  });
}

Deno.test("delete: succeeds when every write succeeds", async () => {
  const { response, written } = await del([], [PUBKEY]);
  eq(response.status, 200);
  eq(written.includes(BLOB_PATH), true);
});

Deno.test("delete: a failed blob deletion is an error", async () => {
  eq((await del([BLOB_PATH], [PUBKEY])).response.status, 500);
});

Deno.test("delete: a failed metadata update for a shared blob is an error", async () => {
  eq((await del([META_PATH], [PUBKEY, "other"])).response.status, 500);
});

Deno.test("delete: a failed index write is an error", async () => {
  eq((await del([INDEX_PATH], [PUBKEY])).response.status, 500);
});

Deno.test("delete: a blob file that's already gone doesn't block the deletion", async () => {
  const { response } = await run({
    failing: [],
    files: { [META_PATH]: meta([PUBKEY]), [INDEX_PATH]: "[]" },
  }, `/${HASH}`, { method: "DELETE", headers: { Authorization: auth("delete") } });
  eq(response.status, 200);
});

Deno.test("CORS: preflight sends the headers BUD-01 requires", async () => {
  const { response } = await run({ failing: [] }, "/upload", { method: "OPTIONS" });
  eq(response.headers.get("Access-Control-Allow-Origin"), "*");
  eq(response.headers.get("Access-Control-Allow-Headers"), "Authorization, *");
  const methods = response.headers.get("Access-Control-Allow-Methods")!;
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    eq(methods.includes(method), true);
  }
});

Deno.test("CORS: browsers can read the reason and payment headers", async () => {
  const { response } = await run({ failing: [] }, `/${"f".repeat(64)}`, { method: "GET" });
  eq(response.status, 404);
  eq(response.headers.get("Access-Control-Allow-Origin"), "*");
  const exposed = response.headers.get("Access-Control-Expose-Headers")!.split(", ");
  for (const header of ["X-Reason", "X-Cashu", "X-Lightning", "Content-Length"]) {
    eq(exposed.includes(header), true);
  }
});
