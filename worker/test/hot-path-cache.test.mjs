import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { sqlBudgetNamespace } from './sql-budget-namespace.mjs';
import { usageEnv, proxyKey } from './usage-budget-fixture.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { resolveGrantSelection } from '../grant-selection.ts';
import { HotCache, hotCacheConfig, hotCacheNow, pendingBackgroundWork, setHotCacheClock } from '../hot-cache.ts';
import { applyLocalGrantRuntime, resolveAdmission } from '../admission-cache.ts';
import { cachedGrantCredentials } from '../credential-cache.ts';
import { providerById } from '../providers.ts';
import { sha256Hex } from '../utils.ts';
const { default: worker } = await import('../index.ts');
const { captureGrantRuntime } = await import('../proxy.ts');
const { normalizePolicy } = await import('../admin.ts');

const provider = providerById('anthropic');
const endpoint = provider.endpoints.find(item => item.id === 'messages');
const model = 'claude-sonnet-5';
const selection = { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model, catalogModelId: 'anthropic/claude-sonnet-5', capability: 'llm.chat' };
const keyA = 'oauth/fixture/anthropic', keyB = 'oauth/fixture/backup';
const grant = (extra = {}) => ({ provider: provider.id, kind: 'subscription', enabled: true, accessToken: 'synthetic-token', updatedAt: '2026-01-01T00:00:00Z', ...extra });
const ok = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });

function clock(start = Date.now()) {
  let now = start;
  setHotCacheClock(() => now);
  return { advance(ms) { now += ms; } };
}

async function fixture(env = {}) {
  const f = await admissionFixture();
  Object.assign(f.env, env);
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.ownerCalls = 0;
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(...args) { f.ownerCalls++; return stub.fetch(...args); } }; };
  f.put = (key, value) => putGrantCredentials(f.env, key, value);
  f.request = (headers = admissionHeaders) => worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [] }) }), f.env, f.context);
  f.send = async (headers) => { const response = await f.request(headers); const body = await response.text(); await Promise.all(f.pending); return { response, body }; };
  f.reset = () => { f.calls.length = 0; f.ownerCalls = 0; };
  return f;
}

test('hot-cache config: default, disabled and bounded max age', () => {
  assert.deepEqual(hotCacheConfig({}), { maxAgeMs: 60_000, freshMs: 10_000 });
  assert.deepEqual(hotCacheConfig({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }), { maxAgeMs: 0, freshMs: 0 });
  assert.deepEqual(hotCacheConfig({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: 'off' }), { maxAgeMs: 0, freshMs: 0 });
  assert.deepEqual(hotCacheConfig({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '5' }), { maxAgeMs: 5_000, freshMs: 5_000 });
});

test('hot cache serves fresh, revalidates stale once, expires at max age, and bounds size', async () => {
  const time = clock(), config = hotCacheConfig({}), cache = new HotCache(2);
  let loads = 0;
  const loader = async () => ({ value: ++loads, cacheable: true });
  assert.deepEqual(await cache.get('a', config, loader), { value: 1, state: 'miss' });
  assert.deepEqual(await cache.get('a', config, loader), { value: 1, state: 'hit' });
  time.advance(10_001);
  const gate = Promise.withResolvers();
  const gated = async () => { await gate.promise; return loader(); };
  assert.deepEqual(await cache.get('a', config, gated), { value: 1, state: 'stale' });
  assert.deepEqual(await cache.get('a', config, gated), { value: 1, state: 'stale' });
  gate.resolve(); await pendingBackgroundWork();
  assert.equal(loads, 2, 'one background refresh for concurrent stale hits');
  assert.deepEqual(await cache.get('a', config, loader), { value: 2, state: 'hit' });
  time.advance(60_000);
  assert.deepEqual(await cache.get('a', config, loader), { value: 3, state: 'miss' });
  await cache.get('b', config, loader); await cache.get('c', config, loader);
  assert.equal(cache.size, 2);
  assert.equal(cache.peek('a', config), undefined, 'least recently used entry evicted');
});

test('hot cache single-flights misses, never stores uncacheable results, and honours entry expiry', async () => {
  const time = clock(), config = hotCacheConfig({}), cache = new HotCache(8);
  let loads = 0; const gate = Promise.withResolvers();
  const slow = async () => { loads++; await gate.promise; return { value: 'v', cacheable: true, expiresAt: hotCacheNow() + 1_000 }; };
  const [one, two] = [cache.get('k', config, slow), cache.get('k', config, slow)];
  gate.resolve(); await Promise.all([one, two]);
  assert.equal(loads, 1);
  time.advance(1_001);
  assert.equal(cache.peek('k', config), undefined, 'entry expiry wins over max age');
  await cache.get('n', config, async () => ({ value: 'denied', cacheable: false }));
  assert.equal(cache.peek('n', config), undefined);
  assert.deepEqual(await cache.get('x', hotCacheConfig({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }), async () => ({ value: 'live', cacheable: true })), { value: 'live', state: 'off' });
});

test('warm proxy-key inference performs zero foreground authority, credential-owner or KV calls', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  f.reset();
  const first = await f.send();
  assert.equal(first.response.status, 200, first.body);
  assert.deepEqual(f.calls, ['/admission/resolve']); assert.equal(f.ownerCalls, 1);
  assert.match(first.response.headers.get('server-timing'), /cr-cache;desc=miss/);
  f.reset();
  const order = [];
  globalThis.fetch.mock.mockImplementation(async () => { order.push(`upstream after ${f.calls.length} authority calls`); return ok(); });
  t.mock.method(f.env.POLICY_KV, 'get', () => { throw new Error('warm inference must not read KV'); });
  const second = await f.send();
  assert.equal(second.response.status, 200, second.body);
  assert.match(second.response.headers.get('server-timing'), /cr-cache;desc=hit/);
  assert.deepEqual(order, ['upstream after 0 authority calls']);
  assert.equal(f.ownerCalls, 0, 'credential served from the isolate cache');
  assert.deepEqual(f.calls, ['/grant-pools/record'], 'only the coalesced background counter write');
  const counts = [...f.authority.sql.exec('SELECT grant_key, selected_count FROM upstream_grant_selection')];
  assert.deepEqual(counts.map(row => [row.grant_key, row.selected_count]), [[keyA, 2]]);
});

test('disabling the hot cache restores the authoritative foreground path', async t => {
  const f = await fixture({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  for (let n = 0; n < 2; n++) {
    f.reset();
    const { response } = await f.send();
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls, ['/admission/resolve']); assert.equal(f.ownerCalls, 1);
    assert.match(response.headers.get('server-timing'), /cr-cache;desc=off/);
  }
});

test('a cached key never admits a different secret', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  assert.equal((await f.send()).response.status, 200);
  f.reset();
  const wrong = { ...admissionHeaders, authorization: 'Bearer clawrouter-live-fixture-not-the-secret' };
  const { response } = await f.send(wrong);
  assert.equal(response.status, 401);
  assert.deepEqual(f.calls, ['/admission/resolve'], 'a mismatch re-asks the authority');
  f.reset();
  assert.equal((await f.send()).response.status, 200);
  assert.deepEqual(f.calls, ['/grant-pools/record'], 'a wrong secret does not evict the owner entry');
});

test('revocation outside this isolate takes effect within the max age; stale entries revalidate', async t => {
  const time = clock();
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  assert.equal((await f.send()).response.status, 200);
  // Another isolate disables the policy: this isolate has not been told.
  f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  assert.equal((await f.send()).response.status, 200, 'within the fresh window the snapshot still serves');
  time.advance(10_001);
  const stale = await f.send();
  assert.equal(stale.response.status, 200, 'a stale hit serves while refreshing in the background');
  assert.match(stale.response.headers.get('server-timing'), /cr-cache;desc=stale/);
  assert.equal((await f.send()).response.status, 403, 'the refreshed admission is enforced');
  f.policy.enabled = true; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  assert.equal((await f.send()).response.status, 200);
  f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  time.advance(60_000);
  assert.equal((await f.send()).response.status, 403, 'past the max age admission is foreground again');
});

test('same-isolate mutation requests clear the hot caches immediately', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  assert.equal((await f.send()).response.status, 200);
  f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const admin = await worker.fetch(new Request('https://fixture/v1/admin/policies/fixture', { method: 'PUT', body: '{}' }), f.env, f.context);
  await admin.text();
  assert.equal((await f.send()).response.status, 403);
});

test('credential cache: reuse, version change, refresh margin, and eviction on upstream rejection', async () => {
  const time = clock(Date.parse('2026-06-01T00:00:00Z'));
  const env = {}; let materialized = 0;
  const projection = grant({ credentialGeneration: 1 });
  const materialize = (expiresAt = '2026-06-01T01:00:00Z') => async () => ({ ...projection, accessToken: `token-${++materialized}`, expiresAt });
  assert.equal((await cachedGrantCredentials(env, keyA, projection, materialize())).accessToken, 'token-1');
  const reused = await cachedGrantCredentials(env, keyA, projection, materialize());
  assert.equal(reused.accessToken, 'token-1'); reused.accessToken = 'mutated';
  assert.equal((await cachedGrantCredentials(env, keyA, projection, materialize())).accessToken, 'token-1', 'callers get copies');
  assert.equal((await cachedGrantCredentials(env, keyA, { ...projection, credentialGeneration: 2 }, materialize())).accessToken, 'token-2', 'a new generation re-materializes');
  captureGrantRuntime({ waitUntil() {} }, env, keyA, projection.updatedAt, provider.quota, { status: 401, headers: new Headers() });
  assert.equal((await cachedGrantCredentials(env, keyA, projection, materialize())).accessToken, 'token-3', 'an upstream 401 evicts');
  time.advance(55 * 60_000 + 1);
  assert.equal((await cachedGrantCredentials(env, keyA, projection, materialize())).accessToken, 'token-4', 'never served inside the refresh margin');
  assert.equal((await cachedGrantCredentials({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }, keyA, projection, materialize())).accessToken, 'token-5');
});

for (const strategy of ['priority', 'round_robin', 'least_used', 'most_remaining', 'threshold', 'weighted_random']) {
  for (const stickiness of ['none', 'identity', 'session']) test(`local snapshot selection parity: ${strategy}/${stickiness}`, async t => {
    const old = await fixture(), local = await fixture();
    t.mock.method(crypto, 'getRandomValues', array => { array.fill(123456789); return array; });
    const routing = { strategy, stickiness, staleState: 'allow', includedQuotaReservePercent: 10 };
    const observedAt = new Date().toISOString(), resetAt = new Date(Date.now() + 60_000).toISOString();
    const runtime = remaining => ({ status: 'available', observedAt, source: 'provider_response', lastSignal: 'quota', cooldownUntil: null, grantRevision: '2026-01-01T00:00:00Z', windows: [{ id: 'week', kind: 'requests', remaining, limit: 100, resetAt }] });
    for (const f of [old, local]) {
      await f.put(keyA, grant({ weight: 1 })); await f.put(keyB, grant({ weight: 7 }));
      f.policy.grantRouting = routing; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
      await f.call('/grant-pools/feedback', { key: keyA, state: runtime(25) });
      await f.call('/grant-pools/feedback', { key: keyB, state: runtime(90) });
    }
    const normalizedSticky = strategy === 'threshold' ? 'none' : stickiness;
    const sessionHash = await sha256Hex('session:fixture-session');
    const hash = normalizedSticky === 'identity' ? await sha256Hex('identity:owner@example.com') : normalizedSticky === 'session' ? sessionHash : null;
    const states = [];
    for (let n = 0; n < 5; n++) {
      const expected = await resolveGrantSelection(provider.id, 'fixture', 'fixture', provider.id, old.env, new Set(), routing, hash, true, undefined, { provider, endpoint, mode: 'http', model });
      const { admission, cache } = await resolveAdmission(local.env, { credentialId: 'fixture', secretSha256: local.credential.secretSha256, providers: [{ id: provider.id, tokenRef: provider.id }], selection: { ...selection, sessionHash } });
      states.push(cache);
      assert.equal(admission.selection?.selected?.key, expected.selected?.key, `selection ${n}`);
      assert.equal(admission.selection?.hasConfiguredGrant, expected.hasConfiguredGrant);
    }
    assert.deepEqual(states, ['miss', 'hit', 'hit', 'hit', 'hit']);
    await pendingBackgroundWork();
    const rows = f => [...f.authority.sql.exec('SELECT grant_key, selected_count FROM upstream_grant_selection ORDER BY grant_key')].map(row => [row.grant_key, row.selected_count]);
    assert.deepEqual(rows(local), rows(old), 'coalesced counters converge on the authority');
  });
}

test('observed quota feedback applies to this isolate before the authority write lands', async () => {
  const f = await fixture(); await f.put(keyA, grant()); await f.put(keyB, grant());
  f.policy.grantRouting = { strategy: 'priority', stickiness: 'none' }; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const admit = () => resolveAdmission(f.env, { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [{ id: provider.id, tokenRef: provider.id }], selection });
  const first = (await admit()).admission.selection.selected.key;
  applyLocalGrantRuntime(first, { status: 'cooldown', observedAt: new Date().toISOString(), source: 'provider_response', lastSignal: 'rate_limit', cooldownUntil: new Date(Date.now() + 60_000).toISOString(), grantRevision: '2026-01-01T00:00:00Z', windows: [] });
  const { admission, cache } = await admit();
  assert.equal(cache, 'hit');
  assert.notEqual(admission.selection.selected.key, first);
});

async function budgetSetup(t, options = {}) {
  const env = usageEnv([], { provider: 'local-openai', retainContent: false, ...options });
  env.LOCAL_OPENAI_BASE_URL = 'https://upstream.example.invalid';
  const ledger = sqlBudgetNamespace(t), calls = [], events = [], pending = [];
  env.BUDGET_LEDGER = { ...ledger, get: name => ({ fetch: (url, init) => { calls.push(new URL(url).pathname); return ledger.get(name).fetch(url, init); } }) };
  env.USAGE_QUEUE = { send: async event => events.push(event) };
  const context = { waitUntil: promise => pending.push(promise) };
  const request = () => worker.fetch(new Request('https://clawrouter.example/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxyKey()}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local/default', messages: [{ role: 'user', content: 'synthetic input' }] }) }), env, context);
  return { env, ledger, calls, events, pending, request, drain: () => Promise.all(pending) };
}

test('new policies default to soft budgets; updates keep the stored mode', () => {
  assert.equal(normalizePolicy({ providers: ['openai'] }, undefined, false).budgetMode, 'soft');
  assert.equal(normalizePolicy({ providers: ['openai'] }, { enabled: true, generation: 'g', providers: ['openai'], budgetMode: 'reserve' }, false).budgetMode, 'reserve');
  assert.equal(normalizePolicy({ providers: ['openai'] }, { enabled: true, generation: 'g', providers: ['openai'] }, false).budgetMode, undefined, 'a stored policy without a mode stays reserve');
});

test('an observed exhausted soft scope denies the next request before dispatch without a ledger call', async t => {
  const f = await budgetSetup(t, { budgetMode: 'soft', limit: 1 });
  f.env.BUDGET_LEDGER.get = () => ({ fetch: async url => { f.calls.push(new URL(url).pathname); return new URL(url).pathname === '/status' ? Response.json({ spentMicros: 5 }) : Response.json({ ok: true }); } });
  let upstream = 0;
  t.mock.method(globalThis, 'fetch', async () => { upstream++; return Response.json({}); });
  await (await f.request()).text(); await f.drain();
  const before = { upstream, calls: f.calls.length };
  const denied = await f.request();
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).error.code, 'budget_exhausted');
  assert.equal(upstream, before.upstream, 'no upstream dispatch');
  assert.equal(f.calls.length, before.calls, 'no ledger round trip');
});

test('explicit reserve budgets stay foreground and authoritative', async t => {
  const f = await budgetSetup(t, { budgetMode: 'reserve' });
  let before;
  t.mock.method(globalThis, 'fetch', async () => { before = [...f.calls]; return Response.json({}); });
  const response = await f.request();
  assert.equal(response.status, 200, await response.clone().text());
  await response.text(); await f.drain();
  assert.ok(before.includes('/reserve') && !before.includes('/dispatch') && !before.includes('/status'), before.join());
});

test('request content retention is written after dispatch and never fails the request', async t => {
  const f = await budgetSetup(t, { retainContent: true });
  const order = [];
  f.env.CONTENT_ARCHIVE = { put: async () => { order.push('retention'); throw new Error('synthetic archive outage'); } };
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { order.push('upstream'); return Response.json({}); });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-clawrouter-content-retention'), 'on; retention-days=30');
  await response.text(); await f.drain();
  assert.deepEqual(order, ['upstream', 'retention']);
  assert.ok(f.events.find(event => event.content_ref), 'usage still references the content ref');
});

test('same-isolate invalidation never drops coalesced selection counters', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  const first = await f.request(); await first.text();
  const second = await f.request(); await second.text();
  const admin = await worker.fetch(new Request('https://fixture/v1/admin/policies/fixture', { method: 'PUT', body: '{}' }), f.env, f.context);
  await admin.text(); await Promise.all(f.pending);
  const counts = [...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')];
  assert.equal(counts[0].selected_count, 2);
});

test('a hung background call leaves the pending set after its bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { runInBackground, BACKGROUND_WORK_BOUND_MS } = await import('../hot-cache.ts');
  runInBackground(new Promise(() => {}));
  const pending = pendingBackgroundWork();
  assert.ok(pending);
  t.mock.timers.tick(BACKGROUND_WORK_BOUND_MS);
  await pending;
  assert.equal(pendingBackgroundWork(), null);
});

test('quota feedback and selection counters coalesce into one flush per window', async t => {
  const { setCoalesceWindowMs } = await import('../admission-cache.ts');
  setCoalesceWindowMs(200); t.after(() => setCoalesceWindowMs(0));
  const f = await fixture(); await f.put(keyA, grant());
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.parse(reset) / 1000)) } }));
  await (await f.request()).text(); await Promise.all(f.pending);
  f.reset();
  await Promise.all([1, 2, 3, 4].map(async () => { const response = await f.request(); await response.text(); }));
  await Promise.all(f.pending);
  assert.deepEqual(f.calls.filter(path => path === '/grant-pools/feedback').length, 1, 'four observations, one authority write');
  assert.deepEqual(f.calls.filter(path => path === '/grant-pools/record').length, 1, 'four selections, one counter write');
  const counts = [...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')];
  assert.equal(counts[0].selected_count, 5);
});

test('with the hot cache disabled quota feedback is written per response', async t => {
  const f = await fixture({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }, { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) } }));
  for (let n = 0; n < 2; n++) await f.send();
  assert.equal(f.calls.filter(path => path === '/grant-pools/feedback').length, 2);
});

test('warm proxy-key catalog and models reuse the derived inventory without backend reads', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  const get = (path) => worker.fetch(new Request(`https://fixture${path}`, { headers: admissionHeaders }), f.env, f.context);
  const first = await get('/v1/catalog'); assert.equal(first.status, 200); const expected = await first.json(); await Promise.all(f.pending);
  f.reset();
  t.mock.method(f.env.POLICY_KV, 'get', () => { throw new Error('warm catalog must not read KV'); });
  const second = await get('/v1/catalog'); assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).providers, expected.providers);
  const models = await get('/v1/models'); assert.equal(models.status, 200);
  assert.ok((await models.json()).data.some(model => model.id === 'anthropic/claude-sonnet-5'));
  assert.deepEqual(f.calls, [], 'no authority calls for warm discovery');
  f.policy.models = []; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const admin = await worker.fetch(new Request('https://fixture/v1/admin/policies/fixture', { method: 'PUT', body: '{}' }), f.env, f.context); await admin.text();
  t.mock.restoreAll();
  const changed = await get('/v1/models'); assert.equal(changed.status, 200);
  assert.ok(!(await changed.json()).data.some(model => model.id === 'anthropic/claude-sonnet-5'), 'a policy change is a new inventory');
});

test('a legacy routing projection repairs itself after one fallback request', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  f.authority.sql.exec('UPDATE upstream_grant_projections SET legacy = 1, projection_json = NULL WHERE grant_key = ?', keyA);
  t.mock.method(globalThis, 'fetch', async () => ok());
  f.reset();
  assert.equal((await f.send()).response.status, 200);
  assert.ok(f.calls.includes('/grant-pools/select'), 'the legacy row took the read-and-select path');
  const row = [...f.authority.sql.exec('SELECT legacy, projection_json FROM upstream_grant_projections WHERE grant_key = ?', keyA)][0];
  assert.equal(row.legacy, 0, 'owner republished the projection'); assert.ok(row.projection_json);
  await f.send();
  f.reset();
  const warm = await f.send();
  assert.equal(warm.response.status, 200);
  assert.match(warm.response.headers.get('server-timing'), /cr-cache;desc=hit/);
  assert.ok(!f.calls.includes('/admission/resolve') && !f.calls.includes('/grant-pools/select'), f.calls.join());
});

test('projection repair is throttled per grant and off when the hot cache is disabled', async t => {
  for (const env of [{}, { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }]) {
    const f = await fixture(env); await f.put(keyA, grant());
    const legacy = () => f.authority.sql.exec('UPDATE upstream_grant_projections SET legacy = 1, projection_json = NULL WHERE grant_key = ?', keyA);
    legacy();
    t.mock.method(globalThis, 'fetch', async () => ok());
    await f.send();
    legacy(); f.reset();
    await f.send();
    const repaired = [...f.authority.sql.exec('SELECT legacy FROM upstream_grant_projections WHERE grant_key = ?', keyA)][0].legacy === 0;
    assert.equal(repaired, false, env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS ? 'no repair with the cache disabled' : 'second fallback within the interval does not repair again');
    t.mock.restoreAll();
  }
});

test('a cold admission miss overlaps the remembered grant credential load and reuses it once', async t => {
  const time = clock();
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  const warm = await f.send();
  assert.match(warm.response.headers.get('server-timing'), /cr-credential;dur=[\d.]+;desc=miss/);
  assert.match((await f.send()).response.headers.get('server-timing'), /cr-credential;dur=[\d.]+;desc=hit/);
  time.advance(61_000); // both the admission snapshot and the credential entry expire
  const release = Promise.withResolvers(), events = [];
  const base = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = base(id); return { async fetch(url, init) { if (new URL(url).pathname === '/admission/resolve') { events.push('admission:start'); await release.promise; events.push('admission:end'); } return stub.fetch(url, init); } }; };
  const ownerGet = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = ownerGet(id); return { fetch(...args) { events.push('owner'); return stub.fetch(...args); } }; };
  f.reset();
  const pending = f.request();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([...events].sort(), ['admission:start', 'owner'], 'owner load runs while admission is still pending');
  release.resolve();
  const response = await pending; await response.text(); await Promise.all(f.pending);
  assert.equal(response.status, 200);
  assert.equal(events.filter(event => event === 'owner').length, 1, 'the real lookup joins the prefetch');
  // The prefetch either finished before the lookup (hit, 0 wait) or was joined in flight (miss).
  assert.match(response.headers.get('server-timing'), /cr-cache;desc=miss.*cr-credential;dur=[\d.]+;desc=(hit|miss)/);
});

test('a wrong secret never starts a remembered credential load', async t => {
  const time = clock();
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send();
  time.advance(61_000);
  f.reset();
  const { response } = await f.send({ ...admissionHeaders, authorization: 'Bearer clawrouter-live-fixture-not-the-secret' });
  assert.equal(response.status, 401);
  assert.equal(f.ownerCalls, 0);
});

function fakeColo(t) {
  const entries = new Map(), stats = { puts: 0, matches: 0, hits: 0 };
  const cache = {
    async match(url) { stats.matches++; const body = entries.get(String(url)); if (body) stats.hits++; return body ? new Response(body) : undefined; },
    async put(url, response) { stats.puts++; entries.set(String(url), await response.text()); },
  };
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  t.after(() => { globalThis.caches = previous; });
  return { entries, stats };
}
// Another isolate in the same location: empty local caches, shared colo layer intact.
const otherIsolate = async () => { const { clearHotCaches } = await import('../hot-cache.ts'); clearHotCaches(); };

test('a cold isolate adopts a fresh colo snapshot instead of calling the authority', async t => {
  clock();
  const colo = fakeColo(t);
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send();
  assert.equal(colo.stats.puts, 1, 'the authority result is published once');
  assert.ok(![...colo.entries.values()].join('').includes('synthetic-token'), 'no credential material in the colo layer');
  await otherIsolate(); f.reset();
  const { response } = await f.send();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('server-timing'), /cr-cache;desc=colo/);
  assert.ok(!f.calls.includes('/admission/resolve'), f.calls.join());
});

test('colo snapshots expire by their original fetch time and never admit a different secret', async t => {
  const time = clock();
  fakeColo(t);
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send();
  await otherIsolate(); f.reset();
  const wrong = await f.send({ ...admissionHeaders, authorization: 'Bearer clawrouter-live-fixture-not-the-secret' });
  assert.equal(wrong.response.status, 401);
  assert.deepEqual(f.calls, ['/admission/resolve'], 'a secret mismatch goes to the authority');
  time.advance(60_000);
  await otherIsolate(); f.reset();
  const late = await f.send();
  assert.equal(late.response.status, 200);
  assert.match(late.response.headers.get('server-timing'), /cr-cache;desc=miss/, 'past the max age the colo entry is ignored');
});

test('a mutation served by this isolate ignores older colo snapshots', async t => {
  clock();
  fakeColo(t);
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send();
  f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const admin = await worker.fetch(new Request('https://fixture/v1/admin/policies/fixture', { method: 'PUT', body: '{}' }), f.env, f.context);
  await admin.text();
  assert.equal((await f.send()).response.status, 403, 'the pre-mutation colo snapshot is not adopted here');
});

test('the colo layer is unused when the hot cache is disabled', async t => {
  const colo = fakeColo(t);
  const f = await fixture({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send(); await f.send();
  assert.deepEqual(colo.stats, { puts: 0, matches: 0, hits: 0 });
});

test('a burst of cold requests for one key shares a single authority admission', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  f.reset();
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.request()));
  const states = responses.map(response => response.headers.get('server-timing').match(/cr-cache;desc=(\w+)/)[1]);
  for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
  await Promise.all(f.pending);
  assert.equal(f.calls.filter(path => path === '/admission/resolve').length, 1, f.calls.join());
  assert.deepEqual(states.sort(), ['joined', 'joined', 'joined', 'joined', 'miss']);
  const counts = [...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')];
  assert.equal(counts[0].selected_count, 5, 'every joined request still records its selection');
});

test('a wrong secret joining a burst is rejected without disturbing the others', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  const wrong = { ...admissionHeaders, authorization: 'Bearer clawrouter-live-fixture-not-the-secret' };
  const [good, bad, also] = await Promise.all([f.request(), f.request(wrong), f.request()]);
  assert.deepEqual([good.status, bad.status, also.status], [200, 401, 200]);
  await Promise.all([good.text(), bad.text(), also.text()]); await Promise.all(f.pending);
});
