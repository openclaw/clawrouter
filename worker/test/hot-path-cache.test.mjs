import { accessBytesResponse } from "./access-byte-fixture.mjs";
import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { sqlBudgetNamespace } from './sql-budget-namespace.mjs';
import { usageEnv, proxyKey } from './usage-budget-fixture.mjs';
import { putGrantCredentials, revokeGrantCredentials } from '../grant-credentials.ts';
import { resolveGrantSelection } from '../grant-selection.ts';
import { HotCache, hotCacheConfig, hotCacheNow, pendingBackgroundWork, setHotCacheClock, tryRunInBackground, backgroundMark, clearHotCaches, BACKGROUND_WORK_LIMIT, BACKGROUND_WORK_BOUND_MS, DRAIN_BOUND_MS } from '../hot-cache.ts';
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

test('shared subscription snapshots reuse the original owner and observe source revocation by max age', async t => {
  const time = clock(), f = await fixture(), sharedKey = 'oauth/source/contributor';
  await f.put(sharedKey, grant({ accessToken: 'synthetic-shared-token' }));
  f.policy.grantRouting = normalizePolicy({ providers: ['anthropic'], grantRouting: { sharedGrants: { anthropic: [sharedKey] } } }, undefined, false).grantRouting;
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-shared-token'); return ok();
  });
  assert.equal((await f.send()).response.status, 200);
  f.reset();
  assert.equal((await f.send()).response.status, 200);
  assert.equal(f.ownerCalls, 0, 'shared membership does not add a foreground owner lookup');
  assert.deepEqual(f.calls, ['/grant-pools/record']);
  assert.deepEqual([...f.env.GRANT_CREDENTIALS.objects.keys()], [sharedKey]);
  await revokeGrantCredentials(f.env, sharedKey);
  time.advance(60_001);
  const denied = await f.send();
  assert.equal(denied.response.status, 503, denied.body);
  assert.equal(calls, 2, 'a revoked shared owner cannot turn into environment fallback');
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

// Every synthetic root is owned and released by its test, including failed paths.
function heldRegistrations(t, count = BACKGROUND_WORK_LIMIT) {
  const roots = [];
  t.after(async () => { for (const root of roots) root.resolve(); await Promise.all(roots.map(root => root.promise.then(() => {}, () => {}))); });
  for (let i = 0; i < count; i++) {
    const root = Promise.withResolvers(); roots.push(root);
    assert.equal(tryRunInBackground(() => root.promise), true);
  }
  return { roots, async release() { for (const root of roots) root.resolve(); await Promise.all(roots.map(root => root.promise.then(() => {}, () => {}))); } };
}

test('facade timers survive wall-clock rollback without releasing actual registrations', async t => {
  let elapsed = 0, wall = 100_000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(Date, 'now', () => wall);
  const held = heldRegistrations(t);
  let starts = 0, finished = false;
  const pending = pendingBackgroundWork(); assert.ok(pending);
  pending.then(() => { finished = true; });
  wall = -1_000_000; clearHotCaches();
  elapsed = DRAIN_BOUND_MS - 1; t.mock.timers.tick(DRAIN_BOUND_MS - 1); await Promise.resolve();
  assert.equal(finished, false);
  elapsed++; t.mock.timers.tick(1); await pending;
  assert.equal(finished, true, 'the ORIGINAL hard timer, not Date.now, bounds this facade');
  assert.equal(tryRunInBackground(() => { starts++; }), false);
  const inspections = performance.now.mock.callCount();
  elapsed = BACKGROUND_WORK_BOUND_MS; t.mock.timers.tick(BACKGROUND_WORK_BOUND_MS - DRAIN_BOUND_MS);
  assert.equal(performance.now.mock.callCount(), inspections, 'completed facade cleared its polling timer');
  const aged = pendingBackgroundWork(); assert.ok(aged); await aged;
  assert.equal(tryRunInBackground(() => { starts++; }), false, '25s visibility expiry does not retire actual work');
  assert.equal(starts, 0);
  await held.release();
  assert.equal(pendingBackgroundWork(), null);
  assert.equal(tryRunInBackground(() => { starts++; }), true); await Promise.resolve();
  assert.equal(starts, 1);
});

test('registration reserves before reentrant start and observes sync throw, undefined and rejection once', async t => {
  const held = heldRegistrations(t, BACKGROUND_WORK_LIMIT - 1);
  let invoked = 0;
  assert.equal(tryRunInBackground(() => {
    assert.equal(tryRunInBackground(() => { invoked++; }), false);
    throw undefined;
  }), true, 'accepted is not successful');
  assert.equal(tryRunInBackground(() => undefined), true);
  assert.equal(tryRunInBackground(() => { invoked++; }), false, 'undefined still has an actual settlement turn');
  await Promise.resolve();
  const rejected = Promise.withResolvers();
  assert.equal(tryRunInBackground(() => rejected.promise), true);
  rejected.reject(undefined); rejected.resolve('ignored'); await Promise.resolve();
  assert.equal(tryRunInBackground(() => { invoked++; }), true); await Promise.resolve();
  assert.equal(invoked, 1);
  await held.release(); assert.equal(pendingBackgroundWork(), null);
});

test('overflow skips stale refresh and preserves age, expiry and foreground loading', async t => {
  const time = clock(), config = hotCacheConfig({}), cache = new HotCache(4);
  cache.set('age', 'old', config); cache.set('expiry', 'short', config, hotCacheNow() + 15_000);
  const held = heldRegistrations(t); let loads = 0;
  const loader = async () => ({ value: ++loads, cacheable: true });
  time.advance(10_001);
  assert.deepEqual(await cache.get('age', config, loader), { value: 'old', state: 'stale' });
  assert.equal(cache.publication('age'), undefined); assert.equal(loads, 0);
  assert.deepEqual(await cache.get('foreground', config, loader), { value: 1, state: 'miss' });
  time.advance(5_000); assert.equal(cache.peek('expiry', config), undefined);
  time.advance(45_000); assert.equal(cache.peek('age', config), undefined, 'denied refresh did not renew original age');
  await held.release();
});

test('overflow performs no speculative materialization or colo hash, serialization, response or put', async t => {
  const { prefetchGrantCredentials } = await import('../credential-cache.ts');
  const { coloPut } = await import('../colo-cache.ts');
  const colo = fakeColo(t), held = heldRegistrations(t);
  let materializations = 0, hashes = 0, serializations = 0, responses = 0;
  const digest = crypto.subtle.digest.bind(crypto.subtle), OriginalResponse = Response;
  t.mock.method(crypto.subtle, 'digest', (...args) => { hashes++; return digest(...args); });
  globalThis.Response = class extends OriginalResponse { constructor(...args) { responses++; super(...args); } };
  t.after(() => { globalThis.Response = OriginalResponse; });
  prefetchGrantCredentials({}, keyA, grant(), async () => { materializations++; return grant(); });
  coloPut('fixture', 'overflow', { toJSON() { serializations++; return {}; } }, hotCacheNow(), hotCacheConfig({}));
  await Promise.resolve();
  assert.deepEqual([materializations, hashes, serializations, responses, colo.stats.puts], [0, 0, 0, 0, 0]);
  await held.release();
});

test('denied repair does not consume its cooldown; a later eligible request repairs once', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  const legacy = () => f.authority.sql.exec('UPDATE upstream_grant_projections SET legacy = 1, projection_json = NULL WHERE grant_key = ?', keyA);
  const isLegacy = () => [...f.authority.sql.exec('SELECT legacy FROM upstream_grant_projections WHERE grant_key = ?', keyA)][0].legacy;
  legacy(); const held = heldRegistrations(t);
  t.mock.method(globalThis, 'fetch', async () => ok());
  assert.equal((await f.send()).response.status, 200); assert.equal(isLegacy(), 1);
  await held.release();
  assert.equal((await f.send()).response.status, 200); assert.equal(isLegacy(), 0);
  legacy(); assert.equal((await f.send()).response.status, 200); assert.equal(isLegacy(), 1, 'accepted repair consumed cooldown');
});

test('an accepted failed repair keeps its cooldown', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  f.authority.sql.exec('UPDATE upstream_grant_projections SET legacy = 1, projection_json = NULL WHERE grant_key = ?', keyA);
  const get = f.env.GRANT_CREDENTIALS.get; let repairs = 0;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(input, init) {
    if (new URL(input).pathname === '/reconcile') { repairs++; throw undefined; }
    return stub.fetch(input, init);
  } }; };
  t.mock.method(globalThis, 'fetch', async () => ok());
  assert.equal((await f.send()).response.status, 200); assert.equal(repairs, 1);
  assert.equal((await f.send()).response.status, 200); assert.equal(repairs, 1);
});

test('overflow creates no flush timer and retains coalesced counters and local feedback for a later flush', async t => {
  const { queueGrantRuntime, flushSelections, setCoalesceWindowMs } = await import('../admission-cache.ts');
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send(); f.reset();
  const held = heldRegistrations(t); let timers = 0;
  setCoalesceWindowMs(431); t.after(() => setCoalesceWindowMs(0));
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { if (args[1] === 431) timers++; return timer(...args); });
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  const state = { status: 'cooldown', observedAt: new Date().toISOString(), source: 'provider_response', lastSignal: 'rate_limited', cooldownUntil: new Date(Date.now() + 60_000).toISOString(), grantRevision: null, windows: [] };
  queueGrantRuntime(f.env, keyA, state);
  assert.equal(timers, 0, 'denied schedule creates no timer');
  assert.equal(f.calls.includes('/grant-pools/record'), false); assert.equal(f.calls.includes('/grant-pools/feedback'), false);
  await held.release();
  setCoalesceWindowMs(0); queueGrantRuntime(f.env, keyA, state); await pendingBackgroundWork();
  assert.equal(f.calls.filter(path => path === '/grant-pools/record').length, 1);
  assert.equal(f.calls.filter(path => path === '/grant-pools/feedback').length, 1);
  assert.equal([...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')][0].selected_count, 2);
  f.reset(); await flushSelections(f.env); assert.deepEqual(f.calls, [], 'attempted additive counts are not replayed');
});

test('synchronous timer failure retains unstarted feedback and an old schedule cannot clear its successor', async t => {
  const { queueGrantRuntime, flushSelections, setCoalesceWindowMs } = await import('../admission-cache.ts');
  const f = await fixture(); await f.put(keyA, grant());
  const state = { status: 'available', observedAt: new Date().toISOString(), source: 'provider_response', lastSignal: 'quota', cooldownUntil: null, grantRevision: null, windows: [] };
  const timers = [], originalTimer = globalThis.setTimeout; let fail = true;
  setCoalesceWindowMs(431); t.after(() => setCoalesceWindowMs(0));
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 431) return originalTimer(callback, ms, ...args);
    if (fail) { fail = false; throw undefined; }
    timers.push(callback); return { fixtureTimer: timers.length };
  });
  t.after(async () => { for (const callback of timers) callback(); await flushSelections(f.env); await pendingBackgroundWork(); });
  queueGrantRuntime(f.env, keyA, state); await pendingBackgroundWork();
  assert.equal(f.calls.includes('/grant-pools/feedback'), false);
  queueGrantRuntime(f.env, keyA, state); assert.equal(timers.length, 1);
  await flushSelections(f.env); // Invalidates the still-unstarted first schedule.
  queueGrantRuntime(f.env, keyA, { ...state, observedAt: new Date(Date.now() + 1).toISOString() });
  assert.equal(timers.length, 2);
  timers[0](); for (let i = 0; i < 4; i++) await Promise.resolve();
  queueGrantRuntime(f.env, keyA, { ...state, observedAt: new Date(Date.now() + 2).toISOString() });
  assert.equal(timers.length, 2, 'old finally did not clear the newer schedule');
  timers[1](); await pendingBackgroundWork();
  assert.equal(f.calls.filter(path => path === '/grant-pools/feedback').length, 2);
});

test('a settling flush cannot delete newer feedback retained while registration is full', async t => {
  const { queueGrantRuntime, flushSelections } = await import('../admission-cache.ts');
  const f = await fixture(); await f.put(keyA, grant());
  const held = heldRegistrations(t, 63), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await held.release(); await pendingBackgroundWork(); await flushSelections(f.env); });
  const get = f.env.ACCESS_CONTROL.get, observations = [];
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(input, init) {
    try {
      if (new URL(input).pathname !== '/grant-pools/feedback') return await stub.fetch(input, init);
      observations.push(JSON.parse(init.body).state.observedAt);
      const response = await stub.fetch(input, init); if (observations.length === 1) { entered.resolve(); await release.promise; } return response;
    }
    catch (error) { entered.reject(error); throw error; }
  } }; };
    const old = { status: 'available', observedAt: new Date().toISOString(), source: 'provider_response', lastSignal: 'quota', cooldownUntil: null, grantRevision: null, windows: [] };
  const newer = { ...old, observedAt: new Date(Date.now() + 1).toISOString() };
  const mark = backgroundMark(); queueGrantRuntime(f.env, keyA, old);
  const arrivalFacade = pendingBackgroundWork(mark); assert.ok(arrivalFacade, 'scheduled flush must register a cohort');
  await cacheBarrierArrival(entered.promise, arrivalFacade, 'registered feedback');
  queueGrantRuntime(f.env, keyA, newer);
  assert.equal(tryRunInBackground(() => assert.fail('overflow start')), false);
  release.resolve(); await pendingBackgroundWork(mark);
  assert.equal(pendingBackgroundWork(mark), null, 'original flush actually settled');
  await flushSelections(f.env);
  assert.deepEqual(observations, [old.observedAt, newer.observedAt]);
  await held.release();
});

test('cache-disabled feedback remains foreground even when background admission is full', async t => {
  const { queueGrantRuntime } = await import('../admission-cache.ts');
  const f = await fixture({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }); await f.put(keyA, grant()); f.reset();
  const held = heldRegistrations(t);
  const actual = queueGrantRuntime(f.env, keyA, { status: 'available', observedAt: new Date().toISOString(), source: 'provider_response', lastSignal: 'quota', cooldownUntil: null, grantRevision: null, windows: [] });
  assert.ok(actual); await actual;
  assert.equal(f.calls.filter(path => path === '/grant-pools/feedback').length, 1);
  await held.release();
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

test('a cold admission miss overlaps the remembered grant credential load and reuses it once', { timeout: 5_000 }, async t => {
  const time = clock();
  const f = await fixture(); await f.put(keyA, grant());
  t.mock.method(globalThis, 'fetch', async () => ok());
  const warm = await f.send();
  assert.match(warm.response.headers.get('server-timing'), /cr-credential;dur=[\d.]+;desc=miss/);
  assert.match((await f.send()).response.headers.get('server-timing'), /cr-credential;dur=[\d.]+;desc=hit/);
  time.advance(61_000); // both the admission snapshot and the credential entry expire
  const release = Promise.withResolvers(), admissionEntered = Promise.withResolvers(), ownerEntered = Promise.withResolvers(), events = [];
  const base = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = base(id); return { async fetch(url, init) { if (new URL(url).pathname === '/admission/resolve') { events.push('admission:start'); admissionEntered.resolve(); await release.promise; events.push('admission:end'); } return stub.fetch(url, init); } }; };
  const ownerGet = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = ownerGet(id); return { fetch(...args) { events.push('owner'); ownerEntered.resolve(); return stub.fetch(...args); } }; };
  f.reset();
  const pending = f.request();
  await Promise.all([admissionEntered.promise, ownerEntered.promise]);
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
    async match(url) { stats.matches++; const body = entries.get(String(url)); if (body) stats.hits++; return body ? String(url).split("/")[4] === "admission" ? accessBytesResponse(body, "") : new Response(body) : undefined; },
    async put(url, response) { stats.puts++; const namespace = String(url).split('/')[4]; byNamespace[namespace] = (byNamespace[namespace] ?? 0) + 1; entries.set(String(url), await response.text()); },
  };
  const byNamespace = {};
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  t.after(() => { globalThis.caches = previous; });
  return { entries, stats, byNamespace };
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

test('a cold isolate adopts a sibling\'s rendered discovery body per variant, keeping its fetch time', async t => {
  const time = clock();
  const colo = fakeColo(t);
  const f = await fixture(); await f.put(keyA, grant());
  const get = (path, headers = {}) => worker.fetch(new Request(`https://fixture${path}`, { headers: { ...admissionHeaders, ...headers } }), f.env, f.context);
  const catalog = await (await get('/v1/catalog')).json(); await Promise.all(f.pending);
  const models = await (await get('/v1/models')).json(); await Promise.all(f.pending);
  assert.ok(![...colo.entries.values()].join('').includes('synthetic-token'), 'no credential material in shared bodies');
  await otherIsolate(); f.reset();
  t.mock.method(f.env.POLICY_KV, 'get', () => { throw new Error('an adopted discovery body must not rebuild the inventory'); });
  assert.deepEqual(await (await get('/v1/catalog')).json(), catalog);
  assert.deepEqual(await (await get('/v1/models')).json(), models, 'variants are shared separately');
  assert.deepEqual(f.calls.filter(call => call !== '/admission/resolve'), [], 'no inventory reads for adopted bodies');
  assert.equal((await get('/v1/catalog', { authorization: 'Bearer clawrouter-live-fixture-not-the-secret' })).status, 401, 'adoption never skips authentication');
  t.mock.restoreAll();
  const anthropic = await (await get('/v1/models', { 'anthropic-version': '2023-06-01' })).json(); await Promise.all(f.pending);
  assert.ok(Array.isArray(anthropic.data) && !('object' in anthropic), 'the Anthropic variant is rendered, not adopted from the OpenAI body');
  time.advance(60_000);
  await otherIsolate();
  const published = colo.byNamespace.discovery;
  assert.equal((await get('/v1/catalog')).status, 200); await Promise.all(f.pending);
  assert.equal(colo.byNamespace.discovery, published + 1, 'past the max age the shared body is ignored and reloaded');
});

test('discovery publishes only from the request that loaded and never with the hot cache off', async t => {
  const colo = fakeColo(t);
  const f = await fixture(); await f.put(keyA, grant());
  const get = () => worker.fetch(new Request('https://fixture/v1/catalog', { headers: admissionHeaders }), f.env, f.context);
  const responses = await Promise.all([get(), get(), get()]); await Promise.all(responses.map(response => response.text())); await Promise.all(f.pending);
  assert.equal(colo.byNamespace.discovery, 1, 'one catalog publication for a burst');
  const off = fakeColo(t);
  const g = await fixture({ CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0' }); await g.put(keyA, grant());
  await (await worker.fetch(new Request('https://fixture/v1/catalog', { headers: admissionHeaders }), g.env, g.context)).text();
  assert.deepEqual(off.stats, { puts: 0, matches: 0, hits: 0 });
});

test('a cold burst still coalesces while the leader reads a slow colo layer', { timeout: 5_000 }, async t => {
  const colo = fakeColo(t), match = globalThis.caches.default.match;
  const f = await fixture(); await f.put(keyA, grant());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let matches = 0;
  globalThis.caches.default.match = async url => { matches++; entered.resolve(); await release.promise; return match(url); };
  t.mock.method(globalThis, 'fetch', async () => ok());
  f.reset();
  const pending = Promise.all(Array.from({ length: 5 }, () => f.request()));
  await entered.promise;
  assert.equal(matches, 1, 'the leader owns the held colo read');
  release.resolve();
  const responses = await pending;
  for (const response of responses) { assert.equal(response.status, 200); await response.text(); }
  await Promise.all(f.pending);
  assert.equal(f.calls.filter(path => path === '/admission/resolve').length, 1, f.calls.join());
  assert.equal(colo.stats.matches, 1, 'followers wait for the leader instead of each reading the colo layer');
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

test('a concurrent load waits for the shared entry instead of awaiting another request\'s promise', async () => {
  clock();
  const config = hotCacheConfig({}), cache = new HotCache(8);
  const gate = Promise.withResolvers();
  let loads = 0;
  const leaderLoader = async () => { loads++; await gate.promise; return { value: 'leader', cacheable: true }; };
  const followerLoader = async () => { loads++; return { value: 'follower', cacheable: true }; };
  const leader = cache.load('k', config, leaderLoader);
  const follower = cache.load('k', config, followerLoader);
  gate.resolve();
  assert.deepEqual((await leader).value, 'leader');
  assert.deepEqual((await follower).value, 'leader', 'the follower adopts the stored entry');
  assert.equal(loads, 1, 'only one load ran');
  const failing = cache.load('f', config, async () => { loads++; return { value: 'denied', cacheable: false }; });
  const retry = cache.load('f', config, async () => { loads++; return { value: 'second', cacheable: true }; });
  assert.equal((await failing).value, 'denied');
  assert.equal((await retry).value, 'second', 'an uncacheable leader result sends the follower to its own load');
});

test('a facade polls a snapshot sequence cohort including interleaved registrations on its own timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const earlier = heldRegistrations(t, 1);
  const mark = backgroundMark();
  assert.equal(pendingBackgroundWork(mark), null, 'the sequence boundary excludes earlier work');
  const interleaved = heldRegistrations(t, 1); // Not necessarily this request's work.
  const drain = pendingBackgroundWork(mark);
  assert.ok(drain);
  const later = heldRegistrations(t, 1); // After snapshot: not part of this facade.
  let finished = false; drain.then(() => { finished = true; });
  t.mock.timers.tick(1); await Promise.resolve();
  assert.equal(finished, false);
  await interleaved.release(); t.mock.timers.tick(2); await drain;
  assert.equal(finished, true, 'snapshot completion does not join the earlier or later roots');
  await earlier.release(); await later.release();
});

// Register release/drain before starting an operation. Node reports an original
// assertion and any cleanup-hook failure separately; neither is suppressed.
function ownCacheBarrier(t, release, fixture) {
  const work = [];
  t.after(async () => {
    release.resolve();
    const errors = [];
    for (const result of await Promise.allSettled(work)) {
      if (result.status === 'rejected') errors.push(result.reason);
      else if (result.value instanceof Response && !result.value.bodyUsed) {
        try { await result.value.arrayBuffer(); } catch (error) { errors.push(error); }
      }
    }
    for (const result of await Promise.allSettled(fixture.pending)) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, 'cache barrier client/background cleanup failed');
  });
  return start => { const pending = Promise.resolve().then(start); work.push(pending); return pending; };
}
async function cacheBarrierArrival(arrival, originating, phase) {
  let timer;
  const bound = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`expected ${phase} barrier did not arrive`)), 2000); });
  // A colo put belongs to background publication and can start after foreground
  // completion. A foreground barrier cannot: completion there is a fixture error.
  const terminal = originating.then(() => phase === 'background colo put'
    ? new Promise(() => {}) : Promise.reject(new Error(`request completed before ${phase} barrier`)));
  try { await Promise.race([arrival, terminal, bound]); }
  finally { clearTimeout(timer); }
}

for (const clockShift of [0, -120_000]) test(`a new admission owner publishes at the original fenced clock (${clockShift})`, async t => {
  const time = clock(), colo = fakeColo(t), f = await fixture(); await f.put(keyA, grant());
  const { clearHotCaches, fenceSharedHotCache, sharedHotCacheFence } = await import('../hot-cache.ts');
  t.mock.method(globalThis, 'fetch', async () => ok());
  clearHotCaches(); fenceSharedHotCache(); time.advance(clockShift);
  const acquiredAt = hotCacheNow(); assert.ok(acquiredAt <= sharedHotCacheFence());
  assert.equal((await f.send()).response.status, 200);
  assert.equal(colo.stats.puts, 1, 'current publication identity may write after invalidation');
  assert.equal(JSON.parse([...colo.entries.values()][0]).fetchedAt, acquiredAt, 'no timestamp renewal');
  clearHotCaches(); f.reset();
  assert.equal((await f.send()).response.status, 200);
  assert.equal(colo.stats.hits, 1, 'the shared response is physically read');
  assert.equal(f.calls.filter(path => path === '/admission/resolve').length, 1, 'fenced timestamp still denies adoption');
});

for (const clockShift of [0, -120_000]) test(`a late admission cannot republish hints or colo after invalidation (clock ${clockShift})`, async t => {
  const time = clock(), colo = fakeColo(t), f = await fixture(); await f.put(keyA, grant());
  const { clearHotCaches, fenceSharedHotCache } = await import('../hot-cache.ts');
  t.mock.method(globalThis, 'fetch', async () => ok());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const get = f.env.ACCESS_CONTROL.get; let first = true;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { async fetch(url, init) {
    const response = await stub.fetch(url, init);
    if (new URL(url).pathname === '/admission/resolve' && first) { first = false; entered.resolve(); await release.promise; }
    return response;
  } }; };
  const start = ownCacheBarrier(t, release, f), old = start(() => f.request());
  try {
    await cacheBarrierArrival(entered.promise, old, 'foreground admission');
    time.advance(clockShift); clearHotCaches(); fenceSharedHotCache();
    f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
    assert.equal((await f.request()).status, 403, 'new request progresses without old I/O');
  } finally { release.resolve(); }
  await (await old).text(); await Promise.all(f.pending);
  assert.equal(colo.stats.puts, 0, 'invalidated completion cannot start a shared publication');
  time.advance(61_000); f.reset();
  assert.equal((await f.send()).response.status, 403);
  assert.equal(f.ownerCalls, 0, 'old completion cannot recreate the remembered credential hint');
});

test('already-issued late colo put retains acquisition time across equal/rollback invalidation', async t => {
  const time = clock(), colo = fakeColo(t), f = await fixture(); await f.put(keyA, grant());
  const { clearHotCaches, fenceSharedHotCache, sharedHotCacheFence } = await import('../hot-cache.ts');
  t.mock.method(globalThis, 'fetch', async () => ok());
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), put = globalThis.caches.default.put;
  let fetchedAt;
  globalThis.caches.default.put = async (url, response) => {
    const text = await response.text(); fetchedAt = JSON.parse(text).fetchedAt; entered.resolve(); await release.promise;
    return put(url, new Response(text));
  };
  const start = ownCacheBarrier(t, release, f), originating = start(() => f.request());
  const response = await originating; await response.text();
  try {
    await cacheBarrierArrival(entered.promise, originating, 'background colo put'); time.advance(-120_000); clearHotCaches(); fenceSharedHotCache();
    assert.ok(fetchedAt <= sharedHotCacheFence());
    f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  } finally { release.resolve(); }
  await Promise.all(f.pending);
  assert.equal(colo.stats.puts, 1, 'the original physical put really completes late');
  f.reset(); assert.equal((await f.send()).response.status, 403);
  assert.equal(f.calls.filter(path => path === '/admission/resolve').length, 1, 'late entry is fenced, not adopted');
});

test('invalidation during a held colo read prevents adoption and drains coalesced writes normally', async t => {
  const time = clock(), colo = fakeColo(t), f = await fixture(); await f.put(keyA, grant());
  const { clearHotCaches, fenceSharedHotCache } = await import('../hot-cache.ts');
  t.mock.method(globalThis, 'fetch', async () => ok());
  await f.send(); clearHotCaches();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), match = globalThis.caches.default.match;
  globalThis.caches.default.match = async url => { const response = await match(url); entered.resolve(); await release.promise; return response; };
  const start = ownCacheBarrier(t, release, f), pending = start(() => f.request());
  try {
    await cacheBarrierArrival(entered.promise, pending, 'foreground colo read'); time.advance(1); clearHotCaches(); fenceSharedHotCache();
    f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  } finally { release.resolve(); }
  const response = await pending; assert.equal(response.status, 403); await response.text(); await Promise.all(f.pending);
  assert.ok(colo.stats.hits > 0, 'a REAL cached response was held before invalidation');
  const rows = [...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')];
  assert.equal(rows[0].selected_count, 1, 'the earlier successful selection write was not discarded');
});

test('cache invalidation preserves pending runtime, selection and cursor writes', async t => {
  const f = await fixture();await f.put(keyA, grant());await f.put(keyB, grant());
  f.policy.grantRouting = { strategy: 'round_robin', stickiness: 'none' };await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const { clearHotCaches, fenceSharedHotCache } = await import('../hot-cache.ts');
  const { flushSelections } = await import('../admission-cache.ts');
  const roots = [], waitUntil = f.context.waitUntil.bind(f.context);
  f.context.waitUntil = promise => {
    // Observe every original immediately; undefined rejection is still failure.
    roots.push(Promise.resolve(promise).then(() => ({ failed: false }), reason => ({ failed: true, reason })));
    waitUntil(promise);
  };
  const join = () => Promise.all(roots); // All observers fulfill, so no first-rejection exit.
  let retirementChecked = false;
  t.after(async () => {
    const outcomes = await join(), failures = outcomes.filter(outcome => outcome.failed).map(outcome => outcome.reason);
    if (!retirementChecked) {
      try { assert.equal(pendingBackgroundWork(), null, 'actual registrations retired, not merely their facades'); }
      catch (error) { failures.push(error); }
    }
    // Node retains the original assertion/rejection (including undefined) and
    // reports this independent cleanup-hook failure separately.
    if (failures.length) throw new AggregateError(failures, 'original background cleanup failed');
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }, { headers: {
    'anthropic-ratelimit-unified-5h-utilization': '0.25',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
  } }));
  await (await f.request()).text();await (await f.request()).text();
  clearHotCaches();fenceSharedHotCache();await flushSelections(f.env);
  await join();
  retirementChecked = true;
  assert.equal(pendingBackgroundWork(), null, 'actual registrations retired, not merely their facades');
  const rows = [...f.authority.sql.exec('SELECT selected_count FROM upstream_grant_selection')];
  assert.equal(rows.reduce((sum, row) => sum + row.selected_count, 0), 2);
  assert.ok(f.calls.includes('/grant-pools/feedback'));
  assert.ok(f.calls.includes('/grant-pools/record'));
});
