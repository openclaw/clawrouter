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
const key = 'oauth/fixture/anthropic';
const fable = 'claude-fable-5-2', olderFable = 'claude-fable-5-1', originalFable = 'claude-fable-5', sibling = 'claude-sonnet-5';
// The named refusal is reproduced from Magpie's pinned claude_model_limit_rest_test.go.
// Anthropic documents one Fable allowance across 5/5.1/5.2 within general weekly usage.
const message = "Claude Code: You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
const errorBody = (text = message) => JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: text } });
const healthy = { 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.5', 'anthropic-ratelimit-unified-7d-reset': new Date(now + 86400000).toISOString() };

async function fixture(t, cache) {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const f = await admissionFixture();
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = cache;
  f.policy.models = [fable, olderFable, originalFable, sibling].map(model => 'anthropic/' + model);
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const grant = await putGrantCredentials(f.env, key, { provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic-named-limit' });
  const requests = [], owners = [], events = [];
  f.env.USAGE_QUEUE.send = async event => { events.push(event); };
  let rejection = { body: errorBody(), status: 429, headers: healthy };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body.model);
    const owner = new Headers(init.headers).get('authorization'); owners.push(owner);
    const current = typeof rejection === 'function' ? rejection(owner) : rejection;
    return current ? new Response(current.body, { status: current.status, headers: { 'content-type': 'application/json', 'retry-after': '90', ...current.headers } })
      : Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const send = async model => {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders,
      body: JSON.stringify({ model: 'anthropic/' + model, max_tokens: 16, messages: [{ role: 'user', content: 'synthetic' }] }) }), f.env, f.context);
    const body = await response.text(); await Promise.all(f.pending.splice(0));
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
  };
  return { ...f, send, requests, owners, events, grant, clock: value => { clock = now + value; }, reject: value => { rejection = value; }, success: () => { rejection = null; } };
}

for (const cache of ['0', '60']) test('explicit Fable-only refusal preserves sibling eligibility and Fable family deadline, cache=' + cache, async t => {
  const f = await fixture(t, cache);
  const first = await f.send(fable);
  assert.equal(first.status, 429); assert.equal(first.body, errorBody()); assert.equal(first.retryAfter, '90');
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0, 'definite rejection is nonbillable');
  f.success();
  const other = await f.send(sibling);
  assert.equal(other.status, 200, other.body);
  for (const model of [fable, olderFable, originalFable]) {
    const blocked = await f.send(model);
    assert.equal(blocked.status, 429); assert.equal(blocked.retryAfter, '90');
  }
  assert.deepEqual(f.requests, [fable, sibling], 'no replay of the rejected request and no dispatch for blocked Fable versions');
  f.clock(90000);
  assert.equal((await f.send(fable)).status, 200);
  assert.deepEqual(f.requests, [fable, sibling, fable]);
});

test('an explicit named rejection fails over once to a healthy authorized alternate', async t => {
  const f = await fixture(t, '60');
  await putGrantCredentials(f.env, 'oauth/fixture/backup', { provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic-backup' });
  f.reject(owner => owner === 'Bearer synthetic-named-limit' ? { body: errorBody(), status: 429, headers: healthy } : null);
  assert.equal((await f.send(fable)).status, 200);
  assert.deepEqual(f.owners, ['Bearer synthetic-named-limit', 'Bearer synthetic-backup']);
  assert.deepEqual(f.requests, [fable, fable]); assert.equal(f.events.length, 1, 'one settled request, not two billings');
});

test('named rejections retain the four-distinct-grant bound', async t => {
  const f = await fixture(t, '0');
  for (const ref of ['b', 'c', 'd', 'e']) await putGrantCredentials(f.env, 'oauth/fixture/' + ref, { provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic-' + ref });
  const result = await f.send(fable);
  assert.equal(result.status, 429); assert.equal(result.body, errorBody());
  assert.equal(f.owners.length, 4); assert.equal(new Set(f.owners).size, 4);
  assert.equal(f.owners.includes('Bearer synthetic-e'), false);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].actual_cost_micros, 0);
});

for (const [name, body, headers, status = 429] of [
  ['ambiguous refusal', errorBody("You've hit your limit"), healthy],
  ['unknown scope without shared allowance', errorBody(), {}],
  ['shared quota rejection', errorBody(), { ...healthy, 'anthropic-ratelimit-unified-7d-status': 'rejected' }],
  ['unrelated named family', errorBody("You've reached your Sonnet limit."), healthy],
  ['authentication failure', errorBody(), healthy, 401],
  ['missing rejection deadline', errorBody(), { ...healthy, 'retry-after': '' }],
  ['malformed JSON', errorBody().slice(0, -1), healthy],
  ['oversized JSON', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message }, padding: 'x'.repeat(65536) }), healthy],
  ['words outside native error', JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' }, ignored: message }), healthy],
]) test(name + ' keeps account-level exclusion', async t => {
  const f = await fixture(t, '0'); f.reject({ body, headers, status });
  const first = await f.send(fable); assert.equal(first.status, status); assert.equal(first.body, body);
  f.success(); assert.equal((await f.send(sibling)).status, status === 401 ? 503 : 429);
  assert.deepEqual(f.requests, [fable]);
});

for (const observationOffset of [-1000, 1000]) test('usage snapshots cannot erase the named family deadline, observation=' + observationOffset, async t => {
  const f = await fixture(t, '0');
  assert.equal((await f.send(fable)).status, 429); f.clock(2000);
  const observedAt = new Date(now + observationOffset).toISOString();
  const state = observeGrantQuotaProbe({ limits: [{ kind: 'weekly_all', percent: 50, resets_at: new Date(now + 86400000).toISOString() }] }, providerById('anthropic').quota.probes[0], now + observationOffset);
  // A real successful usage snapshot retires its omitted family windows. It
  // does not own the independent, explicitly rejected request's deadline.
  state.windowSnapshots = { 'subscription-seven-day-*': { observedAt, ids: [] } };
  await f.call('/grant-pools/feedback', { key, state: { ...state, grantRevision: f.grant.updatedAt } });
  f.success(); assert.equal((await f.send(sibling)).status, 200);
  const blocked = await f.send(olderFable); assert.equal(blocked.status, 429); assert.equal(blocked.retryAfter, '88');
  assert.deepEqual(f.requests, [fable, sibling]);
});

for (const signal of ['authentication', 'rate_limited']) test('a newer independent ' + signal + ' cooldown survives scoped feedback', async t => {
  const f = await fixture(t, '0');
  assert.equal((await f.send(fable)).status, 429); f.clock(1000);
  const state = { status: 'cooldown', source: 'provider_response', observedAt: new Date(now + 1000).toISOString(),
    cooldownUntil: new Date(now + 120000).toISOString(), lastSignal: signal, windows: [], grantRevision: f.grant.updatedAt };
  await f.call('/grant-pools/feedback', { key, state });
  // Older successful response feedback must not overwrite the newer rejection.
  await f.call('/grant-pools/feedback', { key, state: { ...state, observedAt: new Date(now).toISOString(), status: 'available', cooldownUntil: null, lastSignal: 'quota' } });
  f.success(); assert.equal((await f.send(sibling)).status, signal === 'authentication' ? 503 : 429);
  assert.deepEqual(f.requests, [fable]);
});

test('a later healthy shared probe cannot erase an unclassified independent rate-limit deadline', async t => {
  const f = await fixture(t, '0');
  f.reject({ body: errorBody("You've hit your limit"), status: 429, headers: healthy });
  assert.equal((await f.send(fable)).status, 429);
  f.clock(1000);
  const state = observeGrantQuotaProbe({ limits: [
    { kind: 'weekly_all', percent: 50, resets_at: new Date(now + 86400000).toISOString() },
    { kind: 'weekly_scoped', percent: 100, resets_at: new Date(now + 90000).toISOString(), scope: { model: { display_name: 'Fable' } } },
  ] }, providerById('anthropic').quota.probes[0], now + 1000);
  await f.call('/grant-pools/feedback', { key, state: { ...state, grantRevision: f.grant.updatedAt } });
  f.success();
  assert.equal((await f.send(sibling)).status, 429);
  assert.equal((await f.send(olderFable)).status, 429);
  assert.deepEqual(f.requests, [fable]);
});
