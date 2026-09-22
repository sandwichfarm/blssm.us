import type { ISigner } from 'applesauce-signers';
import { getEventHash, nip19, verifyEvent } from 'nostr-tools';

export const ADMIN_PUBKEY = 'e771af0b05c8e95fcdf6feb3500544d2fb1ccd384788e9f490bb3ee28e8ed66f';

export interface ModerationPolicy {
  mode: 'manual' | 'trusted' | 'all';
  trustedReporters: string[];
}

export interface Report {
  id: string;
  sha256: string;
  event: { pubkey: string; content: string; tags: string[][]; [key: string]: unknown };
  receivedAt: number;
  pow: number;
  category: string;
  status: string;
  blocked: boolean;
  automationProtected: boolean;
  automationError?: boolean;
  source: 'manual' | 'automatic' | null;
}

export interface ReportPage {
  reports: Report[];
  total: number;
  page: number;
  pageSize: number;
  stats: { total: number; pending: number; blocked: number; dismissed: number; allowed: number;
    uniqueHashes: number; protectedHashes: number; averagePow: number };
  policy: ModerationPolicy;
  nextCursor?: string | null;
  scanTotal?: number;
}

export function reportView(
  reports: Report[], policy: ModerationPolicy,
  options: { status: string; query: string; sort: string; order: string; page: number; pageSize: number },
): ReportPage {
  const query = options.query.trim().toLowerCase();
  const filtered = reports.filter(report =>
    (options.status === 'all' || report.status === options.status) &&
    (!query || [report.sha256, report.event.pubkey, report.event.content].some(value => value.toLowerCase().includes(query))));
  const value = (report: Report): string | number => {
    switch (options.sort) {
      case 'pow': return report.pow;
      case 'sha256': return report.sha256;
      case 'category': return report.category;
      case 'pubkey': return report.event.pubkey;
      case 'status': return report.status;
      default: return report.receivedAt;
    }
  };
  filtered.sort((left, right) => {
    const a = value(left), b = value(right);
    const comparison = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
    return (comparison || left.id.localeCompare(right.id)) * (options.order === 'asc' ? 1 : -1);
  });
  const page = Math.max(1, Math.min(options.page, Math.ceil(filtered.length / options.pageSize) || 1));
  return {
    reports: filtered.slice((page - 1) * options.pageSize, page * options.pageSize),
    total: filtered.length, page, pageSize: options.pageSize, policy,
    stats: {
      total: reports.length,
      pending: reports.filter(report => report.status === 'pending').length,
      blocked: reports.filter(report => report.blocked).length,
      dismissed: reports.filter(report => report.status === 'dismissed').length,
      allowed: reports.filter(report => report.status === 'allowed').length,
      uniqueHashes: new Set(reports.map(report => report.sha256)).size,
      protectedHashes: new Set(reports.filter(report => report.automationProtected).map(report => report.sha256)).size,
      averagePow: reports.length ? reports.reduce((sum, report) => sum + report.pow, 0) / reports.length : 0,
    },
  };
}

export function normalizePubkey(value: string): string {
  const key = value.trim();
  if (/^[0-9a-f]{64}$/i.test(key)) return key.toLowerCase();
  try {
    const decoded = nip19.decode(key);
    if (decoded.type === 'npub') return decoded.data;
  } catch { /* Fall through to the actionable error. */ }
  throw new Error(`Invalid reporter key: ${key || '(empty)'}. Use npub or 64-character hex.`);
}

export function parseTrustedReporters(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean).map(normalizePubkey))];
}

export async function adminRequest<T>(
  signer: ISigner,
  origin: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/admin/')) {
    throw new Error('Admin requests must stay on this server.');
  }
  const pubkey = await signer.getPublicKey();
  if (pubkey !== ADMIN_PUBKEY) throw new Error('This Nostr account is not an administrator.');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const tags = [['u', url.href], ['method', method], ['nonce', crypto.randomUUID()]];
  if (payload !== undefined) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    tags.push(['payload', Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')]);
  }
  const now = Date.now();
  if (method !== 'GET' && method !== 'HEAD') tags.push(['created_at_ms', String(now)]);
  const template = { kind: 27235, created_at: Math.floor(now / 1000), content: '', tags };
  const expectedId = getEventHash({ ...template, pubkey });
  const signed = await signer.signEvent(template);
  if (signed.id !== expectedId || !verifyEvent(signed)) {
    throw new Error('The signer changed the authorization request or returned an invalid signature.');
  }
  signal?.throwIfAborted();
  const headers: Record<string, string> = { Authorization: `Nostr ${btoa(JSON.stringify(signed))}` };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url.href, { method, headers, body: payload, signal, cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? data?.error ?? `Request failed (HTTP ${response.status}).`);
  return data as T;
}
