import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const secret = 'synthetic-credit-secret';
const credit = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } };

// Each named Worker runs its own module graph/isolate. Only KV, the SQLite
// authority/credential owners and the Cache API namespace are shared.
const router = `
import handler from './worker/index.ts';
export * from './worker/index.ts';
import { setHotCacheClock } from './worker/hot-cache.ts';
import { putGrantCredentials } from './worker/grant-credentials.ts';
import { grantRuntimeStates } from './worker/grant-selection.ts';
import { flushSelections, setCoalesceWindowMs } from './worker/admission-cache.ts';
const realNow = Date.now.bind(Date); let offset = 0;
Date.now = () => realNow() + offset; setHotCacheClock(() => Date.now()); setCoalesceWindowMs(60000);
let admissions = 0, coloHits = 0, coloAge = null, saved; const events = [];
const cache = caches.default, match = cache.match.bind(cache), put = cache.put.bind(cache);
cache.put = async (key, response) => {
  if (!saved && String(key).includes('/admission/')) saved = { key, body: await response.clone().text(), headers: [...response.headers] };
  return put(key, response);
};
cache.match = async (...args) => { const response = await match(...args); if (response) {
  coloHits++; coloAge = Date.now() - (await response.clone().json()).fetchedAt;
} return response; };
export default { ...handler, async fetch(request, bindings, context) {
  const url = new URL(request.url), env = { ...bindings };
  if (url.pathname === '/fixture/setup') {
    for (const [key, credential] of [['oauth/fixture/anthropic', 'synthetic-policy'], ['oauth/tenants/fixture/anthropic', 'synthetic-tenant'], ['oauth/other/anthropic', 'synthetic-other']])
      await putGrantCredentials(env, key, { provider: 'anthropic', kind: 'api_key', enabled: true, credential, updatedAt: '2026-01-01T00:00:00Z' });
    return new Response('ok');
  }
  if (url.pathname === '/fixture/restore') { if (!saved) throw new Error('missing saved snapshot'); await put(saved.key, new Response(saved.body, { headers: saved.headers })); return new Response('ok'); }
  if (url.pathname === '/fixture/runtime') return Response.json(await grantRuntimeStates(env, ['oauth/fixture/anthropic', 'oauth/tenants/fixture/anthropic']));
  if (url.pathname === '/fixture/state') return Response.json({ admissions, coloHits, coloAge, saved: !!saved, events });
  if (url.pathname === '/fixture/clock') { offset += Number(url.searchParams.get('advance')); return new Response('ok'); }
  if (url.pathname === '/fixture/flush') { await flushSelections(env); return new Response('ok'); }
  if (url.pathname === '/fixture/upstream') return fetch('https://fixture/control', request);
  const authority = env.ACCESS_CONTROL;
  env.ACCESS_CONTROL = { idFromName: name => authority.idFromName(name), get: id => {
    const stub = authority.get(id); return { async fetch(input, init) {
      const path = new URL(input).pathname;
      if (path === '/admission/resolve') admissions++;
      const response = await stub.fetch(input, init);
      return response;
    } };
  } };
  const queue = env.USAGE_QUEUE;
  env.USAGE_QUEUE = { async send(event) { events.push(event); return queue.send(event); } };
  return handler.fetch(request, env, context);
} };
`;
const upstream = `
const depleted = new Set(), trace = []; let weeklyHeld = false;
export default { async fetch(request) {
  if (new URL(request.url).pathname === '/control') {
    if (request.method === 'POST') { const value = await request.json(); for (const label of value.depleted ?? []) depleted.add(label); if (value.releaseWeekly) weeklyHeld = false; }
    return Response.json({ trace, weeklyHeld });
  }
  const key = request.headers.get('x-api-key');
  const label = { 'synthetic-policy': 'policy', 'synthetic-tenant': 'tenant', 'synthetic-other': 'other' }[key];
  if (!label) throw new Error('unexpected synthetic credential');
  const body = await request.json(), content = body.messages[0].content;
  if (content === 'deplete' && !depleted.size || content === 'deplete-all') depleted.add(label);
  if (content === 'weekly-held') { weeklyHeld = true; while (weeklyHeld) await new Promise(resolve => setTimeout(resolve, 2)); }
  const status = content !== 'weekly-held' && depleted.has(label) ? 400 : 200;
  trace.push({ label, status, content, retryAfter: null });
  if (status === 400) return Response.json(${JSON.stringify(credit)}, { status });
  const payload = 'event: message_start\\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: label, usage: { input_tokens: 1 } } })
    + '\\n\\nevent: message_delta\\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\\n\\nevent: message_stop\\ndata: {"type":"message_stop"}\\n\\n'
    + (content === 'late-error' ? 'event: error\\ndata: ' + JSON.stringify(${JSON.stringify(credit)}) + '\\n\\n' : '');
  return new Response(payload, { headers: { 'content-type': 'text/event-stream', 'x-fixture-label': label,
    ...(content === 'weekly-held' ? { 'anthropic-ratelimit-unified-7d-utilization': '1', 'anthropic-ratelimit-unified-7d-reset': new Date(Date.now()+3600000).toISOString() } : {}) } });
} };
`;

async function fixture(t, routing = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'grant-credit-workerd-'));
  let mf;
  t.after(async () => { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); });
  const bundle = await build({ stdin: { contents: router, resolveDir: process.cwd(), loader: 'ts' }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
  const names = ['router', 'reader', 'cold'];
  const durableObjects = Object.fromEntries([['ACCESS_CONTROL', 'PolicyBindingIndexObject'], ['BUDGET_LEDGER', 'BudgetLedgerObject'], ['USAGE_LEDGER', 'UsageLedgerObject'], ['GRANT_CREDENTIALS', 'GrantCredentialObject']]
    .map(([binding, className]) => [binding, { className, scriptName: 'router', useSQLite: true, unsafePreventEviction: true }]));
  mf = new Miniflare(convertV4MiniflareOptions({ resourceTmpPath: directory, workers: [
    ...names.map(name => ({ name, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-06-05', compatibilityFlags: ['enable_request_signal'],
      kvNamespaces: { POLICY_KV: 'shared-credit-kv' }, durableObjects, outboundService: 'upstream',
      queueProducers: { USAGE_QUEUE: 'usage' }, ...(name === 'router' ? { queueConsumers: { usage: { maxBatchSize: 1, maxBatchTimeout: 0 } } } : {}) })),
    { name: 'upstream', modules: true, script: upstream, compatibilityDate: '2026-06-05' },
  ] }));
  await mf.ready;
  const kv = await mf.getKVNamespace('POLICY_KV', 'router');
  const policy = { enabled: true, generation: 'g1', providers: ['anthropic'], tenantId: 'fixture', monthlyBudgetMicros: null, retainRequestContent: false, grantRouting: { stickiness: 'session', ...routing } };
  for (const [id, value] of [['fixture', policy], ['other', { ...policy, tenantId: 'other' }]]) {
    await kv.put('policies/' + id, JSON.stringify(value));
    await kv.put('credentials/' + id, JSON.stringify({ enabled: true, secretSha256: createHash('sha256').update(secret).digest('hex'), policyId: id, policyGeneration: 'g1' }));
  }
  for (const [key, credential] of [['oauth/fixture/anthropic', 'synthetic-policy'], ['oauth/tenants/fixture/anthropic', 'synthetic-tenant'], ['oauth/other/anthropic', 'synthetic-other']])
    await kv.put(key, JSON.stringify({ provider: 'anthropic', kind: 'api_key', enabled: true, credential, updatedAt: '2026-01-01T00:00:00Z' }));
  await kv.put('connections/anthropic', JSON.stringify({ providerId: 'anthropic', enabled: true }));
  const workers = Object.fromEntries(await Promise.all(names.map(async name => [name, await mf.getWorker(name)])));
  const control = async (name, path, body) => {
    const response = await workers[name].fetch('https://fixture/fixture/' + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200); const text = await response.text(); return text === 'ok' ? text : JSON.parse(text);
  };
  const send = async (name = 'router', content = 'healthy', id = 'fixture') => {
    const response = await workers[name].fetch('https://fixture/v1/messages', { method: 'POST', headers: {
      authorization: `Bearer clawrouter-live-${id}-${secret}`, 'content-type': 'application/json', 'x-clawrouter-session-id': 'synthetic-session',
    }, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content }] }) });
    const body = await response.text();
    return { status: response.status, label: response.headers.get('x-fixture-label'), failover: response.headers.get('x-clawrouter-grant-failover'), retryAfter: response.headers.get('retry-after'), timing: response.headers.get('server-timing'), body };
  };
  await control('router', 'setup');
  return { send, control };
}
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

// Printed evidence contains only fixture labels and request markers, never keys.
function trace(t, name, responses, upstream) {
  t.diagnostic(JSON.stringify({ scenario: name, responses: responses.map(({ body, timing, ...value }) => ({ ...value, cache: /cr-cache;desc=([^;,]+)/.exec(timing ?? '')?.[1] ?? null })), upstream }));
}

test('real workerd credit failover serves one alternate, then pinned hot hits avoid authority and bill once', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await f.send(); assert.equal(first.status, 200);
  assert.deepEqual(first.body.trim().split('\n\n').map(event => JSON.parse(event.split('\ndata: ')[1]).type), ['message_start', 'message_delta', 'message_stop'], 'fixture emits actual SSE frames, not escaped newline text');
  const rotated = await f.send('router', 'deplete');
  assert.equal(rotated.status, 200); assert.equal(rotated.failover, '1'); assert.notEqual(rotated.label, first.label);
  assert.ok(!rotated.body.includes('"id":"' + first.label + '"'));
  const before = await f.control('router', 'state');
  const warm = await f.send(); assert.equal(warm.status, 200); assert.equal(warm.label, rotated.label); assert.equal(warm.failover, null);
  assert.match(warm.timing, /cr-cache;desc=hit/);
  assert.equal((await f.control('router', 'state')).admissions, before.admissions, 'zero warm authority calls');
  const failed = await f.send('router', 'deplete-all'); assert.equal(failed.status, 400); assert.equal(failed.failover, null);
  const blocked = await f.send(); assert.equal(blocked.status, 429); assert.match(blocked.body, /no available scoped upstream grant/);
  assert.ok(Number(blocked.retryAfter) > 290 && Number(blocked.retryAfter) <= 300);
  await until(async () => (await f.control('router', 'state')).events.length === 5);
  const { events } = await f.control('router', 'state');
  assert.deepEqual(events.map(event => event.status_code), [200, 200, 200, 400, 429]);
  assert.ok(events.slice(0, 3).every(event => event.actual_cost_micros > 0));
  assert.ok(events.slice(3).every(event => event.actual_cost_micros === 0));
  assert.equal(events[1].grant_key, events[2].grant_key, 'one final event belongs to the alternate');
  trace(t, 'pinned-credit', [first, rotated, warm, failed, blocked], (await f.control('router', 'upstream')).trace);
});

test('independent workerd isolates and colo snapshots converge by the original 60-second acquisition bound', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await f.send(); await f.control('router', 'flush');
  // Ensure the shared Cache API write has completed before cold adoption.
  const reader = await f.send('reader'); assert.equal(reader.label, first.label);
  assert.match(reader.timing, /cr-cache;desc=colo/);
  assert.ok((await f.control('reader', 'state')).coloHits > 0);
  const rotated = await f.send('router', 'deplete'); assert.equal(rotated.status, 200); await f.control('router', 'flush');
  // Restore the actual pre-feedback Cache API response, preserving its acquisition time.
  await f.control('router', 'restore');
  await f.control('cold', 'clock?advance=60001');
  const cold = await f.send('cold'); assert.equal(cold.status, 200); assert.equal(cold.label, rotated.label); assert.equal(cold.failover, null);
  assert.match(cold.timing, /cr-cache;desc=miss/);
  assert.equal((await f.control('cold', 'state')).admissions, 1, 'expired colo snapshot forces authoritative admission');
  await f.control('reader', 'clock?advance=60001');
  const converged = await f.send('reader'); assert.equal(converged.label, rotated.label); assert.equal(converged.failover, null);
  trace(t, 'cross-isolate-bound', [first, reader, rotated, cold, converged], (await f.control('router', 'upstream')).trace);
});

test('real workerd disabled failover preserves credit response, scoped tenants and post-stream no-replay', { timeout: 60000 }, async t => {
  const f = await fixture(t, { failover: false });
  const first = await f.send();
  const failed = await f.send('router', 'deplete'); assert.equal(failed.status, 400); assert.equal(failed.failover, null);
  const warm = await f.send(); assert.equal(warm.status, 200); assert.notEqual(warm.label, first.label);
  const other = await f.send('router', 'healthy', 'other'); assert.equal(other.status, 200); assert.equal(other.label, 'other');
  const late = await f.send('router', 'late-error'); assert.equal(late.status, 200); assert.equal(late.failover, null); assert.match(late.body, /event: error/);
  const calls = (await f.control('router', 'upstream')).trace; assert.equal(calls.length, 5, 'streaming error does not replay');
  trace(t, 'safety-boundaries', [first, failed, warm, other, late], calls);
});


test('weekly-only quota and credit feedback from concurrent workerd requests retain both exclusion windows', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const first = await f.send();
  const weekly = f.send('router', 'weekly-held');
  await until(async () => (await f.control('router', 'upstream')).weeklyHeld);
  const rotated = await f.send('router', 'deplete'); assert.equal(rotated.status, 200); assert.equal(rotated.failover, '1');
  await f.control('router', 'flush');
  await f.control('router', 'upstream', { releaseWeekly: true });
  assert.equal((await weekly).status, 200);
  await f.control('router', 'flush');
  const states = await f.control('router', 'runtime');
  const state = Object.values(states).find(value => value.windows.some(window => window.id === 'credit-balance'));
  assert.ok(state, 'credit observation persists');
  assert.deepEqual(state.windows.map(window => window.id).sort(), ['credit-balance', 'subscription-seven-day']);
  assert.ok(state.windows.every(window => window.remaining === 0));
  await f.control('router', 'clock?advance=300001');
  const afterCredit = await f.send(); assert.equal(afterCredit.status, 200); assert.equal(afterCredit.label, rotated.label);
  assert.equal(afterCredit.failover, null, 'weekly exclusion survives credit expiry');
  assert.notEqual(afterCredit.label, first.label);
  trace(t, 'weekly-credit-composition', [first, rotated, afterCredit], (await f.control('router', 'upstream')).trace);
});
