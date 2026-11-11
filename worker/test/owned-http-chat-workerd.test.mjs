import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { startOwnedJsonObservedFixture } from '../../test/helpers/owned-json-parser-observer.mjs';
import { ownedJsonCodecCases, ownedJsonCodecWire, ownedUsageCases, ownedUsageWire, ownedCodecSseLines } from '../../test/helpers/owned-json-parser-cases.mjs';
import { ownedHttpModel, ownedHttpPricingModel, ownedHttpControlModels, ownedHttpProxyKey, ownedHttpRouter, ownedHttpUpstream, seedOwnedHttpChat } from '../../test/helpers/owned-http-chat-fixture.mjs';

// One memoized ORIGINAL body root is enrolled as soon as each dispatch resolves,
// including a late response after an earlier assertion has already failed.
async function fixture(t, run, observeParsers = false, runtimeOptions = {}) {
  const roots = [], bodies = new WeakMap(), releases = [], failedRetirements = new Set();
  let directory, runtime, finished = false, cleanupPromise, hasPrimary = false, primary, unknownRetirement = false;
  const own = promise => { const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) }; roots.push(root); return root; };
  const take = async root => { const outcome = await root.outcome; root.used = true; if (outcome.failed) throw outcome.error; return outcome.value; };
  const body = response => { let root = bodies.get(response); if (!root) { root = own(response.text()); bodies.set(response, root); } return root; };
  const dispatch = (url, init) => { const original = runtime.dispatchFetch(url, init), root = own(original); own(original.then(response => { body(response); }, () => {})); return root; };
  const request = async (url, init) => { const response = await take(dispatch(url, init)); return { status: response.status, headers: response.headers, text: await take(body(response)) }; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { await release(); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    if (runtime) try {
      if (unknownRetirement) {
        // Actual caller/body roots joined above. The terminal observer also
        // accounts for every original native ledger/queue promise. UNKNOWN is
        // intentionally retained until isolate disposal, never called retired.
        let terminal;
        do {
          terminal = JSON.parse((await request('https://fixture/fixture/terminal')).text);
          if (terminal.pending) await new Promise(resolve => setTimeout(resolve, 10));
        } while (terminal.pending);
        assert.equal(terminal.logical.length, 1);
        const report = JSON.parse((await request('https://fixture/fixture/state')).text);
        assert.ok(report.completed.length < report.intakes.length); assert.ok(report.charged > 0);
      } else while (true) {
        const response = await request('https://fixture/fixture/state'), report = JSON.parse(response.text);
        if (report.completed.length === report.intakes.length) {
          for (let index = 0; index < report.completed.length; index++)
            assert.equal(report.completed[index].failed, failedRetirements.has(index), 'actual retirement outcome ' + index);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const outcome = await root.outcome; if (outcome.failed && !root.used) { root.used = true; failures.push(outcome.error); } }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    directory = await mkdtemp(join(tmpdir(), 'owned-http-chat-'));
    const start = observeParsers ? startOwnedJsonObservedFixture : startWorkerdFixture;
    runtime = await take(own(start(directory, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true, ...runtimeOptions })));
    await take(own(seedOwnedHttpChat(runtime)));
    assert.equal((await request('https://fixture/fixture/grants', { method: 'POST' })).status, 204);
    await run({ runtime, own, take, request, dispatch, body, releases,
      expectFailedRetirement(index) { assert.ok(Number.isSafeInteger(index) && index >= 0); failedRetirements.add(index); },
      expectUnknownRetirement() { unknownRetirement = true; },
    });
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'owned HTTP native fixture cleanup');
  if (hasPrimary) throw primary;
}
const chat = (id, extra = {}) => ({ method: 'POST', headers: { authorization: `Bearer ${ownedHttpProxyKey(id)}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: ownedHttpModel, messages: [{ role: 'user', content: 'synthetic input' }], ...extra }) });
const count = (state, kind, path) => state.calls.filter(row => row.kind === kind && row.path === path).length;
const state = async f => JSON.parse((await f.request('https://fixture/fixture/state')).text);
const settledState = async f => {
  for (;;) {
    const report = await state(f);
    if (report.completed.length === report.intakes.length) return report;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

for (const mode of ['preparation', 'response', 'mixed', 'exhausted', 'failed-alternate'])
test(`native cumulative four-port generic grant policy ${mode}`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/fixture/retry', { method: 'POST', body: mode })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('pricing', { model: ownedHttpPricingModel, ownedRetryCase: mode }));
    assert.equal(response.status, mode === 'exhausted' || mode === 'failed-alternate' ? 429 : 200);
    const report = await settledState(f), keys = ['a', 'b', 'c', 'd'].map(name => 'oauth/owned_http_pricing/fireworks-' + name);
    assert.deepEqual(report.retryPorts.map(port => port.keys), [[], keys.slice(0, 1), keys.slice(0, 2), keys.slice(0, 3)]);
    assert.deepEqual(report.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').map(row => row.key), keys);
    const sent = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    const expected = mode === 'preparation' ? ['d'] : mode === 'mixed' ? ['b', 'd'] : mode === 'failed-alternate' ? ['a'] : ['a', 'b', 'c', 'd'];
    assert.deepEqual(sent.map(row => row.id), expected.map(name => 'retry-' + name));
    assert.ok(report.credentialReductions.length >= expected.length);
    assert.ok(report.credentialReductions.every(row => row.before === 33554432 && row.after === row.bytes && row.bytes >= 4096 && row.bytes < 33554432));
    for (const [index, row] of report.credentialReductions.entries()) {
      const census = report.credentialCensuses[index];
      assert.ok(census.originalCleared && census.retained && (census.completion & 4)); assert.equal(row.rejections, 5);
      assert.equal(row.bytes, 8 * (census.containers + 2 * census.members + census.entries + census.values) + 2 * census.units + 4096 + 6 * (row.idUnits + census.keyUnits));
    }
    assert.equal(report.events.length, 1); assert.equal(count(report, 'budget', '/reserve'), 1); assert.equal(count(report, 'budget', '/settle'), 1);
    if (mode === 'failed-alternate') assert.match(response.text, /synthetic rejection a/);
    if (mode === 'exhausted') assert.match(response.text, /synthetic rejection d/);
  }, true);
});

// Venice's native descriptor and GMI's existing main conjunction exclude only
// response-driven retries. Materialization failures precede either future right.
for (const provider of ['venice', 'gmi']) for (const status of [401, 403, 429]) for (const streaming of provider === 'venice' ? [false, true] : [false])
test(`native ${provider} prepared ${status} does not create an alternate (stream=${streaming})`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat(provider, { model: ownedHttpControlModels[provider], stream: streaming, ownedCodecStatus: status }));
    assert.equal(response.status, status);
    const report = await settledState(f), sent = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(sent.length, 1); assert.equal(count(report, 'credential', '/materialize'), 1);
    assert.equal(report.retryPorts.length, 1); assert.equal(report.credentialReductions.length, 0);
    assert.equal(report.events.length, 1);
  }, true);
});
test('native invalid canonical Venice preparation has no fetch, retry or retained reduction', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', { model: ownedHttpControlModels.venice, stream: 'invalid' }));
    assert.equal(response.status, 400); assert.equal(JSON.parse(response.text).error.code, 'invalid_venice_chat_request');
    const report = await settledState(f);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
    assert.equal(report.retryPorts.length, 1); assert.equal(report.credentialReductions.length, 0);
    assert.equal(count(report, 'credential', '/materialize'), 1);
  }, true);
});

for (const provider of ['venice', 'gmi']) test(`native ${provider} materialization A/B/C failures leave only D's future owner`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/fixture/retry?provider=' + provider, { method: 'POST', body: 'preparation' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat(provider, { model: ownedHttpControlModels[provider], ownedRetryCase: 'preparation' }));
    assert.equal(response.status, 200);
    const report = await settledState(f), sent = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    const keys = ['a', 'b', 'c', 'd'].map(name => 'oauth/owned_http_' + provider + '/' + provider + '-' + name);
    assert.deepEqual(report.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').map(row => row.key), keys);
    assert.deepEqual(report.retryPorts.map(port => port.keys), [[], keys.slice(0, 1), keys.slice(0, 2), keys.slice(0, 3)]);
    assert.deepEqual(sent.map(row => row.id), ['retry-d']); assert.equal(report.credentialReductions.length, 0);
    assert.equal(report.events.length, 1);
  }, true);
});

test('native generic retained reduction covers unknown grant fields and a completed cache HIT', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    await f.request('https://fixture/fixture/retry?unknown=large', { method: 'POST', body: 'response' });
    const first = await f.request('https://fixture/v1/chat/completions', chat('pricing', { model: ownedHttpPricingModel, ownedRetryCase: 'response' }));
    assert.equal(first.status, 200);
    const before = await settledState(f);
    assert.equal(before.credentialReductions.length, 4);
    assert.ok(before.credentialCensuses.every(row => row.units >= 16384 && row.originalCleared));
    assert.ok(before.credentialReductions.every(row => row.bytes > 2 * 16384 + 4096));
    const second = await f.request('https://fixture/v1/chat/completions', chat('pricing', { model: ownedHttpPricingModel, ownedRetryCase: 'response' }));
    assert.equal(second.status, 200);
    const after = await settledState(f);
    assert.ok(after.credentialCensuses.slice(before.credentialCensuses.length).some(row => row.completion === 6 && row.borrowed));
    assert.equal(after.events.length, 2);
  }, true);
});

test('native retained private callbacks become inert after physical retirement', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat')); assert.equal(response.status, 200);
    const report = await settledState(f), rows = report.originalObservers, roles = new Set(rows.map(row => row.role));
    for (const role of ['OwnedProviderFetch', 'OwnedLedgerCommand', 'OwnedTerminalOperation']) assert.ok(roles.has(role), role);
    assert.ok(rows.every(row => row.severed && row.state === 8));
    const replay = JSON.parse((await f.request('https://fixture/fixture/observer-replay')).text);
    assert.equal(replay.reads, 0); assert.equal(replay.callbacks, 2 * rows.length);
  }, true);
});

test('native 513 empty string tools fund every string primitive occurrence', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat', { tools: Array(513).fill('') }));
    assert.equal(response.status, 200);
    const report = await settledState(f);
    assert.ok(report.toolScratchBytes >= 8224);
    assert.equal(report.events.length, 1);
    assert.equal(count(report, 'budget', '/reserve'), 1);
    assert.equal(count(report, 'budget', '/settle'), 1);
  }, true);
});

const budgetState = async f => JSON.parse((await f.request('https://fixture/fixture/budget-sequence')).text);
const terminalState = async f => JSON.parse((await f.request('https://fixture/fixture/terminal')).text);
for (const laneFault of ['ok-getter', 'install-before-late']) for (const laneReason of ['undefined', 'shared'])
test(`native terminal failure keeps recovery live and late FIRST cleanup ${laneFault}/${laneReason}`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.expectUnknownRetirement();
    f.releases.push(() => f.request('https://fixture/fixture/terminal', { method: 'DELETE' }));
    assert.equal((await f.request('https://fixture/fixture/terminal', { method: 'POST', body: JSON.stringify({ laneFault, laneReason }) })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat')); assert.equal(response.status, 200);
    let row; do { row = await terminalState(f); if (!row.logical.length) await new Promise(resolve => setTimeout(resolve, 10)); } while (!row.logical.length);
    assert.deepEqual(row.logical, [true]); assert.equal(row.recovery.length, 1); assert.equal(row.recovery[0].args, 1);
    const report = await state(f), settled = report.calls.filter(value => value.kind === 'budget' && value.path === '/settle');
    assert.equal(settled.length, 1); assert.equal(row.recovery[0].id, settled[0].reservationId);
    if (laneFault === 'install-before-late') { assert.equal(row.laneInstalls, 1); assert.equal(row.bodyCancels, 0); }
    assert.equal((await f.request('https://fixture/fixture/terminal', { method: 'DELETE' })).status, 204);
    do { row = await terminalState(f); if (row.pending || row.bodyCancelSettled !== 1) await new Promise(resolve => setTimeout(resolve, 10)); } while (row.pending || row.bodyCancelSettled !== 1);
    assert.equal(row.bodyCancels, 1); assert.equal(row.launches, 1); assert.equal((await state(f)).events.length, 1);
    assert.ok((await state(f)).originalObservers.some(value => value.role === 'OwnedTerminalOperation' && !value.severed));
  }, true);
});

for (const options of [{ late: 'throw' }, { late: 'other', wrong: true }, { receipt: 'first' }, { receipt: 'both' },
  { shellFailure: true }, ...['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE'].map(factoryThrow => ({ factoryThrow })),
  { startFailure: true }, { closeFailure: true }, { installFailure: true }, { closeFailure: true, diagnosticFailure: true }])
test(`native prepaid terminal adoption ${JSON.stringify(options)}`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/terminal', { method: 'DELETE' }));
    const unknown = !!(options.closeFailure || options.installFailure);
    if (unknown) f.expectUnknownRetirement();
    assert.equal((await f.request('https://fixture/fixture/terminal', { method: 'POST', body: JSON.stringify(options) })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    let row;
    if (unknown) {
      for (;;) { row = await terminalState(f); if (row.logical.length && !row.pending) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    } else { await settledState(f); row = await terminalState(f); }
    const report = await state(f);
    assert.equal(row.shellAttempts, 1); assert.equal(row.lateGets, 0); assert.equal(row.methodsB, 0);
    assert.equal(row.foreignReads, 0); assert.equal(row.pending, 0);
    if (options.shellFailure || options.factoryThrow) {
      assert.ok(response.status >= 400); assert.equal(row.adopted, 0); assert.equal(row.launches, 0);
      assert.equal(report.calls.filter(value => value.kind === 'budget').length, 0); assert.equal(report.events.length, 0);
      if (options.factoryThrow) {
        const names = ['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE'];
        assert.ok(row.factories.length > 0);
        for (const trace of row.factories) assert.deepEqual(trace, names.slice(0, names.indexOf(options.factoryThrow) + 1));
      } else assert.equal(row.shells, 0);
    } else {
      assert.equal(response.status, 200); assert.equal(row.shells, 1); assert.equal(row.primary, 1);
      assert.equal(row.fallback, options.receipt ? 1 : 0);
      if (options.receipt === 'both') {
        assert.equal(row.failed, 1); assert.equal(row.adopted, 0); assert.equal(row.launches, 0);
        assert.deepEqual(row.logical, [false]); assert.equal(row.retainedFailure, true); assert.equal(report.events.length, 0);
        assert.equal(count(report, 'budget', '/settle'), 0);
        assert.deepEqual(row.diagnostics, [{ origin: 'terminal-prepare', undefined: true }, { origin: 'terminal-fallback', undefined: true }]);
      } else {
        assert.equal(row.adopted, 1); assert.equal(row.launches, 1); assert.equal(row.installs, 1);
        assert.deepEqual(row.order, ['adopt', 'close', 'install', 'launch']);
        assert.equal(report.events.length, 1); assert.equal(count(report, 'budget', '/settle'), 1);
        assert.deepEqual(row.logical, [!options.startFailure]);
      }
      if (options.wrong) assert.equal(row.rejected, 6);
      for (const trace of row.factories) assert.deepEqual(trace, ['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE']);
    }
  }, true);
});
async function prepareBudgetSequence(f, options) {
  // Registered before setup/dispatch; failure cannot strand the returned send
  // or an independently held unused-response cancellation.
  f.releases.push(() => f.request('https://fixture/fixture/budget-sequence', { method: 'DELETE' }));
  assert.equal((await f.request('https://fixture/fixture/budget-sequence', {
    method: 'POST', body: JSON.stringify({ legs: 4, ...options }),
  })).status, 204);
}

// UNRUN_CODE_ONLY_HOSTED: exact configured Workerd, real private Chat pipeline.
for (const failureOrdinal of [0, 1, 2, 3])
test(`native four-leg reserve ordinal ${failureOrdinal} denial retains prepaid rollback and queue custody`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const held = failureOrdinal === 3;
    await prepareBudgetSequence(f, { reserveFailure: 'denied', failureOrdinal, settleFailure: '503', pressure: held, holdSend: held, holdCancel: held });
    const original = f.dispatch('https://fixture/v1/chat/completions', chat('chat'));
    if (held) {
      let row;
      for (;;) {
        row = await budgetState(f); if (row.queue.length === 3) break;
        await Promise.race([new Promise(resolve => setTimeout(resolve, 10)), original.outcome.then(outcome => {
          throw outcome.failed ? outcome.error : Error('request ended before prepaid recovery handoff');
        })]);
      }
      assert.equal(row.accepted, 3); assert.equal(row.pressure, true); assert.equal(row.grows, 0);
      assert.equal(row.cancel, 3); assert.equal(row.cancelSettled, 0); assert.equal(row.sendSettled, 0);
      await f.request('https://fixture/fixture/budget-sequence', { method: 'PATCH' });
    }
    const response = await f.take(original); await f.take(f.body(response));
    assert.equal(response.status, 402);
    const row = await budgetState(f), ids = row.reserve.filter(item => item.ordinal !== failureOrdinal).map(item => item.id).sort();
    assert.equal(row.reserve.length, 4); assert.deepEqual(row.branches, ['rollback']); assert.equal(row.dispatch.length, 0);
    assert.deepEqual(row.settle.map(item => item.id).sort(), ids); assert.deepEqual(row.queue.map(item => item.id).sort(), ids);
    assert.ok(row.settle.every(item => item.cost === 0));
    for (const item of row.queue) {
      assert.equal(item.args, 1); assert.equal(item.cost, 0); assert.ok(item.root && item.request && item.ledger && item.hookBlocked);
      assert.equal(item.after, item.before);
    }
    if (held) assert.equal(row.cancelSettled, 0, 'publication does not join the held ledger cleanup');
    await f.request('https://fixture/fixture/budget-sequence', { method: 'DELETE' });
    const report = await settledState(f); assert.equal(report.events.length, 1);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
    assert.ok(row.prepayBytes >= 10489728);
  }, true);
});

for (const options of [
  { reserveFailure: 'malformed', settleFailure: '404' },
  { reserveFailure: 'lost', settleFailure: '409' },
  { reserveFailure: 'undefined', settleFailure: 'undefined' },
  { reserveFailure: 'shared', settleFailure: 'shared', queueFailure: 'shared' },
  { reserveFailure: 'denied', settleFailure: '503', queueFailure: 'undefined' },
  { reserveFailure: 'forged', settleFailure: '503' },
  { reserveFailure: 'denied', settleFailure: '503', sameIds: true, rights: true },
  { prepayRefusal: true }, { dispatchFailure: true },
]) test(`native prepaid budget sequence ${JSON.stringify(options)} preserves the one terminal path`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    await prepareBudgetSequence(f, options);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.ok(response.status >= 400);
    if (options.reserveFailure === 'forged') assert.notEqual(response.status, 402);
    const row = await budgetState(f);
    if (options.prepayRefusal) {
      assert.equal(row.refused, true); assert.equal(row.factories, 0); assert.equal(row.reserve.length, 0);
      assert.equal(row.dispatch.length, 0); assert.equal(row.settle.length, 0); assert.deepEqual(row.branches, []);
    } else if (options.dispatchFailure) {
      assert.deepEqual(row.branches, ['dispatch']); assert.equal(row.reserve.length, 4); assert.equal(row.dispatch.length, 4);
      // Completion is logical; wait below for the independent actual terminal.
    } else {
      assert.deepEqual(row.branches, ['rollback']); assert.equal(row.accepted, 3); assert.equal(row.dispatch.length, 0);
      assert.equal(row.settle.length, 3); assert.equal(row.queue.length, 3);
      assert.ok(row.settle.every(item => item.cost === 0));
      if (options.sameIds) {
        assert.equal(new Set(row.reserve.map(item => item.id)).size, 1);
        assert.equal(row.rejectedRights, 26);
      } else assert.ok(row.settle.every(item => item.id !== row.reserve[3].id));
      assert.deepEqual(row.queue.map(item => item.id), row.settle.map(item => item.id));
    }
    await f.request('https://fixture/fixture/budget-sequence', { method: 'DELETE' });
    const report = await settledState(f); assert.equal(report.events.length, 1);
    if (options.dispatchFailure) {
      const final = await budgetState(f);
      assert.equal(final.settle.length, 4); assert.equal(final.queue.length, 0);
      assert.deepEqual(final.settle.map(item => item.id).sort(), final.reserve.map(item => item.id).sort());
    }
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
  }, true);
});

test('native expanded owned intake retains depth 128 and rejects depth 129 before selection', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    for (const depth of [128, 129]) {
      let nested = 'quoted " \\ {[ ]}';
      for (let index = 1; index < depth; index++) nested = { child: nested };
      const request = chat('chat');
      request.body = ' '.repeat(8 * 1024 * 1024) + JSON.stringify({ extra: nested });
      const before = await settledState(f);
      const response = await f.request('https://fixture/v1/chat/completions', request);
      assert.equal(response.status, depth === 128 ? 400 : 413, String(depth));
      assert.equal(JSON.parse(response.text).error.code, depth === 128 ? 'model_required' : 'request_too_large');
      const after = await settledState(f), calls = after.calls.slice(before.calls.length);
      assert.equal(calls.filter(row => row.kind === 'authority' && row.path === '/grant-pools/select').length, 0);
      assert.equal(calls.filter(row => row.kind === 'budget').length, 0);
      assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
    }
  });
});

test('native owned pricing preserves deep/wide JSON, media presence, cache-rate precedence and original reservation IDs', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    let deep = 'text'; for (let index = 0; index < 1025; index++) deep = { ownedPricingNested: deep };
    const unicode = JSON.parse('{"__proto__":{"kept":true}}');
    unicode.text = 'é😀\ud800x\udfff'; unicode.escaped = '"\\\n\u0001'; unicode.numbers = [-0, 1e21, 1e-7];
    const cases = [
      ['pricing', { messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic', extra: deep }] }] }, false, 1400000],
      ['pricing_media', { messages: [{ role: 'user', content: [{ type: 'text', image_url: null }] }] }, true, 1400000],
      ['pricing_cache', { extra: [{ cache_control: { ttl: '1h' } }, { cache_control: { ttl: '5m' } }] }, false, 2000000],
      ['pricing_wide', { messages: [{ role: 'user', content: Array.from({ length: 4096 }, (_, index) => ({ type: 'text', text: String(index), cache_control: null })) }] }, false, 9000000],
      ['pricing_unicode', { extra: unicode }, false, 1400000],
      ['pricing_outside', { extra: { image_url: null, cache_control: null } }, false, 9000000],
      ['pricing_large', { messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }, false, 1400000],
    ];
    for (const [id, extra, media, rate] of cases) {
      const body = { model: ownedHttpPricingModel, messages: [{ role: 'user', content: 'synthetic input' }], max_tokens: 1, ...extra };
      const wire = JSON.stringify({ ...body, model: 'accounts/fireworks/models/glm-5p2' });
      const tokens = media ? 1048576 : Math.min(1048576, Buffer.byteLength(wire) + 1024);
      const expected = Math.ceil(tokens * rate / 1000000) + Math.ceil(4400000 / 1000000);
      const before = await settledState(f);
      const response = await f.request('https://fixture/v1/chat/completions', chat(id, body));
      assert.equal(response.status, 200, id); assert.equal(JSON.parse(response.text).model, 'accounts/fireworks/models/glm-5p2');
      const after = await settledState(f), calls = after.calls.slice(before.calls.length);
      const reserves = calls.filter(row => row.kind === 'budget' && row.path === '/reserve');
      assert.equal(reserves.length, 1, id); assert.equal(reserves[0].costMicros, expected, id);
      assert.equal(calls.find(row => row.kind === 'budget' && row.path === '/settle').reservationId, reserves[0].reservationId);
      const events = after.events.slice(before.events.length); assert.equal(events.length, 1); assert.equal(events[0].reserved, expected); assert.equal(events[0].status, 200);
      assert.equal(after.recursivePricingValues, 0, 'both actual pricing phases avoid recursive Object.values');
      const rows = JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === id);
      assert.equal(rows.length, 1); assert.equal(rows[0].bytes, Buffer.byteLength(wire), 'no pricing rewrite or replay');
    }
    const before = await settledState(f);
    const failed = await f.request('https://fixture/v1/chat/completions', chat('pricing_prepare_fail', {
      model: ownedHttpPricingModel, max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic', extra: deep }] }],
    }));
    assert.equal(failed.status, 503, 'early pricing succeeds, then the actual fixture materializer refuses');
    const after = await settledState(f);
    assert.equal(after.recursivePricingValues, 0);
    assert.equal(after.calls.slice(before.calls.length).filter(row => row.kind === 'budget' && row.path === '/reserve').length, 0);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'pricing_prepare_fail').length, 0);
  });
});

for (const provider of ['gmi', 'venice']) test(`owned unified ${provider} keeps genuine proof and fresh provider control on a covered hit`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat(provider, { model: ownedHttpControlModels[provider] });
    const first = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(first.status, 200, 'genuine generation proof reaches original provider authority');
    assert.equal(JSON.parse(first.text).model, ownedHttpControlModels[provider].slice(provider.length + 1));
    const before = await state(f);
    const revalidations = provider === 'venice' ? 2 : 1;
    assert.equal(count(before, 'authority', '/authorization/snapshot'), revalidations, 'dispatch plus existing delivery only');
    assert.equal(count(before, 'credential', '/inspect'), revalidations);
    const hit = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(hit.status, 200);
    const after = await state(f);
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'), 'covered generation hit');
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'), 'covered private credential hit');
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), revalidations);
    assert.equal(count(after, 'credential', '/inspect') - count(before, 'credential', '/inspect'), revalidations);
    assert.ok(after.calls.filter(row => row.path === '/inspect').every(row => row.emptyInspect === true), 'ordinary inspect body, no special producer marker');
    const rows = JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === provider);
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.organization === (provider === 'gmi' ? 'fixture-organization' : null)));
  });
});

for (const kind of ['authority', 'credential']) for (const origin of ['id', 'get'])
for (const reason of ['undefined', 'huge', 'opaque', 'forged']) test('native covered control ' + kind + '/' + origin + '/' + reason + ' fails before acquisition effects', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('gmi', { model: ownedHttpControlModels.gmi });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    assert.equal((await f.request('https://fixture/fixture/control-fault', { method: 'POST', body: JSON.stringify({ kind, origin, reason }) })).status, 204);
    const failed = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(failed.status, 503);
    assert.equal(JSON.parse(failed.text).error.code, 'identity_admission_unavailable');
    const after = await settledState(f);
    assert.equal(after.reasonReads, 0, 'no getter/stringification of arbitrary rejection graphs');
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'));
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'), 'no false refresh/alternate');
    assert.equal(count(after, kind, kind === 'authority' ? '/authorization/snapshot' : '/inspect'),
      count(before, kind, kind === 'authority' ? '/authorization/snapshot' : '/inspect'), 'failed acquisition starts no RPC');
    const upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(upstream.filter(row => row.id === 'gmi').length, 1);
    assert.equal(after.charged, before.charged, 'all temporary operations retire while the same cached generations remain');
  });
});

for (const streaming of [false, true]) test('native owned Venice ' + (streaming ? 'SSE' : 'JSON') + ' compact parser observes original depth peaks and preserves complete wire/value semantics', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    for (const [mode, valid] of ownedJsonCodecCases) {
      const before = await settledState(f), wire = ownedJsonCodecWire(mode, ownedHttpControlModels.venice.slice('venice/'.length));
      const response = await f.take(f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
        model: ownedHttpControlModels.venice, ownedVeniceCase: mode, ...(streaming ? { stream: true } : {}),
      })));
      const text = await f.take(f.body(response));
      assert.equal(response.status, valid ? 200 : 502, mode + ' first-frame validation precedes publication');
      if (!valid) assert.equal(JSON.parse(text).error.code, 'provider_unavailable');
      if (valid) {
        assert.equal(text, streaming ? 'data: ' + wire + '\n\ndata: [DONE]\n\n' : wire, mode + ' exact original wire');
        const value = JSON.parse(streaming ? text.slice(6, text.indexOf('\n\n')) : text);
        assert.deepEqual(value, JSON.parse(wire)); assert.equal(value.model, 'zai-org-glm-5-2');
        assert.deepEqual(value.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
      }
      const after = await settledState(f), rows = after.parsers.slice(before.parsers.length);
      assert.equal(rows.length, 1, mode + ' actual private parser invocation');
      const row = rows[0]; assert.equal(row.kind, 'validator'); assert.equal(row.nativeParses, valid || mode === 'compact-strict-space' || mode === 'compact-invalid-eof' ? 1 : 0); assert.equal(row.cleared, true); assert.equal(row.parents, 0); assert.equal(row.tokens, 0); assert.equal(row.pending, false); assert.equal(row.member, false);
      if (valid) {
        assert.equal(row.parentPushes, row.parentPops); assert.equal(row.tokenPushes, row.tokenPops);
      }
      if (mode === 'compact-object128') {
        assert.equal(row.peakParents, 0); assert.equal(row.peakDepth, 128); assert.equal(row.peakTokens, 0); assert.equal(row.tokenPushes, 0); assert.equal(row.receiptCleared, true);
      } else if (mode === 'compact-object-string128') {
        assert.equal(row.peakParents, 0); assert.equal(row.peakDepth, 128); assert.equal(row.peakTokens, 0); assert.equal(row.tokenPushes, 0); assert.equal(row.receiptCleared, true);
        assert.equal(row.objectAttachments, 0, 'validation creates no graph properties');
      } else if (mode === 'compact-object129' || mode === 'compact-open2048') {
        assert.equal(row.peakParents, 0); assert.equal(row.peakDepth, mode === 'compact-object129' ? 129 : 2049);
        assert.equal(row.peakTokens, 0); assert.equal(row.tokenPushes, 0); assert.equal(row.limited, true);
        assert.equal(row.receiptCleared, true);
      }
      assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), valid ? 2 : 1);
      assert.equal(after.events.length - before.events.length, 1, mode + ' original native accounting event');
    }
  }, true);
});

test('native later object-128 SSE transfers one original sniff reader into usage without replay factories', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-object128', stream: true,
    }))).status, 200);
    const before = await settledState(f), model = 'zai-org-glm-5-2';
    const first = 'data: ' + JSON.stringify({ model, choices: [] }) + '\n\n';
    const wire = first + 'data: ' + ownedJsonCodecWire('compact-object-string128', model) + '\n\ndata: [DONE]\n\n';
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-later-object128', stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
    }));
    assert.equal(response.status, 200); assert.equal(response.text, wire);
    const after = await settledState(f), rows = after.parsers.slice(before.parsers.length);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].peakParents, 0); assert.equal(rows[1].peakTokens, 0); assert.equal(rows[1].tokenPushes, 0);
    assert.equal(rows[1].peakDepth, 128); assert.equal(rows[1].receiptCleared, true); assert.equal(rows[1].restored, true);
    assert.equal(rows[1].consumerReaders, 1, 'the SAME original sniff reader owns the later parser peak');
    assert.equal(rows[1].pricingOwners, 0, 'pricing metadata cleared after its final consumer');
    assert.equal(rows[1].innerWrappers, 0); assert.equal(rows[1].outerWrappers, before.consumers.outer + 1);
    assert.equal(after.consumers.created - before.consumers.created, 1);
    assert.equal(after.consumers.acquired - before.consumers.acquired, 1);
    assert.equal(after.consumers.transferred - before.consumers.transferred, 1);
    assert.equal(after.consumers.replay - before.consumers.replay, 0, 'no intermediate replay stream/Response factories');
    assert.equal(after.consumers.retired - before.consumers.retired, 1); assert.equal(after.consumers.live, 0);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'), 'genuine covered generation hit');
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 2);
    const upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(upstream.filter(row => row.id === 'venice').length, 2, 'warm request plus exactly one later request');
  }, true);
});

test('native later rejected depth-129 frame preserves published status and the same reader custody', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    const response = await f.take(f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-later-object129', stream: true,
    })));
    assert.equal(response.status, 200, 'the earlier healthy event already published');
    await assert.rejects(f.take(f.body(response)));
    const after = await settledState(f), rows = after.parsers.slice(before.parsers.length);
    assert.equal(rows.length, 2); assert.equal(rows[1].consumerReaders, 1);
    assert.equal(rows[1].peakParents, 0); assert.equal(rows[1].peakTokens, 0); assert.equal(rows[1].peakDepth, 129);
    assert.equal(rows[1].limited, true); assert.equal(rows[1].nativeParses, 0); assert.equal(rows[1].cleared, true);
    assert.equal(after.consumers.acquired - before.consumers.acquired, 1);
    assert.equal(after.consumers.retired - before.consumers.retired, 1); assert.equal(after.consumers.live, 0);
    assert.equal(after.consumers.replay, before.consumers.replay);
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 2);
    assert.equal(after.events.length - before.events.length, 1);
  }, true);
});

test('native private sniff publishes its 8-KiB comment prefix before held first-data authorization', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), prefix = ':' + 'x'.repeat(8192) + '\n\n';
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'POST', body: 'delivery' })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-comment-prefix', stream: true,
    }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.parserHold?.arrived) break;
      if (held.completed.length > before.completed.length) { await f.take(dispatch); assert.fail('first-data authorization was not held'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(held.consumers.enqueued - before.consumers.enqueued, Buffer.byteLength(prefix));
    assert.equal(held.consumers.transferred - before.consumers.transferred, 1);
    assert.equal(held.consumers.acquired - before.consumers.acquired, 1);
    assert.equal(held.consumers.replay, before.consumers.replay);
    const response = await f.take(dispatch);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    assert.equal(held.completed.length, before.completed.length);
    await release();
    assert.equal(await f.take(f.body(response)), prefix + 'data: ' + ownedJsonCodecWire('compact-object128', 'zai-org-glm-5-2') + '\n\ndata: [DONE]\n\n');
    const after = await settledState(f);
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 2);
    assert.equal(after.events.length - before.events.length, 1); assert.equal(after.consumers.live, 0);
  }, true);
});

for (const mode of ['forged', 'stale', 'mode']) test('native private consumer rejects ' + mode + ' binding before reader acquisition', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('venice', { model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-object128' });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode })).status, 204);
    const denied = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(denied.status, 503);
    const after = await settledState(f);
    assert.equal(after.consumers.acquired, before.consumers.acquired);
    assert.equal(after.consumers.created, before.consumers.created);
    assert.equal(after.consumers.live, 0);
    assert.equal(after.events.length - before.events.length, 1, 'one original accounting outcome, no request replay');
  }, true);
});

for (const kind of ['undefined', 'primitive', 'shared']) test('native consumer joins held post-native cancellation and independent ' + kind + ' read/unlock origins', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    f.expectFailedRetirement(before.intakes.length);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'read-' + kind })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-later-object128', stream: true,
    }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.consumers.held) break;
      if (held.completed.length > before.completed.length) { await f.take(dispatch); assert.fail('original consumer ended before its cancellation hold'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await f.take(dispatch); assert.equal(response.status, 200, 'prefix already published before later consumer failure');
    let hasBodyFailure = false, bodyFailure;
    try { await f.take(f.body(response)); } catch (error) { hasBodyFailure = true; bodyFailure = error; }
    assert.equal(hasBodyFailure, true); assert.equal(held.consumers.cancel, 1); assert.equal(held.consumers.unlock, 1);
    assert.equal(held.consumers.reasonReads, 0); assert.equal(held.completed.length, before.completed.length);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const after = await settledState(f), origins = after.completed.at(-1).origins;
    try {
      assert.equal(after.consumers.live, 0); assert.equal(after.consumers.cancel, 1); assert.equal(after.consumers.reasonReads, 0);
      assert.deepEqual(origins.map(value => value.origin), ['read', 'cancel', 'unlock']);
      assert.ok(origins.every(value => value.undefined === (kind === 'undefined')));
      assert.equal(origins.length, 3, 'shared rejection values remain three actual operation origins');
      assert.equal(after.events.length - before.events.length, 1);
    } catch (validation) { throw new AggregateError([...(hasBodyFailure ? [bodyFailure] : []), validation], 'native consumer failure validation'); }
  }, true);
});

for (const phase of ['delivery', 'accounting']) test('native compact parser aliases clear while original ' + phase + ' still owns funded request children', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const streaming = phase === 'delivery', before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'POST', body: phase })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-object128', ...(streaming ? { stream: true } : {}),
    }));
    const progress = f.own((async () => {
      const response = await f.take(dispatch); assert.equal(response.status, 200);
      return f.take(f.body(response));
    })());
    let ended = false;
    const monitor = f.own(progress.outcome.then(() => { ended = true; }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.parserHold?.arrived) break;
      if (held.completed.length > before.completed.length || phase === 'delivery' && ended) {
        await f.take(progress); assert.fail('original request completed before its parser custody hold');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const parser = held.parsers.at(-1);
    assert.equal(parser.peakParents, 0); assert.equal(parser.peakDepth, 128); assert.equal(parser.nativeParses, 1); assert.equal(parser.peakTokens, 0); assert.equal(parser.tokenPushes, 0); assert.equal(parser.restored, true); assert.equal(parser.cleared, true);
    assert.equal(parser.parents, 0); assert.equal(parser.tokens, 0); assert.equal(parser.pending, false);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024, 'parser discard is not request/foreground credit retirement');
    assert.equal(held.completed.length, before.completed.length, 'original request retirement remains held');
    if (phase === 'accounting') assert.equal(await f.take(progress), ownedJsonCodecWire('compact-object128', 'zai-org-glm-5-2'), 'complete public JSON is deliverable while accounting remains held');
    else assert.equal(ended, false, 'first SSE data still waits for its actual fresh authority result');
    await release();
    const text = await f.take(progress); await f.take(monitor);
    if (streaming) assert.equal(text, 'data: ' + ownedJsonCodecWire('compact-object128', 'zai-org-glm-5-2') + '\n\ndata: [DONE]\n\n');
    const after = await settledState(f);
    assert.ok(after.charged < held.charged, 'only joined original children permit foreground retirement');
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 2);
  }, true);
});

for (const [mode, expected] of [['depth128', 200], ['object-depth128', 200], ['depth129', 502], ['open2048', 502],
  ['nodes65536', 200], ['nodes65537', 502], ['wire-limit', 200], ['wire-plus', 502],
  ['unicode-unknown', 200], ['wrong-model', 502], ['own-error', 502]])
test('owned native Venice JSON preserves its original ' + mode + ' boundary', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: mode,
    }));
    assert.equal(response.status, expected, mode);
    const report = await settledState(f);
    const dispatch = report.calls.findLast(row => row.kind === 'budget' && row.path === '/dispatch');
    const provider = report.calls.findLast(row => row.kind === 'provider');
    assert.ok(dispatch && provider, 'actual reserved and dispatched original request');
    assert.ok(provider.charged - dispatch.charged < 1024 * 1024, 'no extra ordinary 64 MiB response lease');
    assert.equal(count(report, 'credential', '/materialize'), 1, 'no response-driven credential retry');
    assert.equal(count(report, 'authority', '/authorization/snapshot'), expected === 200 ? 2 : 1);
    if (expected === 200) {
      assert.equal(response.headers.get('etag'), null); assert.equal(response.headers.get('digest'), null);
      assert.equal(response.headers.get('content-md5'), null); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const value = JSON.parse(response.text);
      assert.equal(value.model, ownedHttpControlModels.venice.slice('venice/'.length));
      if (mode === 'wire-limit') assert.equal(new TextEncoder().encode(response.text).byteLength, 2097152);
      if (mode === 'nodes65536') assert.equal(value.extra.length, 65533);
      if (mode === 'depth128') { let nested = value.extra; for (let index = 0; index < 127; index++) nested = nested[0]; assert.equal(nested, 0); }
      if (mode === 'unicode-unknown') {
        assert.equal(Object.hasOwn(value.extra, '__proto__'), true);
        assert.deepEqual(value.extra.__proto__, { kept: true }); assert.equal(value.extra.duplicate, 2);
        assert.equal(value.extra.text, 'é😀\ud800x\udfff\n"\\');
        assert.match(response.text, /"duplicate":1,"duplicate":2/, 'original raw wire, not a parse/reserialize copy');
      }
    }
    const rows = JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'venice');
    assert.equal(rows.length, 1);
  });
});

test('owned native Venice SSE exceeds 2 MiB total with one fresh first-data check and no per-frame RPC', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'stream-large',
    }));
    assert.equal(response.status, 200); assert.ok(new TextEncoder().encode(response.text).byteLength > 2097152);
    const frames = response.text.split('\n\n').filter(Boolean), data = frames.map(frame => frame.slice('data: '.length));
    assert.equal(data.at(-1), '[DONE]');
    const values = data.slice(0, -1).map(value => JSON.parse(value));
    assert.equal(values.filter(value => value.choices[0]?.delta.content?.length === 120000).length, 20);
    assert.ok(values.every(value => value.model === ownedHttpControlModels.venice.slice('venice/'.length)));
    const report = await settledState(f);
    assert.equal(count(report, 'authority', '/authorization/snapshot'), 2);
    assert.equal(count(report, 'credential', '/inspect'), 2);
    const dispatch = report.calls.findLast(row => row.kind === 'budget' && row.path === '/dispatch');
    const provider = report.calls.findLast(row => row.kind === 'provider');
    assert.ok(provider.charged - dispatch.charged < 1024 * 1024, 'no extra ordinary 16 MiB SSE lease');
    assert.equal(report.events.length, 1); assert.equal(report.events[0].reserved, 7);
  });
});

for (const provider of ['gmi', 'venice']) for (const change of ['disabled', 'rotated', 'policy-provider', 'policy-model'])
test('native covered ' + provider + ' revalidation uses fresh canonical ' + change, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat(provider, { model: ownedHttpControlModels[provider] });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    assert.equal((await f.request('https://fixture/fixture/revalidation-change', { method: 'POST', body: JSON.stringify({ provider, change }) })).status, 204);
    const failed = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(failed.status, 403);
    const after = await settledState(f);
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'), 'genuine covered HIT');
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 1);
    assert.equal(count(after, 'credential', '/inspect'), count(before, 'credential', '/inspect'), 'snapshot denial precedes inspect');
    const upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(upstream.filter(row => row.id === provider).length, 1, 'no retry or fallback after changed authority');
  });
});

for (const kind of ['authority', 'credential']) for (const reason of ['undefined', 'shared'])
test('native ' + kind + ' control keeps original read/cancel/unlock and funding across a post-native cancellation hold: ' + reason, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('gmi', { model: ownedHttpControlModels.gmi });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    // Release is enrolled before the failing request. Teardown must release it
    // even if arrival assertions fail, then join that request's original roots.
    const release = async () => {
      assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204);
    };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind, reason }),
    })).status, 204);
    let settled = false;
    const original = f.request('https://fixture/v1/chat/completions', request());
    const root = f.own(original);
    // The arrival wait also observes an early original rejection/fulfillment;
    // it cannot hang until teardown behind a gate the request never reached.
    const observer = f.own(original.then(() => { settled = true; }, () => { settled = true; }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.controlReads.at(-1)?.cancelSettled === 1) break;
      if (settled) {
        await f.take(root);
        assert.fail('control request fulfilled before original cancellation hold');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(settled, false, 'public failure does not substitute for the original cleanup join');
    assert.deepEqual(held.controlReads.at(-1), {
      kind, read: 1, readSettled: 1, cancel: 1, cancelSettled: 1, unlock: 0, released: false,
    });
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024, 'foreground backing remains held');
    assert.equal(held.reasonReads, 0, 'no arbitrary reason getters while a sibling cleanup is held');
    await release();
    const failed = await f.take(root); await f.take(observer);
    assert.equal(failed.status, 503);
    assert.equal(JSON.parse(failed.text).error.code, 'identity_admission_unavailable');
    const after = await settledState(f);
    assert.deepEqual(after.controlReads.at(-1), {
      kind, read: 1, readSettled: 1, cancel: 1, cancelSettled: 1, unlock: 1, released: true,
    });
    assert.equal(after.reasonReads, 0);
    assert.equal(after.charged, before.charged, 'only actual completion and alias clearing retire the temporary debit');
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'));
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'));
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'gmi').length, 1);
  });
});

for (const streaming of [false, true]) for (const reason of ['undefined', 'shared', 'huge'])
test('native Venice ' + (streaming ? 'delivered SSE' : 'JSON') + ' codec joins independently failing original read/cancel/unlock after the post-native hold: ' + reason, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('venice', { model: ownedHttpControlModels.venice, ...(streaming ? { stream: true } : {}) });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204); };
    f.releases.push(release); f.expectFailedRetirement(before.completed.length);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind: 'provider', reason, ...(streaming ? { afterReads: 1 } : {}) }),
    })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', request());
    const original = f.take(dispatch).then(async response => ({ response, text: await f.take(f.body(response)) })), root = f.own(original);
    let settled = false;
    const observer = f.own(original.then(() => { settled = true; }, () => { settled = true; }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.controlReads.at(-1)?.cancelSettled === 1) break;
      if (settled) { await f.take(root); assert.fail('codec failed before reaching original cancellation'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(held.controlReads.at(-1), {
      kind: 'provider', read: streaming ? 2 : 1, readSettled: streaming ? 2 : 1, cancel: 1, cancelSettled: 1, unlock: 0, released: false,
    });
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    assert.equal(held.reasonReads, 0);
    await release();
    let failed, hasBodyFailure = false, bodyFailure;
    try { failed = await f.take(root); } catch (error) { hasBodyFailure = true; bodyFailure = error; }
    await f.take(observer);
    const response = await f.take(dispatch);
    try {
      assert.equal(response.status, streaming ? 200 : 502); assert.equal(hasBodyFailure, streaming);
      if (!streaming) assert.equal(JSON.parse(failed.text).error.code, 'provider_unavailable');
    } catch (validation) { throw new AggregateError(hasBodyFailure ? [bodyFailure, validation] : [validation], 'codec public outcome'); }
    const after = await settledState(f);
    assert.deepEqual(after.controlReads.at(-1), {
      kind: 'provider', read: streaming ? 2 : 1, readSettled: streaming ? 2 : 1, cancel: 1, cancelSettled: 1, unlock: 1, released: true,
    });
    assert.equal(after.reasonReads, 0); assert.equal(after.charged, before.charged);
    assert.deepEqual(after.completed.at(-1).origins, ['read', 'cancel', 'unlock'].map(origin => ({ origin, undefined: reason === 'undefined' })));
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'));
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'));
    assert.equal(count(after, 'authority', '/authorization/snapshot'), count(before, 'authority', '/authorization/snapshot') + (streaming ? 2 : 1));
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'venice').length, 2);
  });
});

// UNKNOWN has no success retirement receipt. These isolated fixtures observe
// every dispatch/body, release originals, then terminate the actual Worker.
async function unknownFixture(run) {
  let directory, runtime, hasPrimary = false, primary;
  const roots = [], releases = [], failures = [];
  const request = async (url, init) => {
    const root = runtime.dispatchFetch(url, init)
      .then(async response => ({ status: response.status, text: await response.text() }))
      .then(value => ({ value }), error => ({ failed: true, error }));
    roots.push(root);
    const outcome = await root;
    if (outcome.failed) throw outcome.error;
    return outcome.value;
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'owned-http-unknown-'));
    runtime = await startOwnedJsonObservedFixture(directory, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true });
    await seedOwnedHttpChat(runtime);
    assert.equal((await request('https://fixture/fixture/grants', { method: 'POST' })).status, 204);
    await run({ request, releases });
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    for (const release of releases) try { await release(); } catch (error) { failures.push(error); }
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    for (const root of roots) await root;
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'UNKNOWN fixture termination');
  if (hasPrimary) throw primary;
}

for (const [provider, kind, status] of [['gmi', 'authority', 503], ['venice', 'provider', 502]])
test(`native ${provider} listener-removal uncertainty retains funding until isolate termination`, { timeout: 120000 }, async () => {
  await unknownFixture(async f => {
    const request = () => chat(provider, { model: ownedHttpControlModels[provider] });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind, reason: 'listener' }),
    })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(response.status, status);
    const held = await state(f);
    assert.equal(held.controlReads.at(-1).removalFailed, true);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    assert.equal(held.completed.length, before.completed.length, 'UNKNOWN does not report completed retirement');
    assert.equal(held.reasonReads, 0);
    await release();
    const after = await state(f);
    assert.equal(after.controlReads.at(-1).released, true);
    assert.equal(after.charged, held.charged, 'fixture release cannot refund UNKNOWN ownership');
    assert.equal(after.completed.length, before.completed.length);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === provider).length,
      provider === 'gmi' ? 1 : 2, 'the revalidation failure precedes dispatch; the codec failure follows it');
  });
});

test('compiled owned HTTP Chat preserves JSON and covered-hit zero foreground authority/materialization RPCs', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const first = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(first.status, 200); assert.equal(JSON.parse(first.text).choices[0].message.content, 'synthetic-answer');
    assert.deepEqual(JSON.parse(first.text).usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
    const before = await state(f);
    const hit = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(hit.status, 200); const after = await state(f);
    assert.equal(count(after, 'authority', '/admission/credential-preflight'), count(before, 'authority', '/admission/credential-preflight'));
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'));
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'));
    assert.equal(count(after, 'authority', '/grant-pools/select'), count(before, 'authority', '/grant-pools/select'));
  });
});

test('compiled owned HTTP Chat streams original SSE tools/usage and a valid one-MiB upload', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const tools = await f.request('https://fixture/v1/chat/completions', chat('tool', { stream: true }));
    assert.equal(tools.status, 200); assert.match(tools.headers.get('content-type'), /text\/event-stream/);
    assert.match(tools.text, /tool_calls/); assert.match(tools.text, /total_tokens/); assert.match(tools.text, /\[DONE\]/);
    const large = await f.request('https://fixture/v1/chat/completions', chat('large', { messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }));
    assert.equal(large.status, 200);
    const upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    const original = upstream.filter(row => row.id === 'large'); assert.equal(original.length, 1); assert.ok(original[0].bytes > 1024 * 1024);
    assert.equal(original[0].method, 'POST'); assert.equal(original[0].model, ownedHttpModel.slice('volcengine/'.length));
  });
});

test('owned OFF revalidates while wrong-secret and malformed-JSON precedence preserve native errors', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('off'))).status, 200);
    const before = await state(f);
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('off'))).status, 200);
    const after = await state(f);
    assert.ok(count(after, 'authority', '/admission/credential-preflight') > count(before, 'authority', '/admission/credential-preflight'));
    assert.ok(count(after, 'credential', '/materialize') > count(before, 'credential', '/materialize'));
    const largeBefore = await settledState(f);
    const large = await f.request('https://fixture/v1/chat/completions', chat('off', { messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }));
    assert.equal(large.status, 200, 'OFF intake owner retires before the covered replacement reserves');
    const largeAfter = await settledState(f);
    const admissions = largeAfter.calls.slice(largeBefore.calls.length).filter(row => row.kind === 'authority' && row.path === '/admission/resolve');
    assert.equal(admissions.length, 2);
    assert.ok(admissions[0].charged >= 32 * 1024 * 1024);
    assert.ok(admissions[1].charged >= 64 * 1024 * 1024 && admissions[1].charged < 96 * 1024 * 1024);
    const bad = chat('chat'); bad.headers.authorization = 'Bearer clawrouter-live-owned_http_chat-wrong'; bad.body = '{';
    assert.equal((await f.request('https://fixture/v1/chat/completions', bad)).status, 401);
    bad.headers.authorization = `Bearer ${ownedHttpProxyKey('chat')}`;
    assert.equal((await f.request('https://fixture/v1/chat/completions', bad)).status, 400);
    const rejected = await f.request('https://fixture/v1/chat/completions', chat('error'));
    assert.equal(rejected.status, 400);
    const upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(upstream.filter(row => row.id === 'error').length, 1, 'no replay of rejected original');
  });
});

test('known HTTP preparation pressure denies BEFORE full admission can count or dispatch', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    // Cleanup is registered before acquiring pressure. This is common-arena
    // pressure, not optional-cache pressure or a new request/profile limit.
    f.releases.push(async () => { assert.equal((await f.request('https://fixture/fixture/pressure', { method: 'DELETE' })).status, 204); });
    assert.equal((await f.request('https://fixture/fixture/pressure', { method: 'POST' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat', { tools: Array(513).fill('') }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-clawrouter-error-code'), 'identity_admission_unavailable');
    const report = await state(f);
    assert.ok(report.toolScratchBytes >= 8224);
    assert.equal(count(report, 'authority', '/admission/credential-preflight'), 1, 'correct secret was preverified');
    assert.equal(count(report, 'authority', '/admission/resolve'), 0, 'no full admission or initial choice');
    assert.equal(count(report, 'authority', '/grant-pools/select'), 0);
    assert.equal(count(report, 'authority', '/grant-pools/record'), 0);
    assert.deepEqual(JSON.parse((await f.request('https://fixture/fixture/upstream')).text), []);
  }, true);
});


for (const streaming of [false, true]) for (const mode of ['capture-before', 'capture-after'])
test('native accepted-byte capture preserves ' + mode + ' mutation policy and usage: ' + streaming, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', { model: ownedHttpControlModels.venice, stream: streaming }));
    assert.equal(response.status, 200);
    const expected = mode === 'capture-before' ? 9 : 4;
    assert.ok(response.text.includes('"prompt_tokens":' + expected));
    const after = await settledState(f);
    assert.equal(after.consumers.mutations, 1); assert.equal(after.consumers.oversizedOutput, 0, 'no future slab bytes exposed through buffer');
    assert.equal(after.consumers.acquired, 1); assert.equal(after.consumers.replay, 0);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(after.events.at(-1).input, expected, 'usage consumes actual accepted captured bytes, not codec identity');
    assert.equal(after.events.at(-1).output, 3);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true);
});

for (const mode of [
  ...['before', 'after'].flatMap(order => ['success', 'undefined', 'primitive', 'shared'].map(kind => 'unlock-' + order + '-' + kind)),
  'closed-undefined', 'closed-shared', 'unlock-before-closed-shared',
]) test('native request intake keeps its original ' + mode + ' before returning', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), kind = mode.split('-').at(-1);
    if (kind !== 'success') f.expectFailedRetirement(before.intakes.length);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-' + mode })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('chat'));
    let delivered = false;
    const observer = f.own(dispatch.outcome.then(() => { delivered = true; }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.consumers.intake.held) break;
      if (delivered) { await f.take(dispatch); assert.fail('intake returned before its actual hold'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(delivered, false, 'request intake keeps cleanup-before-return ordering');
    assert.equal(held.consumers.intake.live, 1); assert.equal(held.consumers.intake.unlock, 1);
    assert.equal(held.consumers.intake.nativeUnlocked, mode.startsWith('unlock-after-') ? 0 : 1);
    assert.equal(held.reasonReads + held.consumers.intake.reasonReads, 0);
    assert.ok(held.charged > before.charged, 'the actual intake debit survives the hold');
    assert.equal(count(held, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'));
    await release();
    const response = await f.take(dispatch); await f.take(f.body(response)); await f.take(observer);
    assert.equal(response.status, kind === 'success' || mode.startsWith('closed-') ? 200 : 500);
    const after = await settledState(f), row = after.consumers.intake;
    assert.equal(row.unlock, 1); assert.equal(row.nativeUnlocked, 1); assert.equal(row.unlockSettled, 1); assert.equal(row.live, 0);
    assert.deepEqual(after.completed.at(-1).origins.map(value => value.origin), kind === 'success' ? []
      : mode.startsWith('closed-') ? ['closed'] : mode.includes('-closed-') ? ['unlock', 'closed'] : ['unlock']);
    assert.equal(row.reasonReads, 0);
  }, true);
});

for (const stage of ['consumer', 'public']) for (const mode of [
  ...['before', 'after'].flatMap(order => ['success', 'undefined', 'primitive', 'shared'].map(kind => 'unlock-' + order + '-' + kind)),
  'closed-undefined', 'closed-shared', 'unlock-before-closed-shared',
]) test('native ' + stage + ' original ' + mode + ' is joined independently of public completion', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), kind = mode.split('-').at(-1);
    if (kind !== 'success') f.expectFailedRetirement(before.intakes.length);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release); // Before setup or dispatch can fail.
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: (stage === 'public' ? 'public-' : '') + mode })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-later-object128', stream: true,
    }));
    let held;
    for (;;) {
      held = await state(f);
      if ((stage === 'public' ? held.consumers.public : held.consumers).held) break;
      if (held.completed.length > before.completed.length) { await f.take(dispatch); assert.fail('consumer ended before returned-work arrival'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const response = await f.take(dispatch); assert.equal(response.status, 200);
    const text = await f.take(f.body(response)); assert.ok(text.includes('data: [DONE]'), 'public output does not wait for independent retirement');
    held = await state(f);
    const heldReader = stage === 'public' ? held.consumers.public : held.consumers;
    assert.equal(held.completed.length, before.completed.length); assert.equal(heldReader.live, 1);
    assert.equal(held.consumers.acquired, 1); assert.equal(held.consumers.replay, 0);
    assert.equal(heldReader.unlock, 1); assert.equal(heldReader.reasonReads, 0);
    assert.equal(heldReader.nativeUnlocked, mode.startsWith('unlock-after-') ? 0 : 1);
    assert.equal(heldReader.unlockSettled, mode.startsWith('closed-') ? 1 : 0);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const after = await settledState(f), origins = after.completed.at(-1).origins ?? [];
    const retiredReader = stage === 'public' ? after.consumers.public : after.consumers;
    assert.equal(retiredReader.unlock, 1); assert.equal(retiredReader.nativeUnlocked, 1);
    assert.equal(retiredReader.unlockSettled, 1); assert.equal(retiredReader.live, 0);
    assert.equal(retiredReader.thenCalls, mode === 'unlock-after-success' ? 1 : 0);
    assert.equal(retiredReader.reasonReads, 0); assert.ok(after.charged < held.charged);
    assert.deepEqual(origins.map(value => value.origin), kind === 'success' ? [] : mode.startsWith('closed-') ? ['closed']
      : mode.includes('-closed-') ? ['unlock', 'closed'] : ['unlock']);
    assert.ok(origins.every(value => value.undefined === (kind === 'undefined')));
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true);
});

for (const [mode, kind, streaming] of [
  ...['unlock-before', 'unlock-after'].flatMap(mode => ['success', 'undefined', 'shared', 'huge'].map(kind => [mode, kind, true])),
  ['closed', 'undefined', true], ['closed', 'shared', true], ['unlock-before-closed', 'shared', true],
  ['unlock-before', 'success', false], ['unlock-after', 'success', false],
]) test('native source original ' + mode + '/' + kind + '/' + (streaming ? 'SSE' : 'BYOB JSON') + ' settles before lock disposition', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    if (kind !== 'success') f.expectFailedRetirement(before.intakes.length);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind: 'provider', mode, reason: kind }),
    })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: streaming ? 'compact-later-object128' : 'compact-object128', ...(streaming ? { stream: true } : {}),
    }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.controlReads.at(-1)?.held) break;
      if (held.completed.length > before.completed.length) { await f.take(dispatch); assert.fail('source ended before returned-work arrival'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const row = held.controlReads.at(-1);
    assert.equal(row.read, row.readSettled); assert.ok(row.read > 0); assert.equal(held.reasonReads, 0);
    if (mode !== 'closed') {
      assert.equal(row.unlock, 1); assert.equal(row.unlockSettled, 0);
      assert.equal(row.nativeUnlocked, mode.startsWith('unlock-before') ? 1 : 0);
    }
    if (streaming) assert.equal((await f.take(dispatch)).status, 200, 'headers/prefix remain deliverable while source retirement is held');
    assert.equal(held.completed.length, before.completed.length); assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const response = await f.take(dispatch); let text, hasBodyFailure = false, bodyFailure;
    try { text = await f.take(f.body(response)); } catch (error) { hasBodyFailure = true; bodyFailure = error; }
    try {
      const after = await settledState(f), final = after.controlReads.at(-1), origins = after.completed.at(-1).origins ?? [];
      assert.equal(response.status, 200); assert.equal(final.unlock, 1); assert.equal(final.nativeUnlocked, 1);
      assert.equal(final.unlockSettled, 1); assert.equal(final.thenCalls, mode === 'unlock-after' && kind === 'success' ? 1 : 0);
      assert.equal(after.reasonReads, 0); assert.ok(after.charged < held.charged);
      assert.equal(hasBodyFailure, kind !== 'success' && mode !== 'closed');
      if (!hasBodyFailure) assert.ok(streaming ? text.includes('data: [DONE]') : JSON.parse(text).choices);
      assert.deepEqual(origins.map(value => value.origin), kind === 'success' ? [] : mode === 'closed' ? ['closed']
        : mode === 'unlock-before-closed' ? ['unlock', 'closed'] : ['unlock']);
      assert.ok(origins.every(value => value.undefined === (kind === 'undefined')));
      assert.equal(after.events.length - before.events.length, 1);
      assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
    } catch (validation) { throw new AggregateError([...(hasBodyFailure ? [bodyFailure] : []), validation], 'native original returned-work validation'); }
  });
});


test('native independent source closed getter throw keeps its own origin and original cleanup', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f); f.expectFailedRetirement(before.intakes.length);
    f.releases.push(async () => { assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204); });
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind: 'provider', mode: 'closed-getter', reason: 'undefined' }),
    })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-object128',
    }));
    const after = await settledState(f), row = after.controlReads.at(-1);
    assert.equal(response.status, 502); assert.equal(JSON.parse(response.text).error.code, 'provider_unavailable');
    assert.equal(row.closedGetter, 1); assert.equal(row.read, 0); assert.equal(row.unlock, 1); assert.equal(row.nativeUnlocked, 1);
    assert.deepEqual(after.completed.at(-1).origins, [{ origin: 'closed', undefined: true }]);
    assert.equal(after.reasonReads, 0); assert.equal(after.events.length - before.events.length, 1);
  });
});

for (const streaming of [true, false]) for (const name of ownedUsageCases.filter(name => streaming || ['wide', 'deep', 'quoted', 'scalar', 'malformed', 'many-lines', 'overflow'].includes(name)))
test('native genuine accepted usage census and ordinary oracle: ' + name + '/' + streaming, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = { method: 'POST', body: JSON.stringify({ name, format: streaming ? 'sse' : 'json' }) };
    const reference = JSON.parse((await f.request('https://fixture/fixture/usage-reference', request)).text);
    f.releases.push(async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); });
    assert.equal((await f.request('https://fixture/fixture/usage-case', request)).status, 204);
    const before = await settledState(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', { model: ownedHttpControlModels.venice, stream: streaming }));
    assert.equal(response.status, 200); assert.equal(response.text, ownedUsageWire(name, streaming));
    const after = await settledState(f);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(after.events.at(-1).input, reference.tokens?.input ?? null);
    assert.equal(after.events.at(-1).output, reference.tokens?.output ?? null);
    assert.equal(after.consumers.acquired, 1); assert.equal(after.consumers.replay, 0);
    assert.equal(after.consumers.oversizedOutput, 0);
    assert.equal(after.usage.census, after.usage.parsed); assert.equal(after.usage.cleared, 1);
    if (name === 'wide') { assert.equal(after.usage.maxContainers, 600002); assert.ok(after.usage.maxGraph >= 9600042); }
    if (name.startsWith('refusal') || name === 'two-large') assert.ok(after.usage.summaries >= 2);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true);
});

for (const when of ['before', 'after']) test('native request capture survives real intake authentication yield: ' + when, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => {
      await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' });
      await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-request-' + when })).status, 204);
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'POST', body: 'intake' })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('chat', { messages: [{ role: 'user', content: 'snapA' + 'x'.repeat(1024 * 1024) }] }));
    let held;
    for (;;) { held = await state(f); if (held.parserHold?.arrived) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(held.consumers.intake.capturedBytes >= 1024 * 1024);
    assert.equal(held.consumers.intake.live, 1); assert.equal(held.completed.length, 0);
    assert.equal(count(held, 'provider', '/chat/completions'), 0);
    if (when === 'after') assert.equal((await f.request('https://fixture/fixture/intake-mutate', { method: 'POST' })).status, 204);
    await release();
    const response = await f.take(dispatch); assert.equal(response.status, 200); await f.take(f.body(response));
    const after = await settledState(f), upstream = JSON.parse((await f.request('https://fixture/fixture/upstream')).text);
    assert.equal(upstream.length, 1); assert.equal(upstream[0].requestMarker, when === 'before' ? 'snapB' : 'snapA');
    assert.equal(after.events.length, 1); assert.equal(after.consumers.intake.mutations, 1);
    assert.equal(after.consumers.intake.live, 0); assert.equal(after.consumers.intake.retired, 1);
  }, true);
});

test('native aborted intake captures and discards an actual late fulfilled read before retirement', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-request-late' })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('chat', { messages: [{ role: 'user', content: 'snapA-late' }] }));
    let held;
    for (;;) { held = await state(f); if (held.consumers.intake.held) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(held.consumers.intake.captures ?? 0, 0); assert.equal(held.completed.length, 0);
    assert.equal((await f.request('https://fixture/fixture/intake-abort', { method: 'POST' })).status, 204);
    const aborted = await state(f); assert.equal(aborted.completed.length, 0); assert.ok(aborted.charged >= held.charged);
    await release();
    const response = await f.take(dispatch); assert.equal(response.status, 499); await f.take(f.body(response));
    const after = await settledState(f);
    assert.equal(after.consumers.intake.captures, 1, 'actual late fulfillment was captured under its original owner');
    assert.equal(after.consumers.intake.live, 0); assert.equal(after.consumers.intake.retired, 1);
    assert.equal(count(after, 'provider', '/chat/completions'), 0); assert.equal(after.events.length, 0);
    assert.ok(after.charged < held.charged, 'only joined intake ownership retires');
  }, true);
});

for (const mode of ['unlock-after-success', 'closed-undefined', 'unlock-before-closed-shared'])
test('native private four soft-status owners overlap delivery and charging: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const kv = await f.runtime.getKVNamespace('POLICY_KV', 'router');
    await kv.put('connections/volcengine', JSON.stringify({ providerId: 'volcengine', enabled: true, monthlyBudgetMicros: 1000000 }));
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'status-' + mode })).status, 204);
    const before = await state(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('soft', { stream: true }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    let held;
    for (;;) { held = await state(f); if (held.statusReaders.length === 4 && held.statusReaders.every(row => row.held) && held.events.length === 1) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(held.completed.length, 0, 'public delivery and logical charge do not retire held originals');
    assert.ok(held.charged > before.charged);
    assert.equal(held.statusReaders.every(row => row.retired), false);
    assert.equal(held.statusReaders.every(row => row.decided), mode === 'closed-undefined', 'closed is independent custody; returned unlock precedes decision');
    const charges = held.calls.filter(row => row.kind === 'budget' && row.path === '/charge');
    assert.equal(charges.length, 4); assert.equal(new Set(charges.map(row => row.chargeId)).size, 4);
    assert.ok(Number(response.headers.get('server-timing')?.match(/cr-budget;dur=([\d.]+)/)?.[1]) >= 40);
    await release();
    const after = await settledState(f);
    assert.ok(after.statusReaders.every(row => row.retired && row.decided && row.unlock === 1 && row.nativeUnlocked === 1));
    assert.ok(after.statusReaders.every(row => row.reasonReads === 0));
    assert.equal(after.events.length, 1); assert.ok(after.charged < held.charged);
    assert.deepEqual(after.calls.filter(row => row.kind === 'budget' && row.path === '/charge').map(row => row.chargeId), charges.map(row => row.chargeId));
  }, true);
});


test('native later object-128 SSE overlaps four original private status reads after grace', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const kv = await f.runtime.getKVNamespace('POLICY_KV', 'router');
    await kv.put('connections/venice', JSON.stringify({ providerId: 'venice', enabled: true, monthlyBudgetMicros: 1000000 }));
    const input = { model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128' };
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('soft_venice', input))).status, 200);
    const before = await settledState(f);
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'status-pending-success' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('soft_venice', input));
    assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    const held = await state(f);
    assert.equal(held.statusReaders.length, 4); assert.ok(held.statusReaders.every(row => row.held && !row.retired && !row.decided));
    const current = held.parsers.slice(before.parsers.length);
    assert.equal(current.length, 2); assert.equal(current[1].peakParents, 0); assert.equal(current[1].peakDepth, 128); assert.equal(current[1].statusPending, 4);
    assert.equal(count(held, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'), 'covered later borrower');
    assert.equal(count(held, 'authority', '/grant-pools/record'), count(before, 'authority', '/grant-pools/record'), 'own pending cohort remains deferred');
    assert.equal(held.events.length, before.events.length + 1); assert.equal(held.completed.length, before.completed.length);
    await release();
    const after = await settledState(f);
    assert.ok(after.statusReaders.every(row => row.retired && row.decided));
    assert.equal(after.events.length, before.events.length + 1); assert.ok(after.charged < held.charged);
    assert.equal(count(after, 'authority', '/grant-pools/record'), count(before, 'authority', '/grant-pools/record') + 1);
  }, true);
});

for (const mode of ['line-limit', 'line-plus', 'line-error'])
test('native private codec range fold preserves line count and event-error boundary: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: mode,
    }));
    assert.equal(response.status, mode === 'line-limit' ? 200 : 502);
    if (mode === 'line-limit') assert.equal(response.text, ownedCodecSseLines('zai-org-glm-5-2', mode));
    const after = await settledState(f); assert.equal(after.events.length, 1);
  }, true);
});

test('native private terminal keeps post-native original pending despite early then return', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(async () => { await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' }); });
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'POST', body: 'accounting-then' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    let held;
    for (;;) { held = await state(f); if (held.parserHold?.arrived) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(held.completed.length, 0); assert.ok(held.charged >= 32 * 1024 * 1024);
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' })).status, 204);
    const after = await settledState(f); assert.equal(after.events.length, 1); assert.ok(after.charged < held.charged);
  }, true);
});

test('native private status fetch ignores early then return and keeps its late body', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const kv = await f.runtime.getKVNamespace('POLICY_KV', 'router');
    await kv.put('connections/venice', JSON.stringify({ providerId: 'venice', enabled: true, monthlyBudgetMicros: 1000000 }));
    f.releases.push(async () => { await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' }); });
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'POST', body: 'status-then' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('soft_venice', { model: ownedHttpControlModels.venice, stream: true }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    const held = await state(f);
    assert.equal(held.parserHold.arrived, true); assert.equal(held.completed.length, 0);
    assert.equal(held.calls.filter(row => row.kind === 'budget' && row.path === '/status').length, 4);
    assert.ok(held.charged >= 32 * 1024 * 1024);
    assert.equal((await f.request('https://fixture/fixture/parser-hold', { method: 'DELETE' })).status, 204);
    const after = await settledState(f);
    assert.ok(after.statusReaders.every(row => row.retired && row.decided));
    assert.equal(after.events.length, 1); assert.ok(after.charged < held.charged);
  }, true);
});

test('native private intake charges empty string value cells like null value cells', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('chat', { ownedCellCheck: [null, null] }))).status, 200);
    const nulls = (await settledState(f)).consumers.intake.graphBytes;
    assert.equal((await f.request('https://fixture/v1/chat/completions', chat('chat', { ownedCellCheck: ['', ''] }))).status, 200);
    const strings = await settledState(f);
    assert.equal(strings.consumers.intake.graphBytes, nulls, 'both parsed values own two primitive cells and no string payload units');
    assert.equal(strings.events.length, 2);
  }, true);
});

for (const mode of ['then-early', 'public-then-early', 'source-then-early'])
test('native private reader joins actual work despite an early then return: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode })).status, 204);
    let completed = false;
    const pending = f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128',
    })).then(value => { completed = true; return value; });
    const joined = f.own(pending);
    let held;
    for (;;) {
      held = await state(f);
      const row = mode === 'then-early' ? held.consumers : mode.startsWith('public-') ? held.consumers.public : held.consumers.source;
      if (row.held && row.thenCalls) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(completed, false); assert.equal(held.completed.length, 0);
    assert.ok(held.charged >= 32 * 1024 * 1024);
    await release();
    const response = await f.take(joined); assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    const after = await settledState(f); assert.equal(after.events.length, 1); assert.ok(after.charged < held.charged);
  }, true);
});


for (const instance of [1, 2]) test('native Worker instance ' + instance + ' owns one permanent tokenizer claim', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const baseline = await state(f);
    assert.equal(baseline.shared.claims, 0); assert.equal(baseline.shared.held, 0);
    await f.request('https://fixture/v1/catalog', { headers: { authorization: `Bearer ${ownedHttpProxyKey('chat')}` } });
    assert.equal((await state(f)).shared.claims, 0, 'ordinary default route does not activate private custody');
    const request = mode => chat('venice', { model: ownedHttpControlModels.venice, ownedVeniceCase: mode });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request('compact-open2048'))).status, 502);
    let after = await settledState(f);
    assert.equal(after.shared.claims, 1); assert.equal(after.shared.held, 65536);
    assert.equal(after.shared.after - after.shared.before, 65536); assert.ok(after.driverFactories > 0);
    assert.equal(after.parsers.at(-1).nativeParses, 0); assert.equal(after.parsers.at(-1).cleared, true);
    const responses = await Promise.all([f.request('https://fixture/v1/chat/completions', request('compact-object128')),
      f.request('https://fixture/v1/chat/completions', request('compact-object-string128'))]);
    assert.ok(responses.every(response => response.status === 200));
    after = await settledState(f); assert.equal(after.shared.claims, 1);
    assert.ok(after.parsers.slice(-2).every(row => row.nativeParses === 1 && row.cleared));
    assert.equal((await f.request('https://fixture/fixture/evict', { method: 'POST', body: 'venice' })).status, 204);
    assert.equal((await state(f)).charged, baseline.charged + 65536, 'exact request retirement, no shared release');
  }, true);
});

test('native first intake shared claim refusal preserves auth precedence and starts no private I/O factory', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await state(f);
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'shared-refusal' })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid',
    });
    assert.equal(response.status, 401, 'the existing authenticate-before-rethrow path still wins');
    const held = await settledState(f);
    assert.equal(held.shared.claims, 0); assert.equal(held.shared.refused, 1); assert.equal(held.shared.held, 0);
    assert.equal(held.intakeFactories, 0); assert.equal(held.driverFactories, 0);
    assert.equal(held.consumers.intake.acquired, 0); assert.equal(held.parsers.length, before.parsers.length);
    assert.equal(held.calls.length, before.calls.length, 'missing credentials need no authority/provider effect');
    await release();
    assert.equal((await state(f)).charged, before.charged, 'failed reserve leaves no permanent claim or request debit');
  }, true);
});

for (const invalid of ['missing-key', 'malformed', 'declared-overflow'])
test('native first intake permanently claims custody before ' + invalid, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await state(f);
    assert.equal(before.shared.claims, 0);
    const headers = { 'content-type': 'application/json' };
    if (invalid === 'declared-overflow') headers['content-length'] = '32000001';
    const response = await f.request('https://fixture/v1/chat/completions', {
      method: 'POST', headers, body: invalid === 'malformed' ? '{invalid' : '{}',
    });
    assert.equal(response.status, 401);
    const after = await settledState(f);
    assert.equal(after.shared.claims, 1); assert.equal(after.shared.held, 65536);
    assert.equal(after.intakeFactories, 1); assert.equal(after.driverFactories, 0);
    assert.equal(after.charged, before.charged + 65536);
    assert.equal(after.calls.length, before.calls.length);
  }, true);
});

for (const minimum of [148, 512]) test('native intake detaches retained observer cells across ' + minimum + ' tiny reads', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-cells-' + minimum });
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat', { extra: 'x'.repeat(minimum) }));
    assert.equal(response.status, 200);
    let after = await settledState(f), row = after.consumers.intake;
    assert.ok(row.read > minimum); assert.equal(row.observations, row.read);
    assert.equal(row.getterOrder, 'dvvv'.repeat(row.read - 1) + 'd');
    assert.equal(row.foreignGets, 0); assert.equal(row.coercions, 0); assert.equal(row.live, 0);
    await release(); // Invoke every saved callback after the actual intake retired.
    after = await state(f); row = after.consumers.intake;
    assert.equal(row.inert, row.read); assert.equal(row.foreignGets, 0);
    assert.equal(after.events.length, 1); assert.equal(after.intakeFactories, 1);
  }, true);
});

// UNRUN_CODE_ONLY_HOSTED. Each injected operand is at most16385 backing bytes.
for (const name of ['third-bytes', 'shadow-buffer', 'value1-oversized', 'value2-oversized', 'value3-oversized',
  'length-one-to-four', 'length-four-to-one', 'length-object', 'set-accessor', 'set-replacement', 'set-shadow', 'set-persist-through-auth', 'set-change-in-third-getter'])
test('native private intake proves the actual copy operand: ' + name, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await state(f), valid = ['third-bytes', 'shadow-buffer', 'set-accessor', 'set-replacement', 'set-shadow', 'set-persist-through-auth', 'set-change-in-third-getter'].includes(name);
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-operand-' + name });
    const response = await f.request('https://fixture/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401, 'authentication-before-intake-error precedence is unchanged');
    const after = await settledState(f), row = after.consumers.intake;
    assert.equal(row.copyAccessor, 0); assert.equal(row.customCopy, 0); assert.equal(row.coercions, 0);
    assert.equal(row.captures ?? 0, Number(valid)); assert.equal(row.capturedBytes ?? 0, valid ? 2 : 0);
    assert.equal(row.live, 0); assert.equal(after.events.length, before.events.length); assert.equal(after.calls.length, before.calls.length);
    assert.equal(after.charged, before.charged + 65536);
    if (valid) assert.deepEqual(row.operandOrder, ['done', 'value1', 'buffer1', 'value2', 'length2', 'set', 'value3', 'copy']);
    else if (name === 'value1-oversized') assert.deepEqual(row.operandOrder, ['done', 'value1', 'buffer1']);
    else if (name === 'value2-oversized' || name === 'length-object' || name.startsWith('set-'))
      assert.deepEqual(row.operandOrder, ['done', 'value1', 'buffer1', 'value2', 'length2']);
    else assert.deepEqual(row.operandOrder, ['done', 'value1', 'buffer1', 'value2', 'length2', 'set', 'value3']);
    await release();
  }, true);
});

test('native private JSON retains a wire BOM while validating exact decoded text', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const wire = ownedJsonCodecWire('compact-bom', 'zai-org-glm-5-2');
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, ownedVeniceCase: 'compact-bom',
    }));
    assert.equal(response.status, 200);
    // Response.text consumes the initial BOM; the codec preserves the wire length.
    assert.equal(response.headers.get('content-length'), String(new TextEncoder().encode(wire).byteLength));
    assert.equal(response.text, wire.slice(1));
    const after = await settledState(f); assert.equal(after.parsers.at(-1).nativeParses, 1);
  }, true);
});


for (const role of ['consumer', 'public', 'source']) for (const duplicate of [false, true])
test('native fixed handoff preserves ' + role + ' getters and original callbacks: ' + duplicate, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const mode = (role === 'consumer' ? '' : role + '-') + 'handoff-' + (duplicate ? 'duplicates' : 'getters');
    f.releases.push(async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); });
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128',
    }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('[DONE]'));
    const after = await settledState(f), row = role === 'consumer' ? after.consumers : after.consumers[role];
    assert.ok(row.read > 1); assert.equal(row.methodGets, row.read);
    assert.equal(row.getterOrder, (role === 'public' ? 'dv' : 'vd').repeat(row.read));
    if (duplicate) { assert.equal(row.thenCalls, row.read); assert.equal(row.duplicateCalls, row.read); assert.ok(row.staleCalls > 0); }
    assert.ok(after.driverReads >= row.read, 'compiled path includes the actual lower-level fixed driver');
    assert.equal(after.consumers.replay, 0); assert.equal(after.consumers.live, 0); assert.equal(after.consumers.public.live, 0);
    assert.equal(after.events.length, 1);
    await f.request('https://fixture/fixture/evict', { method: 'POST', body: 'venice' });
    assert.equal((await state(f)).charged, 65536, 'only the explicit module claim remains');
  }, true);
});


for (const streaming of [false, true]) test('native flat preflight retains paid upper through two escaped near-limit graphs: ' + streaming, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), mode = streaming ? 'compact-flat-escaped-sse' : 'compact-flat-escaped-json';
    const wire = ownedJsonCodecWire(mode, 'zai-org-glm-5-2');
    for (let index = 0; index < 2; index++) {
      const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
        model: ownedHttpControlModels.venice, ownedVeniceCase: mode, ...(streaming ? { stream: true } : {}),
      }));
      assert.equal(response.status, 200);
      assert.equal(response.text, streaming ? 'data: ' + wire + '\n\ndata: [DONE]\n\n' : wire);
      const after = await settledState(f), row = after.parsers.at(-1);
      assert.equal(row.nativeParses, 1); assert.equal(row.receiptCleared, true); assert.equal(row.cleared, true);
      assert.ok(row.required <= row.paid); assert.ok(row.exactDebit < row.required); assert.equal(row.restored, true);
      assert.equal(row.tokenPushes, 0); assert.equal(after.consumers.live, 0);

    }
    const after = await settledState(f);
    assert.equal(after.events.length - before.events.length, 2);
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 4);
    assert.equal((await f.request('https://fixture/fixture/evict', { method: 'POST', body: 'venice' })).status, 204);
    assert.equal((await state(f)).charged, before.charged + 65536, 'exact own retirement after genuine cache eviction, permanent claim retained');
  }, true);
});

for (const later of [false, true]) test('native flat syntax projection preserves first/later SSE publication: ' + later, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    const response = await f.take(f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true,
      ownedVeniceCase: later ? 'compact-later-flat-invalid' : 'compact-flat-invalid',
    })));
    assert.equal(response.status, later ? 200 : 502);
    if (later) await assert.rejects(f.take(f.body(response)));
    else assert.equal(JSON.parse(await f.take(f.body(response))).error.code, 'provider_unavailable');
    const after = await settledState(f), row = after.parsers.at(-1);
    assert.equal(row.nativeParses, 1); assert.equal(row.syntaxCleared, true); assert.equal(row.restored, undefined);
    assert.equal(row.receiptCleared, true); assert.equal(row.cleared, true); assert.ok(row.required <= row.paid);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), later ? 2 : 1);
    assert.equal(after.consumers.live, 0); assert.equal(after.consumers.source.cancel, 0, 'no injected source replay');
  }, true);
});


test('native syntax reason is cleared before held original source unlock', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'source-unlock-before-success' })).status, 204);
    const dispatch = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-flat-invalid',
    }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.consumers.source.held) break;
      if (held.completed.length > before.completed.length) { await f.take(dispatch); assert.fail('cleanup finished before the registered hold'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(held.parsers.at(-1).syntaxCleared, true); assert.equal(held.parsers.at(-1).fixedSyntax, true);
    assert.equal(held.consumers.source.unlock, 1); assert.equal(held.consumers.source.unlockSettled, 0);
    assert.equal(held.completed.length, before.completed.length); assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const response = await f.take(dispatch); assert.equal(response.status, 502);
    assert.equal(JSON.parse(await f.take(f.body(response))).error.code, 'provider_unavailable');
    const after = await settledState(f); assert.equal(after.consumers.source.unlockSettled, 1);
    assert.equal(after.events.length - before.events.length, 1);
  }, true);
});


// UNRUN_CODE_ONLY_HOSTED: registered private preflight/materialization receipts
// consume actual Workerd DO replies and retain actual returned cleanup work.
for (const [kind, path] of [['authority', '/admission/credential-preflight'], ['authority', '/admission/resolve'], ['credential', '/materialize']])
for (const cause of ['listener', 'read-install-before', 'read-install-after', 'fetch-install-before', 'fetch-install-after', 'unlock-install'])
test(`native private ${kind}${path}/${cause} uncertainty survives fixture release until isolate termination`, { timeout: 120000 }, async () => {
  // This owner is intentionally UNKNOWN. The ordinary fixture waits for every
  // retirement and therefore cannot be used to pretend this case has retired.
  let directory, runtime, pending, release, terminating = false;
  const failures = [], controller = new AbortController();
  let primary, hasPrimary = false;
  const request = async (url, init) => {
    const response = await runtime.dispatchFetch(url, init);
    return { status: response.status, text: await response.text() };
  };
  const state = async () => JSON.parse((await request('https://fixture/fixture/state')).text);
  try {
    directory = await mkdtemp(join(tmpdir(), 'owned-http-unknown-'));
    runtime = await startOwnedJsonObservedFixture(directory, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true });
    await seedOwnedHttpChat(runtime);
    assert.equal((await request('https://fixture/fixture/grants', { method: 'POST' })).status, 204);
    release = () => request('https://fixture/fixture/control-read', { method: 'DELETE' });
    assert.equal((await request('https://fixture/fixture/control-read', { method: 'POST', body: JSON.stringify({ kind, path,
      reason: cause === 'listener' ? 'listener' : 'undefined', ...(cause === 'listener' ? {} : { mode: cause }),
    }) })).status, 204);
    const before = await state();
    // Observe the actual dispatch and its eventual body before any assertion.
    pending = runtime.dispatchFetch('https://fixture/v1/chat/completions', { ...chat('chat'), signal: controller.signal })
      .then(async response => { await response.arrayBuffer(); })
      .then(() => undefined, error => { if (!terminating) failures.push(error); });
    let held;
    for (;;) {
      held = await state();
      const row = held.controlReads.at(-1);
      if (cause === 'listener' ? row?.removalFailed : row?.installFailed && row.readSettled) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(held.charged > before.charged);
    assert.equal(held.completed.length, before.completed.length);
    assert.equal(held.reasonReads, 0);
    if (cause !== 'listener') {
      if (cause.startsWith('read-')) assert.equal(held.controlReads.at(-1).read, 1);
      assert.equal(held.controlReads.at(-1).thenCalls, 1);
      const reader = kind === 'authority' ? path === '/admission/resolve' ? 'continuation' : 'preflight' : 'materialization';
      if (cause !== 'unlock-install') assert.equal(held.adapterReads[reader], before.adapterReads[reader], 'callback-then-throw cannot publish a successful private read');
      else { assert.equal(held.controlReads.at(-1).foreignGets, 0); assert.equal(held.controlReads.at(-1).thenGets, 1); }
    }
    assert.equal(JSON.parse((await request('https://fixture/fixture/upstream')).text).length, 0);
    await release();
    if (cause.startsWith('fetch-')) for (;;) {
      const row = (await state()).controlReads.at(-1);
      if (row.cancelSettled && row.lateCallbacks && (cause !== 'fetch-install-after' || row.foreignDisposed)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const after = await state();
    assert.equal(after.credentialReductions.length, before.credentialReductions.length, 'UNKNOWN source is never clean preparation');
    assert.equal(after.controlReads.at(-1).released, true);
    if (path === '/admission/resolve') for (const stage of ['delivered', 'advanced', 'handles'])
      assert.equal(after.continuationStages[stage], before.continuationStages[stage], stage);
    assert.equal(after.charged, held.charged, 'fixture release cannot refund sticky UNKNOWN');
    assert.equal(after.completed.length, before.completed.length);
  } catch (error) { hasPrimary = true; primary = error; }
  finally {
    // Release fixture originals first. Terminating this actual isolated Worker
    // ends its UNKNOWN custody; it is not a production success/refund receipt.
    try { await release?.(); } catch (error) { failures.push(error); }
    terminating = true; controller.abort();
    if (runtime) try { await runtime.dispose(); } catch (error) { failures.push(error); }
    try { await pending; } catch (error) { failures.push(error); }
    if (directory) try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'private UNKNOWN fixture termination');
  if (hasPrimary) throw primary;
});

for (const [kind, path] of [['authority', '/admission/credential-preflight'], ['authority', '/admission/resolve'], ['credential', '/materialize'], ['provider', undefined]])
test(`native ${kind}${path ?? ''} observes returned unlock directly and ignores both foreign values`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/control-read', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/control-read', { method: 'POST', body: JSON.stringify({ kind, path, mode: 'unlock-void', reason: 'success' }) });
    const id = kind === 'provider' ? 'venice' : 'chat';
    const response = await f.request('https://fixture/v1/chat/completions', chat(id, kind === 'provider' ? { model: ownedHttpControlModels.venice } : {}));
    assert.equal(response.status, 200);
    const report = await settledState(f), rows = report.controlReads;
    assert.ok(rows.length > 0);
    for (const row of rows) { assert.equal(row.unlock, 1); assert.equal(row.thenGets, 1); assert.equal(row.thenCalls, 1); assert.equal(row.foreignGets, 0); }
    assert.equal(report.events.length, 1);
  }, true);
});

for (const [kind, path] of [['authority', '/admission/credential-preflight'], ['authority', '/admission/resolve'], ['credential', '/materialize']])
for (const mode of ['unlock-before', 'unlock-after', 'closed']) test(`native private ${kind}${path} receipt joins ${mode} before delivery`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/control-read', { method: 'DELETE' }));
    assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'POST', body: JSON.stringify({
      kind, path, mode, reason: mode === 'closed' ? 'undefined' : 'success',
    }) })).status, 204);
    const before = await state(f), pending = f.dispatch('https://fixture/v1/chat/completions', chat('chat'));
    let held;
    for (;;) {
      held = await state(f);
      if (held.controlReads.at(-1)?.held) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(held.charged > before.charged);
    assert.equal(held.completed.length, before.completed.length);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
    assert.equal(held.credentialReductions.length, before.credentialReductions.length, 'a held source cannot reduce its full foreground ticket');
    assert.equal(held.controlReads.at(-1).unlock, 1);
    assert.equal(held.controlReads.at(-1).nativeUnlocked, mode === 'unlock-after' ? 0 : 1);
    if (path === '/admission/resolve') {
      assert.equal(held.continuationStages.staged - before.continuationStages.staged, 1);
      for (const stage of ['delivered', 'advanced', 'handles']) assert.equal(held.continuationStages[stage], before.continuationStages[stage], stage);
    }
    await f.request('https://fixture/fixture/control-read', { method: 'DELETE' });
    const response = await f.take(pending); assert.equal(response.status, 200); await f.take(f.body(response));
    const after = await settledState(f), row = after.controlReads.at(-1);
    assert.equal(row.unlock, 1); assert.equal(row.nativeUnlocked, 1); assert.equal(row.released, true);
    if (path === '/admission/resolve') assert.ok(count(after, kind, path) > count(before, kind, path));
    else assert.equal(count(after, kind, path) - count(before, kind, path), 1);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 1);
    assert.equal(after.reasonReads, 0);
    if (path === '/admission/resolve') for (const stage of ['delivered', 'advanced', 'handles'])
      assert.equal(after.continuationStages[stage] - before.continuationStages[stage],
        after.continuationStages.staged - before.continuationStages.staged, stage);
  }, true);
});

for (const origin of ['id', 'get']) for (const reason of ['undefined', 'huge', 'opaque', 'forged'])
test(`native cold materialization ${origin}/${reason} preserves acquisition provenance`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    assert.equal((await f.request('https://fixture/fixture/control-fault', { method: 'POST', body: JSON.stringify({ kind: 'credential', origin, reason }) })).status, 204);
    const before = await state(f), response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.text).error.code, 'identity_admission_unavailable');
    const after = await settledState(f);
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'));
    assert.equal(count(after, 'budget', '/reserve'), count(before, 'budget', '/reserve'));
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
    assert.equal(after.reasonReads, 0);
  });
});

for (const identity of [false, true]) test(`native private materialization preserves cleanup and error precedence: identity=${identity}`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/control-read', { method: 'DELETE' }),
      () => f.request('https://fixture/fixture/control-reply', { method: 'DELETE' }));
    assert.equal((await f.request('https://fixture/fixture/control-reply', { method: 'POST', body: JSON.stringify({ identity }) })).status, 204);
    assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'POST', body: JSON.stringify({
      kind: 'credential', path: '/materialize', mode: 'unlock-after', reason: 'success',
    }) })).status, 204);
    const before = await state(f), pending = f.dispatch('https://fixture/v1/chat/completions', chat('chat'));
    let held;
    for (;;) {
      held = await state(f);
      if (held.controlReads.at(-1)?.held) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(held.completed.length, before.completed.length);
    assert.equal(held.events.length, before.events.length);
    assert.equal(held.controlReads.at(-1).nativeUnlocked, 0);
    assert.equal(held.materializationReplies.at(-1).retryAfterReads, identity ? 0 : 1);
    assert.ok(held.charged > before.charged);
    await f.request('https://fixture/fixture/control-read', { method: 'DELETE' });
    const response = await f.take(pending), error = JSON.parse(await f.take(f.body(response))).error;
    assert.equal(response.status, identity ? 503 : 401);
    assert.equal(error.code, identity ? 'identity_admission_unavailable' : 'grant_refresh_failed');
    assert.equal(response.headers.get('retry-after'), identity ? null : '7');
    const after = await settledState(f);
    assert.equal(count(after, 'credential', '/materialize') - count(before, 'credential', '/materialize'), 1);
    assert.equal(count(after, 'budget', '/reserve') - count(before, 'budget', '/reserve'), 0);
    assert.equal(after.controlReads.at(-1).nativeUnlocked, 1);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).length, 0);
  });
});


// UNRUN_CODE_ONLY_HOSTED: fixed RPC byte folds keep actual getters and native
// next-BYOB storage; the fixture only wraps actual original read observations.
for (const mode of ['rpc-trace', 'rpc-duplicates'])
test('native snapshot/inspect preserves original byte-fold operands: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode });
    const before = await state(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128',
    }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('data: [DONE]'));
    const after = await settledState(f), rows = after.rpcReaders;
    assert.equal(rows.length, 4); assert.equal(rows.filter(row => row.kind === 'snapshot').length, 2);
    assert.equal(count(after, 'authority', '/authorization/snapshot') - count(before, 'authority', '/authorization/snapshot'), 2);
    assert.equal(count(after, 'credential', '/inspect') - count(before, 'credential', '/inspect'), 2);
    assert.equal(after.events.length - before.events.length, 1);
    for (const row of rows) {
      assert.equal(row.reads, row.thenCalls); assert.ok(row.reuses > 0); assert.equal(row.foreignGets, 0);
      if (mode === 'rpc-duplicates') assert.ok(row.duplicateCalls > 0);
      for (const sample of row.orders) {
        const expected = sample.value ? ['v1', 'v2', 'b2', 'v3', 'b3', 'v4', 'n4', 'v5', 'v6', 'd1', 'v7', 'b7', 'd2', ...(sample.done ? ['v8'] : [])]
          : ['v1', 'd1', ...(sample.done ? ['v2'] : [])];
        assert.deepEqual(sample.order, expected);
      }
    }
  }, true);
});

for (const mode of ['public-byte-snapshot', 'public-eof-foreign'])
test('native public capture uses real storage and retains a noncumulative postseal high water: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode });
    const before = await state(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128',
    }));
    assert.equal(response.status, 200); assert.ok(response.text.includes('data: [DONE]'));
    assert.equal(response.text.includes('\u0000'), false, 'retained-view writes after first capture cannot rewrite the client snapshot');
    const after = await settledState(f), row = after.consumers.public;
    assert.equal(row.shadowGets, 0); assert.equal(row.live, 0); assert.equal(row.liveCapture, 0);
    assert.ok(row.captureCount > 1); assert.ok(row.capturePeak > 0); assert.ok(row.captureTotal > row.capturePeak);
    assert.ok(row.postSeal > 0); assert.equal(row.read, row.thenCalls);
    if (mode === 'public-byte-snapshot') assert.ok(row.mutations > 0);
    else assert.equal(row.eofValueGets, 1, 'EOF observes VALUE once without inspecting its foreign storage');
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true);
});


// Admission occurs on the already-enrolled public reader after sealing, before
// its destination snapshot. Pressure is fixture-owned and released before joins.
test('native public capture refuses before copying or changing high-water ownership', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'public-capacity-refusal' });
    const before = await state(f);
    f.expectFailedRetirement(before.completed.length);
    const pending = f.dispatch('https://fixture/v1/chat/completions', chat('venice', {
      model: ownedHttpControlModels.venice, stream: true, ownedVeniceCase: 'compact-later-object128',
    }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.consumers.public.refusals) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const row = held.consumers.public;
    assert.equal(row.copies, 0); assert.equal(row.captureCount, 0);
    assert.equal(row.refusedLive, row.beforeLive); assert.equal(row.refusedHigh, row.beforeHigh);
    await release();
    const response = await f.take(pending);
    assert.equal(response.status, 200, 'already-published response retains its status');
    await assert.rejects(f.take(f.body(response)));
    const after = await settledState(f);
    assert.equal(after.consumers.public.liveCapture, 0);
    assert.equal(after.events.length - before.events.length, 1);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true);
});


test('native private archive keeps chunk custody through original R2 completion with poisoned DATA hooks', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    const kv = await f.runtime.getKVNamespace('POLICY_KV', 'router');
    const policy = JSON.parse(await kv.get('policies/owned_http_chat'));
    policy.retainRequestContent = true; await kv.put('policies/owned_http_chat', JSON.stringify(policy));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'archive-kernel-held' });
    const content = ('fixture archive "\\\n😀\ud800').repeat(3000), before = await state(f);
    const pending = f.dispatch('https://fixture/v1/chat/completions', chat('chat', { messages: [{ role: 'user', content }] }));
    let held;
    for (;;) {
      held = await state(f);
      if (held.archive.nativeSettled) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(held.archive.puts, 1); assert.equal(held.archive.thenCalls, 1); assert.equal(held.archive.delivered, 0);
    assert.ok(held.archive.pulls > 1); assert.ok(held.archive.chunks > 1); assert.equal(held.archive.maximumBacking, 32768);
    assert.equal(held.archive.hookAccesses, 0); assert.equal(held.completed.length, before.completed.length);
    assert.ok(held.charged > before.charged);
    await release();
    const response = await f.take(pending); assert.equal(response.status, 200); await f.take(f.body(response));
    const after = await settledState(f);
    assert.equal(after.archive.delivered, 1); assert.equal(after.events.length - before.events.length, 1);
    const bucket = await f.runtime.getR2Bucket('CONTENT_ARCHIVE', 'router');
    const objects = await bucket.list(); assert.equal(objects.objects.length, 1);
    const stored = JSON.parse(await (await bucket.get(objects.objects[0].key)).text());
    assert.equal(stored.body.messages[0].content, content);
    assert.equal(stored.contentRef, after.events.at(-1).content_ref);
    assert.equal(count(after, 'provider', '/chat/completions') - count(before, 'provider', '/chat/completions'), 1);
  }, true, { r2Buckets: ['CONTENT_ARCHIVE'] });
});


// Workerd1.20261021.1, compatibility_date2026-06-05 and enable_request_signal.
// These malicious-Headers guarantees are intentionally not asserted for Node's
// different Undici header implementation or previously exposed header cache.
for (const mode of ['headers-prototype-foreach', 'headers-swap', 'headers-foreach', 'headers-iterator', 'headers-next', 'headers-late', 'headers-long-text'])
test('exact native private header clone admits the actual second operand: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode });
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fixture-large'), 'x'.repeat(4096));
    assert.equal(response.headers.get('x-mixed-case'), 'one, two'); assert.equal(response.headers.get('x-empty'), '');
    assert.deepEqual(response.headers.getSetCookie(), ['first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'second=2; Path=/']);
    if (mode === 'headers-late') {
      assert.equal(response.headers.get('x-status-mutation'), 'status'); assert.equal(response.headers.get('x-text-mutation'), 'text');
    }
    const after = await settledState(f), row = after.headerClone;
    assert.equal(row.body, 1); assert.equal(row.headers, 2); assert.equal(row.status, 1); assert.equal(row.statusText, 1);
    assert.equal(row.hooks, 0); assert.equal(row.coercions, 0); assert.equal(row.constructors, 1);
    assert.ok(row.component > row.early); assert.ok(row.component >= 4 * 4096);
    assert.equal(row.unitMeasurements, 1); assert.ok(row.indexUnits >= 4096, 'private index admits the populated native header storage');
    if (mode === 'headers-long-text') assert.ok(row.component >= 4 * (4096 + 4102));
  }, true);
});
for (const mode of ['headers-status-object', 'headers-text-object'])
test('private metadata rejects coercible status operands before construction: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode });
    const before = await state(f); f.expectFailedRetirement(before.completed.length);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 503);
    const after = await settledState(f), row = after.headerClone;
    assert.equal(row.body, 1); assert.equal(row.headers, 2); assert.equal(row.status, 1); assert.equal(row.statusText, 1);
    assert.equal(row.coercions, 0); assert.equal(row.constructors, 0); assert.equal(after.consumers.public.live, 0);
  }, true);
});


// UNRUN_CODE_ONLY_HOSTED: constructor failure retains the already-enrolled
// reader while its actual unlock is pending; the index must not invent UNKNOWN.
test('native failed public constructor joins its owned locked reader before exact retirement', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' })).status, 204); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'headers-constructor-held' });
    const before = await settledState(f); f.expectFailedRetirement(before.completed.length);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 500); assert.equal(JSON.parse(response.text).error.code, 'internal_error');
    let held;
    for (;;) {
      held = await state(f);
      if (held.consumers.public.held) break;
      assert.equal(held.completed.length, before.completed.length, 'no retirement before returned unlock');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(held.headerClone.body, 1); assert.equal(held.headerClone.constructors, 1);
    assert.equal(held.headerClone.unitMeasurements, 0, 'constructor failure precedes index copies');
    assert.equal(held.consumers.public.unlock, 1); assert.equal(held.consumers.public.nativeUnlocked, 0);
    assert.equal(held.consumers.public.unlockSettled, 0); assert.ok(held.consumers.public.live > 0);
    assert.equal(held.completed.length, before.completed.length); assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const after = await settledState(f);
    assert.equal(after.consumers.public.unlockSettled, 1); assert.equal(after.consumers.public.nativeUnlocked, 1);
    assert.equal(after.consumers.public.live, 0); assert.equal(after.completed.length, before.completed.length + 1);
    assert.equal(after.charged, before.charged + (before.shared.held ? 0 : 65536));
  }, true);
});


// UNRUN_CODE_ONLY_HOSTED. Production ownership qualification is scoped to the
// pinned Workerd runtime/configuration; Node hostile Headers are not an oracle.
test('native final metadata ignores poisoned header methods and preserves separate cookies and rate exposure', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }));
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'metadata-poison' });
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-clawrouter-version-id'), 'second-value');
    assert.equal(response.headers.get('x-clawrouter-background-recovery'), 'synthetic-locator-' + 'x'.repeat(8192));
    assert.deepEqual(response.headers.getSetCookie(), ['first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'second=2']);
    const exposed = response.headers.get('access-control-expose-headers').split(',');
    assert.deepEqual(exposed.slice(-2), ['anthropic-ratelimit-fixture', 'x-ratelimit-fixture']);
    const after = await settledState(f);
    assert.equal(after.metadata.hooks, 0); assert.equal(after.metadata.versionGets, 2);
    assert.deepEqual(after.metadata.stages, [0, 1, 2, 3, 4, 5]);
  }, true);
});
test('native branded replacement delivers while the old inner reader unlock stays held', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'metadata-branded-held' });
    const before = await settledState(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 200, 'formatting preserves the actual branded source status');
    assert.equal(response.headers.get('x-clawrouter-error-code'), 'fixture_metadata');
    assert.equal(JSON.parse(response.text).error.code, 'fixture_metadata');
    const held = await state(f);
    assert.equal(held.completed.length, before.completed.length); assert.ok(held.consumers.public.held);
    assert.equal(held.consumers.public.unlockSettled, 0); assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    await release();
    const after = await settledState(f);
    assert.equal(after.consumers.public.live, 0); assert.equal(after.consumers.public.unlockSettled, 1);
    assert.equal(after.charged, before.charged + (before.shared.held ? 0 : 65536));
  }, true);
});
for (const stage of [0, 2, 3, 4, 5]) test(`native metadata stage ${stage} refuses before its first destination factory`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'metadata-refuse-' + stage });
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 503); assert.equal(JSON.parse(response.text).error.code, 'identity_admission_unavailable');
    const held = await state(f);
    assert.equal(held.metadata.refused, stage); assert.equal(held.metadata.factories[stage], 0);
    await release();
    const after = await settledState(f); assert.equal(after.consumers.public.live, 0);
  }, true);
});

// UNRUN_CODE_ONLY_HOSTED: the platform response is qualified only by the pinned
// Workerd fixture. No application JSON response is promised at this frontier.
test('native first reservation refusal uses the platform failure without application error factories', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'bootstrap-refuse' });
    const before = await state(f);
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 500);
    assert.notEqual(response.headers.get('content-type')?.split(';')[0], 'application/json');
    const refused = await state(f);
    assert.equal(refused.initialErrors.bootstrapRefused, before.initialErrors.bootstrapRefused + 1);
    assert.equal(refused.initialErrors.owners, before.initialErrors.owners);
    assert.equal(refused.initialErrors.renderings, before.initialErrors.renderings);
    assert.equal(refused.shared.claims, before.shared.claims);
    await release();
  }, true);
});
for (const mode of ['initial-error-hooks', 'initial-error-refuse']) test('native initial private error boundary: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: mode });
    const input = chat('chat'), headers = new Headers(input.headers); headers.delete('authorization');
    const response = await f.request('https://fixture/v1/chat/completions', { ...input, headers });
    const after = await state(f);
    if (mode === 'initial-error-hooks') {
      assert.equal(response.status, 401); assert.equal(JSON.parse(response.text).error.code, 'invalid_proxy_key');
      assert.equal(after.initialErrors.hooks, 0); assert.ok(after.initialErrors.renderings > 0);
    } else {
      assert.equal(response.status, 500);
      assert.notEqual(response.headers.get('content-type')?.split(';')[0], 'application/json');
      assert.equal(after.initialErrors.refusals, 1); assert.equal(after.initialErrors.renderings, 0);
    }
    await release(); await settledState(f);
  }, true);
});


// UNRUN_CODE_ONLY_HOSTED: same actual authority/materialization/preparation
// route; only the fixture provider's declared configuration operand changes.
for (const mode of ['missing', 'undefined', 'forged', 'opaque', 'invalid-url'])
test(`native current private configuration ${mode} preserves source-local provenance`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/configuration', { method: 'DELETE' });
    f.releaseWith(release);
    const before = await settledState(f);
    await f.request('https://fixture/fixture/configuration', { method: 'POST', body: mode });
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 503);
    const error = JSON.parse(response.text).error;
    assert.equal(error.code, mode === 'missing' ? 'provider_not_configured' : 'provider_request_invalid');
    assert.equal(error.message, mode === 'missing'
      ? 'missing Cloudflare config value OWNED_CONFIG_FIXTURE for provider volcengine'
      : 'provider request configuration is invalid');
    await release();
    const after = await settledState(f);
    assert.equal(after.configurationGets - before.configurationGets, 1);
    assert.equal(after.configurationReasonReads - before.configurationReasonReads, 0);
    assert.equal(after.calls.slice(before.calls.length).filter(row => row.kind === 'budget' && row.path === '/reserve').length, 0);
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'chat').length, 0);
  }, true);
});

// UNRUN_CODE_ONLY_HOSTED: the actual Worker constructor site is captured at
// trusted initialization; this observer never supplies an alternate parsed graph.
test('native private intake excludes a replaced JSON.parse from its admitted text', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await state(f);
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'intake-constructor-capture' });
    const response = await f.request('https://fixture/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"privateConstructorProbe":true,"extra":[-0,1e999,{"__proto__":null}]}',
    });
    assert.equal(response.status, 401);
    await release();
    const after = await settledState(f), row = after.consumers.intake;
    assert.equal(row.constructed, 1); assert.equal(row.constructorHooks, 0); assert.equal(row.live, 0);
    assert.equal(after.events.length, before.events.length); assert.equal(after.calls.length, before.calls.length);
  }, true);
});


// UNRUN_CODE_ONLY_HOSTED: the held deferred serialization is part of the
// actual returned send operation, with real Worker queue binding underneath.
test('native private accounting keeps its immutable queue payload until deferred send finishes', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/queue-handoff', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/queue-handoff', { method: 'POST' });
    const response = await f.request('https://fixture/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + ownedHttpProxyKey('chat'), 'content-type': 'application/json' },
      body: JSON.stringify({ model: ownedHttpModel, messages: [{ role: 'user', content: 'queue handoff fixture' }] }),
    });
    assert.equal(response.status, 200);
    let row;
    for (let attempt = 0; attempt < 200; attempt++) {
      row = JSON.parse((await f.request('https://fixture/fixture/queue-handoff')).text);
      if (row.calls) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(row.calls, 1); assert.equal(row.args, 1); assert.equal(row.frozen, true); assert.equal(row.nullPrototype, true);
    assert.equal(row.completed, false); assert.equal(row.after, null);
    await release(); await settledState(f);
    row = JSON.parse((await f.request('https://fixture/fixture/queue-handoff')).text);
    assert.equal(row.completed, true); assert.equal(row.hooks, 0);
    assert.equal(row.hookBlocked, true); assert.equal(row.valueBlocked, true); assert.equal(row.prototypeBlocked, true);
    assert.equal(row.after, row.before); assert.equal(row.calls, 1);
    const value = JSON.parse(row.after); assert.equal(value.type, 'clawrouter.usage.v1'); assert.equal(value.provider, 'volcengine');
  });
});


for (const mode of ['fetch-return-held', 'fetch-return-undefined'])
test(`native full admission ignores ${mode} while preserving the actual callback and cumulative counters`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    f.releases.push(() => f.request('https://fixture/fixture/control-read', { method: 'DELETE' }));
    assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'POST', body: JSON.stringify({
      kind: 'authority', path: '/admission/resolve', mode, reason: 'success',
    }) })).status, 204);
    const before = await state(f), response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 200);
    const after = await settledState(f), row = after.controlReads.at(-1);
    assert.equal(row.thenCalls, 1); assert.equal(row.callbacks, 1); assert.equal(row.released, false);
    const stages = after.continuationStages, prior = before.continuationStages;
    assert.ok(stages.staged > prior.staged);
    for (const kind of ['delivered', 'advanced', 'handles']) assert.equal(stages[kind] - prior[kind], stages.staged - prior.staged, kind);
    assert.equal(after.events.length - before.events.length, 1);
  }, true);
});

// Generic HTTP normalization is separate from the Venice codec consumer. These
// run on the exact Worker fixture and remain UNRUN until the publication lease.
for (const mode of ['trace', 'large-backing', 'capture-after'])
for (const wireCase of ['comments', 'cutoff', 'crossing'])
test('native generic normalizer preserves replay bytes: ' + mode + '/' + wireCase, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'normalizer-' + mode });
    const event = 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n';
    const prefix = wireCase === 'comments' ? ': comment\r\n\r\n' : wireCase === 'cutoff' ? ':' + 'x'.repeat(8192) : ':' + 'x'.repeat(2097153) + '\n\n';
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true, ownedNormalizerCase: wireCase }));
      assert.equal(reply.status, 200); assert.equal(reply.text, prefix + event);
      const report = await settledState(f), row = report.consumers.normalizer;
      assert.equal(row.acquired, 1); assert.equal(row.retired, 1); assert.equal(row.live, 0);
      assert.equal(row.doneGets, row.valueGets); assert.equal(row.trace, 'dv'.repeat(row.doneGets));
      assert.ok(row.transfers > 0); assert.equal(report.consumers.acquired, 0, 'generic child never impersonates codec');
      if (mode === 'large-backing') assert.ok(row.maximumBacking >= 3 * 1024 * 1024);
    } finally { await release(); }
  }, true);
});

for (const wireCase of ['json-limit', 'json-over', 'native-json'])
test('native generic LIMITED error keeps status and processing limit: ' + wireCase, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'normalizer-eof-value' });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true, ownedNormalizerCase: wireCase }));
      assert.equal(reply.status, 400);
      if (wireCase === 'json-limit') assert.ok(reply.text.includes('x'.repeat(1024)));
      if (wireCase === 'json-over') assert.ok(!reply.text.includes('x'.repeat(1024)));
      if (wireCase === 'native-json') assert.equal(reply.text, ' {"error":{"message":"fixture native","type":"invalid_request_error","extra":true}} \n');
      const report = await settledState(f), row = report.consumers.normalizer;
      assert.equal(row.doneGets, row.valueGets); assert.equal(row.trace, 'dv'.repeat(row.doneGets));
      assert.equal(row.retired, 1); assert.equal(row.live, 0);
    } finally { await release(); }
  }, true);
});

for (const mode of ['unlock-before-success', 'unlock-after-success', 'closed-undefined'])
test('native generic replay delivers while its original cleanup is held: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    if (mode === 'closed-undefined') f.expectFailedRetirement(before.intakes.length);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'normalizer-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true, ownedNormalizerCase: 'comments' }));
      assert.equal(reply.status, 200); assert.ok(reply.text.includes('[DONE]'));
      const held = await state(f); assert.equal(held.completed.length, before.completed.length);
      assert.equal(held.consumers.normalizer.live, 1); assert.ok(held.charged > before.charged);
      await release(); const after = await settledState(f);
      assert.equal(after.consumers.normalizer.retired, 1); assert.equal(after.consumers.normalizer.live, 0);
    } finally { await release(); }
  }, true);
});

for (const mode of ['tiny-empty', 'sniff-eof', 'replay-eof'])
test('native generic SNIFF/REPLAY EOF and bounded tiny-read history: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'normalizer-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true, ownedNormalizerCase: 'comments' }));
      const event = 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n';
      assert.equal(reply.status, 200); assert.equal(reply.text, (mode === 'tiny-empty' ? ':\r\n\r\n'.repeat(160) : '') + event);
      const row = (await settledState(f)).consumers.normalizer;
      assert.equal(row.doneGets, row.valueGets); assert.equal(row.trace, 'dv'.repeat(row.doneGets));
      assert.equal(row.retired, 1); assert.equal(row.live, 0);
      if (mode === 'tiny-empty') assert.ok(row.read > 148);
      if (mode === 'sniff-eof') assert.equal(row.read, 1);
      if (mode === 'replay-eof') assert.equal(row.eofValues, 1);
    } finally { await release(); }
  }, true);
});

for (const mode of ['snapshot', 'after', 'big']) for (const streaming of mode === 'big' ? [false] : [false, true])
test('native generic usage FIRST snapshot is single-value and EOF value-free: ' + mode + '/' + streaming, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'generic-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: streaming }));
      assert.equal(reply.status, 200); assert.ok(reply.text.includes('synthetic-answer'));
      const after = await settledState(f), row = after.consumers.generic;
      assert.equal(row.acquired, 1); assert.equal(row.retired, 1); assert.equal(row.logical, 1); assert.equal(row.live, 0);
      assert.equal(row.doneGets, row.valueGets + 1); assert.equal(row.eofValues, 0);
      assert.equal(row.trace, 'dv'.repeat(row.valueGets) + 'd'); assert.ok(row.transfers > 0);
      assert.equal(after.events.length, 1); assert.equal(after.events[0].input, 4); assert.equal(after.events[0].output, 3);
      if (streaming) assert.ok(after.consumers.normalizer.transfers > 0);
    } finally { await release(); }
  }, true);
});

for (const streaming of [false, true]) for (const name of ownedUsageCases.filter(name => streaming || ['deep', 'quoted', 'scalar', 'malformed', 'many-lines', 'overflow'].includes(name)))
test('native generic usage shares ordinary inspection semantics: ' + name + '/' + streaming, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const reference = JSON.parse((await f.request('https://fixture/fixture/usage-reference', {
      method: 'POST', body: JSON.stringify({ name, format: streaming ? 'sse' : 'json' }),
    })).text);
    const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: streaming, ownedGenericUsageCase: name }));
    assert.equal(reply.status, 200); assert.equal(reply.text, ownedUsageWire(name, streaming));
    const after = await settledState(f), row = after.consumers.generic;
    assert.equal(row.logical, 1); assert.equal(row.retired, 1); assert.equal(after.events.length, 1);
    assert.equal(after.events[0].input, reference.tokens?.input ?? null); assert.equal(after.events[0].output, reference.tokens?.output ?? null);
  }, true);
});

for (const mode of ['unlock-before-success', 'unlock-after-success', 'closed-undefined'])
test('native generic logical accounting precedes held physical cleanup: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release); if (mode === 'closed-undefined') f.expectFailedRetirement(before.intakes.length);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'generic-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: true }));
      assert.equal(reply.status, 200); assert.ok(reply.text.includes('[DONE]'));
      let held;
      do { held = await state(f); if (!held.events.length) await new Promise(resolve => setTimeout(resolve, 10)); } while (!held.events.length);
      assert.equal(held.consumers.generic.logical, 1); assert.equal(held.consumers.generic.live, 1);
      assert.equal(held.completed.length, before.completed.length); assert.ok(held.charged > before.charged);
      await release(); const after = await settledState(f); assert.equal(after.consumers.generic.retired, 1); assert.equal(after.events.length, 1);
    } finally { await release(); }
  }, true);
});

test('native generic finished-late FIRST inspects no payload and still joins the read', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = async () => { await f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' }); };
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'generic-late' });
    const pending = f.own(f.request('https://fixture/v1/chat/completions', chat('chat')));
    try {
      let held;
      do { held = await state(f); if (!held.consumers.generic.held) await new Promise(resolve => setTimeout(resolve, 10)); } while (!held.consumers.generic.held);
      await f.request('https://fixture/fixture/intake-abort', { method: 'POST' });
      let aborted;
      do { aborted = await state(f); if (!aborted.consumers.generic.logical) await new Promise(resolve => setTimeout(resolve, 10)); } while (!aborted.consumers.generic.logical);
      assert.equal(aborted.consumers.generic.lateGets, 0); assert.equal(aborted.consumers.generic.retired, 0);
      await release(); try { await f.take(pending); } catch { /* Caller abort may fail the body. */ }
      const after = await settledState(f); assert.equal(after.consumers.generic.lateGets, 0);
      assert.equal(after.consumers.generic.retired, 1); assert.equal(after.consumers.generic.logical, 1);
    } finally { await release(); }
  }, true);
});

for (const boundary of ["normalizer", "public"])
test('native generic unmatched ' + boundary + ' offer stays funded after cancellation', { timeout: 120000 }, async () => {
  await unknownFixture(async f => {
    const before = await settledState(f), release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'generic-copy-' + boundary });
    try {
      try { await f.request('https://fixture/v1/chat/completions', chat('chat', { stream: boundary === 'normalizer' })); }
      catch { /* The unsupported changed operand can fail the delivered body. */ }
      let held;
      do { held = await state(f); if (!held.consumers.generic.logical) await new Promise(resolve => setTimeout(resolve, 10)); } while (!held.consumers.generic.logical);
      assert.ok(held.consumers.generic.copies > 0);
      const owner = boundary === 'normalizer' ? held.consumers.normalizer : held.consumers.generic;
      assert.equal(owner.transfers, 0); assert.equal(owner.retired, 0); assert.equal(owner.live, 1);
      assert.ok(held.charged > before.charged); assert.equal(held.completed.length, before.completed.length);
      await release(); const after = await state(f);
      assert.equal(after.completed.length, before.completed.length);
      assert.ok(after.charged > before.charged, 'fixture release is not a missing transfer receipt');
    } finally { await release(); }
  });
});

for (const order of ['before', 'after', 'reject'])
test('native generic read installation uncertainty retains its independent origin: ' + order, { timeout: 120000 }, async () => {
  await unknownFixture(async f => {
    const before = await settledState(f), release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'generic-install-' + order });
    try {
      try { await f.request('https://fixture/v1/chat/completions', chat('chat')); }
      catch { /* Prompt failed read, with physical UNKNOWN held independently. */ }
      const held = await state(f), row = held.consumers.generic;
      assert.equal(row.installs, 1); assert.equal(row.failures, 1);
      assert.equal(row.readFailures, order === 'reject' ? 1 : 0);
      assert.equal(row.doneGets, order === 'after' ? 1 : 0); assert.equal(row.eofValues, 0);
      assert.equal(row.logical, 1); assert.equal(row.retired, 0);
      assert.ok(held.charged > before.charged); assert.equal(held.completed.length, before.completed.length);
      await release(); const after = await state(f);
      assert.equal(after.consumers.generic.retired, 0); assert.equal(after.consumers.generic.logical, 1);
      assert.equal(after.completed.length, before.completed.length);
    } finally { await release(); }
  });
});


// Exact pinned Workerd metadata witnesses. Clean Node coverage does not certify
// Undici's mutable-iterator/cache history. All remain UNRUN_CODE_ONLY_HOSTED.
for (const provider of ['chat', 'venice'])
for (const mode of ['trace', 'constructors', 'methods', 'next', 'long-text', 'shrink'])
test('native closed proxy publication binds ' + provider + ' output: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'publication-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat(provider,
        provider === 'venice' ? { model: ownedHttpControlModels.venice, stream: true } : {}));
      assert.equal(reply.status, 200); assert.ok(reply.text.length);
      assert.equal(reply.headers.get('x-clawrouter-upstream-provider'), provider === 'venice' ? 'venice' : 'volcengine');
      assert.deepEqual(reply.headers.getSetCookie(), []);
      for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'trailer', 'transfer-encoding', 'upgrade', 'x-clawrouter-grant-failover', 'openai-project', 'anthropic-organization-id', 'anthropic-workspace-id']) assert.equal(reply.headers.get(name), null, name);
      assert.equal(reply.headers.get('openai-organization'), null); assert.equal(reply.headers.get('x-clawrouter-error-code'), null);
      assert.equal(reply.headers.get('x-mixed-case'), mode === 'shrink' ? null : 'one, two');
      assert.equal(reply.headers.get('x-unicode'), 'héllo'); assert.equal(reply.headers.get('x-empty'), '');
      assert.match(reply.headers.get('server-timing'), /^cr-admission;dur=\d+\.\d, cr-budget;dur=\d+\.\d, cr-upstream-ttfb;dur=\d+\.\d/);
      assert.ok(reply.headers.has('x-clawrouter-request-id'));
      const after = await settledState(f), row = after.consumers.publication;
      assert.equal(row.hooks, 0); assert.equal(row.produced, 1); assert.equal(row.published, 1); assert.equal(row.retired, 1);
      assert.equal(row.trace, 'S;T;H;p;h;b;b;s;t;'); assert.equal(row.factories, 2);
      assert.ok(row.bytes > (mode === 'long-text' ? 12 * 16384 : 0));
      assert.equal(after.events.length, 1, 'publication does not duplicate accounting');
    } finally { await release(); }
  }, true);
});

for (const provider of ['chat', 'venice'])
for (const mode of ['fund-grow', 'status-grow', 'final-grow', 'body-swap', 'constructor-fail', 'producer-fail'])
test('native proxy publication refuses changed operands before delivery: ' + provider + '/' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'publication-' + mode });
    const before = await settledState(f); f.expectFailedRetirement(before.intakes.length);
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat(provider,
        provider === 'venice' ? { model: ownedHttpControlModels.venice, stream: true } : {}));
      assert.equal(reply.status, mode === 'constructor-fail' || mode === 'producer-fail' ? 500 : 503);
      const after = await settledState(f), row = after.consumers.publication;
      assert.equal(row.published, 0); assert.equal(row.cleanups, 1); assert.equal(row.foreignCancels, 0);
      assert.equal(row.retired, 1); assert.equal(after.events.length, 1);
      if (mode === 'body-swap') assert.equal(row.trace, 'S;T;H;p;h;b;b;s;t;');
      if (mode === 'fund-grow') { assert.equal(row.growCalls, 2); assert.equal(row.factories, 1); }
      if (mode === 'status-grow' || mode === 'final-grow' || mode === 'body-swap') assert.equal(row.factories, 1);
      if (mode === 'producer-fail') { assert.equal(row.produced, 0); assert.equal(row.factories, 1); }
    } finally { await release(); }
  }, true);
});

for (const provider of ['chat', 'venice']) for (const mode of ['fail-held', 'capacity-held'])
test('native proxy publication failure starts ' + provider + ' cleanup before the outer public reader: ' + mode, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release); f.expectFailedRetirement(before.intakes.length);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'publication-' + mode });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat(provider,
        provider === 'venice' ? { model: ownedHttpControlModels.venice, stream: true } : {}));
      assert.ok(reply.status >= 400, 'funded failure delivery does not await old unlock');
      const held = await state(f), reader = provider === 'venice' ? held.consumers : held.consumers.generic;
      assert.equal(held.consumers.publication.cleanups, 1); if (mode === 'capacity-held') assert.equal(held.consumers.publication.refused, true); assert.equal(reader.unlock, 1); assert.equal(reader.nativeUnlocked, 0);
      assert.equal(held.completed.length, before.completed.length); assert.ok(held.charged > before.charged);
      await release(); const after = await settledState(f);
      assert.equal(after.consumers.publication.retired, 1); assert.equal(after.events.length, 1);
    } finally { await release(); }
  }, true);
});


test('native generic bodyless producer binds its exact Response without acquiring a reader', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'publication-bodyless' });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { ownedPublicationCase: 'bodyless' }));
      assert.equal(reply.status, 204); assert.equal(reply.text, '');
      const after = await settledState(f), row = after.consumers.publication;
      assert.equal(after.consumers.generic.acquired, 0); assert.equal(after.consumers.generic.logical, 1);
      assert.equal(row.trace, 'p;h;b;b;s;t;'); assert.equal(row.factories, 1); assert.equal(row.retired, 1);
      assert.equal(after.events.length, 1);
    } finally { await release(); }
  }, true);
});

// A synchronous bodyless result is READY before metadata publication. Failure
// of the later constructor must preserve that result and its single event.
test('native bodyless READY survives failed final publication', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const before = await settledState(f), release = () => f.request('https://fixture/fixture/consumer-mode', { method: 'DELETE' });
    f.releases.push(release); f.expectFailedRetirement(before.intakes.length);
    await f.request('https://fixture/fixture/consumer-mode', { method: 'POST', body: 'publication-constructor-fail' });
    try {
      const reply = await f.request('https://fixture/v1/chat/completions', chat('chat', { ownedPublicationCase: 'bodyless' }));
      assert.equal(reply.status, 500);
      const after = await settledState(f);
      assert.equal(after.consumers.generic.acquired, 0); assert.equal(after.consumers.generic.logical, 1);
      assert.equal(after.events.length, before.events.length + 1);
      assert.equal(after.events.at(-1).status, 204);
      assert.equal(new Set(after.events.map(event => event.id)).size, after.events.length);
    } finally { await release(); }
  }, true);
});
