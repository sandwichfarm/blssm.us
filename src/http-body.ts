/**
 * Read and discard a request body so a response sent without reading it can reach the client.
 * Nothing is buffered. Reading stops at `limit` bytes or after `timeoutMs`, because
 * this runs for unauthenticated requests. Never throws.
 */
export async function drainBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  timeoutMs = 30_000,
): Promise<void> {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  const timer = setTimeout(stop, timeoutMs);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      length += value.byteLength;
      if (length > limit) {
        stop();
        return;
      }
    }
  } catch {
    // Client went away mid-upload; there is nothing left to drain
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Read a small API body with a limit enforced on streamed bytes, not trusted headers. */
export async function readLimitedBody(
  request: { body: ReadableStream<Uint8Array> | null },
  limit = 65_536,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new RangeError(`Body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
