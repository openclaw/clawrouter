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
  const api = { workerPath: '/worker', cloudflare: async (path, init) => { calls.push({ path, init }); return { id: '023e105f4ecef8ad9ca31a8372d0c353', url: 'wss://trace.example' }; } };
  const stop = await startQueueObservation({ api, state, save: (s) => saved.push(structuredClone(s)), queue: 'usage', WebSocketImpl: Socket });
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ scriptVersion: { id: 'green' }, event: { queue: 'usage', batchSize: 2 }, logs: ['private-sentinel'] }) }));
  await stop();
  assert.deepEqual(state.queueObservations, [{ percentage: 10, version: 'green', batches: 1, messages: 2 }]);
  assert.doesNotMatch(JSON.stringify(saved), /private-sentinel/);
  assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(socket.closed, true);
});

test('connection failures identify the fixed stage/status without leaking diagnostics', async () => {
  const state = {}, saved = [];
  const api = { cloudflare: async () => { throw Object.assign(new Error('private credential sentinel'), { status: 403 }); } };
  const stop = await startQueueObservation({ api, state, save: (s) => saved.push(structuredClone(s)) });
  await stop();
  assert.equal(state.queueObservationStatus, 'unavailable at create HTTP 403; consumer version unobserved');
  assert.doesNotMatch(JSON.stringify(saved), /private credential/);
});

test('standalone observation follows percentage changes, stops at a new owner, and never deploys', async () => {
  const { observeQueue } = await import('../scripts/observe-deploy-queue.mjs');
  const { deploymentMessage, splitVersions } = await import('../scripts/deploy-train-policy.mjs');
  const blue = '11111111-1111-1111-1111-111111111111', green = '22222222-2222-2222-2222-222222222222';
  let calls = 0, time = 0, stopped = 0;
  const states = [], base = { blue, green, run: '123', sha: 'a'.repeat(40), status: 'rolling', unsafe: false, exposed: true };
  const api = { latest: async () => { calls++; return { versions: splitVersions(blue, green, calls === 1 ? 10 : 50), annotations: { 'workers/message': deploymentMessage({ ...base, run: calls < 3 ? '123' : '456' }) } }; }, deploy: () => { throw new Error('observation must not mutate'); } };
  const result = await observeQueue({ api, save: (s) => states.push(structuredClone(s)), now: () => time, wait: async (ms) => { time += ms; }, start: async ({ state }) => { state.queueObservationStatus = 'connected'; return async () => { stopped++; }; } });
  assert.equal(result.percentage, 50);
  assert.equal(result.observationStopped, 'deployment owner changed');
  assert.equal(stopped, 1); assert.equal(time, 60_000); assert.equal(calls, 3);
});
