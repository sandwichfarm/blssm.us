/** CORS headers required by Blossom spec (BUD-01) */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  // BUD-01 requires this exact form: `*` doesn't cover Authorization, so it's named separately
  "Access-Control-Allow-Headers": "Authorization, *",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, X-Cashu, X-Content-Type, X-Lightning, X-Max-Upload-Size, X-Reason, X-SHA-256, X-Upload-Message",
  "Access-Control-Max-Age": "86400",
};

/** Handle OPTIONS preflight requests */
export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/** Add CORS headers to an existing Response */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
