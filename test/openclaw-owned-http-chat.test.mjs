import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runOpenClawConsumer } from './helpers/openclaw-consumer.mjs';
import { ownedHttpRouter, ownedHttpUpstream, seedOwnedHttpChat } from './helpers/owned-http-chat-fixture.mjs';

const source = process.env.CLAWROUTER_OPENCLAW_CHECKOUT;
const sourceHead = 'd8bb939408aa4d2be7df0161748edb52ebf3b1fb';
test('actual pinned OpenClaw UNIFIED Chat consumes the compiled owned HTTP entry', { skip: !source, timeout: 300000 }, async t => {
  const roots = [], bodies = new WeakMap(); let temporary, runtime, origin, finished = false, cleanupPromise, hasPrimary = false, primary;
  const own = promise => { const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) }; roots.push(root); return root; };
  const take = async root => { const value = await root.outcome; root.used = true; if (value.failed) throw value.error; return value.value; };
  const body = response => { let root = bodies.get(response); if (!root) { root = own(response.text()); bodies.set(response, root); } return root; };
  const dispatch = (url, init) => { const original = runtime.dispatchFetch(url, init), root = own(original); own(original.then(response => { body(response); }, () => {})); return root; };
  const request = async (path, init) => { const response = await take(dispatch(origin + path, init)); return { status: response.status, text: await take(body(response)) }; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    if (runtime && origin) try {
      // Poll scalars produced AFTER each originating context joined its own
      // originals. This wait neither adopts foreign I/O nor grants retirement.
      while (true) {
        const report = JSON.parse((await request('/fixture/state')).text);
        if (report.completed.length === report.intakes.length) {
          assert.ok(report.completed.every(row => !row.failed), 'all accepted native HTTP roots settled successfully'); break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const value = await root.outcome; if (value.failed && !root.used) { root.used = true; failures.push(value.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (temporary) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    const { startWorkerdFixture } = await import('./helpers/workerd.mjs');
    temporary = await mkdtemp(join(tmpdir(), 'owned-http-openclaw-'));
    runtime = await take(own(startWorkerdFixture(temporary, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true })));
    origin = String(await runtime.ready).replace(/\/$/, '');
    await take(own(seedOwnedHttpChat(runtime)));
    assert.equal((await request('/fixture/grants', { method: 'POST' })).status, 204);
    await take(own(runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL('./fixtures/openclaw-owned-http-chat-contract.test.ts', import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin } })));
    const observed = JSON.parse((await request('/fixture/state')).text);
    assert.equal(observed.intakes.length, 6);
    assert.ok(observed.intakes.every(row => row.path === '/v1/chat/completions'), 'all inference uses actual UNIFIED Chat');
    const calls = JSON.parse((await request('/fixture/upstream')).text);
    assert.equal(calls.filter(row => row.id === 'chat').length, 2);
    assert.equal(calls.filter(row => row.id === 'error').length, 1);
    assert.equal(calls.filter(row => row.id === 'tool').length, 1);
    assert.equal(calls.filter(row => row.id === 'abort').length, 1);
    assert.equal(calls.some(row => row.id === 'invalid'), false, 'wrong proxy secret never reaches a provider');
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'actual owned HTTP client cleanup');
  if (hasPrimary) throw primary;
});
