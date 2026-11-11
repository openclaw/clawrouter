import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { runOpenClawConsumer } from './helpers/openclaw-consumer.mjs';
import { assertOwnedAckCustody, ownedHttpRouter, ownedHttpUpstream, seedOwnedHttpChat } from './helpers/owned-http-chat-fixture.mjs';

function ackFailureState(held, terminal) {
  return JSON.stringify({ cuts: held?.cuts.length, retirements: held?.retirements.length,
    logical: terminal?.logical.length, pending: terminal?.pending, unknown: held?.unknown,
    budgetAccepted: held?.budgetAccepted, posts: held?.custody.posts.length, events: held?.custody.events.length,
    reserve: held?.custody.ledger.filter(row => row.path === '/reserve').length,
    dispatch: held?.custody.ledger.filter(row => row.path === '/dispatch').length,
    settle: held?.custody.ledger.filter(row => row.path === '/settle').length,
    ingest: held?.custody.ledger.filter(row => row.path === '/ingest').length,
    acks: held?.acks.map(({ state, closed, unlock, pending }) => ({ state, closed, unlock, pending })),
    terminals: held?.terminals.map(({ phase, pending, physical, ackCredits }) => ({ phase, pending, physical, ackCredits })),
    origins: held?.origins.map(({ origin, ordinal, primaryIsUndefined }) => ({ origin, ordinal, undefined: primaryIsUndefined })) });
}

test('private HTTP modules remain loadable by Node strip-only TypeScript grammar', async () => {
  for (const name of ['credential-preflight-source', 'http-identity-owner', 'identity-admission', 'proxy-response',
    'proxy', 'soft-budget', 'token-usage', 'venice-chat-runtime']) {
    const source = await readFile(new URL('../worker/' + name + '.ts', import.meta.url), 'utf8');
    assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: 'strip' }), name);
  }
});

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
          assert.ok(report.completed.every(row => !row.failed), 'all accepted native HTTP roots settled successfully: '
            + JSON.stringify({ intakes: report.intakes.length, completed: report.completed.length,
              failures: report.completed.filter(row => row.failed).map(({ id, origins }) => ({ id, origins })) })); break;
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
    assert.equal(observed.intakes.length, 9);
    assert.ok(observed.intakes.every(row => row.path === '/v1/chat/completions'), 'all inference uses actual UNIFIED Chat');
    const calls = JSON.parse((await request('/fixture/upstream')).text);
    assert.equal(calls.filter(row => row.id === 'chat').length, 2);
    assert.equal(calls.filter(row => row.id === 'venice').length, 3);
    assert.equal(calls.filter(row => row.id === 'error').length, 1);
    assert.equal(calls.filter(row => row.id === 'tool').length, 1);
    assert.equal(calls.filter(row => row.id === 'abort').length, 1);
    assert.equal(calls.some(row => row.id === 'invalid'), false, 'wrong proxy secret never reaches a provider');
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'actual owned HTTP client cleanup');
  if (hasPrimary) throw primary;
});

for (const custodyMode of ['provider-install', 'retry-cancel', 'new-post-install'])
test(`actual pinned unified Chat preserves accounting custody: ${custodyMode}`, { skip: !source, timeout: 300000 }, async t => {
  let temporary, runtime, origin, primary, failed = false;
  const request = async (path, init) => {
    const response = await runtime.dispatchFetch(origin + path, init);
    return { status: response.status, text: await response.text() };
  };
  const inspect = async query => JSON.parse((await request('/fixture/ack-phases' + (query ?? ''))).text);
  // Gates are released before any teardown joins. UNKNOWN remains held until
  // isolate disposal; successful ACK retirement is not HTTP retirement proof.
  try {
    const { startOwnedJsonObservedFixture } = await import('./helpers/owned-json-parser-observer.mjs');
    temporary = await mkdtemp(join(tmpdir(), 'owned-http-client-custody-'));
    runtime = await startOwnedJsonObservedFixture(temporary, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true });
    origin = String(await runtime.ready).replace(/\/$/, '');
    await seedOwnedHttpChat(runtime);
    for (const [path, body] of [['grants', undefined], ['budget-sequence', '{"legs":4,"provider":"fireworks"}'], ['terminal', '{}'],
      ['retry', 'response'], ['ack-phases', JSON.stringify({ custodyMode })]])
      assert.equal((await request('/fixture/' + path, { method: 'POST', body })).status, 204);
    await runOpenClawConsumer(t, { source, sourceHead,
      fixture: new URL('./fixtures/openclaw-owned-http-chat-contract.test.ts', import.meta.url),
      env: { CLAWROUTER_CONTRACT_ORIGIN: origin, CLAWROUTER_CUSTODY_SCENARIO: custodyMode } });
    let held, terminal, deadline = Date.now() + 30000;
    do {
      assert.ok(Date.now() < deadline, 'logical ACK handoff stalled: ' + ackFailureState(held, terminal));
      held = await inspect(); terminal = JSON.parse((await request('/fixture/terminal')).text);
      if (held.cuts.length < 13 || !terminal.logical.length || terminal.pending) await new Promise(resolve => setTimeout(resolve, 10));
    } while (held.cuts.length < 13 || !terminal.logical.length || terminal.pending);
    assert.equal(terminal.logical.length, 1);
    await request('/fixture/ack-phases', { method: 'DELETE' });
    let ended; deadline = Date.now() + 30000;
    do { assert.ok(Date.now() < deadline, 'physical ACK retirement stalled: ' + ackFailureState(ended ?? held, terminal)); ended = await inspect(); if (ended.retirements.length < 13) await new Promise(resolve => setTimeout(resolve, 10)); }
    while (ended.retirements.length < 13);
    assertOwnedAckCustody(assert, custodyMode, held, ended, await inspect('?recheck'), await inspect('?stale'));
    const state = JSON.parse((await request('/fixture/state')).text);
    assert.equal(state.intakes.length, 1); assert.equal(state.intakes[0].path, '/v1/chat/completions');
    assert.equal(state.completed.length, 0, 'UNKNOWN must not be called physically retired');
  } catch (error) { failed = true; primary = error; }
  const failures = [];
  if (runtime && origin) {
    for (const path of ['ack-phases', 'terminal', 'budget-sequence']) {
      try { await request('/fixture/' + path, { method: 'DELETE' }); } catch (error) { failures.push(error); }
    }
  }
  if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
  if (temporary) try { await rm(temporary, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, 'client custody fixture cleanup');
  if (failed) throw primary;
});
