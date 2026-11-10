import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { ownedHttpModel, ownedHttpPricingModel, ownedHttpControlModels, ownedHttpProxyKey, ownedHttpRouter, ownedHttpUpstream, seedOwnedHttpChat } from '../../test/helpers/owned-http-chat-fixture.mjs';

// One memoized ORIGINAL body root is enrolled as soon as each dispatch resolves,
// including a late response after an earlier assertion has already failed.
async function fixture(t, run) {
  const roots = [], bodies = new WeakMap(), releases = [];
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
        if (report.completed.length === report.intakes.length) { assert.ok(report.completed.every(row => !row.failed), 'accepted native roots'); break; }
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
    runtime = await take(own(startWorkerdFixture(directory, ownedHttpRouter, ownedHttpUpstream, { preventEviction: true, hotCache: true })));
    await take(own(seedOwnedHttpChat(runtime)));
    assert.equal((await request('https://fixture/fixture/grants', { method: 'POST' })).status, 204);
    await run({ runtime, own, take, request, releases });
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
    assert.ok(count(before, 'authority', '/authorization/snapshot') > 0, 'provider freshness was not bypassed');
    const hit = await f.request('https://fixture/v1/chat/completions', request());
    assert.equal(hit.status, 200);
    const after = await state(f);
    assert.equal(count(after, 'authority', '/admission/resolve'), count(before, 'authority', '/admission/resolve'), 'covered generation hit');
    assert.equal(count(after, 'credential', '/materialize'), count(before, 'credential', '/materialize'), 'covered private credential hit');
    assert.ok(count(after, 'authority', '/authorization/snapshot') > count(before, 'authority', '/authorization/snapshot'), 'mandatory provider revalidation still executes');
    const rows = JSON.parse((await f.request('https://fixture/fixture/upstream')).text).filter(row => row.id === provider);
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.organization === (provider === 'gmi' ? 'fixture-organization' : null)));
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
