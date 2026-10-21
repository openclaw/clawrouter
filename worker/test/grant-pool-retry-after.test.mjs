import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { resolveGrantSelection } from '../grant-selection.ts';
import { providerById } from '../providers.ts';
const { default: worker } = await import('../index.ts');

const provider = providerById('anthropic');
const endpoint = provider.endpoints.find(item => item.id === 'messages');
const model = 'claude-sonnet-5';
const keyA = 'oauth/fixture/anthropic', keyB = 'oauth/fixture/backup';
const grant = (extra = {}) => ({ provider: provider.id, kind: 'subscription', enabled: true, accessToken: 'synthetic-token', updatedAt: '2026-01-01T00:00:00Z', ...extra });
const unavailableBody = { error: { code: 'upstream_grant_pool_unavailable', message: 'provider anthropic has no available scoped upstream grant' } };

// Fixed clock: Retry-After is whole seconds until the earliest pooled grant returns.
const now = Date.parse('2026-10-21T12:00:00.000Z');
const at = seconds => new Date(now + seconds * 1_000).toISOString();
const cooling = (seconds, revision) => ({ status: 'cooldown', observedAt: at(-1), source: 'provider_response', cooldownUntil: at(seconds), lastSignal: 'rate_limited', grantRevision: revision, windows: [] });
// An upstream 401/403 also records a cooldown, but elapsed time does not repair a credential.
const authFailed = (seconds, revision) => ({ ...cooling(seconds, revision), lastSignal: 'authentication' });
const exhausted = (resetSeconds, revision, remaining = 0) => ({ status: 'cooldown', observedAt: at(-1), source: 'provider_response', cooldownUntil: null, lastSignal: 'quota', grantRevision: revision,
  windows: [{ id: 'week', kind: 'requests', remaining, limit: 100, resetAt: resetSeconds == null ? null : at(resetSeconds) }] });

async function fixture(t, { legacy = false, routing } = {}) {
  t.mock.method(Date, 'now', () => now);
  const f = await admissionFixture();
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  if (routing) { f.policy.grantRouting = routing; await f.call('/policies/put', { policyId: 'fixture', policy: f.policy }); }
  const revisions = {};
  for (const key of [keyA, keyB]) {
    if (legacy) { f.records.set(key, grant()); if (key === keyB) f.authority.seedLegacy(key, provider.id); revisions[key] = grant().updatedAt; }
    else revisions[key] = (await putGrantCredentials(f.env, key, grant())).updatedAt;
  }
  f.state = (key, state) => f.call('/grant-pools/feedback', { key, state: state(revisions[key]) });
  f.admit = () => f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [{ id: provider.id, tokenRef: provider.id }], selection: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model, catalogModelId: 'anthropic/claude-sonnet-5', capability: 'llm.chat' } });
  f.send = async () => {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders, body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }) }), f.env, f.context);
    const body = await response.json();
    await Promise.all(f.pending);
    return { status: response.status, retryAfter: response.headers.get('retry-after'), exposed: response.headers.get('access-control-expose-headers')?.split(',') ?? [], body };
  };
  return f;
}

const freshCooling = (seconds, r) => ({ ...exhausted(600, r, 50), cooldownUntil: at(seconds), lastSignal: 'rate_limited' });
for (const legacy of [false, true]) for (const [name, stateA, stateB, retryAfter, routing = { includedQuotaReservePercent: 10 }] of [
  ['rate-limit cooldowns', r => cooling(60, r), r => cooling(150, r), '60'],
  ['a quota window reset beats a later cooldown', r => cooling(200, r), r => exhausted(90, r), '90'],
  ['subscription reserve exhaustion waits for its reset', r => cooling(200, r), r => exhausted(45, r, 5), '45'],
  ['sub-second remainders round up', r => ({ ...cooling(0, r), cooldownUntil: new Date(now + 250).toISOString() }), r => cooling(30, r), '1'],
  ['an earlier authentication cooldown is not a recovery', r => authFailed(30, r), r => cooling(120, r), '120'],
  ['an authentication cooldown with a resettable window is not a recovery', r => ({ ...exhausted(10, r), cooldownUntil: at(20), lastSignal: 'authentication' }), r => exhausted(90, r), '90'],
  // After its only window resets, a stale-deny grant needs a new observation.
  ['stale-deny counts only grants still fresh when they recover', r => exhausted(20, r), r => freshCooling(40, r), '40', { staleState: 'deny' }],
]) test(`${legacy ? 'legacy' : 'combined'} pool cooldown returns 429 with the earliest recovery: ${name}`, async t => {
  const f = await fixture(t, { legacy, routing });
  await f.state(keyA, stateA); await f.state(keyB, stateB);
  // Legacy projections leave selection to the worker; projected owners select in admission.
  assert.equal((await f.admit()).selection === undefined, legacy);
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('a cooling pool must not dispatch'); });
  f.calls.length = 0;
  const response = await f.send();
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, retryAfter);
  assert.ok(response.exposed.includes('retry-after'), 'browser clients can read the retry time');
  assert.deepEqual(response.body, unavailableBody, 'the error body shape and code are unchanged');
  assert.equal(upstream.mock.callCount(), 0);
  assert.deepEqual(f.calls, ['/admission/resolve']);
});

test('combined admission and worker-side selection report the same recovery time', async t => {
  const combined = await fixture(t), old = await fixture(t);
  for (const f of [combined, old]) { await f.state(keyA, r => cooling(75, r)); await f.state(keyB, r => exhausted(120, r)); }
  const admitted = (await combined.admit()).selection;
  const expected = await resolveGrantSelection(provider.id, 'fixture', 'fixture', provider.id, old.env, new Set(), undefined, null, true, undefined, { provider, endpoint, mode: 'http', model });
  assert.equal(admitted.selected, null);
  assert.equal(admitted.retryAt, at(75));
  assert.equal(expected.retryAt, at(75));
  assert.equal(admitted.hasConfiguredGrant, expected.hasConfiguredGrant);
});

for (const [name, routing, stateB, stateA = r => exhausted(null, r), legacy = false] of [
  ['an exhausted window without a reset time', undefined, r => exhausted(null, r)],
  ['an eligibility-restricted pool', { eligibleGrants: { anthropic: ['absent'] } }, r => cooling(30, r)],
  ['a stale-deny pool with no fresh observation', { staleState: 'deny' }, r => cooling(30, r)],
  // Failed credentials are an operator problem, not a timed rate limit.
  ...[false, true].map(legacy => [`${legacy ? 'legacy' : 'combined'} authentication cooldowns`, undefined, r => authFailed(300, r), r => authFailed(60, r), legacy]),
]) test(`a pool with no known recovery keeps 503 without Retry-After: ${name}`, async t => {
  const f = await fixture(t, { routing, legacy });
  await f.state(keyA, stateA); await f.state(keyB, stateB);
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('an unavailable pool must not dispatch'); });
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.equal(response.retryAfter, null);
  assert.deepEqual(response.body, unavailableBody);
  assert.equal(upstream.mock.callCount(), 0);
});

test('an available grant still serves while another grant cools down', async t => {
  const f = await fixture(t);
  await f.state(keyA, r => cooling(60, r));
  const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  const response = await f.send();
  assert.equal(response.status, 200);
  assert.equal(response.retryAfter, null);
  assert.equal(upstream.mock.callCount(), 1);
});

test('environment fallback still serves a cooling pool when the policy allows it', async t => {
  const f = await fixture(t, { routing: { environmentFallback: true } });
  await f.state(keyA, r => cooling(60, r)); await f.state(keyB, r => cooling(60, r));
  const upstream = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(new Headers(init.headers).get('x-api-key'), 'synthetic-environment');
    return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const response = await f.send();
  assert.equal(response.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
});

test('an upstream 429 whose failover pool is cooling keeps the provider timing', async t => {
  const f = await fixture(t);
  await f.state(keyB, r => cooling(90, r));
  const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429, headers: { 'retry-after': '30' } }));
  const response = await f.send();
  assert.equal(upstream.mock.callCount(), 1, 'the cooling alternate is not dispatched');
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, '30');
  assert.equal(response.body.error.type, 'rate_limit_error');
});
