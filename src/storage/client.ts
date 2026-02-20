import type { Config } from "../types.ts";

/** Bunny Storage REST API client */
export class StorageClient {
  private baseUrl: string;
  private accessKey: string;
  private zone: string;
  public cdnHostname: string;

  constructor(config: Config) {
    this.baseUrl = `https://${config.storageHostname}/${config.storageUsername}`;
    this.accessKey = config.storagePassword;
    this.zone = config.storageUsername;
    this.cdnHostname = config.cdnHostname;
  }

  private headers(): Record<string, string> {
    return {
      AccessKey: this.accessKey,
    };
  }

  /** Upload/PUT a file to storage */
  async put(path: string, body: BodyInit, contentType?: string): Promise<boolean> {
    const headers: Record<string, string> = {
      ...this.headers(),
      "Content-Type": contentType || "application/octet-stream",
    };
    const resp = await fetch(`${this.baseUrl}/${path}`, {
      method: "PUT",
      headers,
      body,
    });
    return resp.status === 201;
  }

  /** Download/GET a file from storage. Returns null if not found. */
  async get(path: string): Promise<Response | null> {
    const resp = await fetch(`${this.baseUrl}/${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (resp.status === 404) return null;
    return resp;
  }

  /** HEAD request — check if file exists and get headers */
  async head(path: string): Promise<Response | null> {
    const resp = await fetch(`${this.baseUrl}/${path}`, {
      method: "HEAD",
      headers: this.headers(),
    });
    if (resp.status === 404) return null;
    return resp;
  }

  /** Delete a file from storage */
  async delete(path: string): Promise<boolean> {
    const resp = await fetch(`${this.baseUrl}/${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    return resp.status === 200;
  }

  /** Read JSON from storage */
  async getJson<T>(path: string): Promise<T | null> {
    const resp = await this.get(path);
    if (!resp) return null;
    try {
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }

  /** Write JSON to storage */
  async putJson(path: string, data: unknown): Promise<boolean> {
    const body = new TextEncoder().encode(JSON.stringify(data));
    return this.put(path, body, "application/json");
  }

  /** Get the public CDN URL for a blob */
  blobUrl(sha256: string): string {
    const pre = sha256.substring(0, 2);
    return `https://${this.cdnHostname}/blobs/${pre}/${sha256}`;
  }

  /** Get the storage path for a blob */
  blobPath(sha256: string): string {
    const pre = sha256.substring(0, 2);
    return `blobs/${pre}/${sha256}`;
  }

  /** Get the storage path for blob metadata */
  metaPath(sha256: string): string {
    const pre = sha256.substring(0, 2);
    return `meta/${pre}/${sha256}.json`;
  }

  /** Get the storage path for a pubkey's blob index */
  listPath(pubkey: string): string {
    const pre = pubkey.substring(0, 2);
    return `lists/${pre}/${pubkey}/index.json`;
  }

  /** Get the storage path for reports on a blob */
  reportPath(sha256: string): string {
    return `reports/${sha256}.json`;
  }
}
