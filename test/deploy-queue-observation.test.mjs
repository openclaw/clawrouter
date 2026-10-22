import assert from 'node:assert/strict';
import test from 'node:test';
import { queueObservation, startQueueObservation } from '../scripts/deploy-queue-observation.mjs';

test('queue evidence extracts only known version identity and batch count, never raw trace content', () => {
  const record = { scriptVersion: { id: 'green' }, event: { queue: 'usage', batchSize: 3, privateData: 'sentinel' }, logs: [{ message: 'sentinel' }], headers: { authorization: 'sentinel' } };
  assert.deepEqual(queueObservation(record, 'usage', ['blue', 'green']), { version: 'green', messages: 3 });
  for (const value of [{ ...record, event: { request: { url: 'private' } } }, { ...record, scriptVersion: { id: 'other' } }, { ...record, event: { queue: 'usage', batchSize: -1 } }]) assert.equal(queueObservation(value, 'usage', ['blue', 'green']), null);
});

test('observer saves sanitized per-stage counts and deletes its ephemeral tail', async () => {
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; setImmediate(() => this.dispatchEvent(new Event('open'))); }
    send(message) { assert.deepEqual(JSON.parse(message), { debug: false }); }
    close() { this.closed = true; }
  }
  const calls = [], saved = [], state = { blue: 'blue', green: 'green', percentage: 10 };
  const api = { workerPath: '/worker', cloudflare: async (path, init) => { calls.push({ path, init }); return { id: '11111111-1111-1111-1111-111111111111', url: 'wss://trace.example' }; } };
  const stop = await startQueueObservation({ api, state, save: (s) => saved.push(structuredClone(s)), queue: 'usage', WebSocketImpl: Socket });
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ scriptVersion: { id: 'green' }, event: { queue: 'usage', batchSize: 2 }, logs: ['private-sentinel'] }) }));
  await stop();
  assert.deepEqual(state.queueObservations, [{ percentage: 10, version: 'green', batches: 1, messages: 2 }]);
  assert.doesNotMatch(JSON.stringify(saved), /private-sentinel/);
  assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(socket.closed, true);
});
