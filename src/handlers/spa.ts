import type { Config } from "../types.ts";

/**
 * Serve SPA files from a separate Bunny Storage zone.
 * Falls back to /index.html for client-side routing.
 */
export async function handleSpa(
  request: Request,
  config: Config,
): Promise<Response> {
  if (!config.spaStoragePassword || !config.spaStorageHostname || !config.spaStorageUsername) {
    return new Response("SPA not configured", { status: 404 });
  }

  const url = new URL(request.url);
  let path = url.pathname;

  // Normalize: strip trailing slash, default to /index.html
  if (path === "/") path = "/index.html";

  const headers = { AccessKey: config.spaStoragePassword };
  const baseUrl = `https://${config.spaStorageHostname}/${config.spaStorageUsername}`;

  let resp: Response;

  if (hasFileExtension(path)) {
    // Static asset — fetch directly, 404 if missing (don't fall through to index.html)
    resp = await fetch(`${baseUrl}${path}`, { headers });
    if (resp.status === 404) {
      return new Response("Not Found", { status: 404 });
    }
  } else {
    // SPA route (no extension) — go directly to index.html
    resp = await fetch(`${baseUrl}/index.html`, { headers });
    if (resp.status === 404) {
      return new Response("Not Found", { status: 404 });
    }
  }

  // Pass through with appropriate cache headers
  const respHeaders = new Headers(resp.headers);
  // Static assets with extensions get long cache, HTML gets short cache
  if (hasFileExtension(path) && !path.endsWith(".html")) {
    respHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    respHeaders.set("Cache-Control", "public, max-age=60");
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split("/").pop() || "";
  return lastSegment.includes(".");
}
