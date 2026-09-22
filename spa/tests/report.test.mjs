import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools';
import { getPow } from 'nostr-tools/nip13';

// Exercise the component's actual submission handler without a browser or a
// second copy of its logic. Only the worker transport and HTTP are mocked.
const component = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const handler = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'submitReport');
assert.ok(handler, 'report submission handler must exist');
const handlerJs = ts.transpileModule(handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test('report submission mines kind 1984 before signing and preserves valid proof', async () => {
  const secret = new Uint8Array(32);
  secret[31] = 1;
  const pubkey = getPublicKey(secret);
  const hash = 'a'.repeat(64);
  let minedId;
  let submitted;
  let options;

  class Miner {
    constructor(input) {
      options = input;
      const stream = () => ({ subscribe: () => ({ unsubscribe() {} }) });
      this.progress$ = stream();
      this.error$ = stream();
      this.cancelledEvent$ = stream();
      this.success$ = { subscribe: callback => {
        this.onSuccess = callback;
        return { unsubscribe() {} };
      } };
    }

    mine() {
      const nonce = ['nonce', '0', String(options.difficulty)];
      const event = {
        kind: options.kind ?? 1, // Match the installed miner's default.
        pubkey: options.pubkey,
        created_at: 1700000000,
        content: options.content,
        tags: [...options.tags, nonce],
      };
      for (let attempt = 0; ; attempt++) {
        nonce[1] = String(attempt);
        minedId = getEventHash(event);
        if (getPow(minedId) >= options.difficulty) break;
      }
      this.onSuccess({ result: { event } });
    }
  }

  const context = vm.createContext({
    Notemine: Miner,
    getSigner: async () => ({
      getPublicKey: async () => pubkey,
      signEvent: async event => finalizeEvent(JSON.parse(JSON.stringify(event)), secret),
    }),
    fetch: async (url, request) => {
      assert.equal(url, '/report');
      assert.equal(request.method, 'PUT');
      submitted = JSON.parse(request.body);
      return { ok: true, json: async () => ({ message: 'Report received' }) };
    },
    cleanupMining() {},
    reportResult: null, mining: false, miningProgress: null,
    reportDescription: 'testing', reportCategory: 'other', reportHash: hash,
    hashVerified: true, activeMiner: null, miningSubscriptions: [],
    submitting: false, signerType: 'anonymous',
  });
  await vm.runInContext(`${handlerJs}\nsubmitReport()`, context);

  assert.ok(submitted, context.reportResult?.message);
  assert.equal(submitted.kind, 1984);
  assert.equal(options.difficulty, 16);
  assert.equal(submitted.id, minedId, 'signing must preserve the mined event hash');
  assert.ok(verifyEvent(submitted), 'server receives a valid signature');
  assert.ok(getPow(submitted.id) >= 16, 'server receives valid proof of work');
  assert.deepEqual(submitted.tags[0], ['x', hash, 'other']);
  assert.equal(context.hashVerified, false);
  assert.equal(context.reportHash, '');
  assert.equal(context.reportDescription, '');
  assert.equal(context.reportResult.success, true);
  assert.equal(context.submitting, false);
  assert.equal(context.mining, false);
});
