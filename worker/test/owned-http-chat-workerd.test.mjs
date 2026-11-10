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
async function fixture(t, run, observeParsers = false) {
  const roots = [], bodies = new WeakMap(), releases = [], failedRetirements = new Set();
  let directory, runtime, finished = false, cleanupPromise, hasPrimary = false, primary;
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
      while (true) {
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
    runtime = await take(own(start(directory, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true })));
    await take(own(seedOwnedHttpChat(runtime)));
    assert.equal((await request('https://fixture/fixture/grants', { method: 'POST' })).status, 204);
    await run({ runtime, own, take, request, dispatch, body, releases,
      expectFailedRetirement(index) { assert.ok(Number.isSafeInteger(index) && index >= 0); failedRetirements.add(index); },
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
      const row = rows[0]; assert.equal(row.cleared, true); assert.equal(row.parents, 0); assert.equal(row.tokens, 0); assert.equal(row.pending, false); assert.equal(row.member, false);
      if (valid) {
        assert.equal(row.parentPushes, row.parentPops); assert.equal(row.tokenPushes, row.tokenPops);
      }
      if (mode === 'compact-object128') {
        assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 128); assert.equal(row.peakStored, 259);
      } else if (mode === 'compact-object-string128') {
        assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 128); assert.equal(row.peakStored, 260);
        assert.ok(row.objectAttachments >= 128, 'actual child properties existed before both temporary key aliases cleared');
      } else if (mode === 'compact-object129' || mode === 'compact-open2048') {
        assert.equal(row.peakParents, 128); assert.equal(row.peakTokens, 129); assert.equal(row.peakStored, 260);
        assert.equal(row.abandonedParents, 128); assert.equal(row.abandonedTokens, 129);
        assert.equal(row.peakActive, 260); assert.equal(row.peakRejected, 260);
        assert.ok(row.peakBetween >= 259, 'accepted parent state existed before the rejecting opener');
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
    assert.equal(rows[1].peakParents, 128); assert.equal(rows[1].peakTokens, 128); assert.equal(rows[1].peakStored, 260);
    assert.equal(rows[1].peakActive, 260); assert.equal(rows[1].peakBetween, 259); assert.equal(rows[1].peakRejected, 0);
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
    assert.equal(rows[1].peakParents, 128); assert.equal(rows[1].peakTokens, 129);
    assert.equal(rows[1].peakActive, 260); assert.equal(rows[1].peakRejected, 260); assert.equal(rows[1].cleared, true);
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
    assert.equal(parser.peakParents, 128); assert.equal(parser.peakTokens, 128); assert.equal(parser.cleared, true);
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

test('native revalidation listener-removal uncertainty retains funding after original body completion', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('gmi', { model: ownedHttpControlModels.gmi });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    const release = async () => {
      assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204);
    };
    f.releases.push(release);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind: 'authority', reason: 'listener' }),
    })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(response.status, 503);
    const held = await settledState(f);
    assert.equal(held.controlReads.at(-1).removalFailed, true);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    assert.equal(held.reasonReads, 0);
    await release();
    const after = await state(f);
    assert.equal(after.charged, held.charged, 'fixture obstruction removal is not a production refund receipt');
    assert.equal(JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === 'gmi').length, 1);
    // This isolated runtime is disposed with the UNKNOWN owner still funded.
    // No test cleanup hook retries production retirement or fabricates an ACK.
  });
});

test('native Venice codec listener-removal uncertainty retains its funded terminal capabilities', { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    const request = () => chat('venice', { model: ownedHttpControlModels.venice });
    assert.equal((await f.request('https://fixture/v1/chat/completions', request())).status, 200);
    const before = await settledState(f);
    const release = async () => { assert.equal((await f.request('https://fixture/fixture/control-read', { method: 'DELETE' })).status, 204); };
    f.releases.push(release); f.expectFailedRetirement(before.completed.length);
    assert.equal((await f.request('https://fixture/fixture/control-read', {
      method: 'POST', body: JSON.stringify({ kind: 'provider', reason: 'listener' }),
    })).status, 204);
    const response = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(response.status, 502);
    const held = await settledState(f);
    assert.equal(held.controlReads.at(-1).removalFailed, true);
    assert.ok(held.charged >= before.charged + 32 * 1024 * 1024);
    assert.deepEqual(held.completed.at(-1).origins, [
      { origin: 'listener-remove', undefined: true }, { origin: 'abort', undefined: false },
    ], 'the still-installed listener observes the operation stop as its distinct origin');
    await release();
    const after = await state(f);
    assert.equal(after.charged, held.charged, 'fixture cleanup cannot refund UNKNOWN codec ownership');
    assert.equal(after.reasonReads, 0);
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
    const response = await f.request('https://fixture/v1/chat/completions', chat('chat'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-clawrouter-error-code'), 'identity_admission_unavailable');
    const report = await state(f);
    assert.equal(count(report, 'authority', '/admission/credential-preflight'), 1, 'correct secret was preverified');
    assert.equal(count(report, 'authority', '/admission/resolve'), 0, 'no full admission or initial choice');
    assert.equal(count(report, 'authority', '/grant-pools/select'), 0);
    assert.equal(count(report, 'authority', '/grant-pools/record'), 0);
    assert.deepEqual(JSON.parse((await f.request('https://fixture/fixture/upstream')).text), []);
  });
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
    assert.equal(current.length, 2); assert.equal(current[1].peakParents, 128); assert.equal(current[1].statusPending, 4);
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
