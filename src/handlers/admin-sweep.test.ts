/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert";
import { handleAdminSweep } from "./admin-sweep.ts";
import type { StorageClient } from "../storage/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set ADMIN_KEY for tests */
function setAdminKey(key: string): void {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).process = (globalThis as any).process ?? { env: {} };
  // deno-lint-ignore no-explicit-any
  ((globalThis as any).process.env)["ADMIN_KEY"] = key;
}

function makeRequest(adminKey?: string): Request {
  const headers: Record<string, string> = {};
  if (adminKey) headers["X-Admin-Key"] = adminKey;
  return new Request("https://example.com/admin/sweep", {
    method: "POST",
    headers,
  });
}

/** Mock StorageClient with inbox files */
function makeStorage(
  inboxFiles: Record<string, unknown>,
): StorageClient {
  const store = new Map<string, unknown>(Object.entries(inboxFiles));
  return {
    list: async (prefix: string) => {
      const dirPath = prefix.endsWith("/") ? prefix : `${prefix}/`;
      return [...store.keys()].filter((k) => k.startsWith(dirPath));
    },
    getJson: async <T>(path: string): Promise<T | null> => {
      return (store.get(path) as T) ?? null;
    },
    putJson: async (_path: string, _data: unknown): Promise<boolean> => {
      store.set(_path, _data);
      return true;
    },
    delete: async (path: string): Promise<boolean> => {
      store.delete(path);
      return true;
    },
  } as unknown as StorageClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("admin-sweep: rejects missing admin key with 401", async () => {
  setAdminKey("test-secret");
  const storage = makeStorage({});
  const resp = await handleAdminSweep(makeRequest(), storage);
  assertEquals(resp.status, 401);
});

Deno.test("admin-sweep: rejects wrong admin key with 401", async () => {
  setAdminKey("test-secret");
  const storage = makeStorage({});
  const resp = await handleAdminSweep(makeRequest("wrong-key"), storage);
  assertEquals(resp.status, 401);
});

Deno.test("admin-sweep: returns 400 when LND not configured", async () => {
  setAdminKey("test-secret");
  const storage = makeStorage({});
  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => null,
  });
  assertEquals(resp.status, 400);
  const body = await resp.json();
  assertEquals(body.error.includes("lightning not configured"), true);
});

Deno.test("admin-sweep: returns empty when no inbox files", async () => {
  setAdminKey("test-secret");
  const storage = makeStorage({});
  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 0);
  assertEquals(body.skipped.length, 0);
  assertEquals(body.errors.length, 0);
});

Deno.test("admin-sweep: skips mints below threshold", async () => {
  setAdminKey("test-secret");
  const storage = makeStorage({
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 50, secret: "s1", C: "02abc" }],
      totalSats: 50,
    },
  });
  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
  });
  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 0);
  assertEquals(body.skipped.length, 1);
  assertEquals(body.skipped[0].reason, "below_threshold");
  assertEquals(body.skipped[0].totalSats, 50);
});

Deno.test("admin-sweep: sweeps proofs above threshold", async () => {
  setAdminKey("test-secret");
  let invoiceCreated = false;
  let meltCalled = false;
  const deletedFiles: string[] = [];

  const store: Record<string, unknown> = {
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 200, secret: "s1", C: "02abc" }],
      totalSats: 200,
    },
  };

  const storage = {
    list: async (_prefix: string) => Object.keys(store).filter((k) => k.startsWith("wallet/inbox/")),
    getJson: async <T>(path: string): Promise<T | null> => (store[path] as T) ?? null,
    putJson: async (path: string, data: unknown): Promise<boolean> => {
      store[path] = data;
      return true;
    },
    delete: async (path: string): Promise<boolean> => {
      deletedFiles.push(path);
      delete store[path];
      return true;
    },
  } as unknown as StorageClient;

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => {
      invoiceCreated = true;
      return "lnbc200n1...";
    },
    meltProofs: async () => {
      meltCalled = true;
      return { paid: true };
    },
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 1);
  assertEquals(body.swept[0].mint, "https://mint.a.com");
  assertEquals(body.swept[0].sats, 200);
  assertEquals(body.swept[0].status, "success");
  assertEquals(invoiceCreated, true);
  assertEquals(meltCalled, true);
  assertEquals(deletedFiles.includes("wallet/inbox/1-abc.json"), true);
});

Deno.test("admin-sweep: aggregates multiple inbox files per mint", async () => {
  setAdminKey("test-secret");

  const store: Record<string, unknown> = {
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 60, secret: "s1", C: "02abc" }],
      totalSats: 60,
    },
    "wallet/inbox/2-def.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k2", amount: 50, secret: "s2", C: "02def" }],
      totalSats: 50,
    },
  };

  const storage = {
    list: async (_prefix: string) => Object.keys(store).filter((k) => k.startsWith("wallet/inbox/")),
    getJson: async <T>(path: string): Promise<T | null> => (store[path] as T) ?? null,
    putJson: async (path: string, data: unknown): Promise<boolean> => {
      store[path] = data;
      return true;
    },
    delete: async (path: string): Promise<boolean> => {
      delete store[path];
      return true;
    },
  } as unknown as StorageClient;

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => "lnbc110n1...",
    meltProofs: async () => ({ paid: true }),
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 1);
  assertEquals(body.swept[0].sats, 110);
});

Deno.test("admin-sweep: handles melt failure gracefully", async () => {
  setAdminKey("test-secret");

  const storage = makeStorage({
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 200, secret: "s1", C: "02abc" }],
      totalSats: 200,
    },
  });

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => "lnbc200n1...",
    meltProofs: async () => ({ paid: false }),
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 0);
  assertEquals(body.errors.length, 1);
  assertEquals(body.errors[0].error, "melt_failed: payment not settled");
});

Deno.test("admin-sweep: saves change proofs back to inbox", async () => {
  setAdminKey("test-secret");

  const store: Record<string, unknown> = {
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 200, secret: "s1", C: "02abc" }],
      totalSats: 200,
    },
  };

  const storage = {
    list: async (_prefix: string) => Object.keys(store).filter((k) => k.startsWith("wallet/inbox/")),
    getJson: async <T>(path: string): Promise<T | null> => (store[path] as T) ?? null,
    putJson: async (path: string, data: unknown): Promise<boolean> => {
      store[path] = data;
      return true;
    },
    delete: async (path: string): Promise<boolean> => {
      delete store[path];
      return true;
    },
  } as unknown as StorageClient;

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => "lnbc200n1...",
    meltProofs: async () => ({
      paid: true,
      change: [{ id: "k2", amount: 5, secret: "s-change", C: "02xyz" }],
    }),
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 1);

  // Check that a change file was saved (original was deleted, new one added)
  const remainingFiles = Object.keys(store).filter((k) => k.startsWith("wallet/inbox/"));
  assertEquals(remainingFiles.length, 1);
  // deno-lint-ignore no-explicit-any
  const changeEntry = store[remainingFiles[0]] as any;
  assertEquals(changeEntry.totalSats, 5);
  assertEquals(changeEntry.mint, "https://mint.a.com");
});

Deno.test("admin-sweep: handles invoice creation failure", async () => {
  setAdminKey("test-secret");

  const storage = makeStorage({
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 200, secret: "s1", C: "02abc" }],
      totalSats: 200,
    },
  });

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => null,
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.errors.length, 1);
  assertEquals(body.errors[0].error, "invoice_creation_failed");
});

Deno.test("admin-sweep: handles multiple mints independently", async () => {
  setAdminKey("test-secret");

  const store: Record<string, unknown> = {
    "wallet/inbox/1-abc.json": {
      mint: "https://mint.a.com",
      proofs: [{ id: "k1", amount: 200, secret: "s1", C: "02abc" }],
      totalSats: 200,
    },
    "wallet/inbox/2-def.json": {
      mint: "https://mint.b.com",
      proofs: [{ id: "k2", amount: 50, secret: "s2", C: "02def" }],
      totalSats: 50,
    },
  };

  const storage = {
    list: async (_prefix: string) => Object.keys(store).filter((k) => k.startsWith("wallet/inbox/")),
    getJson: async <T>(path: string): Promise<T | null> => (store[path] as T) ?? null,
    putJson: async (path: string, data: unknown): Promise<boolean> => {
      store[path] = data;
      return true;
    },
    delete: async (path: string): Promise<boolean> => {
      delete store[path];
      return true;
    },
  } as unknown as StorageClient;

  const resp = await handleAdminSweep(makeRequest("test-secret"), storage, {
    loadLnConfig: () => ({ endpoint: "https://lnd.test", macaroon: "abc" }),
    getThreshold: () => 100,
    createLnInvoice: async () => "lnbc200n1...",
    meltProofs: async () => ({ paid: true }),
  });

  assertEquals(resp.status, 200);
  const body = await resp.json();
  assertEquals(body.swept.length, 1);
  assertEquals(body.swept[0].mint, "https://mint.a.com");
  assertEquals(body.skipped.length, 1);
  assertEquals(body.skipped[0].mint, "https://mint.b.com");
  assertEquals(body.skipped[0].reason, "below_threshold");
});
