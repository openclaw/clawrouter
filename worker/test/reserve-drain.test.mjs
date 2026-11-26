import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionFixture, admissionHeaders } from './admission-fixture.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { providerById } from '../provider-catalog.ts';
import { selectAdmissionCandidate, selectGenerationAdmissionCandidate, selectPrivateAdmissionCandidate } from '../authority-grant-selection.ts';
import { selectPolicyCandidates, selectProviderPolicy } from '../grant-selection.ts';
import { chooseGrantKey, normalizedChoiceCandidates } from '../grant-selection-strategies.ts';
import { normalizePolicyRecord } from '../authority-policy.ts';
const { default: worker } = await import('../index.ts');

// The per-policy reserve is a soft floor (2026-11-26): once no grant in the
// policy is above it, grants that still have real capacity are drained, spread
// by the policy hysteresis, instead of answering upstream_grant_pool_unavailable.
const provider = providerById('anthropic');
const endpoint = provider.endpoints.find(item => item.id === 'messages');
const now = Date.parse('2026-11-26T01:30:00.000Z');
const at = seconds => new Date(now + seconds * 1_000).toISOString();
const key = ref => ref.includes('/') ? ref : `oauth/fixture/${ref}`;
// openclaw_foundation at the incident: threshold at 90% used, 10% hysteresis,
// 8% reserve, failover on and no paid fallback.
const foundation = { strategy: 'threshold', switchAtUsedPercent: 90, hysteresisPercent: 10, includedQuotaReservePercent: 8, failover: true, environmentFallback: false };
const band = ['josh', 'setup', 'ocf1', 'patrick'];
const weeklyReset = 98_971; // the Retry-After the incident's 429 carried

const window = (id, remaining, resetSeconds, extra = {}) => ({ id, kind: 'subscription', unit: 'percent', remaining, limit: 100, resetAt: at(resetSeconds), observedAt: at(-1), ...extra });
const weekly = (remaining, resetSeconds = weeklyReset) => window('subscription-seven-day', remaining, resetSeconds, { window: 'seven_day' });
const state = (windows, extra = {}) => revision => ({ status: 'available', observedAt: at(-1), source: 'provider_response', cooldownUntil: null, lastSignal: 'quota', grantRevision: revision, windows, ...extra });
// A real upstream 429 cools the grant for a day; a 401/403 is not timed recovery.
const cooled = (windows, seconds = 86_400) => state(windows, { status: 'cooldown', cooldownUntil: at(seconds), lastSignal: 'rate_limited' });
const authFailed = state([], { status: 'cooldown', cooldownUntil: at(300), lastSignal: 'authentication' });

async function fixture(t, { legacy = false, routing = foundation, grants = {}, models } = {}) {
  t.mock.method(Date, 'now', () => now);
  const f = await admissionFixture();
  // Authoritative per request, so each choice sees the previous response's quota.
  f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '0';
  attachGrantCredentialNamespace(f.env, { useExistingAuthority: true });
  f.policy.grantRouting = routing;
  if (models) f.policy.models = models;
  await f.call('/policies/put', { policyId: 'fixture', policy: f.policy });
  const revisions = {};
  for (const [ref, options] of Object.entries(grants)) {
    const grant = { provider: provider.id, kind: 'subscription', enabled: true, accessToken: `synthetic-${ref.split('/').at(-1)}`, updatedAt: '2026-01-01T00:00:00Z', ...options.grant };
    // Only an attached projection can be shared, so a shared owner is never legacy.
    if (legacy && !ref.startsWith('oauth/')) { f.records.set(key(ref), grant); f.authority.seedLegacy(key(ref), provider.id); revisions[ref] = grant.updatedAt; }
    else revisions[ref] = (await putGrantCredentials(f.env, key(ref), grant)).updatedAt;
    if (options.state) await f.call('/grant-pools/feedback', { key: key(ref), state: options.state(revisions[ref]) });
  }
  // Upstream reports each served account's weekly use, as Anthropic's unified headers do.
  f.used = Object.fromEntries(Object.entries(grants).flatMap(([ref, options]) => options.used === undefined ? [] : [[ref.split('/').at(-1), options.used]]));
  f.served = [];
  f.upstream = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const ref = new Headers(init.headers).get('authorization')?.replace('Bearer synthetic-', '');
    f.served.push(ref);
    if (f.used[ref] !== undefined) f.used[ref] += f.step ?? 0;
    const headers = f.used[ref] === undefined ? {} : { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': String(f.used[ref] / 100), 'anthropic-ratelimit-unified-7d-reset': at(weeklyReset) };
    return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }, { headers });
  });
  f.send = async (model = 'claude-sonnet-5') => {
    const response = await worker.fetch(new Request('https://fixture/v1/messages', { method: 'POST', headers: admissionHeaders, body: JSON.stringify({ model: `anthropic/${model}`, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }) }), f.env, f.context);
    const body = await response.text();
    await Promise.all(f.pending.splice(0));
    return { status: response.status, retryAfter: response.headers.get('retry-after'), errorCode: response.headers.get('x-clawrouter-error-code'), body };
  };
  return f;
}

// The incident pool: four accounts at exactly 8%, one at 0% after a real 429,
// and shared accounts whose credentials fail.
const incident = () => ({
  ...Object.fromEntries(band.map(ref => [ref, { state: state([weekly(8)]), used: 92 }])),
  frank: { state: cooled([weekly(0, 120_000)]) },
  ...Object.fromEntries(['oauth/peter/one', 'oauth/peter/two'].map(ref => [ref, { state: authFailed }])),
});
const sharingPeter = { ...foundation, sharedGrants: { anthropic: ['oauth/peter/one', 'oauth/peter/two'] } };

for (const legacy of [false, true]) {
  const path = legacy ? 'legacy' : 'combined';

  test(`${path}: the incident pool serves from a reserve-band account instead of a pool-unavailable 429`, async t => {
    const f = await fixture(t, { legacy, routing: sharingPeter, grants: incident() });
    const response = await f.send();
    assert.equal(response.status, 200, `${response.status} ${response.errorCode} retry-after=${response.retryAfter} ${response.body}`);
    assert.equal(f.upstream.mock.callCount(), 1, 'one dispatch, never to the cooled or failed accounts');
    assert.ok(band.includes(f.served[0]), f.served[0]);
  });

  test(`${path}: successive requests spread the drain across the reserve band with hysteresis`, async t => {
    const f = await fixture(t, { legacy, routing: sharingPeter, grants: incident() });
    f.step = 0.5; // each request uses half a point of that account's week
    const margin = 10 * 8 / 10_000 * 100; // the 10% hysteresis applied to the 8% band, in points
    for (let request = 0; request < 16; request++) {
      const response = await f.send();
      assert.equal(response.status, 200, `request ${request}: ${response.status} ${response.body}`);
      const remaining = band.map(ref => 100 - f.used[ref]);
      assert.ok(Math.max(...remaining) - Math.min(...remaining) <= margin + f.step + 1e-9, `request ${request} drained one account ahead of the others: ${remaining}`);
    }
    assert.deepEqual([...new Set(f.served)].sort(), [...band].sort());
    // Hysteresis: a stint ends only once its account is a margin behind, never per request.
    const stints = f.served.reduce((runs, ref, index) => (ref === f.served[index - 1] ? runs.at(-1).push(ref) : runs.push([ref]), runs), []);
    assert.ok(stints.slice(0, -1).every(stint => stint.length >= 2), JSON.stringify(f.served));
  });

  test(`${path}: a grant above the reserve wins over the reserve band, even at a lower priority`, async t => {
    const f = await fixture(t, { legacy, routing: sharingPeter, grants: { ...incident(), fresh: { grant: { priority: 200 }, state: state([weekly(30)]), used: 70 } } });
    f.step = 11;
    for (const expected of ['fresh', 'fresh']) { // 30% -> 19% -> 8%: above the reserve until the last report
      const response = await f.send();
      assert.equal(response.status, 200, response.body); assert.equal(f.served.at(-1), expected);
    }
    // Now nothing is above the reserve. The drain keeps priority order: the
    // priority-100 band serves before the priority-200 account.
    f.step = 0.5;
    for (let request = 0; request < 4; request++) {
      const response = await f.send();
      assert.equal(response.status, 200, `${response.status} ${response.body}`);
      assert.ok(band.includes(f.served.at(-1)), f.served.at(-1));
    }
  });

  test(`${path}: a truly exhausted or cooling pool keeps its 429 and earliest Retry-After`, async t => {
    const grants = incident();
    band.forEach((ref, index) => { grants[ref] = { state: state([weekly(0, 200_000 + index * 1_000)]) }; });
    grants.josh = { state: cooled([weekly(5)], 150_000) }; // a real 429 still cools a reserve-band account
    const f = await fixture(t, { legacy, routing: sharingPeter, grants });
    const response = await f.send();
    assert.equal(response.status, 429, response.body);
    assert.equal(response.errorCode, 'upstream_grant_pool_unavailable');
    assert.equal(response.retryAfter, '120000', 'the earliest recovery: frank, after its cooldown and its own weekly reset');
    assert.equal(f.upstream.mock.callCount(), 0);
  });

  test(`${path}: the consuming policy's reserve governs a shared grant, and a shared reserve-band grant drains`, async t => {
    const shared = 'oauth/owner/lent', routing = { ...foundation, sharedGrants: { anthropic: [shared] } };
    const owner = async f => f.call('/policies/put', { policyId: 'owner', policy: { ...f.policy, tenantId: 'owner', grantRouting: { ...foundation, includedQuotaReservePercent: 50 } } });
    // Under its owner's 50% reserve the lent grant would lose to 'mine'; this
    // consumer's 8% reserve ranks it above the reserve with the most remaining.
    const ranked = await fixture(t, { legacy, routing, grants: { mine: { state: state([weekly(15)]) }, [shared]: { state: state([weekly(20)]) } } });
    await owner(ranked);
    assert.equal((await ranked.send()).status, 200); assert.deepEqual(ranked.served, ['lent']);
    const f = await fixture(t, { legacy, routing, grants: { ...Object.fromEntries(band.map(ref => [ref, { state: state([weekly(8)]), used: 92 }])), [shared]: { state: state([weekly(8)]), used: 92 } } });
    await owner(f);
    f.step = 0.5;
    for (let request = 0; request < 10; request++) { const response = await f.send(); assert.equal(response.status, 200, `${response.status} ${response.body}`); }
    assert.deepEqual([...new Set(f.served)].sort(), [...band, 'lent'].sort());
  });

  // Every window the reserve governs: account-wide five-hour and weekly, and a
  // model-scoped (Fable) allowance. Each drains above zero and recovers at its own reset.
  for (const [name, model, inBand] of [
    ['five-hour', 'claude-sonnet-5', (remaining, reset) => [window('subscription-five-hour', remaining, reset, { window: 'five_hour' }), weekly(60)]],
    ['weekly', 'claude-sonnet-5', (remaining, reset) => [window('subscription-five-hour', 70, 9_000, { window: 'five_hour' }), weekly(remaining, reset)]],
    ['model-scoped Fable', 'claude-fable-5-1', (remaining, reset) => [weekly(60), window('rate-limit-fable', remaining, reset, { window: 'retry_after', models: ['fable'] })]],
  ]) test(`${path}: the ${name} window drains above zero and then waits for its reset`, async t => {
    const models = ['anthropic/claude-sonnet-5', 'anthropic/claude-fable-5-1'];
    const draining = await fixture(t, { legacy, models, grants: { a: { state: state(inBand(3, 4_000)) }, b: { state: state(inBand(6, 5_000)) } } });
    const served = await draining.send(model);
    assert.equal(served.status, 200, served.body); assert.equal(draining.served[0], 'b', 'the most remaining of the band');
    const exhausted = await fixture(t, { legacy, models, grants: { a: { state: state(inBand(0, 4_000)) }, b: { state: state(inBand(0, 5_000)) } } });
    const waiting = await exhausted.send(model);
    assert.equal(waiting.status, 429, waiting.body); assert.equal(waiting.retryAfter, '4000');
    assert.equal(exhausted.upstream.mock.callCount(), 0);
  });
}

test('a policy with an environment fallback keeps using it at the reserve rather than draining', async t => {
  const f = await fixture(t, { routing: { ...foundation, environmentFallback: true }, grants: Object.fromEntries(band.map(ref => [ref, { state: state([weekly(8)]) }])) });
  f.upstream.mock.mockImplementation(async (_url, init) => {
    f.served.push(new Headers(init.headers).get('x-api-key'));
    return Response.json({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const response = await f.send();
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(f.served, ['synthetic-environment']);
});

test('a principal policy draining its reserve yields to one with a grant above its reserve', async t => {
  // Discovery ranks already-resolved pools.
  const grant = { provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic' };
  const pool = (policyId, reserveDrain) => ({ entry: { policyId }, candidates: { available: [{ key: `oauth/${policyId}/a`, grant, runtimeState: null }], hasConfiguredGrant: true, ...(reserveDrain ? { reserveDrain: true } : {}) } });
  assert.equal(selectPolicyCandidates([pool('draining', true), pool('above', false)]).entry.policyId, 'above');
  assert.equal(selectPolicyCandidates([pool('first', true), pool('second', true)]).entry.policyId, 'first');
  // Access inference resolves each of the principal's policies in order.
  const f = await fixture(t, { grants: Object.fromEntries(band.map(ref => [ref, { state: state([weekly(8)]) }])) });
  const other = { ...f.policy, tenantId: 'other' }, spare = 'oauth/other/spare';
  await f.call('/policies/put', { policyId: 'other', policy: other });
  const revision = (await putGrantCredentials(f.env, spare, { provider: provider.id, kind: 'subscription', enabled: true, accessToken: 'synthetic-spare' })).updatedAt;
  const requirement = { provider, endpoint, mode: 'http', model: 'claude-sonnet-5' };
  const choose = async (spareRemaining, order) => {
    await f.call('/grant-pools/feedback', { key: spare, state: state([weekly(spareRemaining)])(revision) });
    return (await selectProviderPolicy(order.map(policyId => ({ policyId, policy: policyId === 'other' ? other : f.policy })), provider.id, f.env, requirement)).policyId;
  };
  assert.equal(await choose(40, ['fixture', 'other']), 'other', 'capacity elsewhere beats draining a reserve');
  assert.equal(await choose(0, ['other', 'fixture']), 'fixture', 'with none above a reserve, a draining policy beats an exhausted one');
});

// The authority transaction, the isolate snapshot, generation consumption and
// the private streaming bridge each select; all four must drain identically.
test('every selection path narrows a reserve drain identically', () => {
  const grant = (priority = 100) => ({ provider: 'anthropic', kind: 'subscription', enabled: true, credentialStore: 'durable_object', credentialStatus: 'active',
    hasAccessToken: true, credentialLineage: 'synthetic', credentialGeneration: 1, priority });
  const runtime = remaining => ({ status: 'available', observedAt: at(-1), source: 'provider_response', cooldownUntil: null, lastSignal: 'quota', grantRevision: null, windows: [weekly(remaining)] });
  const scenarios = [
    // margin 0.8 points: 7.5 stays within reach of 8, 7 and 5 do not
    { name: 'all in the band', grants: { a: [8], b: [7.5], c: [7], d: [5] }, cursor: null, choices: ['a', 'b'], selected: 'a' },
    { name: 'the cursor stays within the hysteresis', grants: { a: [8], b: [7.5], c: [7] }, cursor: 'b', choices: ['a', 'b'], selected: 'b' },
    { name: 'the cursor leaves once a margin behind', grants: { a: [8], b: [7.5], c: [7] }, cursor: 'c', choices: ['a', 'b'], selected: 'a' },
    { name: 'a lower-priority grant above the reserve wins', grants: { a: [8], b: [40, 200] }, cursor: 'a', choices: ['b'], selected: 'b' },
    { name: 'the drain keeps priority order', grants: { a: [2, 50], b: [8], c: [7.9] }, cursor: null, choices: ['a'], selected: 'a' },
    { name: 'zero remaining is exhausted, not drained', grants: { a: [0], b: [0] }, cursor: null, choices: null, selected: null },
    { name: 'an environment fallback keeps priority', grants: { a: [8] }, routing: { environmentFallback: true }, cursor: null, choices: null, selected: null },
    { name: 'a pinned owner drains even with an environment fallback', grants: { a: [8], b: [4] }, routing: { environmentFallback: true }, pinnedKey: key('b'), cursor: null, choices: ['b'], selected: 'b' },
  ];
  for (const scenario of scenarios) {
    const candidates = Object.entries(scenario.grants).map(([ref, [, priority]]) => ({ key: key(ref), grant: grant(priority) }));
    const states = Object.fromEntries(Object.entries(scenario.grants).map(([ref, [remaining]]) => [key(ref), runtime(remaining)]));
    const input = { provider, endpoint, request: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model: 'claude-sonnet-5', pinnedKey: scenario.pinnedKey },
      policy: { policyId: 'fixture', policy: normalizePolicyRecord({ grantRouting: { ...foundation, ...scenario.routing } }, false) }, poolKey: 'fixture', candidates, states,
      identityHash: 'ab'.repeat(32), fallbackSessionHash: 'cd'.repeat(32) };
    const results = [], offered = [];
    const choose = choice => { offered.push(choice.candidates.map(item => item.key)); return chooseGrantKey(choice, normalizedChoiceCandidates(choice.candidates), scenario.cursor && key(scenario.cursor), () => undefined); };
    results.push(selectAdmissionCandidate({}, input, choose, () => 7));
    results.push(selectGenerationAdmissionCandidate({}, input, choose, () => 7, (_vector, run) => run()));
    results.push(selectPrivateAdmissionCandidate({}, input, choose, () => 7));
    for (const result of results.slice(1)) assert.deepEqual(result, results[0], scenario.name);
    assert.deepEqual(offered, scenario.choices ? results.map(() => scenario.choices.map(key)) : [], scenario.name);
    assert.equal(results[0].selected?.key ?? null, scenario.selected && key(scenario.selected), scenario.name);
  }
});
