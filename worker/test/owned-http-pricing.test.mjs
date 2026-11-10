import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateOwnedHttpChat } from '../index.ts';
import { continuationAuthority } from './continuation-authority.mjs';
import { attachGrantCredentialNamespace } from './grant-credential-mock.mjs';
import { sqlBudgetNamespace } from './sql-budget-namespace.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { putGrantCredentials } from '../grant-credentials.ts';
import { snapshot } from '../providers.ts';
import { estimateCost } from '../proxy-accounting.ts';
import { bodyBudgetCharged, bodyBudgetBytes, ExactBodyCharge } from '../body-budget.ts';
import { sha256Hex } from '../utils.ts';
import { evictCredentialGeneration } from '../credential-preflight.ts';
import { prepareOwnedHttpPricing, enterOwnedHttpPricing } from '../pricing.ts';
import { beginOwnedHttpRequest, finishOwnedHttpRequest } from '../http-identity-owner.ts';
import { isIdentityFailure } from '../identity-admission.ts';

const modelId = 'fireworks/glm-5.2', kid = 'http_pricing', policyId = 'http-pricing-policy';
const provider = snapshot.providers.find(item => item.id === 'fireworks');
const model = provider.models.find(item => item.id === modelId);
const endpoint = provider.endpoints.find(item => item.request_format === 'openai.chat_completions');
const grantKey = 'oauth/' + policyId + '/fireworks';
const payload = extra => ({ model: modelId, messages: [{ role: 'user', content: 'synthetic input' }], max_tokens: 1, ...extra });
const transformed = body => ({ ...body, model: model.upstream });
const ordinaryCost = body => estimateCost(model, transformed(body), null, 'llm.chat', endpoint, undefined, undefined, 'fireworks');
const deferred = () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.then(() => undefined, () => undefined); return { promise, resolve, reject };
};

// Original dispatch, late body and accepted background roots share ONE outcome
// identity. Release gates first, dynamically join all finite roots, then retire
// generation publication and fixture resources. Mocks stay installed until joins.
async function fixture(t, run, retained = false) {
  const baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), bodies = new WeakMap();
  const resources = [], releases = [], values = new Map(), calls = [], sent = [], events = [];
  let done = false, cleanupPromise, hasPrimary = false, primary, rejectMaterialize = false, pressure, archiveGate;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    origins.set(promise, root); roots.push(root); return root;
  };
  const take = async root => { const value = await root.outcome; root.used = true; if (value.failed) throw value.error; return value.value; };
  const bodyRoot = response => {
    let root = bodies.get(response); if (!root) { root = own(response.text()); bodies.set(response, root); } return root;
  };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    try { pressure?.release(); pressure = undefined; } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const value = await root.outcome; if (value.failed && !root.used) { root.used = true; failures.push(value.error); } }
    try { evictCredentialGeneration(env, kid); } catch (error) { failures.push(error); }
    try { assert.equal(bodyBudgetCharged(), baseline, 'last actual pricing/body/original roots'); } catch (error) { failures.push(error); }
    for (const release of resources) try { release(); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!done) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  const env = { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '0', POLICY_KV: {
    async get(key, type) { const value = values.get(key); return value == null ? null : type === 'stream' ? accessBytesResponse(JSON.stringify(value)).body : structuredClone(value); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  }, USAGE_QUEUE: { async send(event) { events.push(structuredClone(event)); } }, CONTENT_ARCHIVE: { async put(key, body) {
    calls.push({ kind: 'archive', key });
    if (archiveGate) { archiveGate.entered.resolve(); await take(own(archiveGate.release.promise)); }
    const text = typeof body === 'string' ? body : await take(own(new Response(body).text()));
    calls.push({ kind: 'archive-complete', bytes: Buffer.byteLength(text) });
  } } };
  const resourceOwner = { after(close) { resources.push(close); } };
  const budgets = sqlBudgetNamespace(resourceOwner);
  env.BUDGET_LEDGER = { idFromName: name => name, get(name) { const stub = budgets.get(name); return { fetch(url, init) {
    calls.push({ kind: 'budget', path: new URL(url).pathname, body: JSON.parse(init.body) });
    return stub.fetch(url, init);
  } }; } };
  env.ACCESS_CONTROL = continuationAuthority(resourceOwner, env);
  env.ACCESS_CONTROL.beforeFetch = (_name, request) => { calls.push({ kind: 'authority', path: new URL(request.url).pathname, charged: bodyBudgetCharged() }); };
  attachGrantCredentialNamespace(env, { useExistingAuthority: true, kvValues: values });
  const originalGet = env.GRANT_CREDENTIALS.get;
  env.GRANT_CREDENTIALS.get = function (id) {
    const stub = Reflect.apply(originalGet, this, [id]); return { fetch(url, init) {
      const path = new URL(url).pathname; calls.push({ kind: 'credential', path });
      if (rejectMaterialize && path === '/materialize') return Promise.resolve(accessBytesResponse('{"error":{"code":"grant_credential_missing","message":"synthetic refusal"}}', '', { status: 503 }));
      return stub.fetch(url, init);
    } };
  };
  let upstreamGate;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    if (upstreamGate) { upstreamGate.entered.resolve(); await take(own(upstreamGate.release.promise)); }
    const text = await take(own(request.text())); sent.push({ text, method: request.method, url: request.url });
    return Response.json({ id: 'synthetic-priced-chat', model: model.upstream, choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
  });
  const dispatch = input => {
    const original = privateOwnedHttpChat.fetch(new Request('https://router.example/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer clawrouter-live-' + kid + '-fixture-secret', 'content-type': 'application/json' },
      body: typeof input === 'string' ? input : JSON.stringify(input),
    }), env, { waitUntil: promise => { own(promise); } });
    const root = own(original); own(original.then(response => { bodyRoot(response); }, () => {})); return root;
  };
  const request = async input => { const response = await take(dispatch(input)); return { status: response.status, text: await take(bodyRoot(response)), headers: response.headers }; };
  const drain = async () => { for (let i = 0; i < roots.length; i++) await roots[i].outcome; };
  try {
    values.set('credentials/' + kid, { enabled: true, secretSha256: await take(own(sha256Hex('fixture-secret'))), policyId, policyGeneration: 'pricing' });
    values.set('policies/' + policyId, { enabled: true, generation: 'pricing', providers: ['fireworks'], models: [modelId], tenantId: 'pricing',
      monthlyBudgetMicros: 1000000000000, requestCostMicros: null, budgetMode: 'reserve', retainRequestContent: retained,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { fireworks: ['fireworks'] } } });
    values.set('connections/fireworks', { providerId: 'fireworks', enabled: true });
    await take(own(putGrantCredentials(env, grantKey, { provider: 'fireworks', enabled: true, kind: 'api_key', credential: 'fixture-upstream-key' })));
    calls.length = 0;
    await run({ env, calls, sent, events, own, take, request, dispatch, drain, releases, bodyRoot,
      failMaterialization() { rejectMaterialize = true; },
      holdUpload() { upstreamGate = { entered: deferred(), release: deferred() }; releases.push(() => upstreamGate.release.resolve()); return upstreamGate; },
      holdArchive() { archiveGate = { entered: deferred(), release: deferred() }; releases.push(() => archiveGate.release.resolve()); return archiveGate; },
      async arrival(gate) {
        // Snapshot preceding roots BEFORE enrolling this waiter. Waiting on a
        // dynamically growing drain here would include this waiter's own root.
        const preceding = roots.map(root => root.outcome);
        await take(own(Promise.race([gate.entered.promise, Promise.all(preceding).then(() => { throw new Error('original roots ended before archive entry'); })])));
      },
      pressure(bytes) { pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged() - bytes); assert.ok(pressure); },
    });
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); done = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'owned pricing fixture outcomes');
  if (hasPrimary) throw primary;
}

test('pricing scope rejects forged and unregistered body provenance before funding', async () => {
  const before = bodyBudgetCharged(), cap = beginOwnedHttpRequest(new Request('https://router.example/v1/chat/completions'), {});
  const funded = bodyBudgetCharged(), body = payload({});
  let hasPrimary = false, primary;
  try {
    assert.throws(() => prepareOwnedHttpPricing(cap, body), isIdentityFailure);
    assert.throws(() => enterOwnedHttpPricing(cap, body), isIdentityFailure);
    assert.equal(bodyBudgetCharged(), funded);
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = [];
  try { await finishOwnedHttpRequest(cap); } catch (error) { failures.push(error); }
  try { assert.equal(bodyBudgetCharged(), before); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures);
  if (hasPrimary) throw primary;
});

for (const failedPreparation of [false, true]) test(`real owned token-priced depth 1025 uses bounded early${failedPreparation ? '-only' : ' and late'} traversal`, async t => {
  await fixture(t, async f => {
    let nested = 'text'; for (let index = 0; index < 1025; index++) nested = { ownedPricingNested: nested };
    const input = payload({ messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic', extra: nested }] }] });
    const expectedWire = JSON.stringify(transformed(input)), bytes = Buffer.byteLength(expectedWire);
    const original = Object.values; let recursiveValues = 0;
    t.mock.method(Object, 'values', function (value) { if (value && Object.hasOwn(value, 'ownedPricingNested')) recursiveValues++; return Reflect.apply(original, this, [value]); });
    if (failedPreparation) f.failMaterialization();
    const response = await f.request(input); await f.drain();
    assert.equal(response.status, failedPreparation ? 503 : 200); assert.equal(recursiveValues, 0, 'neither reached pricing phase uses recursive Object.values');
    assert.equal(f.sent.length, failedPreparation ? 0 : 1);
    if (!failedPreparation) {
      assert.equal(f.sent[0].text, expectedWire, 'pricing does not alter unknown input');
      const price = model.pricing, expected = Math.ceil((bytes + price.inputTokenOverhead) * price.inputMicrosPerMillion / 1000000) + Math.ceil(price.outputMicrosPerMillion / 1000000);
      const reservations = f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve');
      assert.equal(reservations.length, 1); assert.equal(reservations[0].body.costMicros, expected);
      assert.equal(f.events.length, 1); assert.equal(f.events[0].reserved_cost_micros, expected);
    } else assert.equal(f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve').length, 0);
  });
});

test('OFF large-body early identity is retired before covered admission reserves its genuine owners', async t => {
  await fixture(t, async f => {
    const input = payload({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
    const response = await f.request(input); await f.drain();
    assert.equal(response.status, 200);
    const admissions = f.calls.filter(row => row.kind === 'authority' && row.path === '/admission/resolve');
    assert.equal(admissions.length, 2, 'identity-only intake and genuinely covered provider admission');
    assert.ok(admissions[0].charged >= 32 * 1024 * 1024);
    assert.ok(admissions[1].charged >= 64 * 1024 * 1024, 'new admission and foreground remain positively funded');
    assert.ok(admissions[1].charged < bodyBudgetBytes, 'no third unused 32 MiB intake owner');
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve').length, 1);
    assert.equal(f.events.length, 1);
  });
});

const pricingCases = [
  ['escaped Unicode/numbers/own proto', () => { const extra = JSON.parse('{"__proto__":{"kept":true}}'); extra.quoted = 'a"\\\n\u0001'; extra.unicode = 'é😀\ud800x\udfff'; extra.numbers = [-0, 1e21, 1e-7, Infinity]; return { extra }; }],
  ['wide content and cache fields', () => ({ messages: [{ role: 'user', content: Array.from({ length: 4096 }, (_, index) => ({ type: 'text', text: String(index), extra: { cache_control: null } })) }] })],
  ['scalar tool inventory and tagged unknown Chat data', () => ({ tools: Array.from({ length: 4096 }, (_, index) => index % 2 ? null : 'unknown'), input: [{ type: 'additional_tools', tools: [{ type: 'web_search' }] }] })],
  ['null media property is present', () => ({ messages: [{ role: 'user', content: [{ type: 'text', file_id: null }] }] })],
  ['media outside exact roots is ordinary text', () => ({ extra: { image_url: null, cache_control: { ttl: '5m' } } })],
  ['one-hour early return ignores larger five-minute rate', () => ({ extra: [{ cache_control: { ttl: '1h' } }, { cache_control: { ttl: '5m' } }] })],
];

for (const depth of [128, 129]) test(`expanded owned intake preserves the existing depth ${depth} boundary`, async t => {
  await fixture(t, async f => {
    // Whitespace crosses the existing 8 MiB parser boundary without making a
    // larger retained graph. Include escaped quotes/brackets in the scalar so
    // the private feed partition must distinguish structure from string data.
    let nested = 'quoted " \\ {[ ]}';
    for (let index = 1; index < depth; index++) nested = { child: nested };
    const wire = ' '.repeat(8 * 1024 * 1024) + JSON.stringify({ extra: nested });
    const response = await f.request(wire); await f.drain();
    assert.equal(response.status, depth === 128 ? 400 : 413);
    assert.equal(JSON.parse(response.text).error.code, depth === 128 ? 'model_required' : 'request_too_large');
    assert.equal(f.sent.length, 0);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/grant-pools/select').length, 0);
    assert.equal(f.calls.filter(row => row.kind === 'budget').length, 0);
  });
});
for (const [name, make] of pricingCases) test('owned pricing preserves ordinary math and wire: ' + name, async t => {
  const saved = model.pricing; model.pricing = { ...saved, cacheWrite1hInputMicrosPerMillion: 2000000, cacheWrite5mInputMicrosPerMillion: 9000000 };
  t.after(() => { model.pricing = saved; });
  await fixture(t, async f => {
    const input = payload(make()), expected = ordinaryCost(input), wire = JSON.stringify(transformed(input));
    const response = await f.request(input); await f.drain();
    assert.equal(response.status, 200); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, wire);
    const reserve = f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve');
    assert.equal(reserve.length, 1); assert.equal(reserve[0].body.costMicros, expected.reserveMicros);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].reserved_cost_micros, expected.reserveMicros);
    const settlement = f.calls.find(row => row.kind === 'budget' && row.path === '/settle');
    assert.equal(settlement.body.reservationId, reserve[0].body.reservationId);
    if (name.startsWith('escaped')) assert.ok(Object.hasOwn(JSON.parse(f.sent[0].text).extra, '__proto__'));
  });
});

test('late token pricing overlaps the held ORIGINAL one-MiB upload without waiting on public completion', async t => {
  await fixture(t, async f => {
    const input = payload({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
    const expected = ordinaryCost(input), gate = f.holdUpload(), dispatch = f.dispatch(input);
    // Arrival is raced against the ORIGINAL outcome; an early error cannot hang cleanup.
    const arrived = f.own(Promise.race([gate.entered.promise.then(() => true), dispatch.outcome.then(value => {
      if (value.failed) throw value.error; throw new Error('request fulfilled before upload entry');
    })]));
    await f.take(arrived);
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024, 'original upload and generation/credential owners remain funded');
    gate.release.resolve();
    const response = await f.take(dispatch); assert.equal(response.status, 200); await f.take(f.bodyRoot(response)); await f.drain();
    assert.equal(f.calls.find(row => row.kind === 'budget' && row.path === '/reserve').body.costMicros, expected.reserveMicros);
  });
});

test('pricing/common preparation pressure fails before full admission count or budget effects', async t => {
  await fixture(t, async f => {
    f.pressure(40 * 1024 * 1024);
    const response = await f.request(payload({ extra: Array.from({ length: 8192 }, () => ({ value: null })) }));
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-clawrouter-error-code'), 'identity_admission_unavailable');
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/admission/resolve').length, 0);
    assert.equal(f.calls.filter(row => row.kind === 'budget').length, 0); assert.equal(f.sent.length, 0);
  });
});

test('prospective serializer funding refuses before the first media rewrite or selection effect', async t => {
  await fixture(t, async f => {
    const input = payload({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }], extra: { serializationWitness: true } });
    const wire = JSON.stringify(input), original = JSON.stringify; let serializerCalls = 0;
    t.mock.method(JSON, 'stringify', function (value, ...args) {
      if (value?.model === model.upstream && value?.extra?.serializationWitness === true) serializerCalls++;
      return Reflect.apply(original, this, [value, ...args]);
    });
    f.pressure(40 * 1024 * 1024);
    const response = await f.request(wire);
    assert.equal(response.status, 503); assert.equal(serializerCalls, 0);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/admission/resolve').length, 0);
    assert.equal(f.calls.filter(row => row.kind === 'budget' || row.kind === 'archive').length, 0); assert.equal(f.sent.length, 0);
  });
});

test('public JSON is delivered while the ORIGINAL archive and its separately funded copy remain held', async t => {
  await fixture(t, async f => {
    const gate = f.holdArchive(), input = payload({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
    const response = await f.request(input);
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).id, 'synthetic-priced-chat');
    await f.arrival(gate);
    assert.equal(f.calls.filter(row => row.kind === 'archive-complete').length, 0);
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024, 'archive original/copy and HTTP consumers remain funded');
    gate.release.resolve(); await f.drain();
    assert.equal(f.calls.filter(row => row.kind === 'archive-complete').length, 1);
    assert.equal(f.events.length, 1);
  }, true);
});
