import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { observeGrantQuotaProbe } from '../grant-quota.ts';
import { providerById } from '../providers.ts';
const { default: worker } = await import('../index.ts');

const now = Date.parse('2030-01-01T00:00:00Z');
const reset = new Date(now + 3600000).toISOString();
const provider = providerById('anthropic');
const a = 'oauth/fixture/anthropic', b = 'oauth/fixture/backup';
const fable = 'anthropic/claude-fable-5-2', sonnet = 'anthropic/claude-sonnet-5';
const quota = (free, shared = 80, resetAt = reset) => ({ seven_day: { utilization: 100 - shared, resets_at: reset },
  limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 100 - free, resets_at: resetAt }] });

async function fixture(t, { hot = true, second = true, visible = true, routing = {} } = {}) {
  t.mock.method(Date, 'now', () => now);
  const f = await admissionFixture();
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = hot ? '60' : '0';
  Object.assign(f.policy, { models: [fable, sonnet], poolStatus: visible ? 'visible' : 'hidden', grantRouting: {
    strategy: 'threshold', stickiness: 'none', switchAtUsedPercent: 90, hysteresisPercent: 5, environmentFallback: false, ...routing,
  } });
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  f.put = async key => putGrantCredentials(f.env, key, { provider: 'anthropic', kind: 'subscription', enabled: true,
    accessToken: key === a ? 'synthetic-a' : key === b ? 'synthetic-b' : 'synthetic-other', expiresAt: reset });
  await f.put(a); if (second) await f.put(b);
  f.state = async (key, state) => f.call('/grant-pools/feedback', { key, state: { ...state, grantRevision: f.records.get(key).updatedAt } });
  f.quota = (key, payload) => f.state(key, observeGrantQuotaProbe(payload, provider.quota.probes[0], now));
  f.send = async (model = fable) => {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders,
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'synthetic' }] }) }), f.env, f.context);
    const body = await response.json();
    while (f.pending.length) await Promise.all(f.pending.splice(0));
    return { response, body };
  };
  f.stats = async () => (await f.call('/grant-pools/stats', { keys: [a, b] })).stats;
  return f;
}

for (const hot of [false, true]) test('model-window threshold switches the actually dispatched account, hot=' + hot, async t => {
  const f = await fixture(t, { hot });
  await f.quota(a, quota(80)); await f.quota(b, quota(60));
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sent.push(new Headers(init.headers).get('authorization'));
    assert.equal(JSON.parse(init.body).model, 'claude-fable-5-2');
    return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  assert.equal((await f.send()).response.status, 200);
  await f.quota(a, quota(10));
  // An authoritative feedback update is not a promise of immediate cross-isolate
  // visibility. Cold admission imports the new observation; its next hit selects locally.
  if (hot) (await import('../hot-cache.ts')).clearHotCaches();
  assert.equal((await f.send()).response.status, 200);
  assert.equal((await f.send()).response.status, 200);
  assert.deepEqual(sent, ['Bearer synthetic-a', 'Bearer synthetic-b', 'Bearer synthetic-b']);
  const stats = await f.stats();
  assert.equal(stats[a].selectedCount, 1); assert.equal(stats[b].selectedCount, 2);
});

test('healthy shared week and zero Fable quota still dispatch another model', async t => {
  const f = await fixture(t, { second: false });
  await f.quota(a, quota(0));
  const upstream = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, 'claude-sonnet-5');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-a');
    return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const blocked = await f.send();
  assert.equal(blocked.response.status, 429);
  assert.match(blocked.body.error.message, /model_quota_exhausted=1/);
  assert.equal((await f.send(sonnet)).response.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal((await f.stats())[a].selectedCount, 1);
});

for (const visible of [false, true]) test('empty-pool diagnostics stay scoped and do not invent confirmed recovery, visible=' + visible, async t => {
  const f = await fixture(t, { visible, routing: { eligibleGrants: { anthropic: ['anthropic', 'backup'] }, sharedGrants: { anthropic: ['oauth/private-source/anthropic'] } } });
  for (const key of ['oauth/private-source/anthropic', 'oauth/fixture/excluded', 'oauth/foreign/anthropic', 'oauth/tenants/foreign/backup']) {
    await f.put(key); await f.quota(key, quota(0));
  }
  await f.quota(a, quota(0, 80, null));
  await f.state(b, { status: 'cooldown', observedAt: new Date(now).toISOString(), source: 'provider_response', lastSignal: 'rate_limited',
    cooldownUntil: new Date(now + 60000).toISOString(), windows: [] });
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('excluded candidates cannot dispatch'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { response, body } = await f.send();
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('x-clawrouter-error-code'), 'upstream_grant_pool_unavailable');
    assert.match(body.error.message, /for model "claude-fable-5-2"/);
    assert.match(body.error.message, /earliest possible retry at 2030-01-01T00:01:00.000Z [(]eligibility rechecked on retry[)]/);
    if (visible) assert.match(body.error.message, /observed scoped exclusions: cooldown=1, model_quota_exhausted=2/);
    else assert.doesNotMatch(body.error.message, /exclusions|cooldown=|exhausted=/);
    assert.doesNotMatch(JSON.stringify(body), /oauth[/]|synthetic|foreign|private-source|backup|principal|accountId|tokenRef/);
    assert.ok(JSON.stringify(body).length < 1000);
  }
  assert.equal(upstream.mock.callCount(), 0);
  const stats = await f.stats();
  assert.equal(stats[a].selectedCount, 0); assert.equal(stats[b].selectedCount, 0);
});

for (const payload of [{}, { seven_day: { utilization: 'malformed', resets_at: 'invalid' } }]) test('unknown or malformed observations cannot satisfy stale-deny admission: ' + JSON.stringify(payload), async t => {
  const f = await fixture(t, { second: false, routing: { staleState: 'deny' } });
  const observation = observeGrantQuotaProbe(payload, provider.quota.probes[0], now);
  if (observation) await f.state(a, observation);
  const upstream = t.mock.method(globalThis, 'fetch', () => assert.fail('unknown quota cannot dispatch under stale deny'));
  const { response, body } = await f.send();
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), null);
  assert.match(body.error.message, /quota_not_fresh=1/);
  assert.doesNotMatch(body.error.message, /earliest possible retry|quota_exhausted/);
  assert.equal(upstream.mock.callCount(), 0);
});
