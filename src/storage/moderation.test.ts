/// <reference lib="deno.ns" />
import process from "node:process";
import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import type { NostrEvent } from "../types.ts";
import type { StorageClient } from "./client.ts";
import {
  applyReportPolicy,
  getModerationState,
  getPolicy,
  listFiles,
  loadReportBatch,
  loadReports,
  type ModerationReport,
  readJson,
  reportPow,
  reportRows,
  storeReport,
} from "./moderation.ts";
import { _resetBlockedCacheForTesting, isBlocked } from "./metadata.ts";

const hash = "a".repeat(64),
  reporter = "b".repeat(64),
  time = Date.now();
function report(
  id = "f".repeat(64),
  overrides: Partial<ModerationReport> = {},
): ModerationReport {
  const event: NostrEvent = {
    id,
    pubkey: reporter,
    created_at: time / 1000,
    kind: 1984,
    tags: [["x", hash, "other"], ["nonce", "1", "255"]],
    content: "review",
    sig: "0".repeat(128),
  };
  return {
    id,
    sha256: hash,
    event,
    receivedAt: time,
    pow: reportPow(id),
    ...overrides,
  };
}
function mock(initial: Record<string, unknown> = {}, fail?: string) {
  const files = new Map(Object.entries(initial));
  let writes = 0;
  const storage = {
    cdnHostname: "cdn.example.test",
    get: (path: string): Promise<Response | null> => {
      if (path === fail) {
        return Promise.resolve(new Response("outage", { status: 503 }));
      }
      if (files.has(path)) {
        return Promise.resolve(
          typeof files.get(path) === "string"
            ? new Response(files.get(path) as string)
            : Response.json(files.get(path)),
        );
      }
      if (path.endsWith("/")) {
        const names = [...files.keys()].filter((key) => key.startsWith(path))
          .map((key) => key.slice(path.length));
        return Promise.resolve(
          Response.json(
            names.map((name) => ({
              ObjectName: name.split("/")[0],
              IsDirectory: name.includes("/"),
            })),
          ),
        );
      }
      return Promise.resolve(null);
    },
    getToml: () => Promise.resolve({ hashes: [hash] }),
    putJson: (path: string, value: unknown) => {
      writes++;
      files.set(path, structuredClone(value));
      return Promise.resolve(true);
    },
  } as unknown as StorageClient;
  return { storage, files, writes: () => writes };
}

Deno.test("moderation: immutable receipts deduplicate and preserve original event/time", async () => {
  const m = mock(), r = report();
  eq(await storeReport(m.storage, hash, r.event), true);
  const first = structuredClone(m.files.get(`moderation/reports/${r.id}.json`));
  eq(
    await storeReport(m.storage, hash, {
      ...r.event,
      content: "retry must not replace",
    }),
    true,
  );
  eq(m.writes(), 1);
  eq(m.files.get(`moderation/reports/${r.id}.json`), first);
});
Deno.test("moderation: PoW counts actual event id bits, never nonce claims", async () => {
  eq(reportPow("f".repeat(64)), 0);
  eq(reportPow("08" + "f".repeat(62)), 4);
  eq(reportPow("01" + "f".repeat(62)), 7);
  eq(reportPow("0".repeat(64)), 256);
  const r = report("08" + "f".repeat(62), { pow: 255 });
  const m = mock({ [`moderation/reports/${r.id}.json`]: r });
  eq((await reportRows(m.storage))[0].pow, 4);
});
Deno.test("moderation: manual default and trusted/all automation modes", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BUNNY_API_KEY;
  process.env.BUNNY_API_KEY = "test-only";
  let purges = 0;
  globalThis.fetch = () => {
    purges++;
    return Promise.resolve(new Response("OK"));
  };
  try {
    const m = mock(), r = report();
    eq(await getPolicy(m.storage), { mode: "manual", trustedReporters: [] });
    eq(await applyReportPolicy(m.storage, r), "skipped");
    eq(
      await applyReportPolicy(m.storage, r, {
        mode: "trusted",
        trustedReporters: [],
      }),
      "skipped",
    );
    eq(
      await applyReportPolicy(m.storage, r, {
        mode: "trusted",
        trustedReporters: [reporter],
      }),
      "blocked",
    );
    eq((await getModerationState(m.storage, hash)).blocked, true);
    eq(
      await applyReportPolicy(mock().storage, r, {
        mode: "all",
        trustedReporters: [],
      }),
      "blocked",
    );
    eq(purges, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.BUNNY_API_KEY;
    else process.env.BUNNY_API_KEY = originalKey;
  }
});
Deno.test("moderation: protection and dismissal prevent automatic blocking", async () => {
  for (
    const initial of [
      {
        [`moderation/controls/${hash}.json`]: {
          blocked: false,
          automationProtected: true,
          updatedAt: time - 10,
        },
      },
      { [`moderation/reviews/${report().id}.json`]: { status: "dismissed" } },
    ]
  ) {
    eq(
      await applyReportPolicy(mock(initial).storage, report(), {
        mode: "all",
        trustedReporters: [],
      }),
      "skipped",
    );
  }
});
Deno.test("moderation: manual reversal overrides legacy and delayed automatic markers", async () => {
  const r = report(),
    marker = `moderation/automatic/${hash}/${time}-${r.id}.json`;
  const m = mock({
    "config/blocked.toml": `hashes = ["${hash}"]`,
    [marker]: { reportId: r.id },
  });
  _resetBlockedCacheForTesting();
  eq(await isBlocked(m.storage, hash, 0), true);
  m.files.set(`moderation/controls/${hash}.json`, {
    blocked: false,
    automationProtected: false,
    updatedAt: time + 100,
  });
  eq(await isBlocked(m.storage, hash, 0), false);
  eq(
    await applyReportPolicy(m.storage, r, {
      mode: "all",
      trustedReporters: [],
    }),
    "skipped",
  );
  m.files.set(
    `moderation/automatic/${hash}/${time + 50}-${"e".repeat(64)}.json`,
    {},
  );
  eq((await getModerationState(m.storage, hash)).source, "manual");
  m.files.set(
    `moderation/automatic/${hash}/${time + 101}-${"d".repeat(64)}.json`,
    {},
  );
  eq((await getModerationState(m.storage, hash)).source, "automatic");
  m.files.set(`moderation/controls/${hash}.json`, {
    blocked: false,
    automationProtected: true,
    updatedAt: time + 100,
  });
  eq(await isBlocked(m.storage, hash, 0), false);
  _resetBlockedCacheForTesting();
});
Deno.test("moderation: strict reads and listings expose failures instead of empty state", async () => {
  await rejects(() => readJson(mock({}, "bad").storage, "bad"));
  await rejects(() => listFiles(mock({}, "bad/").storage, "bad"));
  await rejects(() => listFiles(mock({ "bad/": {} }).storage, "bad"));
  eq(await readJson(mock().storage, "missing"), null);
  eq(await listFiles(mock().storage, "missing"), []);
});
Deno.test("moderation: report rows merge legacy once and reflect review/hash statuses", async () => {
  const a = report(),
    b = report("e".repeat(64), { sha256: "c".repeat(64) }),
    c = report("d".repeat(64), { sha256: "d".repeat(64) }),
    d = report("c".repeat(64), { sha256: "e".repeat(64) });
  const m = mock({
    ...Object.fromEntries(
      [a, b, c, d].map((r) => [`moderation/reports/${r.id}.json`, r]),
    ),
    [`reports/${hash}.json`]: { reports: [a.event] },
    "config/blocked.toml": `hashes = ["${b.sha256}"]`,
    [`moderation/reviews/${c.id}.json`]: { status: "dismissed" },
    [`moderation/controls/${d.sha256}.json`]: {
      blocked: false,
      automationProtected: true,
      updatedAt: time,
    },
  });
  eq((await loadReports(m.storage)).length, 4);
  const rows = new Map((await reportRows(m.storage)).map((r) => [r.id, r]));
  eq([a, b, c, d].map((r) => rows.get(r.id)?.status), [
    "pending",
    "blocked",
    "dismissed",
    "allowed",
  ]);
});

Deno.test("moderation: delayed duplicate receipt cannot reblock a later manual unblock", async () => {
  const m = mock(), r = report(), path = `moderation/reports/${r.id}.json`;
  const originalNow = Date.now, get = m.storage.get.bind(m.storage);
  let now = time;
  Date.now = () => now;
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => resume = resolve);
  let first = true;
  m.storage.get = async (requested) => {
    if (requested === path && first) {
      first = false;
      await barrier;
      return null;
    }
    return get(requested);
  };
  try {
    const delayed = storeReport(m.storage, hash, r.event);
    now = time + 10;
    eq(await storeReport(m.storage, hash, r.event), true);
    now = time + 20;
    m.files.set(`moderation/controls/${hash}/${now}-${"c".repeat(64)}.json`, {
      blocked: false,
      automationProtected: false,
      updatedAt: now,
      reason: "reviewed",
      actor: reporter,
    });
    now = time + 30;
    resume();
    eq(await delayed, true);
    const stored = m.files.get(path) as ModerationReport;
    eq(stored.receivedAt, time);
    eq(
      await applyReportPolicy(m.storage, stored, {
        mode: "all",
        trustedReporters: [],
      }),
      "skipped",
    );
    eq((await getModerationState(m.storage, hash)).blocked, false);
  } finally {
    resume();
    Date.now = originalNow;
  }
});

Deno.test("moderation: cursors reach every current and legacy report in batches of at most 25", async () => {
  const current = Array.from(
    { length: 31 },
    (_, i) => report(i.toString(16).padStart(64, "0")),
  );
  const legacy = Array.from(
    { length: 37 },
    (_, i) => report((i + 100).toString(16).padStart(64, "0")),
  );
  const m = mock({
    ...Object.fromEntries(
      current.map((r) => [`moderation/reports/${r.id}.json`, r]),
    ),
    [`reports/${hash}.json`]: { reports: legacy.map((r) => r.event) },
  });
  const received: string[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const batch = await loadReportBatch(m.storage, cursor);
    eq(batch.reports.length <= 25, true);
    received.push(...batch.reports.map((r) => r.id));
    eq(batch.scanTotal, 32);
    if (batch.nextCursor) {
      eq(cursors.has(batch.nextCursor), false);
      cursors.add(batch.nextCursor);
    }
    cursor = batch.nextCursor ?? undefined;
  } while (cursor);
  eq(received.length, 68);
  eq(new Set(received).size, 68);
  eq([...received].sort(), [...current, ...legacy].map((r) => r.id).sort());
  eq(cursors.size, 2);
  for (
    const invalid of [
      "!",
      btoa("null"),
      btoa(JSON.stringify({ path: "../../secret", offset: 0 })),
      btoa(JSON.stringify({ path: `reports/${hash}.json`, offset: -1 })),
    ]
  ) {
    await rejects(() => loadReportBatch(m.storage, invalid), RangeError);
  }
});

Deno.test("moderation: batched legacy duplicates preserve the modern server receipt", async () => {
  const canonical = report("1".repeat(64), { receivedAt: time });
  const remaining = Array.from(
    { length: 26 },
    (_, i) => report((i + 100).toString(16).padStart(64, "0")),
  );
  const duplicate = {
    ...canonical.event,
    created_at: Math.floor((time + 60_000) / 1000),
  };
  const m = mock({
    [`moderation/reports/${canonical.id}.json`]: canonical,
    [`reports/${hash}.json`]: {
      reports: [duplicate, ...remaining.map((r) => r.event)],
    },
  });
  const received: ModerationReport[] = [];
  let cursor: string | undefined;
  do {
    const batch = await loadReportBatch(m.storage, cursor);
    received.push(...batch.reports);
    cursor = batch.nextCursor ?? undefined;
  } while (cursor);
  eq(received.length, 27);
  eq(received.filter((r) => r.id === canonical.id), [canonical]);
  eq(received.find((r) => r.id === canonical.id)?.receivedAt, time);
  eq(
    received.map((r) => r.id).sort(),
    [canonical, ...remaining].map((r) => r.id).sort(),
  );
});
