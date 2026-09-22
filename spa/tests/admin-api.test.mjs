import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as nostr from 'nostr-tools';

const source = readFileSync(new URL('../src/admin-api.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const secret = new Uint8Array(32);
secret[31] = 1;
const fixturePubkey = nostr.getPublicKey(secret);

function setup() {
  const calls = [];
  const context = vm.createContext({
    exports: {},
    require: name => {
      assert.equal(name, 'nostr-tools');
      return { ...nostr, getEventHash: event => nostr.getEventHash(JSON.parse(JSON.stringify(event))) };
    },
    URL, TextEncoder, crypto, btoa, AbortSignal,
    fetch: async (url, request) => {
      calls.push({ url, ...request });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  });
  vm.runInContext(compiled, context);
  assert.equal(context.exports.ADMIN_PUBKEY, 'e771af0b05c8e95fcdf6feb3500544d2fb1ccd384788e9f490bb3ee28e8ed66f');
  // Substitute only the allowlisted key, so fixtures use real Schnorr signatures
  // without possessing or impersonating the production administrator's key.
  context.exports.ADMIN_PUBKEY = fixturePubkey;
  const signer = {
    getPublicKey: async () => fixturePubkey,
    signEvent: async event => nostr.finalizeEvent(JSON.parse(JSON.stringify(event)), secret),
  };
  return { api: context.exports, calls, signer };
}

test('NIP-98 binds URL including query, method, payload and unique nonce', async () => {
  const { api, calls, signer } = setup();
  const body = { reason: 'Reversible decision', blocked: false, automationProtected: true };
  await api.adminRequest(signer, 'https://blssm.us', '/admin/hashes/abc?audit=1', 'PUT', body);
  await api.adminRequest(signer, 'https://blssm.us', '/admin/hashes/abc?audit=1', 'PUT', body);
  const events = calls.map(call => JSON.parse(atob(call.headers.Authorization.slice(6))));
  assert.notEqual(events[0].id, events[1].id, 'repeated actions need fresh authorization');
  for (const [index, event] of events.entries()) {
    assert.ok(nostr.verifyEvent(event));
    assert.equal(event.kind, 27235);
    assert.equal(event.content, '');
    assert.equal(event.pubkey, fixturePubkey);
    assert.ok(Math.abs(event.created_at - Math.floor(Date.now() / 1000)) < 5);
    const tags = Object.fromEntries(event.tags.map(([key, value]) => [key, value]));
    assert.equal(tags.u, calls[index].url);
    assert.equal(tags.u, 'https://blssm.us/admin/hashes/abc?audit=1');
    assert.equal(tags.method, 'PUT');
    assert.match(tags.created_at_ms, /^\d{13}$/);
    assert.equal(Math.floor(Number(tags.created_at_ms) / 1000), event.created_at);
    assert.equal(calls[index].body, JSON.stringify(body));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(calls[index].body));
    assert.equal(tags.payload, Buffer.from(digest).toString('hex'));
    assert.ok(tags.nonce);
  }
});

test('GET requests sign filters without a payload; foreign origins and non-admin accounts are rejected', async () => {
  const { api, calls, signer } = setup();
  await api.adminRequest(signer, 'https://blssm.us', '/admin/reports?sort=pow&order=desc');
  const event = JSON.parse(atob(calls[0].headers.Authorization.slice(6)));
  assert.equal(event.tags.find(tag => tag[0] === 'payload'), undefined);
  await assert.rejects(api.adminRequest(signer, 'https://blssm.us', 'https://example.com/admin/reports'), /stay on this server/);
  await assert.rejects(api.adminRequest({ ...signer, getPublicKey: async () => 'a'.repeat(64) }, 'https://blssm.us', '/admin/session'), /not an administrator/);
  assert.equal(calls.length, 1);
});

test('altered authorization and cancelled sessions never reach the server', async () => {
  const { api, calls, signer } = setup();
  const changedSigner = { ...signer, signEvent: event => signer.signEvent({ ...event, content: 'changed' }) };
  await assert.rejects(api.adminRequest(changedSigner, 'https://blssm.us', '/admin/session'), /signer changed/);
  await assert.rejects(api.adminRequest(signer, 'https://blssm.us', '/admin/session', 'GET', undefined, AbortSignal.abort()));
  assert.equal(calls.length, 0);
});

test('trusted reporter keys accept npub and hex, deduplicate, and reject malformed input', () => {
  const { api } = setup();
  const encoded = nostr.nip19.npubEncode(fixturePubkey);
  assert.equal(api.normalizePubkey(encoded), fixturePubkey);
  assert.equal(api.normalizePubkey(fixturePubkey.toUpperCase()), fixturePubkey);
  assert.deepEqual(Array.from(api.parseTrustedReporters(`${encoded},\n${fixturePubkey}`)), [fixturePubkey]);
  assert.throws(() => api.parseTrustedReporters('invalid'), /Invalid reporter key/);
  assert.throws(() => api.normalizePubkey(nostr.nip19.nsecEncode(secret)), /Invalid reporter key/);
});

test('complete report collection filters, sorts numeric PoW and paginates locally with global statistics', () => {
  const { api } = setup();
  const reports = [
    { id: 'a', sha256: '1'.repeat(64), event: { pubkey: fixturePubkey, content: 'Phishing file' }, receivedAt: 10, pow: 8, category: 'malware', status: 'pending', blocked: false, automationProtected: true },
    { id: 'b', sha256: '1'.repeat(64), event: { pubkey: fixturePubkey, content: 'Duplicate report' }, receivedAt: 20, pow: 22, category: 'malware', status: 'blocked', blocked: true, automationProtected: true },
    { id: 'c', sha256: '2'.repeat(64), event: { pubkey: '3'.repeat(64), content: 'Reviewed file' }, receivedAt: 30, pow: 16, category: 'other', status: 'allowed', blocked: false, automationProtected: false },
  ];
  const policy = { mode: 'manual', trustedReporters: [] };
  const options = { status: 'all', query: '', sort: 'pow', order: 'desc', page: 1, pageSize: 2 };
  const sorted = api.reportView(reports, policy, options);
  assert.deepEqual(Array.from(sorted.reports, report => report.id), ['b', 'c']);
  assert.equal(sorted.total, 3);
  assert.equal(sorted.stats.total, 3);
  assert.equal(sorted.stats.uniqueHashes, 2);
  assert.equal(sorted.stats.protectedHashes, 1);
  assert.equal(sorted.stats.averagePow, 46 / 3);
  const searched = api.reportView(reports, policy, { ...options, query: 'PHISHING', page: 9 });
  assert.deepEqual(Array.from(searched.reports, report => report.id), ['a']);
  assert.equal(searched.page, 1);
  assert.equal(searched.stats.total, 3, 'filtering must not shrink global statistics');
  assert.equal(api.reportView(reports, policy, { ...options, status: 'allowed' }).reports[0].id, 'c');
  const empty = api.reportView([], policy, options);
  assert.equal(empty.page, 1);
  assert.equal(empty.stats.averagePow, 0);
});
