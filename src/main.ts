import * as BunnySDK from "@bunny.net/edgescript-sdk";
import process from "node:process";
import { route } from "./router.ts";
import { StorageClient } from "./storage/client.ts";
import type { Config } from "./types.ts";
import { startPriceFeedCron } from "./middleware/price-feed.ts";

function getConfig(): Config {
  const env = (key: string, fallback?: string): string => {
    const val = process.env[key] ?? fallback;
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
  };

  return {
    storagePassword: env("BUNNY_STORAGE_PASSWORD"),
    storageHostname: env("BUNNY_STORAGE_HOSTNAME"),
    storageUsername: env("BUNNY_STORAGE_USERNAME"),
    cdnHostname: env("BUNNY_CDN_HOSTNAME"),
    serverUrl: env("SERVER_URL"),
    maxUploadSize: parseInt(env("MAX_UPLOAD_SIZE", "104857600"), 10), // 100MB default
    spaStoragePassword: process.env["BUNNY_SPA_STORAGE_PASSWORD"],
    spaStorageHostname: process.env["BUNNY_SPA_STORAGE_HOSTNAME"],
    spaStorageUsername: process.env["BUNNY_SPA_STORAGE_USERNAME"],
  };
}

const config = getConfig();
const storage = new StorageClient(config);

startPriceFeedCron();

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  return route(request, storage, config);
});
