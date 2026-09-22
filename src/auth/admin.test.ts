/// <reference lib="deno.ns" />
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { computeEventId } from "./schnorr.ts";
import { validateModerationAdmin, validateNip98Admin } from "./admin.ts";
import { bytesToHex, sha256Hex } from "../util.ts";
import type { NostrEvent } from "../types.ts";

const key = "1".padStart(64, "0");
const pubkey = bytesToHex(schnorr.getPublicKey(key));
const url = "https://example.com/admin/moderation?status=pending";
const payload = '{"action":"block"}';

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const nowMs = Date.now();
  const value = {
    id: "",
    sig: "",
    pubkey,
    kind: 27235,
    created_at: Math.floor(nowMs / 1000),
    content: "",
    tags: [["u", url], ["method", "POST"], [
      "payload",
      sha256Hex(new TextEncoder().encode(payload)),
    ], ["created_at_ms", String(nowMs)]],
    ...overrides,
  };
  value.id = computeEventId(value);
  value.sig = bytesToHex(schnorr.sign(value.id, key));
  return value;
}

function request(value: unknown = event(), body = payload): Request {
  return new Request(url, {
    method: "POST",
    body,
    headers: { Authorization: `Nostr ${btoa(JSON.stringify(value))}` },
  });
}

Deno.test("NIP-98: authorizes the expected key and preserves the request body", async () => {
  const req = request();
  assertEquals(await validateNip98Admin(req, pubkey), null);
  assertEquals(await req.text(), payload);
});

Deno.test("NIP-98: production moderation entry rejects a different signing key", async () => {
  assertEquals((await validateModerationAdmin(request()))?.status, 401);
});

Deno.test("NIP-98: binds authorization to exact URL, method, timestamp, and payload", async () => {
  const valid = event();
  for (
    const invalid of [
      event({ kind: 1984 }),
      event({ created_at: valid.created_at - 61 }),
      event({ created_at: valid.created_at + 120 }),
      event({
        tags: valid.tags.map((tag) =>
          tag[0] === "u" ? ["u", url.split("?")[0]] : tag
        ),
      }),
      event({
        tags: valid.tags.map((tag) =>
          tag[0] === "method" ? ["method", "DELETE"] : tag
        ),
      }),
      event({ tags: valid.tags.filter((tag) => tag[0] !== "payload") }),
      event({ tags: [...valid.tags, ["u", url]] }),
      event({ tags: [...valid.tags, ["method", "POST"]] }),
      event({ tags: [...valid.tags, valid.tags[2]] }),
      { ...valid, content: "changed" },
      { ...valid, sig: "0".repeat(128) },
    ]
  ) {
    assertEquals(
      (await validateNip98Admin(request(invalid), pubkey))?.status,
      401,
    );
  }
  assertEquals(
    (await validateNip98Admin(request(valid, '{"action":"dismiss"}'), pubkey))
      ?.status,
    401,
  );
});

Deno.test("NIP-98: malformed and oversized authorization is rejected", async () => {
  for (const value of [null, [], {}, { ...event(), tags: [null] }]) {
    assertEquals(
      (await validateNip98Admin(request(value), pubkey))?.status,
      401,
    );
  }
  for (
    const header of [
      "",
      "Bearer token",
      "Nostr !!!",
      `Nostr ${"A".repeat(16385)}`,
    ]
  ) {
    const req = new Request(url, { headers: { Authorization: header } });
    assertEquals((await validateNip98Admin(req, pubkey))?.status, 401);
  }
});

Deno.test("NIP-98: permits bodyless signed GET and validates optional payload tags", async () => {
  const tags = [["u", url], ["method", "GET"]];
  const get = (value: NostrEvent) =>
    new Request(url, {
      headers: { Authorization: `Nostr ${btoa(JSON.stringify(value))}` },
    });
  assertEquals(await validateNip98Admin(get(event({ tags })), pubkey), null);
  assertEquals(
    (await validateNip98Admin(
      get(event({ tags: [...tags, ["payload", "bad"]] })),
      pubkey,
    ))?.status,
    401,
  );
});

Deno.test("NIP-98: mutation timestamp is unique, precise and matches signed seconds", async () => {
  const valid = event();
  const withoutTime = valid.tags.filter((tag) => tag[0] !== "created_at_ms");
  for (
    const tags of [
      withoutTime,
      [...valid.tags, ["created_at_ms", String(Date.now())]],
      [...withoutTime, ["created_at_ms", "123"]],
      [...withoutTime, [
        "created_at_ms",
        String((valid.created_at + 1) * 1000),
      ]],
    ]
  ) {
    assertEquals(
      (await validateNip98Admin(request(event({ tags })), pubkey))?.status,
      401,
    );
  }
});
