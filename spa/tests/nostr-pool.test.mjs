import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Observable, merge } from 'rxjs';

const component = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const handler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'makeNostrPool');
assert.ok(handler);
const compiled = ts.transpileModule(handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
  const calls = [];
  const publications = [];
  class SimplePool {
    subscribeMany(relays, filter, callbacks) {
      assert.ok(!Array.isArray(filter), 'SimplePool expects one Filter per subscription');
      const call = { relays, filter, callbacks, closed: 0 };
      calls.push(call);
      return { close: () => { call.closed++; } };
    }
    publish(relays, event) {
      publications.push({ relays, event });
      return relays.map(() => Promise.resolve('accepted'));
    }
  }
  const adapter = vm.runInNewContext(`${compiled}\nmakeNostrPool()`, { SimplePool, Observable, merge });
  return { adapter, calls, publications };
}

test('remote signer adapter subscribes each filter separately and tears all subscriptions down', async () => {
  const { adapter, calls, publications } = setup();
  const relays = ['wss://relay.example'];
  const filters = [{ kinds: [24133], '#p': ['a'.repeat(64)] }, { kinds: [24133], authors: ['b'.repeat(64)] }];
  const stream = adapter.subscription(relays, filters);
  assert.ok(stream instanceof Observable, 'signer requires an ObservableInput');
  assert.equal(calls.length, 0, 'subscriptions should start only when observed');
  const received = [];
  const subscription = stream.subscribe(event => received.push(event));
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.filter, filters[index]);
    assert.equal(call.relays, relays);
    call.callbacks.onevent({ id: String(index) });
  }
  assert.deepEqual(received, [{ id: '0' }, { id: '1' }]);
  subscription.unsubscribe();
  assert.ok(calls.every(call => call.closed === 1));
  calls[0].callbacks.onevent({ id: 'late' });
  assert.equal(received.length, 2, 'late relay events must not reach a disconnected signer');
  const event = { id: 'publication' };
  assert.deepEqual(Array.from(await adapter.publish(relays, event)), ['accepted']);
  assert.deepEqual(publications, [{ relays, event }]);
});

test('relay closure completes the stream only after every filter closes', () => {
  const { adapter, calls } = setup();
  let completed = false;
  adapter.subscription(['wss://relay.example'], [{ kinds: [24133] }, { kinds: [1] }]).subscribe({ complete: () => { completed = true; } });
  calls[0].callbacks.onclose();
  assert.equal(completed, false);
  calls[1].callbacks.onclose();
  assert.equal(completed, true);
  assert.ok(calls.every(call => call.closed === 1));
});
