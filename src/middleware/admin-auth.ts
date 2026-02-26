/// <reference lib="deno.ns" />
import process from "node:process";
import { timingSafeEqual } from "node:crypto";

/**
 * Validate the X-Admin-Key header against the ADMIN_KEY env var.
 * Returns null if valid, or an error Response (401/500) if not.
 */
export function validateAdminKey(request: Request): Response | null {
  const adminKey = process.env["ADMIN_KEY"];
  if (!adminKey) {
    return new Response(JSON.stringify({ error: "server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const provided = request.headers.get("X-Admin-Key") ?? "";
  if (!constantTimeEqual(adminKey, provided)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

/** Constant-time string comparison to prevent timing attacks on the admin key. */
function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}
