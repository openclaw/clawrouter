import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkerdFixture } from '../../test/helpers/workerd.mjs';
import { ownedHttpModel, ownedHttpProxyKey, ownedHttpRouter, ownedHttpUpstream, seedOwnedHttpChat } from '../../test/helpers/owned-http-chat-fixture.mjs';

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
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
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
