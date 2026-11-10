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
import { ownedJsonCodecCases, ownedJsonCodecWire } from '../../test/helpers/owned-json-parser-cases.mjs';

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
async function fixture(t, run, retained = false, variant = 'fireworks') {
  const activeProvider = snapshot.providers.find(item => item.id === variant);
  const activeModel = variant === 'venice' ? activeProvider.models.find(item => item.id === 'venice/zai-org-glm-5-2') : model;
  const activeGrantKey = 'oauth/' + policyId + '/' + variant;
  const baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), bodies = new WeakMap();
  const resources = [], releases = [], values = new Map(), calls = [], sent = [], events = [], retirements = [];
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
  let upstreamGate, veniceWire, veniceFault, veniceStreaming = false;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    if (upstreamGate) { upstreamGate.entered.resolve(); await take(own(upstreamGate.release.promise)); }
    const text = await take(own(request.text())); sent.push({ text, method: request.method, url: request.url });
    if (variant === 'venice') {
      const headers = {
        'content-type': veniceStreaming ? 'text/event-stream' : 'application/json', 'content-length': String(Buffer.byteLength(veniceWire)),
        etag: 'fixture-etag', digest: 'fixture-digest', 'content-md5': 'fixture-md5',
      };
      const response = veniceStreaming ? new Response(new ReadableStream({ type: 'bytes', start(controller) {
        controller.enqueue(new TextEncoder().encode(veniceWire)); controller.close();
      } }), { headers }) : accessBytesResponse(veniceWire, '', { headers });
      if (!veniceFault) return response;
      const fault = veniceFault, body = response.body;
      const observed = new Proxy(body, { get(target, key) {
        if (key === 'getReader') return options => {
          const reader = target.getReader(options);
          return new Proxy(reader, { get(current, name) {
            if (name === 'read') return (...args) => {
              fault.read++; const original = Reflect.apply(current.read, current, args);
              return original.then(value => { fault.readSettled++; if (fault.read > fault.afterReads) throw fault.reason; return value; });
            };
            if (name === 'cancel') return (...args) => {
              fault.cancel++; const original = Reflect.apply(current.cancel, current, args);
              return original.then(async () => {
                fault.cancelSettled++; fault.entered.resolve(); await fault.release.promise; throw fault.reason;
              });
            };
            if (name === 'releaseLock') return () => { Reflect.apply(current.releaseLock, current, []); fault.unlock++; throw fault.reason; };
            const value = Reflect.get(current, name, current); return typeof value === 'function' ? value.bind(current) : value;
          } });
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return new Proxy(response, { get(target, key) {
        if (key === 'body') return observed;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    return Response.json({ id: 'synthetic-priced-chat', model: model.upstream, choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
  });
  const dispatch = input => {
    const original = privateOwnedHttpChat.fetch(new Request('https://router.example/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer clawrouter-live-' + kid + '-fixture-secret', 'content-type': 'application/json' },
      body: accessBytesResponse(typeof input === 'string' ? input : JSON.stringify(input)).body, duplex: 'half',
    }), env, { waitUntil: promise => { retirements.push(own(promise)); } });
    const root = own(original); own(original.then(response => { bodyRoot(response); }, () => {})); return root;
  };
  const request = async input => { const response = await take(dispatch(input)); return { status: response.status, text: await take(bodyRoot(response)), headers: response.headers }; };
  const drain = async () => { for (let i = 0; i < roots.length; i++) await roots[i].outcome; };
  try {
    values.set('credentials/' + kid, { enabled: true, secretSha256: await take(own(sha256Hex('fixture-secret'))), policyId, policyGeneration: 'pricing' });
    values.set('policies/' + policyId, { enabled: true, generation: 'pricing', providers: [variant], models: [activeModel.id], tenantId: 'pricing',
      monthlyBudgetMicros: 1000000000000, requestCostMicros: null, budgetMode: 'reserve', retainRequestContent: retained,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { [variant]: [variant] } } });
    values.set('connections/' + variant, { providerId: variant, enabled: true });
    await take(own(putGrantCredentials(env, activeGrantKey, { provider: variant, enabled: true, kind: 'api_key', credential: 'fixture-upstream-key' })));
    calls.length = 0;
    await run({ env, calls, sent, events, own, take, request, dispatch, drain, releases, bodyRoot, retirements,
      veniceResponse(wire, streaming = false) { assert.equal(variant, 'venice'); veniceWire = wire; veniceStreaming = streaming; },
      failVeniceSource(reason, afterReads = 0) {
        assert.equal(variant, 'venice'); assert.equal(veniceFault, undefined);
        veniceFault = { reason, afterReads, read: 0, readSettled: 0, cancel: 0, cancelSettled: 0, unlock: 0, entered: deferred(), release: deferred() };
        releases.push(() => veniceFault.release.resolve()); return veniceFault;
      },
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

const veniceModelId = 'venice/zai-org-glm-5-2', veniceUpstream = 'zai-org-glm-5-2';
const venicePrefix = '{"model":"' + veniceUpstream + '","extra":';
for (const streaming of [false, true]) test('real owned Venice ' + (streaming ? 'SSE' : 'JSON') + ' compact parser preserves deep/mixed/key/number and ordinary string boundaries', async t => {
  await fixture(t, async f => {
    for (const [mode, valid] of ownedJsonCodecCases) {
      const wire = ownedJsonCodecWire(mode, veniceUpstream), delivered = streaming ? 'data: ' + wire + '\n\ndata: [DONE]\n\n' : wire;
      f.veniceResponse(delivered, streaming);
      const before = f.calls.length, eventCount = f.events.length;
      const response = await f.take(f.dispatch(payload({ model: veniceModelId, ...(streaming ? { stream: true } : {}) })));
      let text, failed = false;
      try { text = await f.take(f.bodyRoot(response)); } catch (error) { if (!streaming || valid) throw error; failed = true; }
      await f.drain();
      assert.equal(response.status, streaming || valid ? 200 : 502, mode);
      assert.equal(failed, streaming && !valid, mode);
      if (valid) {
        assert.equal(text, delivered, mode + ' exact original response bytes');
        const value = JSON.parse(streaming ? text.slice(6, text.indexOf('\n\n')) : text);
        assert.deepEqual(value, JSON.parse(wire)); assert.equal(value.model, veniceUpstream);
        assert.deepEqual(value.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
      }
      assert.equal(f.calls.slice(before).filter(row => row.kind === 'authority' && row.path === '/authorization/snapshot').length, valid ? 2 : 1, mode);
      assert.equal(f.events.length - eventCount, 1, mode + ' original accounting event');
    }
  }, false, 'venice');
});

for (const [name, expected, make] of [
  ['depth 128', 200, () => venicePrefix + '['.repeat(127) + '0' + ']'.repeat(127) + '}'],
  ['object depth 128', 200, () => venicePrefix + '{"child":'.repeat(127) + '0' + '}'.repeat(128)],
  ['depth 129', 502, () => venicePrefix + '['.repeat(128) + '0' + ']'.repeat(128) + '}'],
  ['2048-parent single prefix', 502, () => venicePrefix + '['.repeat(2048)],
  ['65536 nodes', 200, () => venicePrefix + '[' + '0,'.repeat(65532) + '0]}'],
  ['65537 nodes', 502, () => venicePrefix + '[' + '0,'.repeat(65533) + '0]}'],
  ['4096-unit key', 200, () => venicePrefix + '{"' + 'k'.repeat(4096) + '":0}}'],
  ['4097-unit key', 502, () => venicePrefix + '{"' + 'k'.repeat(4097) + '":0}}'],
  ['exact wire limit', 200, () => venicePrefix + '"' + 'x'.repeat(2097152 - Buffer.byteLength(venicePrefix) - 3) + '"}'],
  ['wire limit plus one', 502, () => venicePrefix + '"' + 'x'.repeat(2097153 - Buffer.byteLength(venicePrefix) - 3) + '"}'],
  ['escaped Unicode and duplicate own data', 200, () => venicePrefix + '{"__proto__":{"kept":true},"duplicate":1,"duplicate":2,"text":"é😀\\ud800x\\udfff\\n\\\"\\\\"}}'],
  ['wrong returned model', 502, () => '{"model":"different-model","extra":null}'],
  ['own error field including null', 502, () => '{"model":"' + veniceUpstream + '","error":null}'],
]) test('real owned Venice JSON codec preserves ' + name, async t => {
  await fixture(t, async f => {
    const wire = make(); f.veniceResponse(wire);
    const input = payload({ model: veniceModelId }), response = await f.request(input); await f.drain();
    assert.equal(response.status, expected);
    assert.equal(f.sent.length, 1, 'the original selected upstream is dispatched exactly once');
    assert.equal(JSON.parse(f.sent[0].text).model, veniceUpstream);
    assert.equal(f.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/authorization/snapshot').length, expected === 200 ? 2 : 1);
    if (expected === 200) {
      assert.equal(response.text, wire, 'unknowns, duplicates and original wire survive validation unchanged');
      assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(wire)));
      assert.equal(response.headers.get('etag'), null); assert.equal(response.headers.get('digest'), null);
      assert.equal(response.headers.get('content-md5'), null); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const parsed = JSON.parse(response.text);
      if (name === 'escaped Unicode and duplicate own data') {
        assert.equal(Object.hasOwn(parsed.extra, '__proto__'), true); assert.deepEqual(parsed.extra.__proto__, { kept: true });
        assert.equal(parsed.extra.duplicate, 2); assert.equal(parsed.extra.text, 'é😀\ud800x\udfff\n"\\');
      }
    }
    const reservation = f.calls.find(row => row.kind === 'budget' && row.path === '/reserve');
    assert.ok(reservation); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].reserved_cost_micros, reservation.body.costMicros);
  }, false, 'venice');
});

test('owned Venice JSON publication does not retire a held ORIGINAL archive', async t => {
  await fixture(t, async f => {
    const wire = '{"model":"' + veniceUpstream + '","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3}}';
    f.veniceResponse(wire);
    const gate = f.holdArchive(), response = await f.request(payload({ model: veniceModelId }));
    assert.equal(response.status, 200); assert.equal(response.text, wire); await f.arrival(gate);
    assert.equal(f.calls.filter(row => row.kind === 'archive-complete').length, 0);
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024, 'original archive and foreground graph remain funded after public delivery');
    gate.release.resolve(); await f.drain();
    assert.equal(f.calls.filter(row => row.kind === 'archive-complete').length, 1);
  }, true, 'venice');
});

for (const streaming of [false, true]) for (const kind of ['undefined', 'shared', 'huge'])
test('owned Venice ' + (streaming ? 'delivered SSE' : 'JSON') + ' first observers retain independent origins without retaining ' + kind + ' rejection data', async t => {
  let reasonReads = 0;
  const opaque = {};
  for (const key of ['message', 'stack', 'cause', 'errors', 'code', 'status'])
    Object.defineProperty(opaque, key, { get() { reasonReads++; throw new Error('raw fixture reason observed'); } });
  const reason = kind === 'undefined' ? undefined : kind === 'huge' ? 'x'.repeat(17 * 1024 * 1024) : opaque;
  await fixture(t, async f => {
    const json = '{"model":"' + veniceUpstream + '","choices":[]}';
    f.veniceResponse(streaming ? 'data: ' + json + '\n\ndata: [DONE]\n\n' : json, streaming);
    const gate = f.failVeniceSource(reason, streaming ? 1 : 0), dispatch = f.dispatch(payload({ model: veniceModelId, ...(streaming ? { stream: true } : {}) }));
    const progress = streaming ? f.own(dispatch.outcome.then(async outcome => {
      if (outcome.failed) throw outcome.error;
      const body = await f.bodyRoot(outcome.value).outcome;
      if (body.failed) throw body.error;
      throw new Error('codec body completed before original cancellation hold');
    })) : undefined;
    await f.take(f.own(Promise.race([gate.entered.promise, (progress ?? dispatch).outcome.then(outcome => {
      if (outcome.failed) throw outcome.error;
      throw new Error('codec returned before original cancellation hold');
    })])));
    assert.equal(gate.read, streaming ? 2 : 1); assert.equal(gate.readSettled, streaming ? 2 : 1);
    assert.equal(gate.cancel, 1); assert.equal(gate.cancelSettled, 1); assert.equal(gate.unlock, 0);
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024); assert.equal(reasonReads, 0);
    gate.release.resolve();
    const response = await f.take(dispatch);
    let text, bodyFailed = false, bodyFailure;
    try { text = await f.take(f.bodyRoot(response)); } catch (error) { bodyFailed = true; bodyFailure = error; }
    if (progress) try { await f.take(progress); } catch { /* same memoized body origin, asserted below */ }
    await f.drain();
    const terminalFailures = [];
    for (const root of f.retirements) {
      const outcome = await root.outcome;
      if (outcome.failed) try { await f.take(root); } catch (error) { terminalFailures.push(error); }
    }
    try {
      assert.equal(response.status, streaming ? 200 : 502);
      assert.equal(bodyFailed, streaming);
      if (streaming) assert.ok(bodyFailure instanceof AggregateError);
      else assert.equal(JSON.parse(text).error.code, 'provider_unavailable');
      assert.equal(gate.unlock, 1); assert.equal(reasonReads, 0);
      assert.equal(terminalFailures.length, 1);
      assert.ok(terminalFailures[0] instanceof AggregateError);
      const failures = terminalFailures[0].errors;
      assert.equal(failures.length, 3);
      assert.deepEqual(failures.map(value => Object.getOwnPropertyDescriptor(value, 'origin')?.value), ['read', 'cancel', 'unlock']);
      assert.ok(failures.every(value => Object.getOwnPropertyDescriptor(value, 'primaryIsUndefined')?.value === (kind === 'undefined')));
      assert.ok(failures.every(value => value !== reason), 'only bounded origin records leave the first observers');
      assert.equal(new Set(failures).size, 3, 'a shared original reason does not merge independent origins');
      assert.equal(f.sent.length, 1);
    } catch (validation) {
      throw new AggregateError([...(bodyFailed ? [bodyFailure] : []), ...terminalFailures, validation], 'owned codec failure-consumer validation');
    }
  }, false, 'venice');
});
