import type { NostrEvent } from "../types.ts";
import type { StorageClient } from "./client.ts";
import { parse as parseToml } from "@std/toml";
import process from "node:process";
import { readLimitedBody } from "../http-body.ts";

export type ModerationMode = "manual" | "trusted" | "all";
export interface ModerationPolicy {
  mode: ModerationMode;
  trustedReporters: string[];
}
export interface ModerationReport {
  id: string;
  sha256: string;
  event: NostrEvent;
  receivedAt: number;
  pow: number;
}
export interface HashControl {
  blocked: boolean;
  automationProtected: boolean;
  updatedAt: number;
  reason: string;
  actor: string;
}
export interface ReportReview {
  status: "pending" | "reviewed" | "dismissed";
  reason: string;
  updatedAt: number;
  actor: string;
}
export interface ModerationState {
  blocked: boolean | null;
  automationProtected: boolean;
  source: "manual" | "automatic" | null;
}

/** Strict reads: an unavailable moderation store must never look like an empty one. */
export async function readJson<T>(
  storage: StorageClient,
  path: string,
): Promise<T | null> {
  const response = await storage.get(path);
  if (!response) return null;
  if (!response.ok) {
    throw new Error(`Moderation read failed (${response.status})`);
  }
  return JSON.parse(
    new TextDecoder().decode(await readLimitedBody(response, 4 * 1024 * 1024)),
  ) as T;
}

export async function listFiles(
  storage: StorageClient,
  prefix: string,
): Promise<string[]> {
  const response = await storage.get(`${prefix}/`);
  if (!response) return [];
  if (!response.ok) {
    throw new Error(`Moderation listing failed (${response.status})`);
  }
  const entries: Array<{ ObjectName: string; IsDirectory: boolean }> = JSON
    .parse(
      new TextDecoder().decode(
        await readLimitedBody(response, 16 * 1024 * 1024),
      ),
    );
  if (!Array.isArray(entries)) throw new Error("Invalid moderation listing");
  return entries.filter((entry) =>
    !entry.IsDirectory && !entry.ObjectName.includes("/")
  )
    .map((entry) => `${prefix}/${entry.ObjectName}`);
}

/** Count actual leading zero bits, not the claimed nonce target. */
export function reportPow(id: string): number {
  let bits = 0;
  for (const char of id) {
    const value = parseInt(char, 16);
    if (value === 0) bits += 4;
    else return bits + Math.clz32(value) - 28;
  }
  return bits;
}

export async function getPolicy(
  storage: StorageClient,
): Promise<ModerationPolicy> {
  return await latestVersion<ModerationPolicy>(
    storage,
    "moderation/policies",
    "moderation/policy.json",
  ) ??
    { mode: "manual", trustedReporters: [] };
}

export async function latestVersion<T>(
  storage: StorageClient,
  prefix: string,
  fallback: string,
): Promise<T | null> {
  const versions = (await listFiles(storage, prefix)).filter((path) =>
    /\/\d{13}-[0-9a-f]{64}\.json$/.test(path)
  ).sort();
  return readJson<T>(storage, versions.at(-1) ?? fallback);
}

export function getControl(
  storage: StorageClient,
  sha256: string,
): Promise<HashControl | null> {
  return latestVersion<HashControl>(
    storage,
    `moderation/controls/${sha256}`,
    `moderation/controls/${sha256}.json`,
  );
}

export function getReview(
  storage: StorageClient,
  reportId: string,
): Promise<ReportReview | null> {
  return latestVersion<ReportReview>(
    storage,
    `moderation/reviews/${reportId}`,
    `moderation/reviews/${reportId}.json`,
  );
}

export async function storeReport(
  storage: StorageClient,
  sha256: string,
  event: NostrEvent,
): Promise<boolean> {
  const receivedAt = Date.now();
  const path = `moderation/reports/${event.id}.json`;
  // Preserve receipt time on retries; replay cannot become a new automatic action.
  if (await readJson<ModerationReport>(storage, path)) return true;
  return storage.putJson(
    path,
    {
      id: event.id,
      sha256,
      event,
      receivedAt,
      pow: reportPow(event.id),
    } satisfies ModerationReport,
  );
}

export async function getModerationState(
  storage: StorageClient,
  sha256: string,
): Promise<ModerationState> {
  const [control, markers] = await Promise.all([
    getControl(storage, sha256),
    listFiles(storage, `moderation/automatic/${sha256}`),
  ]);
  const newest = markers.map((path) => path.split("/").at(-1)!)
    .filter((name) => /^\d{13}-[0-9a-f]{64}\.json$/.test(name)).sort().at(-1);
  const automaticAt = newest ? Number(newest.slice(0, 13)) : 0;
  if (
    control && (control.automationProtected || control.updatedAt >= automaticAt)
  ) {
    return {
      blocked: control.blocked,
      automationProtected: control.automationProtected,
      source: "manual",
    };
  }
  if (newest) {
    return { blocked: true, automationProtected: false, source: "automatic" };
  }
  return { blocked: null, automationProtected: false, source: null };
}

export async function applyReportPolicy(
  storage: StorageClient,
  report: ModerationReport,
  policy?: ModerationPolicy,
): Promise<"blocked" | "skipped"> {
  const currentPolicy = policy ?? await getPolicy(storage);
  if (
    currentPolicy.mode === "manual" ||
    (currentPolicy.mode === "trusted" &&
      !currentPolicy.trustedReporters.includes(report.event.pubkey))
  ) {
    return "skipped";
  }
  const [control, review] = await Promise.all([
    getControl(storage, report.sha256),
    getReview(storage, report.id),
  ]);
  if (
    review?.status === "dismissed" ||
    control &&
      (control.automationProtected || control.updatedAt >= report.receivedAt)
  ) return "skipped";
  const path =
    `moderation/automatic/${report.sha256}/${report.receivedAt}-${report.id}.json`;
  if (
    !await storage.putJson(path, {
      reportId: report.id,
      mode: currentPolicy.mode,
      receivedAt: report.receivedAt,
    })
  ) {
    throw new Error("Automatic block could not be stored");
  }
  await purgeModeratedBlob(storage, report.sha256);
  return (await getModerationState(storage, report.sha256)).blocked
    ? "blocked"
    : "skipped";
}

/** Invalidate previously cached byte responses when a moderation decision changes. */
export async function purgeModeratedBlob(
  storage: StorageClient,
  sha256: string,
): Promise<void> {
  const key = process.env["BUNNY_API_KEY"];
  if (!key) {
    throw new Error("BUNNY_API_KEY is required to purge moderated content");
  }
  for (
    const path of [`/${sha256}*`, `/blobs/${sha256.slice(0, 2)}/${sha256}*`]
  ) {
    const url = new URL("https://api.bunny.net/purge");
    url.searchParams.set("url", `https://${storage.cdnHostname.trim()}${path}`);
    url.searchParams.set("async", "false");
    const response = await fetch(url, {
      method: "POST",
      headers: { AccessKey: key },
    });
    await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(
        `Moderation cache purge failed (${response.status})`,
      );
    }
  }
}

/** Bounded concurrency for object storage; list responses themselves are paginated by the API. */
export async function mapStorage<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await fn(items[index]);
      }
    }),
  );
  return result;
}

export async function loadReports(
  storage: StorageClient,
): Promise<ModerationReport[]> {
  const [currentPaths, legacyPaths] = await Promise.all([
    listFiles(storage, "moderation/reports"),
    listFiles(storage, "reports"),
  ]);
  const current = await mapStorage(
    currentPaths.filter((path) => /\/[0-9a-f]{64}\.json$/.test(path)),
    (path) => readJson<ModerationReport>(storage, path),
  );
  const reports = new Map(
    current.filter((report): report is ModerationReport => !!report).map((
      report,
    ) => [report.id, report]),
  );
  const legacy = await mapStorage(
    legacyPaths.filter((path) => /\/[0-9a-f]{64}\.json$/.test(path)),
    (path) => readJson<{ reports: NostrEvent[] }>(storage, path),
  );
  for (const file of legacy) {
    for (const event of file?.reports ?? []) {
      const sha256 = event.tags.find((tag) => tag[0] === "x")?.[1];
      if (!sha256 || reports.has(event.id)) continue;
      reports.set(event.id, {
        id: event.id,
        sha256,
        event,
        receivedAt: event.created_at * 1000,
        pow: reportPow(event.id),
      });
    }
  }
  return [...reports.values()];
}

/** Hydrate at most 25 reports per edge invocation; callers continue with the opaque cursor. */
export async function loadReportBatch(storage: StorageClient, cursor?: string) {
  let position = { path: "", offset: 0 };
  if (cursor) {
    try {
      position = JSON.parse(atob(cursor));
      if (
        !/^(moderation\/reports|reports)\/[0-9a-f]{64}\.json$/.test(
          position.path,
        ) ||
        !Number.isSafeInteger(position.offset) || position.offset < 0
      ) throw new Error();
    } catch {
      throw new RangeError("Invalid report cursor");
    }
  }
  const [current, legacy] = await Promise.all([
    listFiles(storage, "moderation/reports"),
    listFiles(storage, "reports"),
  ]);
  const allPaths = [...current, ...legacy].filter((path) =>
    /\/[0-9a-f]{64}\.json$/.test(path)
  ).sort();
  const currentIds = new Set(
    current.map((path) => path.split("/").at(-1)!.replace(/\.json$/, "")),
  );
  const paths = allPaths.filter((path) => path >= position.path);
  const reports: ModerationReport[] = [];
  let nextCursor: string | null = null;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    let entries: ModerationReport[];
    if (path.startsWith("moderation/")) {
      const report = await readJson<ModerationReport>(storage, path);
      entries = report ? [report] : [];
    } else {
      const legacyFile = await readJson<{ reports: NostrEvent[] }>(
        storage,
        path,
      );
      entries = (legacyFile?.reports ?? []).filter((event) =>
        !currentIds.has(event.id)
      ).map((event) => ({
        id: event.id,
        sha256: event.tags.find((tag) => tag[0] === "x")?.[1] ??
          path.split("/").at(-1)!.slice(0, 64),
        event,
        receivedAt: event.created_at * 1000,
        pow: reportPow(event.id),
      }));
    }
    const start = path === position.path ? position.offset : 0;
    const take = entries.slice(start, start + 25 - reports.length);
    reports.push(...take);
    if (reports.length === 25) {
      const offset = start + take.length;
      if (offset < entries.length) {
        nextCursor = btoa(JSON.stringify({ path, offset }));
      } else if (paths[index + 1]) {
        nextCursor = btoa(
          JSON.stringify({ path: paths[index + 1], offset: 0 }),
        );
      }
      break;
    }
  }
  return { reports, nextCursor, scanTotal: allPaths.length };
}

export async function legacyBlocked(
  storage: StorageClient,
): Promise<Set<string>> {
  const response = await storage.get("config/blocked.toml");
  if (!response) return new Set();
  if (!response.ok) throw new Error("Blocklist unavailable");
  const config = parseToml(await response.text());
  return new Set((config.hashes ?? []) as string[]);
}

export async function reportRows(
  storage: StorageClient,
  batch?: ModerationReport[],
) {
  const [reports, legacy] = await Promise.all([
    batch ? Promise.resolve(batch) : loadReports(storage),
    legacyBlocked(storage),
  ]);
  const hashes = [...new Set(reports.map((report) => report.sha256))];
  const states = new Map(
    await mapStorage(
      hashes,
      async (hash) => [hash, await getModerationState(storage, hash)] as const,
    ),
  );
  return mapStorage(reports, async (report) => {
    const state = states.get(report.sha256)!;
    const blocked = state.blocked ?? legacy.has(report.sha256);
    const review = await getReview(storage, report.id);
    const processing = await readJson<{ failed: boolean }>(
      storage,
      `moderation/processing/${report.id}.json`,
    );
    const status = review?.status === "dismissed"
      ? "dismissed"
      : blocked
      ? "blocked"
      : review?.status === "reviewed" ||
          state.source === "manual" && state.blocked === false
      ? "allowed"
      : "pending";
    return {
      ...report,
      pow: reportPow(report.event.id),
      category: report.event.tags.find((tag) => tag[0] === "x")?.[2] ?? "other",
      ...state,
      blocked,
      status,
      automationError: processing?.failed ?? false,
      review: review ?? null,
    };
  });
}
