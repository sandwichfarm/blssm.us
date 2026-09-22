/// <reference lib="deno.ns" />
import { deepStrictEqual as eq, rejects } from "node:assert/strict";
import process from "node:process";
import type { StorageClient } from "../storage/client.ts";
import {
  getControl,
  getPolicy,
  getReview,
  type ModerationReport,
} from "../storage/moderation.ts";
import {
  authorizedModerationRequest,
  handleAdminModeration,
} from "./admin-moderation.ts";

const hash = "a".repeat(64), pubkey = "b".repeat(64), time = Date.now();
function row(id: string, sha256 = hash, content = "review"): ModerationReport {
  return {
    id,
    sha256,
    receivedAt: time,
    pow: 255,
    event: {
      id,
      pubkey,
      kind: 1984,
      created_at: time / 1000,
      content,
      tags: [["x", sha256, "other"], ["nonce", "0", "255"]],
      sig: "0".repeat(128),
    },
  };
}
function mock(initial: Record<string, unknown> = {}, failedPath?: string) {
  const files = new Map(Object.entries(initial));
  let reads = 0, writes = 0;
  const storage = {
    cdnHostname: "cdn.example.test",
    get: (path: string): Promise<Response | null> => {
      reads++;
      if (files.has(path)) {
        return Promise.resolve(Response.json(files.get(path)));
      }
      if (path.endsWith("/")) {
        const entries = [...files.keys()].filter((key) => key.startsWith(path))
          .map((key) => key.slice(path.length));
        return Promise.resolve(
          Response.json(
            entries.map((entry) => ({
              ObjectName: entry.split("/")[0],
              IsDirectory: entry.includes("/"),
            })),
          ),
        );
      }
      return Promise.resolve(null);
    },
    putJson: (path: string, value: unknown) => {
      writes++;
      if (path === failedPath) return Promise.resolve(false);
      files.set(path, structuredClone(value));
      return Promise.resolve(true);
    },
  } as unknown as StorageClient;
  return { storage, files, reads: () => reads, writes: () => writes };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  id = "c".repeat(64),
  signedMs = time,
): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: {
      Authorization: `Nostr ${
        btoa(
          JSON.stringify({
            id,
            created_at: Math.floor(signedMs / 1000),
            tags: [["created_at_ms", String(signedMs)]],
          }),
        )
      }`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function withPurge(run: () => Promise<void>) {
  const fetch = globalThis.fetch, key = process.env.BUNNY_API_KEY;
  process.env.BUNNY_API_KEY = "test-only";
  globalThis.fetch = () => Promise.resolve(new Response("OK"));
  try {
    await run();
  } finally {
    globalThis.fetch = fetch;
    if (key === undefined) delete process.env.BUNNY_API_KEY;
    else process.env.BUNNY_API_KEY = key;
  }
}
Deno.test("admin moderation: unauthorized public requests never touch storage", async () => {
  const m = mock();
  const response = await handleAdminModeration(
    request("/admin/reports"),
    m.storage,
  );
  eq(response.status, 401);
  eq(response.headers.get("Cache-Control"), "private, no-store");
  eq(m.reads(), 0);
  eq(m.writes(), 0);
});
Deno.test("admin moderation: report filters, deterministic PoW sorting, pagination and statistics", async () => {
  const a = row("f".repeat(64), hash, "needle"),
    b = row("08" + "f".repeat(62), "d".repeat(64)),
    c = row("01" + "f".repeat(62), "e".repeat(64));
  const m = mock({
    ...Object.fromEntries(
      [a, b, c].map((r) => [`moderation/reports/${r.id}.json`, r]),
    ),
    [`moderation/controls/${b.sha256}.json`]: {
      blocked: true,
      automationProtected: true,
      updatedAt: time,
    },
    [`moderation/reviews/${c.id}.json`]: { status: "dismissed" },
  });
  const all = await authorizedModerationRequest(
    request("/admin/reports?sort=pow&order=desc&pageSize=1&page=2"),
    m.storage,
  );
  eq(all.status, 200);
  eq(all.headers.get("Cache-Control"), "private, no-store");
  const body = await all.json();
  eq(body.reports.map((r: ModerationReport) => r.id), [b.id]);
  eq(body.total, 3);
  eq(body.page, 2);
  eq(body.pageSize, 1);
  eq(body.stats, {
    total: 3,
    pending: 1,
    blocked: 1,
    dismissed: 1,
    allowed: 0,
    uniqueHashes: 3,
    protectedHashes: 1,
    averagePow: 11 / 3,
  });
  const filtered = await (await authorizedModerationRequest(
    request("/admin/reports?status=pending&q=NEEDLE"),
    m.storage,
  )).json();
  eq(filtered.total, 1);
  eq(filtered.reports[0].id, a.id);
  for (
    const query of [
      "page=0",
      "pageSize=101",
      "sort=unknown",
      "status=unknown",
      "order=sideways",
    ]
  ) {
    eq(
      (await authorizedModerationRequest(
        request(`/admin/reports?${query}`),
        m.storage,
      )).status,
      400,
    );
  }
});
Deno.test("admin moderation: saves validated policy with deduplicated keys and prevents auth replay", async () => {
  const m = mock(),
    body = { mode: "trusted", trustedReporters: [pubkey, pubkey] };
  const response = await authorizedModerationRequest(
    request("/admin/moderation", "PUT", body),
    m.storage,
  );
  eq(response.status, 200);
  eq(m.files.get(`moderation/policies/${time}-${"c".repeat(64)}.json`), {
    mode: "trusted",
    trustedReporters: [pubkey],
  });
  eq(
    (m.files.get(`moderation/audit/${"c".repeat(64)}.json`) as {
      status: string;
    }).status,
    "completed",
  );
  const count = m.writes();
  eq(
    (await authorizedModerationRequest(
      request("/admin/moderation", "PUT", body),
      m.storage,
    )).status,
    409,
  );
  eq(m.writes(), count);
  eq(
    (await authorizedModerationRequest(
      request("/admin/moderation", "PUT", {
        mode: "unknown",
        trustedReporters: [],
      }),
      m.storage,
    )).status,
    400,
  );
});
Deno.test("admin moderation: per-hash reversal and protection and report review persist", async () => {
  await withPurge(async () => {
    const r = row("f".repeat(64));
    const m = mock({ [`moderation/reports/${r.id}.json`]: r });
    const response = await authorizedModerationRequest(
      request(`/admin/hashes/${hash}`, "PUT", {
        blocked: false,
        automationProtected: true,
        reason: "false positive",
      }),
      m.storage,
    );
    eq(response.status, 200);
    const control = m.files.get(
      `moderation/controls/${hash}/${time}-${"c".repeat(64)}.json`,
    ) as {
      blocked: boolean;
      automationProtected: boolean;
      reason: string;
    };
    eq(control.blocked, false);
    eq(control.automationProtected, true);
    eq(control.reason, "false positive");
    eq(
      (await authorizedModerationRequest(
        request(`/admin/reports/${r.id}`, "PUT", {
          status: "dismissed",
          reason: "duplicate",
        }, "d".repeat(64)),
        m.storage,
      )).status,
      200,
    );
    const listing = await (await authorizedModerationRequest(
      request("/admin/reports"),
      m.storage,
    )).json();
    eq(listing.reports[0].status, "dismissed");
  });
});
Deno.test("admin moderation: invalid mutations never create audit or controls", async () => {
  const m = mock();
  for (
    const [path, body] of [
      [`/admin/hashes/${hash}`, {
        blocked: "false",
        automationProtected: true,
        reason: "x",
      }],
      [`/admin/hashes/${hash}`, {
        blocked: false,
        automationProtected: true,
        reason: "x".repeat(2001),
      }],
      ["/admin/moderation", { mode: "trusted", trustedReporters: ["invalid"] }],
      [`/admin/reports/${hash}`, { status: "invalid", reason: "x" }],
    ] as const
  ) {
    eq(
      (await authorizedModerationRequest(request(path, "PUT", body), m.storage))
        .status,
      400,
    );
  }
  eq(m.writes(), 0);
});
Deno.test("admin moderation: storage write failure surfaces and leaves auditable started action", async () => {
  const m = mock({}, `moderation/policies/${time}-${"c".repeat(64)}.json`);
  await rejects(() =>
    authorizedModerationRequest(
      request("/admin/moderation", "PUT", {
        mode: "manual",
        trustedReporters: [],
      }),
      m.storage,
    )
  );
  eq(
    (m.files.get(`moderation/audit/${"c".repeat(64)}.json`) as {
      status: string;
    }).status,
    "started",
  );
  eq(m.files.has(`moderation/policies/${time}-${"c".repeat(64)}.json`), false);
});

Deno.test("admin moderation: delayed older operations cannot replace newer signed versions", async () => {
  await withPurge(async () => {
    const r = row("f".repeat(64));
    const m = mock({ [`moderation/reports/${r.id}.json`]: r });
    const olderId = "2".repeat(64), newerId = "1".repeat(64);
    const cases = [
      {
        path: `/admin/hashes/${hash}`,
        old: { blocked: true, automationProtected: false, reason: "older" },
        next: { blocked: false, automationProtected: true, reason: "newer" },
      },
      {
        path: "/admin/moderation",
        old: { mode: "all", trustedReporters: [] },
        next: { mode: "manual", trustedReporters: [] },
      },
      {
        path: `/admin/reports/${r.id}`,
        old: { status: "pending", reason: "older" },
        next: { status: "dismissed", reason: "newer" },
      },
    ];
    for (let i = 0; i < cases.length; i++) {
      const item = cases[i],
        oldId = olderId.slice(0, 63) + String(i),
        newId = newerId.slice(0, 63) + String(i);
      const put = m.storage.putJson.bind(m.storage);
      let reached!: () => void, resume!: () => void;
      const waiting = new Promise<void>((resolve) => reached = resolve);
      const barrier = new Promise<void>((resolve) => resume = resolve);
      m.storage.putJson = async (path, value) => {
        if (
          !path.startsWith("moderation/audit/") &&
          path.endsWith(`${time}-${oldId}.json`)
        ) {
          reached();
          await barrier;
        }
        return put(path, value);
      };
      const delayed = authorizedModerationRequest(
        request(item.path, "PUT", item.old, oldId, time),
        m.storage,
      );
      await waiting;
      eq(
        (await authorizedModerationRequest(
          request(item.path, "PUT", item.next, newId, time + 10),
          m.storage,
        )).status,
        200,
      );
      resume();
      eq((await delayed).status, 200);
      m.storage.putJson = put;
      if (i === 0) {
        eq((await getControl(m.storage, hash))?.automationProtected, true);
      }
      if (i === 1) eq((await getPolicy(m.storage)).mode, "manual");
      if (i === 2) eq((await getReview(m.storage, r.id))?.status, "dismissed");
      const count = m.writes();
      eq(
        (await authorizedModerationRequest(
          request(item.path, "PUT", item.old, oldId, time),
          m.storage,
        )).status,
        409,
      );
      eq(m.writes(), count);
    }
  });
});

Deno.test("admin moderation: listing and processing continue through bounded cursor batches", async () => {
  const records = Array.from(
    { length: 31 },
    (_, i) => row(i.toString(16).padStart(64, "0")),
  );
  const m = mock(
    Object.fromEntries(
      records.map((r) => [`moderation/reports/${r.id}.json`, r]),
    ),
  );
  const originalGet = m.storage.get.bind(m.storage);
  let hydrated = 0;
  m.storage.get = (path) => {
    if (/^moderation\/reports\/[0-9a-f]{64}\.json$/.test(path)) hydrated++;
    return originalGet(path);
  };
  const first = await (await authorizedModerationRequest(
    request("/admin/reports?pageSize=100"),
    m.storage,
  )).json();
  eq(first.reports.length, 25);
  eq(hydrated, 25);
  eq(typeof first.nextCursor, "string");
  eq(first.stats.total, 25);
  const second = await (await authorizedModerationRequest(
    request(`/admin/reports?cursor=${encodeURIComponent(first.nextCursor)}`),
    m.storage,
  )).json();
  eq(second.reports.length, 6);
  eq(second.nextCursor, null);
  eq(second.stats.total, 6);
  eq(
    new Set(
      [...first.reports, ...second.reports].map((r: ModerationReport) => r.id),
    ).size,
    31,
  );
  const processing = await (await authorizedModerationRequest(
    request("/admin/moderation/process", "POST", {}, "1".repeat(64)),
    m.storage,
  )).json();
  eq(processing.processed, 25);
  eq(processing.skipped, 25);
  eq(typeof processing.nextCursor, "string");
  const rest = await (await authorizedModerationRequest(
    request("/admin/moderation/process", "POST", {
      cursor: processing.nextCursor,
    }, "2".repeat(64)),
    m.storage,
  )).json();
  eq(rest.processed, 6);
  eq(rest.nextCursor, null);
});

Deno.test("admin moderation: legacy review requires its hash and avoids scanning the queue", async () => {
  const r = row("f".repeat(64)),
    m = mock({ [`reports/${hash}.json`]: { reports: [r.event] } });
  const read = m.storage.get.bind(m.storage), paths: string[] = [];
  m.storage.get = (path) => {
    paths.push(path);
    return read(path);
  };
  eq(
    (await authorizedModerationRequest(
      request(`/admin/reports/${r.id}`, "PUT", {
        status: "reviewed",
        reason: "review",
      }),
      m.storage,
    )).status,
    404,
  );
  eq(
    (await authorizedModerationRequest(
      request(`/admin/reports/${r.id}`, "PUT", {
        status: "reviewed",
        reason: "review",
        sha256: hash,
      }),
      m.storage,
    )).status,
    200,
  );
  eq(paths.includes("reports/"), false);
  eq(paths.includes("moderation/reports/"), false);
  eq((await getReview(m.storage, r.id))?.status, "reviewed");
});

Deno.test("admin moderation: purge retry survives switch to manual and clears failure only on success", async () => {
  await withPurge(async () => {
    const r = row("f".repeat(64)),
      m = mock({
        [`moderation/reports/${r.id}.json`]: r,
        "moderation/policy.json": { mode: "all", trustedReporters: [] },
      });
    let purges = 0;
    globalThis.fetch = () => {
      purges++;
      return Promise.resolve(new Response("failed", { status: 503 }));
    };
    const failed = await (await authorizedModerationRequest(
      request("/admin/moderation/process", "POST", {}, "1".repeat(64)),
      m.storage,
    )).json();
    eq(failed.failed, 1);
    eq(m.files.get(`moderation/processing/${r.id}.json`), { failed: true });
    m.files.set("moderation/policy.json", {
      mode: "manual",
      trustedReporters: [],
    });
    const retry = await (await authorizedModerationRequest(
      request("/admin/moderation/process", "POST", {}, "2".repeat(64)),
      m.storage,
    )).json();
    eq(retry.failed, 1);
    eq(purges, 2);
    eq(m.files.get(`moderation/processing/${r.id}.json`), { failed: true });
    globalThis.fetch = () => {
      purges++;
      return Promise.resolve(new Response("OK"));
    };
    const success = await (await authorizedModerationRequest(
      request("/admin/moderation/process", "POST", {}, "3".repeat(64)),
      m.storage,
    )).json();
    eq(success.failed, 0);
    eq(success.skipped, 1);
    eq(purges, 4);
    eq(m.files.get(`moderation/processing/${r.id}.json`), { failed: false });
  });
});
