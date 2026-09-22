import type { StorageClient } from "../storage/client.ts";
import {
  MODERATION_ADMIN_PUBKEY,
  validateModerationAdmin,
} from "../auth/admin.ts";
import { isValidSha256, jsonResponse } from "../util.ts";
import {
  applyReportPolicy,
  getPolicy,
  loadReportBatch,
  type ModerationPolicy,
  purgeModeratedBlob,
  readJson,
  reportRows,
} from "../storage/moderation.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function handleAdminModeration(
  request: Request,
  storage: StorageClient,
): Promise<Response> {
  const authError = await validateModerationAdmin(request);
  if (authError) {
    return new Response(authError.body, {
      status: authError.status,
      headers: { ...NO_STORE, "Content-Type": "application/json" },
    });
  }
  try {
    return await authorizedModerationRequest(request, storage);
  } catch (error) {
    if (
      error instanceof RangeError && error.message === "Invalid report cursor"
    ) return jsonResponse({ message: error.message }, 400, NO_STORE);
    console.error(
      "Moderation operation failed",
      error instanceof Error ? error.message : "Unknown failure",
    );
    return jsonResponse(
      { message: "Moderation storage unavailable; refresh and retry" },
      503,
      NO_STORE,
    );
  }
}

/** Internal dispatch, called only after NIP98 validation by the public handler. */
export async function authorizedModerationRequest(
  request: Request,
  storage: StorageClient,
): Promise<Response> {
  const url = new URL(request.url);
  const respond = (body: unknown, status = 200) =>
    jsonResponse(body, status, NO_STORE);
  if (request.method === "GET" && url.pathname === "/admin/session") {
    return respond({ pubkey: MODERATION_ADMIN_PUBKEY });
  }
  if (request.method === "GET" && url.pathname === "/admin/reports") {
    const status = url.searchParams.get("status") ?? "all";
    const sort = url.searchParams.get("sort") ?? "receivedAt";
    const order = url.searchParams.get("order") ?? "desc";
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    if (
      !["all", "pending", "blocked", "dismissed", "allowed"].includes(status) ||
      !["receivedAt", "pow", "category", "sha256", "pubkey", "status"].includes(
        sort,
      ) ||
      !["asc", "desc"].includes(order) || !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    ) {
      return respond({ message: "Invalid report filters or pagination" }, 400);
    }
    const batch = await loadReportBatch(
      storage,
      url.searchParams.get("cursor") ?? undefined,
    );
    const [rows, policy] = await Promise.all([
      reportRows(storage, batch.reports),
      getPolicy(storage),
    ]);
    const stats = {
      total: rows.length,
      pending: rows.filter((row) => row.status === "pending").length,
      blocked: rows.filter((row) => row.status === "blocked").length,
      dismissed: rows.filter((row) => row.status === "dismissed").length,
      allowed: rows.filter((row) => row.status === "allowed").length,
      uniqueHashes: new Set(rows.map((row) => row.sha256)).size,
      protectedHashes: new Set(
        rows.filter((row) => row.automationProtected).map((row) => row.sha256),
      ).size,
      averagePow: rows.length
        ? rows.reduce((sum, row) => sum + row.pow, 0) / rows.length
        : 0,
    };
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const filtered = rows.filter((row) =>
      (status === "all" || row.status === status) &&
      (!q ||
        [row.sha256, row.event.pubkey, row.event.content, row.category, row.id]
          .some((value) => value.toLowerCase().includes(q)))
    );
    const value = (row: typeof rows[number]): string | number =>
      sort === "pubkey"
        ? row.event.pubkey
        : row[sort as "receivedAt" | "pow" | "category" | "sha256" | "status"];
    filtered.sort((a, b) => {
      const left = value(a), right = value(b);
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
      return (order === "asc" ? 1 : -1) *
        (comparison || a.id.localeCompare(b.id));
    });
    return respond({
      reports: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      stats,
      policy,
      nextCursor: batch.nextCursor,
      scanTotal: batch.scanTotal,
    });
  }
  if (!["PUT", "POST"].includes(request.method)) {
    return respond({ message: "Not found" }, 404);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid body");
    }
    body = parsed;
  } catch {
    return respond({ message: "Expected a JSON object" }, 400);
  }
  const hashMatch = url.pathname.match(/^\/admin\/hashes\/([0-9a-f]{64})$/);
  const reportMatch = url.pathname.match(/^\/admin\/reports\/([0-9a-f]{64})$/);
  const policyUpdate = request.method === "PUT" &&
    url.pathname === "/admin/moderation";
  const process = request.method === "POST" &&
    url.pathname === "/admin/moderation/process";
  if (
    !policyUpdate && !process &&
    !(request.method === "PUT" && (hashMatch || reportMatch))
  ) {
    return respond({ message: "Not found" }, 404);
  }
  if (
    policyUpdate &&
    (!["manual", "trusted", "all"].includes(String(body.mode)) ||
      !Array.isArray(body.trustedReporters) ||
      body.trustedReporters.length > 1000 ||
      !body.trustedReporters.every((key) =>
        typeof key === "string" && isValidSha256(key)
      ))
  ) {
    return respond(
      { message: "Invalid mode or trusted reporter public keys" },
      400,
    );
  }
  if (
    hashMatch &&
    (typeof body.blocked !== "boolean" ||
      typeof body.automationProtected !== "boolean")
  ) {
    return respond({
      message: "blocked and automationProtected must be booleans",
    }, 400);
  }
  if (
    reportMatch &&
    !["pending", "reviewed", "dismissed"].includes(String(body.status))
  ) {
    return respond({ message: "Invalid report review status" }, 400);
  }
  if (
    (hashMatch || reportMatch) &&
    (typeof body.reason !== "string" || body.reason.length > 2000)
  ) {
    return respond({
      message: "A reason string of at most 2000 characters is required",
    }, 400);
  }
  if (
    reportMatch &&
    !await readJson(storage, `moderation/reports/${reportMatch[1]}.json`)
  ) {
    const legacy = typeof body.sha256 === "string" && isValidSha256(body.sha256)
      ? await readJson<{ reports: { id: string }[] }>(
        storage,
        `reports/${body.sha256}.json`,
      )
      : null;
    if (!legacy?.reports.some((report) => report.id === reportMatch[1])) {
      return respond({ message: "Report not found" }, 404);
    }
  }
  const auth = JSON.parse(atob(request.headers.get("Authorization")!.slice(6)));
  // Signed millisecond time makes retries identical even across edge isolates.
  const actionAt = Number(
    auth.tags.find((tag: string[]) => tag[0] === "created_at_ms")?.[1],
  );
  const version = `${actionAt}-${auth.id}.json`;
  const auditPath = `moderation/audit/${auth.id}.json`;
  if (await readJson(storage, auditPath)) {
    return respond({
      message: "Authorization already used; sign a fresh request",
    }, 409);
  }
  const audit = {
    id: auth.id,
    actor: MODERATION_ADMIN_PUBKEY,
    at: actionAt,
    method: request.method,
    path: url.pathname,
    body,
    status: "started",
  };
  if (!await storage.putJson(auditPath, audit)) {
    throw new Error("Could not persist moderation audit");
  }

  let result: unknown;
  if (policyUpdate) {
    const policy: ModerationPolicy = {
      mode: body.mode as ModerationPolicy["mode"],
      trustedReporters: [...new Set(body.trustedReporters as string[])],
    };
    if (!await storage.putJson(`moderation/policies/${version}`, policy)) {
      throw new Error("Could not save moderation policy");
    }
    result = policy;
  } else if (hashMatch) {
    const control = {
      blocked: body.blocked,
      automationProtected: body.automationProtected,
      reason: body.reason,
      updatedAt: actionAt,
      actor: MODERATION_ADMIN_PUBKEY,
    };
    if (
      !await storage.putJson(
        `moderation/controls/${hashMatch[1]}/${version}`,
        control,
      )
    ) throw new Error("Could not save hash control");
    await purgeModeratedBlob(storage, hashMatch[1]);
    result = control;
  } else if (reportMatch) {
    const review = {
      status: body.status,
      reason: body.reason,
      updatedAt: actionAt,
      actor: MODERATION_ADMIN_PUBKEY,
    };
    if (
      !await storage.putJson(
        `moderation/reviews/${reportMatch[1]}/${version}`,
        review,
      )
    ) throw new Error("Could not save report review");
    result = review;
  } else {
    const batch = await loadReportBatch(
      storage,
      typeof body.cursor === "string" ? body.cursor : undefined,
    );
    const [rows, policy] = await Promise.all([
      reportRows(storage, batch.reports),
      getPolicy(storage),
    ]);
    const counts = { processed: 0, blocked: 0, skipped: 0, failed: 0 };
    for (
      const report of rows.filter((row) =>
        row.status === "pending" || row.automationError ||
        row.source === "automatic"
      )
    ) {
      counts.processed++;
      try {
        if (report.automationError || report.source === "automatic") {
          await purgeModeratedBlob(storage, report.sha256);
        }
        const outcome = await applyReportPolicy(storage, report, policy);
        if (
          !await storage.putJson(`moderation/processing/${report.id}.json`, {
            failed: false,
          })
        ) throw new Error("Could not save processing result");
        counts[outcome]++;
      } catch {
        counts.failed++;
        if (
          !await storage.putJson(`moderation/processing/${report.id}.json`, {
            failed: true,
          })
        ) throw new Error("Could not save processing failure");
      }
    }
    result = { ...counts, nextCursor: batch.nextCursor };
  }
  if (
    !await storage.putJson(auditPath, { ...audit, status: "completed", result })
  ) {
    throw new Error("Action applied but audit completion could not be saved");
  }
  return respond(result);
}
