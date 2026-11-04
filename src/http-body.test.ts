/// <reference lib="deno.ns" />
import { deepStrictEqual as eq } from "node:assert/strict";
import { drainBody } from "./http-body.ts";

/** A stream of `chunks` 1 KB chunks that records how much was pulled and whether it was cancelled */
function trackedStream(chunks: number) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= chunks) return controller.close();
      seen.pulled++;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, seen };
}

Deno.test("drainBody: reads a body within the limit to the end", async () => {
  const { stream, seen } = trackedStream(10);
  await drainBody(stream, 1024 * 10);
  eq(seen, { pulled: 10, cancelled: false });
});

Deno.test("drainBody: cancels once the byte limit is passed", async () => {
  const { stream, seen } = trackedStream(1000);
  await drainBody(stream, 1024 * 2);
  eq(seen, { pulled: 3, cancelled: true });
});

Deno.test("drainBody: gives up on a client that stops sending", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await drainBody(stalled, 1024, 5);
  eq(cancelled, true);
});

Deno.test("drainBody: does not throw when the client aborts", async () => {
  const aborted = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("connection reset");
    },
  });
  await drainBody(aborted, 1024);
});
