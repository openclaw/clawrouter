import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { putGrantCredentials, revokeGrantCredentials, materializeGrantCredentials } from '../grant-credentials.ts';
import { resolveGrantSelection } from '../grant-selection.ts';
import { providerById } from '../providers.ts';
import { sha256Hex } from '../utils.ts';
const { default: worker } = await import('../index.ts');
const provider = providerById('anthropic');
const endpoint = provider.endpoints.find(item => item.id === 'messages');
const model = 'claude-sonnet-5';
const selection = { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model, catalogModelId: 'anthropic/claude-sonnet-5', capability: 'llm.chat' };
const keyA = 'oauth/fixture/anthropic', keyB = 'oauth/fixture/backup';
const grant = (extra = {}) => ({ provider: provider.id, kind: 'subscription', enabled: true, accessToken: 'synthetic-token', updatedAt: '2026-01-01T00:00:00Z', ...extra });
async function fixture() {
  const f = await admissionFixture();
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.put = (key, value) => putGrantCredentials(f.env, key, value);
  f.admit = () => f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [{ id: provider.id, tokenRef: provider.id }], selection: f.selection ?? selection });
  f.request = () => worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [] }) }), f.env, f.context);
  return f;
}
const observedAt = new Date().toISOString(), resetAt = new Date(Date.now() + 60_000).toISOString();
function runtime(remaining, extra = {}) {
  return { status: 'available', observedAt, source: 'provider_response', lastSignal: 'quota', cooldownUntil: null, grantRevision: '2026-01-01T00:00:00Z', windows: [{ id: 'week', kind: 'requests', remaining, limit: 100, resetAt }], ...extra };
}

for (const strategy of ['priority', 'round_robin', 'least_used', 'most_remaining', 'threshold', 'weighted_random']) {
  for (const stickiness of ['none', 'identity', 'session']) test(`combined selection parity: ${strategy}/${stickiness}`, async t => {
    const old = await fixture(), combined = await fixture();
    t.mock.method(crypto, 'getRandomValues', array => { array.fill(123456789); return array; });
    const routing = { strategy, stickiness, staleState: 'allow', includedQuotaReservePercent: 10 };
    for (const f of [old, combined]) {
      await f.put(keyA, grant({ weight: 1 })); await f.put(keyB, grant({ weight: 7 }));
      f.policy.grantRouting = routing;
      await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
      await f.call('/grant-pools/feedback', { key: keyA, state: runtime(25) });
      await f.call('/grant-pools/feedback', { key: keyB, state: runtime(90) });
    }
    const normalizedSticky = strategy === 'threshold' ? 'none' : stickiness;
    const hash = normalizedSticky === 'identity' ? await sha256Hex('identity:owner@example.com') : normalizedSticky === 'session' ? await sha256Hex('session:fixture-session') : null;
    combined.selection = { ...selection, sessionHash: await sha256Hex('session:fixture-session') };
    for (let n = 0; n < 4; n++) {
      const expected = await resolveGrantSelection(provider.id, 'fixture', 'fixture', provider.id, old.env, new Set(), routing, hash, true, undefined, { provider, endpoint, mode: 'http', model });
      const actual = (await combined.admit()).selection;
      assert.ok(actual);
      assert.equal(actual.selected?.key, expected.selected?.key);
      assert.equal(actual.hasConfiguredGrant, expected.hasConfiguredGrant);
      assert.deepEqual(actual.selected?.runtimeState, expected.selected?.runtimeState);
    }
    assert.deepEqual((await combined.call('/grant-pools/stats', { keys: [keyA, keyB] })).stats && combined.authority.sql.exec('SELECT grant_key, selected_count FROM upstream_grant_selection ORDER BY grant_key'), old.authority.sql.exec('SELECT grant_key, selected_count FROM upstream_grant_selection ORDER BY grant_key'));
  });
}

for (const scenario of ['priority', 'reserve', 'scoped-exhaustion', 'other-model', 'cooldown', 'stale', 'revision', 'exclusion', 'eligibility', 'environment-fallback']) test(`combined eligibility parity: ${scenario}`, async () => {
  const old = await fixture(), combined = await fixture();
  const routing = { strategy: 'most_remaining', includedQuotaReservePercent: scenario === 'reserve' ? 20 : 0, staleState: scenario === 'stale' ? 'deny' : 'allow', staleAfterSeconds: 300, environmentFallback: scenario === 'environment-fallback', eligibleGrants: scenario === 'eligibility' || scenario === 'environment-fallback' ? { anthropic: [] } : {} };
  for (const f of [old, combined]) {
    await f.put(keyA, grant({ priority: scenario === 'priority' ? 1 : 100 })); await f.put(keyB, grant());
    f.policy.grantRouting = routing; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
    let state = runtime(scenario === 'reserve' ? 10 : 80);
    if (scenario === 'scoped-exhaustion' || scenario === 'other-model') state.windows = [{ ...state.windows[0], remaining: 0, models: [scenario === 'scoped-exhaustion' ? 'sonnet' : 'opus'] }];
    if (scenario === 'cooldown') state = { ...state, status: 'cooldown', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
    if (scenario === 'stale') state.observedAt = '2020-01-01T00:00:00Z';
    if (scenario === 'revision') state = { ...state, grantRevision: 'old-revision', status: 'cooldown', cooldownUntil: new Date(Date.now() + 60_000).toISOString() };
    await f.call('/grant-pools/feedback', { key: keyA, state }); await f.call('/grant-pools/feedback', { key: keyB, state: runtime(50) });
  }
  const exclusions = scenario === 'exclusion' ? [keyA] : [];
  combined.selection = { ...selection, excludedKeys: exclusions };
  const expected = await resolveGrantSelection(provider.id, 'fixture', 'fixture', provider.id, old.env, new Set(exclusions), routing, null, true, undefined, { provider, endpoint, mode: 'http', model });
  const actual = (await combined.admit()).selection;
  assert.ok(actual);
  assert.equal(actual.selected?.key, expected.selected?.key);
  assert.equal(actual.hasConfiguredGrant, expected.hasConfiguredGrant);
});

test('warmed HTTP uses one authority invocation, no KV projection read, and one credential-owner call', async t => {
  const f = await fixture(); await f.put(keyA, grant()); await f.admit();
  let ownerCalls = 0;
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = id => { const stub = get(id); return { fetch(...args) { ownerCalls++; return stub.fetch(...args); } }; };
  t.mock.method(f.env.POLICY_KV, 'get', () => { throw new Error('warm inference must not read KV'); });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
  f.calls.length = 0;
  const response = await f.request(); assert.equal(response.status, 200, await response.clone().text()); await response.text(); await Promise.all(f.pending);
  assert.deepEqual(f.calls, ['/admission/resolve']); assert.equal(ownerCalls, 1);
});

test('failover excludes the failed key through a fresh combined admission', async t => {
  const f = await fixture(); await f.put(keyA, grant()); await f.put(keyB, grant()); await f.admit();
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => { tokens.push(new Headers(init.headers).get('authorization')); return tokens.length === 1 ? new Response('rejected', { status: 401 }) : Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }); });
  f.calls.length = 0; const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(tokens.length, 2); assert.equal(response.headers.get('x-clawrouter-grant-failover'), '1');
  assert.equal(f.calls.filter(path => path === '/admission/resolve').length, 2); assert.ok(!f.calls.includes('/grant-pools/select') && !f.calls.includes('/grant-pools/resolve'));
});

for (const mutation of ['revoke', 'reauth_required', 'disable', 'rotate']) test(`fresh admission/materialization enforces ${mutation}`, async t => {
  const f = await fixture(); f.policy.grantRouting = { eligibleGrants: { anthropic: ["anthropic"] } }; await f.call("/policies/put", { policyId: "fixture", policy: f.policy }); await f.put(keyA, grant()); const before = (await f.admit()).selection.selected;
  let upstreamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { upstreamCalls++; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-rotated'); return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }); });
  if (mutation === 'revoke') await revokeGrantCredentials(f.env, keyA);
  if (mutation === 'disable') { f.policy.enabled = false; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy }); }
  if (mutation === 'rotate') await f.put(keyA, grant({ accessToken: 'synthetic-rotated' }));
  if (mutation === 'reauth_required') {
    const owner = f.env.GRANT_CREDENTIALS.objects.get(keyA);
    const record = owner.values.get('credential'); record.status = 'reauth_required'; record.generation++; record.poolSyncPending = true; owner.values.set('credential', record);
    await owner.object.fetch(new Request('https://fixture/reconcile', { method: 'POST', body: JSON.stringify({ key: keyA }) }));
  }
  const current = await f.admit();
  if (mutation === 'rotate') assert.ok(current.selection.selected.grant.credentialGeneration > before.grant.credentialGeneration);
  else assert.equal(current.selection?.selected ?? null, null);
  const response = await f.request(); await response.text(); await Promise.all(f.pending);
  assert.equal(upstreamCalls, mutation === 'rotate' ? 1 : 0);
});

test('failed revoke publication demonstrates why authority-generation credential caching is unsafe', async () => {
  const f = await fixture(); await f.put(keyA, grant()); await f.admit();
  const original = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = original(id); return { fetch(url, init) { if (new URL(url).pathname === '/grant-pools/publish') throw new Error('synthetic publication outage'); return stub.fetch(url, init); } }; };
  await assert.rejects(() => revokeGrantCredentials(f.env, keyA));
  const stale = (await f.admit()).selection.selected;
  assert.equal(stale.key, keyA); assert.equal(stale.grant.credentialStatus, 'active');
  assert.equal(f.env.GRANT_CREDENTIALS.objects.get(keyA).values.get('credential').accessToken, undefined);
  await assert.rejects(() => materializeGrantCredentials(f.env, keyA, stale.grant, provider.id, provider.auth.refresh, false));
});

for (const [endpointId, mode] of [['responses', 'http'], ['chat_completions', 'http'], ['embeddings', 'http'], ['responses', 'websocket']]) test(`transport parity: OpenAI ${endpointId}/${mode}`, async () => {
  const old = await fixture(), combined = await fixture(), openai = providerById('openai');
  const endpoint = openai.endpoints.find(item => item.id === endpointId);
  for (const f of [old, combined]) {
    f.policy.providers = ['openai']; f.policy.models = null;
    await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
    await f.put('oauth/fixture/sub', grant({ provider: 'openai', accountId: 'synthetic-account', priority: 1 }));
    await f.put('oauth/fixture/api', grant({ provider: 'openai', kind: 'api_key', priority: 100 }));
  }
  const expected = await resolveGrantSelection('openai', 'fixture', 'fixture', 'openai', old.env, new Set(), undefined, null, true, undefined, { provider: openai, endpoint, mode });
  const actual = await combined.call('/admission/resolve', { credentialId: 'fixture', secretSha256: combined.credential.secretSha256, providers: [{ id: 'openai', tokenRef: 'openai' }], selection: { providerId: 'openai', endpointId, mode, capability: `llm.${endpointId}` } });
  assert.equal(actual.selection.selected.key, expected.selected.key);
});

test('legacy projections use the old path until owner publication, without storing secrets', async t => {
  const f = await fixture();
  f.records.set(keyA, grant());
  const first = await f.admit(); assert.equal(first.selection, undefined);
  assert.deepEqual(f.authority.sql.exec('SELECT projection_json, legacy FROM upstream_grant_projections WHERE grant_key = ?', keyA).map(row => ({ ...row })), [{ projection_json: null, legacy: 1 }]);
  let bulkReads = 0; const get = f.env.POLICY_KV.get;
  t.mock.method(f.env.POLICY_KV, 'get', async (...args) => { if (Array.isArray(args[0])) bulkReads++; return get(...args); });
  await f.admit(); assert.equal(bulkReads, 0, 'import marker prevents repeating the legacy import');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
  f.calls.length = 0;
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.ok(f.calls.includes('/grant-pools/select'));
  assert.ok((await f.admit()).selection.selected, 'materialization publishes the migrated owner projection');
  assert.ok(!JSON.stringify(f.authority.sql.exec('SELECT * FROM upstream_grant_projections')).includes('synthetic-token'));
});

test('bounded projection backfill imports current metadata once; null defaults stay fenced', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  f.authority.sql.exec('DELETE FROM upstream_grant_projections');
  let reads = 0; const get = f.env.POLICY_KV.get;
  t.mock.method(f.env.POLICY_KV, 'get', async (...args) => { if (Array.isArray(args[0])) { reads++; assert.ok(args[0].length <= 66); } return get(...args); });
  assert.ok((await f.admit()).selection.selected); assert.equal(reads, 1);
  await f.admit(); assert.equal(reads, 1);
  // A late legacy KV row cannot resurrect a default-key miss after its marker.
  f.records.set('oauth/tenants/fixture/anthropic', grant());
  await f.admit(); assert.equal(reads, 1);
});

for (const change of ['rotate', 'revoke']) test(`owner ${change} during backfill beats a delayed KV read`, async t => {
  const f = await fixture(); await f.put(keyA, grant()); f.authority.sql.exec('DELETE FROM upstream_grant_projections');
  const get = f.env.POLICY_KV.get; let delayed = true;
  t.mock.method(f.env.POLICY_KV, 'get', async (...args) => {
    const stale = await get(...args);
    if (delayed && Array.isArray(args[0])) { delayed = false; if (change === 'rotate') await f.put(keyA, grant({ accessToken: 'synthetic-replacement' })); else await revokeGrantCredentials(f.env, keyA); }
    return stale;
  });
  const admission = await f.admit();
  if (change === 'revoke') assert.equal(admission.selection.selected, null);
  else assert.equal(admission.selection.selected.grant.credentialGeneration, 2);
});

test('policy tenant changes during backfill cannot reuse the previous tenant pool', async t => {
  const f = await fixture(); await f.put('oauth/tenants/fixture/anthropic', grant()); f.authority.sql.exec('DELETE FROM upstream_grant_projections');
  const get = f.env.POLICY_KV.get; let delayed = true;
  t.mock.method(f.env.POLICY_KV, 'get', async (...args) => {
    const value = await get(...args);
    if (delayed && Array.isArray(args[0])) { delayed = false; f.policy.tenantId = 'other'; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy }); }
    return value;
  });
  const admission = await f.admit();
  assert.equal(admission.policy.policy.tenantId, 'other'); assert.equal(admission.selection, undefined); assert.deepEqual(admission.pools, {});
});

test('legacy failover uses the freshly admitted tenant instead of the previous tenant', async t => {
  const f = await fixture();
  await f.put('oauth/tenants/fixture/a', grant({ accessToken: 'synthetic-old-tenant' }));
  await f.put('oauth/tenants/fixture/b', grant({ accessToken: 'synthetic-old-backup' }));
  const nextKey = 'oauth/tenants/other/legacy';
  f.records.set(nextKey, grant({ accessToken: 'synthetic-new-tenant' })); f.authority.seedLegacy(nextKey, 'anthropic');
  const tokens = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    tokens.push(new Headers(init.headers).get('authorization'));
    if (tokens.length === 1) {
      f.policy.tenantId = 'other'; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
      return new Response('retry', { status: 401 });
    }
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.deepEqual(tokens, ['Bearer synthetic-old-tenant', 'Bearer synthetic-new-tenant']);
});

test('a transient KV miss for an attached owner does not install an absence marker', async () => {
  const f = await fixture(); const projection = await f.put(keyA, grant());
  f.authority.sql.exec('DELETE FROM upstream_grant_projections'); f.records.delete(keyA);
  assert.equal((await f.admit()).selection, undefined);
  assert.equal(f.authority.sql.exec('SELECT 1 FROM upstream_grant_projections WHERE grant_key = ?', keyA).length, 0);
  f.records.set(keyA, projection);
  assert.equal((await f.admit()).selection.selected.key, keyA);
});

test('budget rejection preserves the existing pre-budget selection counter semantics', async t => {
  const { sqlBudgetNamespace } = await import('./sql-budget-namespace.mjs');
  const outcomes = [];
  for (const legacy of [false, true]) {
    const f = await fixture(); await f.put(keyA, grant());
    f.policy.monthlyBudgetMicros = 0; f.policy.requestCostMicros = 1;
    await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
    f.env.BUDGET_LEDGER = sqlBudgetNamespace(t);
    if (legacy) {
      const get = f.env.ACCESS_CONTROL.get;
      f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) {
        if (new URL(url).pathname === '/admission/resolve') { const body = JSON.parse(init.body); delete body.selection; init = { ...init, body: JSON.stringify(body) }; }
        return stub.fetch(url, init);
      } }; };
    }
    const response = await f.request(); assert.equal(response.status, 402, await response.clone().text()); await response.text(); await Promise.all(f.pending);
    outcomes.push((await f.call('/grant-pools/stats', { keys: [keyA] })).stats[keyA].selectedCount);
  }
  assert.deepEqual(outcomes, [1, 1]);
});

test('legacy failover recomputes sticky input after a concurrent routing-policy change', async t => {
  const f = await fixture(); await f.put(keyA, grant());
  for (const key of [keyB, 'oauth/fixture/third']) { f.records.set(key, grant()); f.authority.seedLegacy(key, 'anthropic'); }
  let sends = 0, retryHash;
  const get = f.env.ACCESS_CONTROL.get;
  f.env.ACCESS_CONTROL.get = id => { const stub = get(id); return { fetch(url, init) {
    if (new URL(url).pathname === '/grant-pools/select' && sends === 1) retryHash = JSON.parse(init.body).stickyHash;
    return stub.fetch(url, init);
  } }; };
  t.mock.method(globalThis, 'fetch', async () => {
    if (++sends === 1) {
      f.policy.grantRouting = { stickiness: 'session' }; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
      return new Response('retry', { status: 401 });
    }
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const response = await f.request(); assert.equal(response.status, 200); await response.text(); await Promise.all(f.pending);
  assert.equal(sends, 2); assert.equal(retryHash, await sha256Hex('session:owner@example.com'));
});
