/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import process from "node:process";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "./auth/schnorr.ts";
import { route } from "./router.ts";
import { StorageClient } from "./storage/client.ts";
import { baseMediaType, extensionForType, sha256Hex } from "./util.ts";
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
const BLOB = new TextEncoder().encode("conformance fixture");
const HASH = sha256Hex(BLOB);
const OTHER_HASH = "a".repeat(64);

function sign(kind: number, tags: string[][]): NostrEvent {
  const event: NostrEvent = {
    id: "",
    sig: "",
    pubkey: PUBKEY,
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "test",
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, SECRET));
  return event;
}

function auth(extra: string[][] = []): string {
  const expiration = String(Math.floor(Date.now() / 1000) + 3600);
  const event = sign(24242, [["t", "upload"], ["x", HASH], ["expiration", expiration], ...extra]);
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/** In-memory Bunny Storage. `blobResponse` overrides how blob bytes are served. */
function fakeStorage(blobResponse?: (request: Request) => Response) {
  const files = new Map<string, Uint8Array>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "api.bunny.net") return new Response("OK");
    if (url.hostname === "remote.example.test") {
      return new Response(BLOB, { headers: { "Content-Type": "application/pdf" } });
    }
    if (url.hostname !== config.storageHostname) {
      throw new Error(`Unexpected network request to ${url.hostname}`);
    }
    const path = url.pathname.slice("/test/".length);
    if (request.method === "PUT") {
      files.set(path, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 201 });
    }
    if (blobResponse && path.startsWith("blobs/")) return blobResponse(request);
    if (path.endsWith("/")) {
      const names = [...new Set(
        [...files.keys()].filter((key) => key.startsWith(path)).map((key) =>
          key.slice(path.length).split("/")[0]
        ),
      )];
      return Response.json(
        names.map((name) => ({ ObjectName: name, IsDirectory: !files.has(path + name) })),
      );
    }
    const file = files.get(path);
    return file ? new Response(new Uint8Array(file)) : new Response(null, { status: 404 });
  };
  return { files, restore: () => globalThis.fetch = originalFetch };
}

const send = (path: string, init?: RequestInit) =>
  route(new Request(config.serverUrl + path, init), storage, config);

const upload = (extra: string[][] = [], type = "text/plain; charset=UTF-8") =>
  send("/upload", {
    method: "PUT",
    headers: { Authorization: auth(extra), "Content-Type": type },
    body: BLOB,
  });

const mirror = (extra: string[][] = [], url = "https://remote.example.test/blob") =>
  send("/mirror", {
    method: "PUT",
    headers: { Authorization: auth(extra) },
    body: JSON.stringify({ url }),
  });

/** Run a test with fake storage that already holds the fixture blob */
function withBlob(
  name: string,
  fn: () => Promise<void>,
  blobResponse?: (request: Request) => Response,
) {
  Deno.test(name, async () => {
    const fake = fakeStorage(blobResponse);
    try {
      fake.files.set(
        `meta/${HASH.slice(0, 2)}/${HASH}.json`,
        new TextEncoder().encode(JSON.stringify({
          sha256: HASH,
          size: BLOB.length,
          type: "text/plain",
          uploaded: 1,
          owners: [PUBKEY],
        })),
      );
      fake.files.set(`blobs/${HASH.slice(0, 2)}/${HASH}`, BLOB);
      await fn();
    } finally {
      fake.restore();
    }
  });
}

function withEmptyStorage(name: string, fn: () => Promise<void>) {
  Deno.test(name, async () => {
    const fake = fakeStorage();
    try {
      await fn();
    } finally {
      fake.restore();
    }
  });
}

// --- BUD-02, BUD-04: status codes and descriptor URLs

withEmptyStorage("BUD-02: a new upload is 201 and a repeat is 200", async () => {
  eq((await upload()).status, 201);
  eq((await upload()).status, 200);
});

withEmptyStorage("BUD-04: a new mirror is 201 and a repeat is 200", async () => {
  eq((await mirror()).status, 201);
  eq((await mirror()).status, 200);
});

withEmptyStorage("BUD-02: an upload of a mirrored blob counts as existing", async () => {
  eq((await mirror()).status, 201);
  eq((await upload()).status, 200);
});

withEmptyStorage("BUD-02: the descriptor URL is /<sha256> with a file extension", async () => {
  eq((await (await upload()).json()).url, `https://blssm.test/${HASH}.txt`);
});

withEmptyStorage("BUD-04: the mirror descriptor URL uses the origin's type", async () => {
  const descriptor = await (await mirror()).json();
  eq(descriptor.url, `https://blssm.test/${HASH}.pdf`);
  eq(descriptor.type, "application/pdf");
});

withEmptyStorage("BUD-02: a repeat upload describes the stored type, not the new one", async () => {
  await upload([], "image/png");
  const descriptor = await (await upload([], "text/plain")).json();
  eq(descriptor.type, "image/png");
  eq(descriptor.url, `https://blssm.test/${HASH}.png`);
});

withEmptyStorage("BUD-12: listed descriptors use the same URL as uploads", async () => {
  await upload();
  const [listed] = await (await send(`/list/${PUBKEY}`)).json();
  eq(listed.url, `https://blssm.test/${HASH}.txt`);
});

withEmptyStorage("BUD-02: the descriptor URL resolves to the blob", async () => {
  const { url } = await (await upload()).json();
  const response = await send(new URL(url).pathname);
  eq(response.status, 200);
  eq(new Uint8Array(await response.arrayBuffer()), BLOB);
});

Deno.test("extensionForType: ignores case and parameters, and falls back to bin", () => {
  eq(extensionForType("TEXT/Plain; charset=UTF-8"), "txt");
  eq(extensionForType("image/jpeg"), "jpg");
  eq(extensionForType("application/x-unknown"), "bin");
  eq(extensionForType(""), "bin");
  eq(baseMediaType("Image/PNG; foo=bar"), "image/png");
});

withEmptyStorage("BUD-04: rejects a url that isn't http or https", async () => {
  eq((await mirror([], "not a url")).status, 400);
  eq((await mirror([], "file:///etc/passwd")).status, 400);
});

// --- BUD-08: NIP-94

const expectedNip94 = (ext: string, m: string) => [
  ["url", `https://blssm.test/${HASH}.${ext}`],
  ["m", m],
  ["x", HASH],
  ["ox", HASH],
  ["size", String(BLOB.length)],
];

withEmptyStorage("BUD-08: uploads generate NIP-94 tags with no help from the token", async () => {
  eq((await (await upload()).json()).nip94, expectedNip94("txt", "text/plain"));
});

withEmptyStorage("BUD-08: mirrors generate NIP-94 tags", async () => {
  eq((await (await mirror()).json()).nip94, expectedNip94("pdf", "application/pdf"));
});

withEmptyStorage("BUD-08: optional tags from the token are kept", async () => {
  const { nip94 } = await (await upload([["alt", "a fixture"], ["dim", "1x1"]])).json();
  eq(nip94, [...expectedNip94("txt", "text/plain"), ["alt", "a fixture"], ["dim", "1x1"]]);
});

withEmptyStorage("BUD-08: a token can't override the generated tags", async () => {
  const forged = [["url", "https://evil.test/x"], ["m", "text/html"], ["ox", OTHER_HASH], ["size", "1"]];
  eq((await (await upload(forged)).json()).nip94, expectedNip94("txt", "text/plain"));
});

withEmptyStorage("BUD-08: token protocol tags aren't treated as metadata", async () => {
  const { nip94 } = await (await upload([["server", "blssm.test"]])).json();
  eq(nip94, expectedNip94("txt", "text/plain"));
});

// --- BUD-01: retrieval

withBlob("BUD-01: GET returns the blob even if the client asks for JSON", async () => {
  const response = await send(`/${HASH}`, { headers: { Accept: "application/json" } });
  eq(response.headers.get("Content-Type"), "text/plain");
  eq(new Uint8Array(await response.arrayBuffer()), BLOB);
});

withBlob("BUD-01: GET and HEAD accept a file extension without changing the type", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await send(`/${HASH}.pdf`, { method });
    eq(response.status, 200);
    eq(response.headers.get("Content-Type"), "text/plain");
    await response.body?.cancel();
  }
});

withBlob("BUD-01: HEAD sets Content-Length", async () => {
  const response = await send(`/${HASH}`, { method: "HEAD" });
  eq(response.headers.get("Content-Length"), String(BLOB.length));
});

withBlob("BUD-01: anything but an extension after the hash is a 400", async () => {
  for (const suffix of ["zzz", "/extra", ".pdf.exe", "."]) {
    eq((await send(`/${HASH}${suffix}`)).status, 400);
  }
});

withBlob("BUD-01: a Range is forwarded and storage's partial response is passed on", async () => {
  const response = await send(`/${HASH}`, { headers: { Range: "bytes=0-3" } });
  eq(response.status, 206);
  eq(response.headers.get("Content-Range"), `bytes 0-3/${BLOB.length}`);
  eq(response.headers.get("Accept-Ranges"), "bytes");
  eq(new Uint8Array(await response.arrayBuffer()), BLOB.slice(0, 4));
}, (request) => {
  eq(request.headers.get("Range"), "bytes=0-3");
  return new Response(BLOB.slice(0, 4), {
    status: 206,
    headers: { "Content-Range": `bytes 0-3/${BLOB.length}`, "Accept-Ranges": "bytes" },
  });
});

withBlob("BUD-01: without a Range, none is sent to storage", async () => {
  eq((await send(`/${HASH}`)).status, 200);
}, (request) => {
  eq(request.headers.get("Range"), null);
  return new Response(BLOB);
});

withBlob("BUD-01: storage ignoring a Range is a plain 200, not a false 206", async () => {
  const response = await send(`/${HASH}`, { headers: { Range: "bytes=0-3" } });
  eq(response.status, 200);
  eq(new Uint8Array(await response.arrayBuffer()), BLOB);
}, () => new Response(BLOB));

withBlob("BUD-01: an unsatisfiable Range is a 416", async () => {
  const response = await send(`/${HASH}`, { headers: { Range: "bytes=999-" } });
  eq(response.status, 416);
  eq(response.headers.get("Content-Range"), `bytes */${BLOB.length}`);
}, () => new Response(null, { status: 416 }));

withBlob("BUD-01: a storage error isn't served as if it were the blob", async () => {
  const response = await send(`/${HASH}`);
  eq(response.status, 503);
  await response.body?.cancel();
}, () => new Response("upstream error", { status: 500 }));

// --- BUD-06: preflight

const preflight = (headers: Record<string, string>) => send("/upload", { method: "HEAD", headers });

withEmptyStorage("BUD-06: a preflight with no token is a 401, like the upload would be", async () => {
  const response = await preflight({ "X-SHA-256": HASH });
  eq(response.status, 401);
  eq(response.headers.get("X-Reason"), "Missing Authorization header");
});

withEmptyStorage("BUD-06: a complete preflight is a 200", async () => {
  const response = await preflight({
    Authorization: auth(),
    "X-SHA-256": HASH,
    "X-Content-Type": "application/pdf",
    "X-Content-Length": "184292",
  });
  eq(response.status, 200);
});

for (const [name, headers] of [
  ["X-Content-Type", { "X-Content-Type": "not a type" }],
  ["X-Content-Length", { "X-Content-Length": "12abc" }],
  ["negative X-Content-Length", { "X-Content-Length": "-1" }],
] as const) {
  withEmptyStorage(`BUD-06: a malformed ${name} is a 400`, async () => {
    const response = await preflight({ Authorization: auth(), "X-SHA-256": HASH, ...headers });
    eq(response.status, 400);
  });
}

withEmptyStorage("BUD-06: X-Content-Type may carry parameters", async () => {
  const response = await preflight({
    Authorization: auth(),
    "X-SHA-256": HASH,
    "X-Content-Type": "text/plain; charset=UTF-8",
  });
  eq(response.status, 200);
});

// Bunny's CDN sends visitors' HEAD requests to the origin as GET
const edgePreflight = (headers: Record<string, string>) => send("/upload", { headers });

withEmptyStorage("BUD-06: GET /upload answers as the preflight, without the SPA", async () => {
  eq((await edgePreflight({})).status, 401);
  eq((await edgePreflight({ "X-SHA-256": "nope" })).status, 400);
  const accepted = await edgePreflight({ Authorization: auth(), "X-SHA-256": HASH });
  eq(accepted.status, 200);
  eq(accepted.headers.get("Content-Type"), null);
  eq(accepted.headers.get("X-Max-Upload-Size"), String(config.maxUploadSize));
  const tooLarge = await edgePreflight({
    Authorization: auth(),
    "X-SHA-256": HASH,
    "X-Content-Length": String(config.maxUploadSize + 1),
  });
  eq(tooLarge.status, 413);
});

// --- BUD-09: reports naming several blobs

const report = (tags: string[][]) =>
  send("/report", { method: "PUT", body: JSON.stringify(sign(1984, tags)) });

const reportFiles = (files: Map<string, Uint8Array>) =>
  [...files.keys()].filter((key) => key.startsWith("moderation/reports/")).map((key) =>
    JSON.parse(new TextDecoder().decode(files.get(key)))
  );

Deno.test("BUD-09: each x tag gets its own report, and retries don't duplicate them", async () => {
  const fake = fakeStorage();
  try {
    const tags = [["x", HASH, "spam"], ["x", OTHER_HASH, "illegal"], ["x", HASH, "spam"]];
    const event = sign(1984, tags);
    const body = JSON.stringify(event);
    const first = await send("/report", { method: "PUT", body });
    eq(first.status, 200);
    eq((await first.json()).reportId, event.id);
    eq((await send("/report", { method: "PUT", body })).status, 200);

    const reports = reportFiles(fake.files);
    eq(reports.length, 2);
    eq(new Set(reports.map((r) => r.sha256)), new Set([HASH, OTHER_HASH]));
    eq(reports.find((r) => r.sha256 === HASH).id, event.id);
    eq(reports.find((r) => r.sha256 === OTHER_HASH).id === event.id, false);
  } finally {
    fake.restore();
  }
});

Deno.test("BUD-09: a blocking policy blocks every reported blob", async () => {
  const fake = fakeStorage();
  const key = process.env.BUNNY_API_KEY;
  process.env.BUNNY_API_KEY = "test-only";
  try {
    await storage.putJson("moderation/policy.json", { mode: "all", trustedReporters: [] });
    const response = await report([["x", HASH, "spam"], ["x", OTHER_HASH, "spam"]]);
    eq((await response.json()).status, "blocked");
    for (const hash of [HASH, OTHER_HASH]) {
      const blocked = await send(`/${hash}`);
      eq(blocked.status, 403);
      await blocked.body?.cancel();
    }
  } finally {
    if (key === undefined) delete process.env.BUNNY_API_KEY;
    else process.env.BUNNY_API_KEY = key;
    fake.restore();
  }
});

Deno.test("BUD-09: one malformed x tag rejects the whole report", async () => {
  const fake = fakeStorage();
  try {
    eq((await report([["x", HASH], ["x", "nope"]])).status, 400);
    eq(reportFiles(fake.files).length, 0);
  } finally {
    fake.restore();
  }
});
