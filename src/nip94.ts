import { baseMediaType } from "./util.ts";

/** Tags the server generates from the blob itself, so tokens can't set them */
const SERVER_TAGS = new Set(["url", "m", "x", "ox", "size"]);
/** BUD-11 token tags, which aren't file metadata */
const TOKEN_TAGS = new Set(["t", "expiration", "server"]);

/** Optional NIP-94 tags a client supplied in its auth token, such as `alt` or `dim` */
export function clientNip94Tags(tags: string[][]): string[][] | undefined {
  const extras = tags.filter((t) =>
    t.length >= 2 && !SERVER_TAGS.has(t[0]) && !TOKEN_TAGS.has(t[0])
  );
  return extras.length > 0 ? extras : undefined;
}

/** BUD-08 `nip94` field. The server never transforms blobs, so `ox` always equals `x`. */
export function buildNip94(
  url: string,
  type: string,
  sha256: string,
  size: number,
  extras: string[][] = [],
): string[][] {
  return [
    ["url", url],
    ["m", baseMediaType(type)],
    ["x", sha256],
    ["ox", sha256],
    ["size", String(size)],
    ...extras.filter((t) => !SERVER_TAGS.has(t[0])),
  ];
}
