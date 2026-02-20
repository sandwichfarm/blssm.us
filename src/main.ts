import * as BunnySDK from "@bunny.net/edgescript-sdk";
import process from "node:process";
import { route } from "./router.ts";
import { StorageClient } from "./storage/client.ts";
import type { Config } from "./types.ts";

function getConfig(): Config {
  const env = (key: string, fallback?: string): string => {
    const val = process.env[key] ?? fallback;
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
  };

  return {
    storageAccessKey: env("BUNNY_STORAGE_ACCESS_KEY"),
    storageZone: env("BUNNY_STORAGE_ZONE"),
    storageRegion: env("BUNNY_STORAGE_REGION", "storage"),
    cdnHostname: env("BUNNY_CDN_HOSTNAME"),
    serverUrl: env("SERVER_URL"),
    maxUploadSize: parseInt(env("MAX_UPLOAD_SIZE", "104857600"), 10), // 100MB default
  };
}

const config = getConfig();
const storage = new StorageClient(config);

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  return route(request, storage, config);
});
