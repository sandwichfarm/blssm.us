/// <reference lib="deno.ns" />
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { computeEventId } from "../auth/schnorr.ts";
import type { Config, NostrEvent } from "../types.ts";
import type { StorageClient } from "../storage/client.ts";
import { handleReport } from "./report.ts";

const hash = "a".repeat(64);
const privateKey = "1".padStart(64, "0");

function signedReport(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const event: NostrEvent = {
    id: "",
    pubkey: bytesToHex(schnorr.getPublicKey(privateKey)),
    created_at: 1_779_000_000,
    kind: 1984,
    tags: [["x", hash, "other"]],
    content: "Please review this content",
    sig: "",
    ...overrides,
  };
  event.id = computeEventId(event);
  event.sig = bytesToHex(schnorr.sign(event.id, privateKey));
  return event;
}

function storageMock(mode: "success" | "false" | "throw" = "success") {
  const saved = new Map<string, unknown>();
  let writes = 0;
  const storage = {
    reportPath: (sha256: string) => `reports/${sha256}.json`,
    get: (path: string) =>
      Promise.resolve(
        saved.has(path) ? Response.json(saved.get(path)) : null,
      ),
    getJson: <T>(path: string): Promise<T | null> =>
      Promise.resolve((saved.get(path) as T) ?? null),
    putJson: (path: string, data: unknown): Promise<boolean> => {
      writes++;
      if (mode === "throw") {
        return Promise.reject(new Error("Storage unavailable"));
      }
      if (mode === "false") return Promise.resolve(false);
      saved.set(path, structuredClone(data));
      return Promise.resolve(true);
    },
  } as unknown as StorageClient;
  return { storage, saved, writes: () => writes };
}

function submit(body: unknown, storage: StorageClient): Promise<Response> {
  return handleReport(
    new Request("https://example.com/report", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    storage,
    {} as Config,
  );
}

Deno.test("report: accepts a signed kind 1984 event and returns a review receipt", async () => {
  const mock = storageMock();
  const event = signedReport();
  const response = await submit(event, mock.storage);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    message: "Report received for review",
    reportId: event.id,
    status: "pending",
  });
  assertEquals(mock.writes() > 0, true);
  assertEquals(
    JSON.stringify([...mock.saved.values()]).includes(event.id),
    true,
  );
});

Deno.test("report: rejects malformed JSON without writing", async () => {
  const mock = storageMock();
  const response = await handleReport(
    new Request("https://example.com/report", { method: "PUT", body: "{" }),
    mock.storage,
    {} as Config,
  );
  assertEquals(response.status, 400);
  assertEquals(mock.writes(), 0);
});

Deno.test("report: rejects malformed event fields without throwing or writing", async () => {
  const valid = signedReport();
  const bodies: unknown[] = [
    null,
    [],
    "report",
    1984,
    {},
    { event: valid },
    { ...valid, tags: undefined },
    { ...valid, tags: null },
    { ...valid, tags: {} },
    { ...valid, tags: [null] },
    { ...valid, tags: ["x"] },
    { ...valid, tags: [["x", 123]] },
    { ...valid, tags: [[]] },
    { ...valid, content: null },
    { ...valid, created_at: "123" },
    { ...valid, created_at: -1 },
    { ...valid, created_at: 0.5 },
    { ...valid, pubkey: "invalid" },
    { ...valid, id: null },
    { ...valid, sig: "invalid" },
    { ...valid, sig: undefined },
  ];
  for (const body of bodies) {
    const mock = storageMock();
    assertEquals(
      (await submit(body, mock.storage)).status,
      400,
      JSON.stringify(body),
    );
    assertEquals(mock.writes(), 0);
  }
});

Deno.test("report: rejects wrong kind, absent hash and invalid signatures", async () => {
  const valid = signedReport();
  const bodies = [
    signedReport({ kind: 24242 }),
    signedReport({ tags: [] }),
    signedReport({ tags: [["x", "invalid"]] }),
    { ...valid, content: "tampered" },
    { ...valid, sig: "0".repeat(128) },
  ];
  for (const body of bodies) {
    const mock = storageMock();
    assertEquals((await submit(body, mock.storage)).status, 400);
    assertEquals(mock.writes(), 0);
  }
});

for (const mode of ["false", "throw"] as const) {
  Deno.test(`report: returns 503 when storage returns ${mode}`, async () => {
    const mock = storageMock(mode);
    const response = await submit(signedReport(), mock.storage);
    assertEquals(response.status, 503);
    assertEquals((await response.json()).reportId, undefined);
    assertEquals(mock.saved.size, 0);
  });
}

Deno.test("report: rejects oversized streamed body without trusting content length or writing", async () => {
  const mock = storageMock();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await handleReport(
    new Request("https://example.com/report", {
      method: "PUT",
      body: stream,
    }),
    mock.storage,
    {} as Config,
  );
  assertEquals(response.status, 413);
  assertEquals(mock.writes(), 0);
  assertEquals(cancelled, true);
});
