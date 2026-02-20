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

  // Try the requested path first
  let resp = await fetch(`${baseUrl}${path}`, { headers });

  // If not found, fall back to /index.html for SPA client-side routing
  if (resp.status === 404 && !hasFileExtension(path)) {
    resp = await fetch(`${baseUrl}/index.html`, { headers });
  }

  if (resp.status === 404) {
    return new Response("Not Found", { status: 404 });
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
