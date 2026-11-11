import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOwnedJsonObservation, observeOwnedJsonSource } from '../../test/helpers/owned-json-parser-observer.mjs';
import { ownedJsonCodecCases, ownedJsonCodecWire, ownedUsageCases, ownedUsageWire, ownedCodecSseLines } from '../../test/helpers/owned-json-parser-cases.mjs';
import { assertOwnedDriverOrigins, ownedSinkInstallationWitness, assertOwnedSinkInstallation, assertOwnedAckCustody, createOwnedAckPhaseFixture, createOwnedBudgetSequenceFixture, createOwnedTerminalFixture } from '../../test/helpers/owned-http-chat-fixture.mjs';

const observation = globalThis.__ownedJsonObservation = createOwnedJsonObservation();
globalThis.__ownedUsageWire = ownedUsageWire;
const sourceHooks = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:') || !/(?:json-body|pricing|credential-preflight|credential-cache|proxy|proxy-accounting|proxy-response|proxy-completion|token-usage|http-identity-owner|venice-chat-runtime)\.ts$/.test(url)) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  return { ...result, source: observeOwnedJsonSource(fileURLToPath(url), source) };
} });
after(() => { sourceHooks.deregister(); delete globalThis.__ownedJsonObservation; delete globalThis.__ownedUsageWire; });
await import('./typescript-setup.mjs');
const { privateOwnedHttpChat } = await import('../index.ts');
const { continuationAuthority } = await import('./continuation-authority.mjs');
const { attachGrantCredentialNamespace } = await import('./grant-credential-mock.mjs');
const { sqlBudgetNamespace } = await import('./sql-budget-namespace.mjs');
const { accessBytesResponse } = await import('./access-byte-fixture.mjs');
const { putGrantCredentials } = await import('../grant-credentials.ts');
const { snapshot } = await import('../providers.ts');
const { estimateCost, OwnedHttpAccountingCommand } = await import('../proxy-accounting.ts');
const { bodyBudgetCharged, bodyBudgetBytes, ExactBodyCharge } = await import('../body-budget.ts');
const { sha256Hex, HttpError } = await import('../utils.ts');
const { evictCredentialGeneration } = await import('../credential-preflight.ts');
const { prepareOwnedHttpPricing, enterOwnedHttpPricing } = await import('../pricing.ts');
const { beginOwnedHttpRequest, finishOwnedHttpRequest } = await import('../http-identity-owner.ts');
const budgetCommands = await import('../http-identity-owner.ts');
const { isIdentityFailure } = await import('../identity-admission.ts');
const { beginOwnedCodecConsumer, normalizeOwnedCodecPreStreamError, observeOwnedCodecUsage, ownedCodecUsageCompletion, checkOwnedAcceptedUsageReceiver, matchesOwnedAcceptedUsageSnapshot, checkOwnedAcceptedUsageTerminal } = await import('../proxy-response.ts');
const { HttpOperation } = await import('../http-operation.ts');
const { createSseUsageInspector, extractUsageTokens, responseOutcome } = await import('../token-usage.ts');

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

test('private codec claims one permanent COMMON baseline before its first validator', async t => {
  const baseline = bodyBudgetCharged();
  assert.equal(observation.shared.claims, 0);
  await fixture(t, async f => {
    f.veniceResponse('{"model":"zai-org-glm-5-2","extra":');
    const failed = await f.request(payload({ model: 'venice/zai-org-glm-5-2' }));
    assert.equal(failed.status, 502);
    assert.equal(observation.shared.claims, 1); assert.equal(observation.shared.held, 65536);
    assert.equal(observation.rows.at(-1).cleared, true); assert.equal(observation.rows.at(-1).nativeParses, 0);
    f.veniceResponse(ownedJsonCodecWire('compact-object128', 'zai-org-glm-5-2'));
    const responses = await Promise.all([f.request(payload({ model: 'venice/zai-org-glm-5-2' })), f.request(payload({ model: 'venice/zai-org-glm-5-2' }))]);
    assert.ok(responses.every(response => response.status === 200)); await f.drain();
    assert.equal(observation.shared.claims, 1);
    assert.ok(observation.rows.slice(-2).every(row => row.cleared && row.nativeParses === 1));
  }, false, 'venice');
  assert.equal(bodyBudgetCharged(), baseline + 65536, 'all request owners retired; only shared module custody remains');
});

test('owned later object-128 SSE retains raw wire, usage and one selected/accounting outcome', async t => {
  await fixture(t, async f => {
    const model = 'zai-org-glm-5-2', first = JSON.stringify({ model, choices: [] });
    const wire = 'data: ' + first + '\n\ndata: ' + ownedJsonCodecWire('compact-object-string128', model) + '\n\ndata: [DONE]\n\n';
    f.veniceResponse(wire, true);
    const response = await f.request({ model: 'venice/' + model, stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] });
    assert.equal(response.status, 200); assert.equal(response.text, wire);
    await f.drain();
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/authorization/snapshot').length, 2);
    assert.equal(f.events.length, 1);
  }, false, 'venice');
});

test('owned Chat keeps the complete comment prefix and subsequent JSON data byte-for-byte', async t => {
  await fixture(t, async f => {
    const model = 'zai-org-glm-5-2', prefix = ':' + 'x'.repeat(8192) + '\n\n';
    const wire = prefix + 'data: ' + ownedJsonCodecWire('compact-object128', model) + '\n\ndata: [DONE]\n\n';
    f.veniceResponse(wire, true);
    const response = await f.request({ model: 'venice/' + model, stream: true });
    assert.equal(response.status, 200); assert.equal(response.text, wire);
    await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/authorization/snapshot').length, 2);
  }, false, 'venice');
});

test('owned later rejected frame fails the body after the healthy prefix published HTTP 200', async t => {
  await fixture(t, async f => {
    const model = 'zai-org-glm-5-2';
    f.veniceResponse('data: ' + JSON.stringify({ model, choices: [] }) + '\n\ndata: '
      + ownedJsonCodecWire('compact-object129', model) + '\n\ndata: [DONE]\n\n', true);
    const response = await f.take(f.dispatch({ model: 'venice/' + model, stream: true }));
    assert.equal(response.status, 200); await assert.rejects(f.take(f.bodyRoot(response)));
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'authority' && row.path === '/authorization/snapshot').length, 2);
  }, false, 'venice');
});

test('private codec consumer rejects fabricated owners before original reader acquisition', async () => {
  const baseline = bodyBudgetCharged(), operation = new HttpOperation();
  let acquired = 0;
  const body = new ReadableStream({ pull(controller) { controller.close(); } }, { highWaterMark: 0 });
  const getReader = body.getReader;
  Object.defineProperty(body, 'getReader', { value(...args) { acquired++; return Reflect.apply(getReader, this, args); } });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } }), cap = Object.freeze({});
  try {
    assert.throws(() => beginOwnedCodecConsumer(cap, cap, response, operation, true, 'fixture-request', undefined,
      { providerId: 'venice', requestFormat: 'openai.chat_completions', responseFormat: 'openai.chat_completions' }), isIdentityFailure);
    await assert.rejects(normalizeOwnedCodecPreStreamError(cap, response, true, operation, { format: 'openai', requestId: 'fixture-request' }), isIdentityFailure);
    assert.throws(() => observeOwnedCodecUsage(cap, response, operation), isIdentityFailure);
    assert.throws(() => ownedCodecUsageCompletion(cap), isIdentityFailure);
    assert.throws(() => checkOwnedAcceptedUsageReceiver(cap, response, 'sse', undefined, false), isIdentityFailure);
    assert.equal(matchesOwnedAcceptedUsageSnapshot(cap, 1, new Uint8Array([1])), false);
    assert.throws(() => checkOwnedAcceptedUsageTerminal(cap, true), isIdentityFailure);
    assert.equal(acquired, 0); assert.equal(bodyBudgetCharged(), baseline);
  } finally { await body.cancel(); operation.stop('complete'); }
});

// Original dispatch, late body and accepted background roots share ONE outcome
// identity. Release gates first, dynamically join all finite roots, then retire
// generation publication and fixture resources. Mocks stay installed until joins.
async function fixture(t, run, retained = false, variant = 'fireworks') {
  const activeProvider = snapshot.providers.find(item => item.id === variant);
  const activeModel = variant === 'venice' ? activeProvider.models.find(item => item.id === 'venice/zai-org-glm-5-2')
    : variant === 'gmi' ? activeProvider.models.find(item => item.id === 'gmi/deepseek-ai/DeepSeek-V4-Pro') : model;
  const activeGrantKey = 'oauth/' + policyId + '/' + variant;
  const baseline = bodyBudgetCharged(), sharedBaseline = observation.shared.held, roots = [], origins = new WeakMap(), bodies = new WeakMap();
  const resources = [], releases = [], values = new Map(), calls = [], sent = [], events = [], retirements = [];
  let done = false, cleanupPromise, hasPrimary = false, primary, rejectMaterialize = false, retryMode, pressure, archiveGate, requestEnv, unknownRetirement = false;
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
    for (let i = 0; i < roots.length; i++) if (!unknownRetirement || !retirements.includes(roots[i])) await roots[i].outcome;
    for (const root of roots) { if (unknownRetirement && retirements.includes(root)) continue; const value = await root.outcome; if (value.failed && !root.used) { root.used = true; failures.push(value.error); } }
    try { evictCredentialGeneration(requestEnv ?? env, kid); } catch (error) { failures.push(error); }
    if (!unknownRetirement) try { assert.equal(bodyBudgetCharged(), baseline + observation.shared.held - sharedBaseline, 'exact request retirement plus permanent shared custody'); } catch (error) { failures.push(error); }
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
      const path = new URL(url).pathname, key = typeof init?.body === 'string' ? JSON.parse(init.body).key : undefined;
      calls.push({ kind: 'credential', path, key, signal: init?.signal, charged: bodyBudgetCharged() });
      if (retryMode && path === '/materialize' && (retryMode === 'preparation' && !key.endsWith('-d') && !key.endsWith('-e')
        || retryMode === 'mixed' && (key.endsWith('-a') || key.endsWith('-c'))
        || retryMode === 'failed-alternate' && !key.endsWith('-a'))) return Promise.resolve(accessBytesResponse('{"error":{"code":"grant_credential_missing","message":"synthetic refusal"}}', '', { status: 503 }));
      if (rejectMaterialize && path === '/materialize') return Promise.resolve(accessBytesResponse('{"error":{"code":"grant_credential_missing","message":"synthetic refusal"}}', '', { status: 503 }));
      return stub.fetch(url, init);
    } };
  };
  let upstreamGate, veniceWire, veniceFault, veniceStreaming = false, upstreamStatus = 200;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const custody = globalThis.__ownedAckPhaseFixture?.fetch(init); if (custody) return custody;
    return (async () => {
    const held = globalThis.__ownedAckPhaseFixture?.upload(init); if (held) return held;
    const request = new Request(input, init);
    if (upstreamGate) { upstreamGate.entered.resolve(); await take(own(upstreamGate.release.promise)); }
    const text = await take(own(request.text())); sent.push({ text, method: request.method, url: request.url, authorization: request.headers.get('authorization') });
    if (retryMode) {
      const authorization = request.headers.get('authorization'), name = authorization?.slice(-1);
      if (retryMode === 'exhausted' || name !== 'd') {
        const status = retryMode === 'response' ? { a: 401, b: 403, c: 429 }[name] ?? 429 : 429;
        return accessBytesResponse(JSON.stringify({ error: { message: 'synthetic rejection ' + name, type: 'rate_limit_error' } }), '', { status });
      }
    }
    if (variant === 'venice') {
      const headers = {
        'content-type': veniceStreaming ? 'text/event-stream' : 'application/json', 'content-length': String(Buffer.byteLength(veniceWire)),
        etag: 'fixture-etag', digest: 'fixture-digest', 'content-md5': 'fixture-md5',
      };
      const response = veniceStreaming ? new Response(new ReadableStream({ type: 'bytes', start(controller) {
        controller.enqueue(new TextEncoder().encode(veniceWire)); controller.close();
      } }), { status: upstreamStatus, headers }) : accessBytesResponse(veniceWire, '', { status: upstreamStatus, headers });
      if (!veniceFault) return response;
      const fault = veniceFault, body = response.body;
      const observed = new Proxy(body, { get(target, key) {
        if (key === 'getReader') return options => {
          const reader = target.getReader(options);
          if (fault.mode) {
            const read = reader.read, unlock = reader.releaseLock;
            Object.defineProperty(reader, 'read', { value(...args) {
              fault.read++; const original = Reflect.apply(read, this, args);
              return original.then(value => { fault.readSettled++; return value; });
            } });
            if (fault.mode === 'closed-getter') Object.defineProperty(reader, 'closed', { get() { fault.closedGetter++; throw fault.reason; } });
            if (fault.mode === 'closed' || fault.mode === 'unlock-before-closed') {
              const original = reader.closed;
              const observed = original.then(() => {
                fault.closedNative++; if (fault.mode === 'closed') fault.entered.resolve();
                return fault.release.promise.then(() => { fault.closedSettled++; if (fault.failed) throw fault.reason; });
              });
              Object.defineProperty(reader, 'closed', { get() { return observed; } });
            }
            Object.defineProperty(reader, 'releaseLock', { value(...args) {
              fault.unlock++;
              const native = () => { Reflect.apply(unlock, this, args); fault.nativeUnlocked++; };
              if (fault.mode.startsWith('closed')) { native(); fault.unlockSettled++; return; }
              if (fault.mode.startsWith('unlock-before')) native();
              fault.entered.resolve();
              const original = fault.release.promise.then(() => {
                if (fault.mode === 'unlock-after') native();
                fault.unlockSettled++; if (fault.failed) throw fault.reason;
              });
              return fault.mode === 'unlock-after' && !fault.failed ? { then(fulfilled, rejected) {
                fault.thenCalls++; return original.then(fulfilled, rejected);
              } } : original;
            } });
            return reader;
          }
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
    return Response.json({ id: 'synthetic-priced-chat', model: activeModel.upstream, choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }, { status: upstreamStatus });
    })();
  });
  requestEnv = env;
  const dispatch = input => {
    const original = privateOwnedHttpChat.fetch(new Request('https://router.example/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer clawrouter-live-' + kid + '-fixture-secret', 'content-type': 'application/json' },
      body: accessBytesResponse(typeof input === 'string' ? input : JSON.stringify(input)).body, duplex: 'half',
    }), requestEnv, { waitUntil: promise => { retirements.push(own(promise)); } });
    const root = own(original); own(original.then(response => { bodyRoot(response); }, () => {})); return root;
  };
  const request = async input => { const response = await take(dispatch(input)); return { status: response.status, text: await take(bodyRoot(response)), headers: response.headers }; };
  const drain = async () => { for (let i = 0; i < roots.length; i++) if (!unknownRetirement || !retirements.includes(roots[i])) await roots[i].outcome; };
  try {
    values.set('credentials/' + kid, { enabled: true, secretSha256: await take(own(sha256Hex('fixture-secret'))), policyId, policyGeneration: 'pricing' });
    values.set('policies/' + policyId, { enabled: true, generation: 'pricing', providers: [variant], models: [activeModel.id], tenantId: 'pricing',
      monthlyBudgetMicros: 1000000000000, requestCostMicros: null, budgetMode: 'reserve', retainRequestContent: retained,
      grantRouting: { strategy: 'round_robin', environmentFallback: false, eligibleGrants: { [variant]: [variant] } } });
    values.set('connections/' + variant, { providerId: variant, enabled: true });
    await take(own(putGrantCredentials(env, activeGrantKey, { provider: variant, enabled: true, kind: 'api_key', credential: 'fixture-upstream-key', ...(variant === 'gmi' ? { accountId: 'fixture-organization' } : {}) })));
    calls.length = 0;
    await run({ env, calls, sent, events, own, take, request, dispatch, drain, releases, bodyRoot, retirements,
      requestEnvironment(value) { requestEnv = value; },
      expectUnknownRetirement() {
        assert.ok(process.env.CLAWROUTER_TERMINAL_UNKNOWN, 'UNKNOWN fixtures run in a separate process; no funding is refunded');
        unknownRetirement = true;
      },
      veniceResponse(wire, streaming = false) { assert.equal(variant, 'venice'); veniceWire = wire; veniceStreaming = streaming; },
      failVeniceSource(reason, afterReads = 0) {
        assert.equal(variant, 'venice'); assert.equal(veniceFault, undefined);
        veniceFault = { reason, afterReads, read: 0, readSettled: 0, cancel: 0, cancelSettled: 0, unlock: 0, entered: deferred(), release: deferred() };
        releases.push(() => veniceFault.release.resolve()); return veniceFault;
      },
      holdVeniceWork(mode, reason, failed) {
        assert.equal(variant, 'venice'); assert.equal(veniceFault, undefined);
        veniceFault = { mode, reason, failed, read: 0, readSettled: 0, unlock: 0, nativeUnlocked: 0, unlockSettled: 0, thenCalls: 0,
          closedNative: 0, closedSettled: 0, closedGetter: 0, entered: deferred(), release: deferred() };
        // Unconditionally release before any dispatch, even on setup/assertion failure.
        releases.push(() => veniceFault.release.resolve()); return veniceFault;
      },
      async retryPool(mode, unknownUnits = 4) {
        retryMode = mode;
        observation.retryPorts.length = 0; observation.credentialReductions.length = 0; observation.credentialCensuses.length = 0;
        const policy = values.get('policies/' + policyId);
        policy.grantRouting = { strategy: 'priority', environmentFallback: false, eligibleGrants: { [variant]: ['a', 'b', 'c', 'd', 'e'].map(name => variant + '-' + name) } };
        for (const [index, name] of ['a', 'b', 'c', 'd', 'e'].entries()) await take(own(putGrantCredentials(env, 'oauth/' + policyId + '/' + variant + '-' + name,
          { provider: variant, enabled: true, kind: 'api_key', credential: 'fixture-upstream-' + name, priority: 100 + index, ...(variant === 'gmi' ? { accountId: 'fixture-organization' } : {}),
            unknownOwnedField: { value: ['x'.repeat(unknownUnits), null, 7] } })));
        calls.length = 0;
      },
      upstreamStatus(status) { upstreamStatus = status; },
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

async function budgetSequence(f, options) {
  const legs = options.legs ?? 4;
  const policy = await f.env.POLICY_KV.get('policies/' + policyId, 'json');
  policy.monthlyBudgetMicros = legs ? 1000000000000 : null;
  policy.dailyBudgetMicros = legs >= 2 ? 1000000000000 : null;
  policy.weeklyBudgetMicros = legs >= 3 ? 1000000000000 : null;
  await f.env.POLICY_KV.put('policies/' + policyId, JSON.stringify(policy));
  await f.env.POLICY_KV.put('connections/fireworks', JSON.stringify({ providerId: 'fireworks', enabled: true, monthlyBudgetMicros: legs >= 4 ? 1000000000000 : null }));
  const control = createOwnedBudgetSequenceFixture({ legs, ...options }, ExactBodyCharge, bodyBudgetBytes, bodyBudgetCharged, HttpError, budgetCommands);
  assert.equal(globalThis.__ownedBudgetSequenceFixture, undefined);
  globalThis.__ownedBudgetSequenceFixture = control;
  f.releases.push(() => { control.release(); delete globalThis.__ownedBudgetSequenceFixture; });
  const namespace = f.env.BUDGET_LEDGER, queue = f.env.USAGE_QUEUE;
  f.env.BUDGET_LEDGER = {
    idFromName(name) { return Reflect.apply(namespace.idFromName, namespace, [name]); },
    get(name) { const stub = Reflect.apply(namespace.get, namespace, [name]); return { fetch(url, init) { return control.fetch(stub, url, init); } }; },
  };
  f.env.USAGE_QUEUE = { send(...args) { return control.send(queue, args); } };
  return control;
}

function terminalScenario(f, options) {
  const control = createOwnedTerminalFixture(options, budgetCommands);
  assert.equal(globalThis.__ownedTerminalFixture, undefined);
  globalThis.__ownedTerminalFixture = control;
  f.releases.push(() => { control.release(); delete globalThis.__ownedTerminalFixture; });
  f.requestEnvironment(control.env(f.env)); return control;
}

for (const options of [{ late: 'throw' }, { late: 'other', wrong: true }, { receipt: 'first' }, { receipt: 'both' },
  { shellFailure: true }, ...['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE'].map(factoryThrow => ({ factoryThrow })),
  { startFailure: true }])
test(`private prepaid terminal adoption ${JSON.stringify(options)}`, async t => {
  await fixture(t, async f => {
    const control = terminalScenario(f, options), response = await f.request(payload({}));
    await f.drain(); const row = control.row;
    assert.equal(row.shellAttempts, 1); assert.equal(row.lateGets, 0); assert.equal(row.methodsB, 0);
    assert.equal(row.foreignReads, 0); assert.equal(row.pending, 0);
    const usage = f.events.filter(value => value.type === 'clawrouter.usage.v1');
    if (options.shellFailure || options.factoryThrow) {
      assert.ok(response.status >= 400); assert.equal(row.adopted, 0); assert.equal(row.launches, 0);
      assert.equal(f.calls.filter(value => value.kind === 'budget').length, 0); assert.equal(f.sent.length, 0);
      assert.equal(usage.length, 0);
      if (options.factoryThrow) {
        const names = ['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE'];
        assert.ok(row.factories.length > 0);
        for (const trace of row.factories) assert.deepEqual(trace, names.slice(0, names.indexOf(options.factoryThrow) + 1));
      } else assert.equal(row.shells, 0);
    } else {
      assert.equal(response.status, 200); assert.equal(row.shells, 1); assert.equal(row.primary, 1);
      assert.equal(row.fallback, options.receipt ? 1 : 0);
      if (options.receipt === 'both') {
        assert.equal(row.failed, 1); assert.equal(row.adopted, 0); assert.equal(row.launches, 0);
        assert.deepEqual(row.logical, [false]); assert.equal(row.retainedFailure, true); assert.equal(usage.length, 0);
        assert.equal(f.calls.filter(value => value.kind === 'budget' && value.path === '/settle').length, 0);
        assert.deepEqual(row.diagnostics, [{ origin: 'terminal-prepare', undefined: true }, { origin: 'terminal-fallback', undefined: true }]);
      } else {
        assert.equal(row.adopted, 1); assert.equal(row.launches, 1); assert.equal(usage.length, 1);
        assert.deepEqual(row.order, ['adopt', 'close', 'install', 'launch']);
        assert.deepEqual(row.logical, [!options.startFailure]);
        assert.equal(f.calls.filter(value => value.kind === 'budget' && value.path === '/settle').length, 1);
      }
      if (options.wrong) assert.equal(row.rejected, 6);
      for (const trace of row.factories) assert.deepEqual(trace, ['BUDGET_LEDGER', 'USAGE_LEDGER', 'USAGE_QUEUE']);
    }
  });
});

for (const mode of ['close', 'install', 'diagnostic']) {
  const name = `private terminal isolated ${mode} UNKNOWN retains one adopted launch`;
  test(name, { timeout: 120000 }, async t => {
    if (process.env.CLAWROUTER_TERMINAL_UNKNOWN !== mode) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)], {
        env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: mode }, maxBuffer: 4 * 1024 * 1024,
      });
      return;
    }
    await fixture(t, async f => {
      f.expectUnknownRetirement();
      const control = terminalScenario(f, { closeFailure: mode !== 'install', installFailure: mode === 'install', diagnosticFailure: mode === 'diagnostic', wrong: true });
      const response = await f.request(payload({})); assert.equal(response.status, 200);
      while (!control.row.logical.length || control.row.pending) await new Promise(resolve => setImmediate(resolve));
      assert.equal(control.row.adopted, 1); assert.equal(control.row.launches, 1); assert.equal(control.row.installs, 1);
      assert.deepEqual(control.row.order, ['adopt', 'close', 'install', 'launch']);
      assert.equal(control.row.rejected, 6); assert.equal(control.row.logical.length, 1);
      assert.equal(f.events.filter(value => value.type === 'clawrouter.usage.v1').length, 1);
      assert.equal(f.calls.filter(value => value.kind === 'budget' && value.path === '/settle').length, 1);
      assert.ok(bodyBudgetCharged() > 0, 'UNKNOWN remains funded until this isolated process ends, not credited as retirement');
      await f.drain();
    });
  });
}

for (const fault of ['ok-getter', 'install-before-late']) for (const reason of ['undefined', 'shared']) {
  const mode = fault + '-' + reason, name = 'private terminal lane failure ' + mode;
  test(name, { timeout: 120000 }, async t => {
    if (process.env.CLAWROUTER_TERMINAL_UNKNOWN !== mode) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)], {
        env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: mode }, maxBuffer: 4 * 1024 * 1024,
      }); return;
    }
    await fixture(t, async f => {
      f.expectUnknownRetirement();
      const control = terminalScenario(f, { laneFault: fault, laneReason: reason });
      const response = await f.request(payload({})); assert.equal(response.status, 200);
      while (!control.row.logical.length) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(control.row.logical, [true]);
      assert.equal(control.row.recovery.length, 1); assert.equal(control.row.recovery[0].args, 1);
      const settled = f.calls.filter(row => row.kind === 'budget' && row.path === '/settle');
      assert.equal(settled.length, 1); assert.equal(control.row.recovery[0].id, settled[0].body.reservationId);
      if (fault === 'install-before-late') { assert.equal(control.row.laneInstalls, 1); assert.equal(control.row.bodyCancels, 0); }
      control.release();
      while (control.row.pending || control.row.bodyCancelSettled !== 1) await new Promise(resolve => setImmediate(resolve));
      assert.equal(control.row.bodyCancels, 1); assert.equal(control.row.launches, 1);
      assert.ok(observation.originalObserverState().some(row => row.role === 'OwnedTerminalOperation' && !row.severed));
      assert.equal(f.events.filter(event => event.type === 'clawrouter.usage.v1').length, 1);
      assert.ok(bodyBudgetCharged() > 0); await f.drain();
    });
  });
}

// UNRUN_CODE_ONLY_HOSTED. These use the actual registered private invocation,
// not a fabricated plan/right. Capacity is filled after FIRST accepted reserve.
for (const failureOrdinal of [0, 1, 2, 3])
test(`four-leg private rollback preserves ordinal ${failureOrdinal} denial with prepaid recovery`, async t => {
  await fixture(t, async f => {
    const held = failureOrdinal === 3;
    const control = await budgetSequence(f, { failureOrdinal, reserveFailure: 'denied', settleFailure: '503',
      pressure: held, holdSend: held, holdCancel: held });
    const original = f.dispatch(payload({}));
    if (held) {
      while (control.row.queue.length !== 3) await Promise.race([
        new Promise(resolve => setImmediate(resolve)),
        original.outcome.then(outcome => { throw outcome.failed ? outcome.error : Error('rollback ended before recovery handoff'); }),
      ]);
      assert.equal(control.row.accepted, 3); assert.equal(control.row.pressure, true);
      assert.equal(control.row.grows, 0, 'reserve/rollback/queue consume only pre-obligation funding');
      assert.equal(control.row.cancel, 3); assert.equal(control.row.cancelSettled, 0);
      assert.equal(control.row.sendSettled, 0);
      control.releaseSend();
    }
    const response = await f.take(original); await f.take(f.bodyRoot(response));
    assert.equal(response.status, 402);
    assert.deepEqual(control.row.branches, ['rollback']); assert.equal(control.row.dispatch.length, 0);
    const ids = control.row.reserve.filter(row => row.ordinal !== failureOrdinal).map(row => row.id).sort();
    assert.equal(control.row.reserve.length, 4);
    assert.deepEqual(control.row.settle.map(row => row.id).sort(), ids);
    assert.deepEqual(control.row.queue.map(row => row.id).sort(), ids);
    for (const row of control.row.settle) assert.equal(row.cost, 0);
    for (const row of control.row.queue) {
      assert.equal(row.cost, 0); assert.equal(row.args, 1);
      assert.ok(row.root && row.request && row.ledger && row.hookBlocked);
      assert.equal(row.after, row.before, 'deferred actual send keeps its sealed graph');
    }
    if (held) assert.equal(control.row.cancelSettled, 0, 'logical denial and accounting need not join ledger cancel');
    control.release(); await f.drain();
    const usage = f.events.filter(row => row.type === 'clawrouter.usage.v1');
    assert.equal(usage.length, 1); assert.equal(f.sent.length, 0);
    assert.ok(control.row.prepayBytes >= 10489728, 'reserve + exclusive branch subtotal; metadata remains additive');
  });
});

for (const [reserveFailure, settleFailure, queueFailure] of [
  ['malformed', '404', undefined], ['lost', '409', undefined],
  ['undefined', 'undefined', undefined], ['shared', 'shared', 'shared'], ['denied', '503', 'undefined'], ['forged', '503', undefined],
]) test(`private recovery keeps ${reserveFailure}/${settleFailure}/${queueFailure ?? 'success'} originals and IDs distinct`, async t => {
  await fixture(t, async f => {
    const control = await budgetSequence(f, { reserveFailure, settleFailure, queueFailure });
    const response = await f.request(payload({}));
    assert.ok(response.status >= 400); assert.equal(control.row.accepted, 3);
    if (reserveFailure === 'forged') assert.notEqual(response.status, 402, 'transport HttpError cannot mint a reserve denial');
    assert.deepEqual(control.row.branches, ['rollback']); assert.equal(control.row.dispatch.length, 0);
    assert.equal(control.row.settle.length, 3); assert.equal(control.row.queue.length, 3);
    const missing = control.row.reserve[3].id;
    assert.ok(control.row.settle.every(row => row.id !== missing && row.cost === 0), 'unacknowledged reserve never acquires rollback eligibility');
    assert.deepEqual(control.row.queue.map(row => row.id), control.row.settle.map(row => row.id));
    await f.drain(); assert.equal(f.events.filter(row => row.type === 'clawrouter.usage.v1').length, 1);
    assert.equal(f.sent.length, 0);
  });
});

for (const prepayRefusal of [true, false])
test(`private budget ${prepayRefusal ? 'pre-admission refusal starts no original' : 'dispatch failure uses only the final terminal'}`, async t => {
  await fixture(t, async f => {
    const control = await budgetSequence(f, { prepayRefusal, dispatchFailure: !prepayRefusal });
    const response = await f.request(payload({}));
    assert.equal(response.status, 503); await f.drain();
    if (prepayRefusal) {
      assert.equal(control.row.refused, true); assert.equal(control.row.factories, 0);
      assert.deepEqual(control.row.branches, []); assert.equal(control.row.reserve.length, 0);
      assert.equal(control.row.dispatch.length, 0); assert.equal(control.row.settle.length, 0);
    } else {
      assert.deepEqual(control.row.branches, ['dispatch']); assert.equal(control.row.reserve.length, 4);
      assert.equal(control.row.dispatch.length, 4); assert.equal(control.row.settle.length, 4);
      assert.deepEqual(control.row.settle.map(row => row.id).sort(), control.row.reserve.map(row => row.id).sort());
    }
    assert.equal(control.row.queue.length, 0); assert.equal(f.sent.length, 0);
    assert.equal(f.events.filter(row => row.type === 'clawrouter.usage.v1').length, 1);
  });
});

test('private duplicate physical ledger and reservation IDs keep four ordinal rights and reject replays', async t => {
  await fixture(t, async f => {
    const control = await budgetSequence(f, { sameIds: true, rights: true, reserveFailure: 'denied', settleFailure: '503' });
    const response = await f.request(payload({})); assert.equal(response.status, 402);
    await f.drain();
    assert.equal(new Set(control.row.reserve.map(row => row.id)).size, 1);
    assert.equal(control.row.reserve.length, 4); assert.equal(control.row.accepted, 3);
    assert.equal(control.row.settle.length, 3); assert.equal(control.row.queue.length, 3);
    assert.equal(control.row.dispatch.length, 0); assert.equal(control.row.rejectedRights, 26);
    assert.deepEqual(control.row.branches, ['rollback']); assert.equal(f.sent.length, 0);
  });
});

for (const legs of [0, 1, 4]) test(`private ${legs}-leg forward plan uses only its prepared sequence`, async t => {
  await fixture(t, async f => {
    const control = await budgetSequence(f, { legs, ...(legs === 1 ? { reserveFailure: 'denied' } : {}),
      pressure: legs === 4, forwardPressure: legs === 4 });
    const response = await f.request(payload({})); assert.equal(response.status, legs === 1 ? 402 : 200);
    await f.drain();
    assert.equal(control.row.reserve.length, legs);
    assert.equal(control.row.dispatch.length, legs === 1 ? 0 : legs);
    assert.equal(control.row.settle.length, legs === 1 ? 0 : legs); assert.equal(control.row.queue.length, 0);
    assert.deepEqual(control.row.branches, [legs === 1 ? 'rollback' : 'dispatch']);
    assert.equal(control.row.grows, 0); assert.equal(f.sent.length, legs === 1 ? 0 : 1);
    assert.equal(f.events.filter(row => row.type === 'clawrouter.usage.v1').length, 1);
  });
});

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

test('genuine unused preparation retires while its streamed upload sibling is held', async t => {
  const retire = OwnedHttpAccountingCommand.prototype.retireUnused;
  let retired = 0, empty = false, debitAtRetirement = 0;
  t.mock.method(OwnedHttpAccountingCommand.prototype, 'retireUnused', async function () {
    empty = Object.keys(this).length === 0;
    await Reflect.apply(retire, this, []); retired++; debitAtRetirement = bodyBudgetCharged();
    assert.throws(() => this.fail(403, 'denied'), /unavailable/);
    await assert.rejects(Reflect.apply(retire, this, []), /unavailable/);
  });
  await fixture(t, async f => {
    const held = f.holdUpload(); // Release registered before the actual dispatch.
    const root = f.dispatch(payload({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }));
    await f.arrival(held);
    assert.equal(retired, 1); assert.equal(empty, true, 'no facts or identity on the opaque receiver');
    assert.ok(debitAtRetirement > 32 * 1024 * 1024, 'retiring unused metadata did not retire the upload/identity owners');
    assert.equal(f.events.length, 0); assert.equal(f.sent.length, 0, 'actual upload has not been drained');
    held.release.resolve();
    const response = await f.take(root); assert.equal(response.status, 200);
    await f.take(f.bodyRoot(response)); await f.drain();
    assert.equal(f.events.length, 1); assert.equal(f.sent.length, 1);
  });
});

test('genuine preparation failure settles exactly once without a successful accounting receiver', async t => {
  const fail = OwnedHttpAccountingCommand.prototype.fail;
  let failures = 0, unused = 0, requestId, eventId;
  t.mock.method(OwnedHttpAccountingCommand.prototype, 'fail', function (...args) {
    failures++; requestId = this.requestId; eventId = this.eventId;
    assert.deepEqual(Object.keys(this), []);
    return Reflect.apply(fail, this, args);
  });
  const retire = OwnedHttpAccountingCommand.prototype.retireUnused;
  t.mock.method(OwnedHttpAccountingCommand.prototype, 'retireUnused', function (...args) { unused++; return Reflect.apply(retire, this, args); });
  await fixture(t, async f => {
    f.failMaterialization();
    const response = await f.request(payload({})); await f.drain();
    assert.equal(response.status, 503); assert.equal(failures, 1); assert.equal(unused, 0);
    assert.equal(f.sent.length, 0); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].request_id, requestId); assert.equal(f.events[0].id, eventId);
    assert.equal(f.events[0].status_code, 503); assert.equal(f.events[0].status, 'provider_error');
    assert.equal(f.events[0].actual_cost_micros, 0);
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

// UNRUN_CODE_ONLY_HOSTED. Actual private Unified Chat: genuine selection,
// materialization and provider originals, one final accounting invocation.
for (const variant of ['venice', 'gmi']) for (const status of [401, 403, 429]) for (const streaming of variant === 'venice' ? [false, true] : [false])
test(`private ${variant} prepared ${status} keeps the main retry exclusion (stream=${streaming})`, async t => {
  await fixture(t, async f => {
    const before = observation.credentialReductions.length, portsBefore = observation.retryPorts.length;
    f.upstreamStatus(status);
    if (variant === 'venice') f.veniceResponse(streaming ? 'data: {"error":{"message":"synthetic rejection"}}\n\n' : '{"error":{"message":"synthetic rejection"}}', streaming);
    const response = await f.request({ model: variant === 'venice' ? 'venice/zai-org-glm-5-2' : 'gmi/deepseek-ai/DeepSeek-V4-Pro', stream: streaming, messages: [] });
    await f.drain(); assert.equal(response.status, status);
    assert.equal(f.sent.length, 1); assert.equal(f.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').length, 1);
    assert.equal(observation.credentialReductions.length, before, 'future revalidation/codec backing remains full');
    assert.equal(observation.retryPorts.length - portsBefore, 1, 'no alternate preparation port');
    assert.equal(f.events.length, 1);
  }, false, variant);
});

test('private Venice invalid canonical stream starts no provider fetch or credential reduction', async t => {
  await fixture(t, async f => {
    const before = observation.credentialReductions.length;
    const response = await f.request({ model: 'venice/zai-org-glm-5-2', stream: 'invalid', messages: [] });
    assert.equal(response.status, 400); assert.equal(JSON.parse(response.text).error.code, 'invalid_venice_chat_request');
    await f.drain(); assert.equal(f.sent.length, 0); assert.equal(observation.credentialReductions.length, before);
    assert.equal(f.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').length, 1);
  }, false, 'venice');
});

for (const variant of ['venice', 'gmi']) test(`private ${variant} materialization failures precede the sole D future-right owner`, async t => {
  await fixture(t, async f => {
    await f.retryPool('preparation');
    if (variant === 'venice') f.veniceResponse('{"model":"zai-org-glm-5-2","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}');
    const response = await f.request({ model: variant === 'venice' ? 'venice/zai-org-glm-5-2' : 'gmi/deepseek-ai/DeepSeek-V4-Pro', messages: [] });
    await f.drain(); assert.equal(response.status, 200);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].authorization, 'Bearer fixture-upstream-d');
    assert.equal(f.calls.filter(row => row.kind === 'credential' && row.path === '/materialize').length, 4);
    assert.equal(observation.retryPorts.length, 4); assert.equal(observation.credentialReductions.length, 0); assert.equal(f.events.length, 1);
  }, false, variant);
});

test('generic retained census includes large unknown grant fields in every attempted record', async t => {
  await fixture(t, async f => {
    await f.retryPool('response', 16384);
    const response = await f.request(payload({})); assert.equal(response.status, 200); await f.drain();
    assert.equal(f.sent.length, 4); assert.equal(observation.credentialReductions.length, 4);
    assert.ok(observation.credentialCensuses.every(row => row.units >= 16384 && row.values >= 4 && row.originalCleared));
    assert.ok(observation.credentialReductions.every(row => row.bytes > 2 * 16384 + 4096));
    assert.equal(f.events.length, 1);
  });
});

// SOURCE_ONLY: hosted execution must establish these source-defined cuts.
for (const activeFinal of [false, true])
test(`thirteen ACK records compact in place with held originals (active final reads: ${activeFinal})`, { timeout: 120000 }, async t => {
  await fixture(t, async f => {
    await budgetSequence(f, { legs: 4, rights: true });
    const control = createOwnedAckPhaseFixture({ activeFinal, upload: true }, bodyBudgetCharged);
    globalThis.__ownedAckPhaseFixture = control;
    f.releases.push(() => { const work = control.release(); f.own(work); delete globalThis.__ownedAckPhaseFixture; });
    f.requestEnvironment(control.env(f.env));
    const response = await f.request(payload({ extra: 'x'.repeat(1048576) })); assert.equal(response.status, 200);
    let held;
    do { held = control.snapshot(); if (held.acks.length < 13) await new Promise(resolve => setImmediate(resolve)); } while (held.acks.length < 13);
    if (activeFinal) {
      assert.equal(held.acks.filter(cell => cell.terminal && cell.capture).length, 5);
      assert.equal(held.terminals[0].pending, 5);
      control.releaseReads();
    }
    do { held = control.snapshot(); if (held.cuts.length < 13 || held.terminals[0].keys.includes('event')) await new Promise(resolve => setImmediate(resolve)); }
    while (held.cuts.length < 13 || held.terminals[0].keys.includes('event'));
    assert.equal(held.uploads, 1); assert.equal(held.uploadDone, 0);
    assert.equal(held.acks.filter(cell => !cell.terminal && cell.keys.length === 8).length, 8);
    assert.equal(held.acks.filter(cell => cell.terminal && cell.keys.length === 9).length, 5);
    assert.ok(held.cuts.every(cut => cut.before === cut.after && cut.physical === cut.physicalAfter));
    assert.deepEqual(held.budgets[0].keys.slice().sort(), ['phase','physical','root']);
    assert.deepEqual(held.terminals[0].live, ['5','6','7','8','9']);
    assert.ok(held.retries.every(cut => cut.closed && !cut.retry && !cut.required && cut.chosen && cut.rejected === 2));
    assert.equal(control.stale().gets, 0);
    await f.take(f.own(control.release())); await f.drain();
    const ended = control.snapshot(); assert.equal(ended.uploadDone, 1);
    assert.ok(ended.acks.every(cell => cell.state & 16384 && !cell.keys.includes('owner') && !cell.keys.includes('body') && !cell.keys.includes('nativeFailure')));
    assert.ok(ended.reads.every(cell => cell.severed)); assert.equal(control.stale().gets, 0);
    assert.equal(ended.retirements.length, 13);
    assert.ok(ended.retirements.every(row => row.physical - row.after === 1));
  });
});

for (const [custodyMode, provenance] of [
  ...['provider-install', 'retry-cancel', 'new-post-install', 'clean-retry'].map(mode => [mode, '']),
  ...['distinct', 'equal', 'undefined'].flatMap(reason => ['fetch:reject:', 'cancel:reject:', 'cancel:fulfill:'].map(phase => ['provider-install', phase + reason]))
]) {
  const name = `private ACK credit and retry evidence ${custodyMode} ${provenance}`;
  test(name, { timeout: 120000 }, async t => {
    const unknown = custodyMode !== 'clean-retry';
    if (unknown && process.env.CLAWROUTER_TERMINAL_UNKNOWN !== name) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)],
        { env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: name }, maxBuffer: 4 * 1024 * 1024 });
      return;
    }
    await fixture(t, async f => {
      if (unknown) f.expectUnknownRetirement();
      await budgetSequence(f, { legs: 4 }); await f.retryPool('response');
      const terminal = terminalScenario(f, {}), control = createOwnedAckPhaseFixture({ custodyMode, provenance }, bodyBudgetCharged);
      globalThis.__ownedAckPhaseFixture = control;
      f.releases.push(() => { f.own(control.release()); delete globalThis.__ownedAckPhaseFixture; });
      f.requestEnvironment(control.env(terminal.env(f.env)));
      let response, failed = false;
      try { response = await f.request(payload({})); } catch { failed = true; }
      assert.ok(unknown ? failed || response.status >= 400 : !failed && response.status === 200);
      let held, deadline = Date.now() + 30000;
      do {
        assert.ok(Date.now() < deadline, 'logical ACK handoff stalled');
        held = control.snapshot();
        if (held.cuts.length < 13 || !terminal.row.logical.length || terminal.row.pending) await new Promise(resolve => setImmediate(resolve));
      } while (held.cuts.length < 13 || !terminal.row.logical.length || terminal.row.pending);
      assert.equal(terminal.row.logical.length, 1);
      await f.take(f.own(control.release()));
      let ended; deadline = Date.now() + 30000;
      do { assert.ok(Date.now() < deadline, 'physical ACK retirement stalled'); ended = control.snapshot(); if (ended.retirements.length < 13) await new Promise(resolve => setImmediate(resolve)); }
      while (ended.retirements.length < 13);
      assertOwnedAckCustody(assert, custodyMode, held, ended, unknown ? control.recheck() : ended, control.stale());
    });
  });
}

for (const failureMode of ['native', 'independent-shared', 'independent-undefined'])
test(`ACK tail keeps native correlation separate from ${failureMode} failure origins`, async t => {
  await fixture(t, async f => {
    await budgetSequence(f, { legs: 4 });
    const control = createOwnedAckPhaseFixture({ failureMode }, bodyBudgetCharged);
    globalThis.__ownedAckPhaseFixture = control;
    f.releases.push(() => { f.own(control.release()); delete globalThis.__ownedAckPhaseFixture; });
    f.requestEnvironment(control.env(f.env));
    const response = await f.request(payload({})); assert.ok(response.status >= 400);
    await f.drain();
    const cuts = control.snapshot().cuts.filter(row => row.failures);
    assert.equal(cuts.length, 4);
    assert.ok(cuts.every(row => row.failures === (failureMode === 'native' ? 1 : 4)));
    assert.ok(cuts.every(row => row.correlated === (failureMode === 'native')));
    if (failureMode === 'independent-undefined') assert.ok(cuts.every(row => row.undefinedFailures === 4));
    assert.equal(control.stale().gets, 0);
  });
});

for (const fault of ['closedInstallThrow', 'unlockInstallThrow', 'readInstallThrow']) {
  const name = `private ACK phase uncertainty ${fault} retains active capture`;
  test(name,{timeout:120000},async t=>{
    if(process.env.CLAWROUTER_TERMINAL_UNKNOWN!==fault){
      await promisify(execFile)(process.execPath,['--test','--test-name-pattern','^'+name+'$',fileURLToPath(import.meta.url)],{env:{...process.env,CLAWROUTER_TERMINAL_UNKNOWN:fault},maxBuffer:4*1024*1024});return;
    }
    await fixture(t,async f=>{
      f.expectUnknownRetirement();await budgetSequence(f,{legs:4});const terminal=terminalScenario(f,{});
      const control=createOwnedAckPhaseFixture({[fault]:true,pendingRead:fault==='readInstallThrow',pendingCancel:fault==='readInstallThrow'},bodyBudgetCharged);globalThis.__ownedAckPhaseFixture=control;
      f.releases.push(()=>{const work=control.release();f.own(work);delete globalThis.__ownedAckPhaseFixture;});f.requestEnvironment(control.env(f.env));
      let response, failed = false;
      try {
        try { response = await f.request(payload({})); } catch { failed = true; }
        assert.ok(failed || response.status >= 400);
        if (fault === 'readInstallThrow') assert.ok(control.snapshot().acks.some(cell => (cell.pending & 6) === 6));
      } finally { await f.take(f.own(control.release())); }
      while(!terminal.row.logical.length||terminal.row.pending)await new Promise(resolve=>setImmediate(resolve));
      const held=control.snapshot();assert.ok(held.acks.length>0);assert.equal(held.cuts.length,0);assert.ok(held.acks.every(cell=>cell.state&4&&cell.capture&&cell.keys.includes('owner')));
      assert.ok(held.charge>0);assert.equal(terminal.row.logical.length,1);
    });
  });
}

test('retained private provider, ledger, terminal and void callbacks sever their owner cells', async t => {
  await fixture(t, async f => {
    const start = observation.originalObservers.length;
    const response = await f.request(payload({})); assert.equal(response.status, 200); await f.drain();
    const rows = observation.originalObserverState().slice(start), roles = new Set(rows.map(row => row.role));
    for (const role of ['OwnedProviderFetch', 'OwnedSinkVoidCommand', 'OwnedLedgerCommand', 'OwnedTerminalOperation']) assert.ok(roles.has(role), role);
    assert.ok(rows.every(row => row.severed && row.state === 8));
    const replay = observation.replayRetiredOriginals(); assert.equal(replay.reads, 0); assert.ok(replay.callbacks >= 2 * rows.length);
  }, true);
});

for (const mode of ['preparation', 'response', 'mixed', 'exhausted', 'failed-alternate'])
test(`private cumulative four-port grant policy ${mode}`, async t => {
  await fixture(t, async f => {
    await f.retryPool(mode);
    const response = await f.request(payload({})); await f.drain();
    const keys = ['a', 'b', 'c', 'd'].map(name => 'oauth/' + policyId + '/fireworks-' + name);
    assert.equal(response.status, mode === 'exhausted' || mode === 'failed-alternate' ? 429 : 200);
    assert.deepEqual(observation.retryPorts.map(port => port.keys), [[], keys.slice(0, 1), keys.slice(0, 2), keys.slice(0, 3)]);
    assert.equal(new Set(observation.retryPorts.map(port => port.input)).size, 4);
    const expected = mode === 'preparation' ? ['d'] : mode === 'mixed' ? ['b', 'd'] : mode === 'failed-alternate' ? ['a'] : ['a', 'b', 'c', 'd'];
    assert.deepEqual(f.sent.map(row => row.authorization), expected.map(name => 'Bearer fixture-upstream-' + name));
    const materializations = f.calls.filter(row => row.kind === 'credential' && row.path === '/materialize');
    assert.deepEqual(materializations.map(row => row.key), keys);
    for (let index = 0; index < materializations.length; index++) assert.equal(materializations[index].signal, observation.retryPorts[index].signal);
    assert.ok(observation.credentialReductions.length >= expected.length);
    assert.ok(observation.credentialReductions.every(row => row.before === 33554432 && row.after === row.bytes && row.bytes >= 4096 && row.bytes < 33554432));
    for (const [index, row] of observation.credentialReductions.entries()) {
      const census = observation.credentialCensuses[index];
      assert.ok(census.originalCleared && census.retained && (census.completion & 4));
      assert.equal(row.rejections, 5);
      assert.equal(row.bytes, 8 * (census.containers + 2 * census.members + census.entries + census.values) + 2 * census.units + 4096 + 6 * (row.idUnits + census.keyUnits));
    }
    assert.equal(f.events.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve').length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'budget' && row.path === '/settle').length, 1);
    if (mode === 'failed-alternate') assert.match(response.text, /synthetic rejection a/);
    if (mode === 'exhausted') assert.match(response.text, /synthetic rejection d/);
  });
});

test('513 empty string tools pay each copied string-value cell before dispatch', async t => {
  await fixture(t, async f => {
    const input = payload({ tools: Array(513).fill('') });
    const response = await f.request(input); await f.drain();
    assert.equal(response.status, 200);
    assert.ok(observation.toolScratchBytes >= 8224, 'two array containers + 513 entry cells + 513 string primitive cells');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].text, JSON.stringify(transformed(input)));
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
    const response = await f.request(payload({ tools: Array(513).fill(''), extra: Array.from({ length: 8192 }, () => ({ value: null })) }));
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-clawrouter-error-code'), 'identity_admission_unavailable');
    assert.ok(observation.toolScratchBytes >= 8224);
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
      const text = await f.take(f.bodyRoot(response));
      await f.drain();
      assert.equal(response.status, valid ? 200 : 502, mode + ' first-frame validation precedes publication');
      if (!valid) assert.equal(JSON.parse(text).error.code, 'provider_unavailable');
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


for (const [mode, kind, streaming] of [
  ...['unlock-before', 'unlock-after'].flatMap(mode => ['success', 'undefined', 'shared', 'huge'].map(kind => [mode, kind, true])),
  ['closed', 'undefined', true], ['closed', 'shared', true], ['unlock-before-closed', 'shared', true],
  ['unlock-before', 'success', false], ['unlock-after', 'success', false],
]) test('owned Venice original ' + mode + '/' + kind + '/' + (streaming ? 'SSE' : 'BYOB JSON') + ' retains its actual returned settlement', async t => {
  let reasonReads = 0;
  const shared = {};
  for (const key of ['message', 'stack', 'cause', 'errors', 'code', 'status', 'then'])
    Object.defineProperty(shared, key, { get() { reasonReads++; throw new Error('foreign returned-work reason'); } });
  const reason = kind === 'undefined' ? undefined : kind === 'huge' ? 'x'.repeat(17 * 1024 * 1024) : shared;
  await fixture(t, async f => {
    const json = '{"model":"' + veniceUpstream + '","choices":[]}';
    const wire = streaming ? 'data: ' + json + '\n\ndata: [DONE]\n\n' : json;
    f.veniceResponse(wire, streaming);
    const gate = f.holdVeniceWork(mode, reason, kind !== 'success');
    const dispatch = f.dispatch(payload({ model: veniceModelId, ...(streaming ? { stream: true } : {}) }));
    const completed = f.own(dispatch.outcome.then(async outcome => {
      if (outcome.failed) throw outcome.error;
      const body = await f.bodyRoot(outcome.value).outcome;
      if (body.failed) throw body.error;
      throw new Error('source completed before returned-work arrival');
    }));
    await f.take(f.own(Promise.race([gate.entered.promise, completed.outcome.then(outcome => { throw outcome.error; })])));
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024);
    assert.equal(gate.read, gate.readSettled, 'successful original reads precede the independent returned-work failure');
    assert.ok(gate.read > 0); assert.equal(reasonReads, 0);
    if (mode !== 'closed') {
      assert.equal(gate.unlock, 1); assert.equal(gate.unlockSettled, 0);
      assert.equal(gate.nativeUnlocked, mode.startsWith('unlock-before') ? 1 : 0);
    }
    if (streaming) assert.equal((await f.take(dispatch)).status, 200, 'public prefix does not await retirement');
    gate.release.resolve();
    const response = await f.take(dispatch);
    let text, hasBodyFailure = false, bodyFailure;
    try { text = await f.take(f.bodyRoot(response)); } catch (error) { hasBodyFailure = true; bodyFailure = error; }
    try { await f.take(completed); } catch { /* same body origin, or the deliberate completion sentinel */ }
    await f.drain();
    const terminal = [];
    for (const root of f.retirements) if ((await root.outcome).failed)
      try { await f.take(root); } catch (error) { terminal.push(error); }
    try {
      assert.equal(response.status, 200); assert.equal(gate.unlock, 1); assert.equal(gate.nativeUnlocked, 1);
      assert.equal(gate.unlockSettled, 1); assert.equal(gate.thenCalls, mode === 'unlock-after' && kind === 'success' ? 1 : 0);
      assert.equal(reasonReads, 0); assert.equal(f.sent.length, 1);
      assert.equal(hasBodyFailure, kind !== 'success' && mode !== 'closed');
      if (!hasBodyFailure) assert.equal(text, wire);
      const expected = kind === 'success' ? [] : mode === 'closed' ? ['closed'] : mode === 'unlock-before-closed' ? ['unlock', 'closed'] : ['unlock'];
      assert.equal(terminal.length, expected.length ? 1 : 0);
      if (expected.length) {
        assert.ok(terminal[0] instanceof AggregateError);
        const failures = terminal[0].errors;
        assert.deepEqual(failures.map(value => Object.getOwnPropertyDescriptor(value, 'origin')?.value), expected);
        assert.ok(failures.every(value => value !== reason && Object.getOwnPropertyDescriptor(value, 'primaryIsUndefined')?.value === (kind === 'undefined')));
        assert.equal(new Set(failures).size, expected.length, 'independent operations retain separate origins');
      }
    } catch (validation) { throw new AggregateError([...(hasBodyFailure ? [bodyFailure] : []), ...terminal, validation], 'returned-work validation'); }
  }, false, 'venice');
});


test('owned Venice independent closed getter throw is a closed origin before any read', async t => {
  await fixture(t, async f => {
    f.veniceResponse('{"model":"' + veniceUpstream + '","choices":[]}');
    const gate = f.holdVeniceWork('closed-getter', undefined, true);
    const response = await f.request(payload({ model: veniceModelId }));
    await f.drain();
    const terminal = [];
    for (const root of f.retirements) if ((await root.outcome).failed)
      try { await f.take(root); } catch (error) { terminal.push(error); }
    try {
      assert.equal(response.status, 502); assert.equal(JSON.parse(response.text).error.code, 'provider_unavailable');
      assert.equal(gate.closedGetter, 1); assert.equal(gate.read, 0);
      assert.equal(gate.unlock, 1); assert.equal(gate.nativeUnlocked, 1);
      assert.equal(terminal.length, 1); assert.ok(terminal[0] instanceof AggregateError);
      assert.deepEqual(terminal[0].errors.map(value => Object.getOwnPropertyDescriptor(value, 'origin')?.value), ['closed']);
      assert.equal(Object.getOwnPropertyDescriptor(terminal[0].errors[0], 'primaryIsUndefined')?.value, true);
    } catch (validation) { throw new AggregateError([...terminal, validation], 'closed getter validation'); }
  }, false, 'venice');
});

for (const streaming of [true, false]) for (const name of ownedUsageCases.filter(name => streaming || ['wide', 'deep', 'quoted', 'scalar', 'malformed', 'many-lines', 'overflow'].includes(name)))
test('owned accepted usage shares ordinary evidence without retaining foreign summary: ' + name + '/' + streaming, async t => {
  const wire = ownedUsageWire(name, streaming);
  let reference;
  if (streaming) {
    const ordinary = createSseUsageInspector(); ordinary.push(new TextEncoder().encode(wire)); ordinary.end();
    reference = ordinary.result(); assert.deepEqual(ordinary.result(), reference);
  } else if (Buffer.byteLength(wire) > 2097152) reference = { tokens: null, outcome: null };
  else {
    let value, valid = false; try { value = JSON.parse(wire); valid = true; } catch {}
    reference = valid ? { tokens: extractUsageTokens(value), outcome: responseOutcome(value) } : { tokens: null, outcome: 'provider_error' };
  }
  const before = { ...observation.usage }, acquired = observation.consumers.acquired;
  observation.consumerMode = 'usage:' + name + ':' + (streaming ? 'sse' : 'json');
  try {
    await fixture(t, async f => {
      f.releases.push(() => observation.releaseConsumer());
      const native = '{"model":"' + veniceUpstream + '","choices":[]}';
      f.veniceResponse(streaming ? 'data: ' + native + '\n\ndata: [DONE]\n\n' : native, streaming);
      const response = await f.request(payload({ model: veniceModelId, stream: streaming }));
      assert.equal(response.status, 200); assert.equal(response.text, wire);
      await f.drain();
      assert.equal(f.events.length, 1); assert.equal(f.sent.length, 1);
      assert.equal(f.events[0].input_tokens, reference.tokens?.input ?? null);
      assert.equal(f.events[0].output_tokens, reference.tokens?.output ?? null);
      assert.equal(observation.consumers.acquired - acquired, 1, 'actual same-reader pipeline');
      assert.equal(observation.usage.parsed - before.parsed, observation.usage.census - before.census);
      if (name === 'wide') {
        assert.equal(observation.usage.maxContainers, 600002);
        assert.ok(observation.usage.maxGraph >= 9600042);
      }
      if (name.startsWith('refusal') || name === 'two-large') assert.ok(observation.usage.summaries > before.summaries);
    }, false, 'venice');
    assert.equal(observation.usage.cleared - before.cleared, 1, 'usage state clears only at genuine final retirement');
  } finally { observation.consumerMode = 'normal'; observation.releaseConsumer(); }
});

for (const mode of ['line-limit', 'line-plus', 'line-error']) test('private codec range fold keeps exact newline and event-error semantics: ' + mode, async t => {
  await fixture(t, async f => {
    const wire = ownedCodecSseLines(veniceUpstream, mode); f.veniceResponse(wire, true);
    const response = await f.request(payload({ model: veniceModelId, stream: true }));
    assert.equal(response.status, mode === 'line-limit' ? 200 : 502);
    if (mode === 'line-limit') assert.equal(response.text, wire);
    await f.drain(); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
  }, false, 'venice');
});

test('private terminal waits for actual first observation when modified then returns early', async t => {
  await fixture(t, async f => {
    const gate = deferred(), entered = deferred(), send = f.env.USAGE_QUEUE.send;
    f.releases.push(gate.resolve, entered.resolve);
    f.env.USAGE_QUEUE.send = function (message) {
      const original = gate.promise.then(() => Reflect.apply(send, this, [message]));
      f.own(original); // Fixture observation is attached before the mutation.
      const then = original.then;
      Object.defineProperty(original, 'then', { value(...args) { Reflect.apply(then, this, args); entered.resolve(); return Promise.resolve(); } });
      return original;
    };
    const response = await f.request(payload({})); assert.equal(response.status, 200);
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(bodyBudgetCharged() > 32 * 1024 * 1024, 'early returned observer promise is not original retirement');
    gate.resolve(); await f.drain(); assert.equal(f.events.length, 1); assert.equal(f.sent.length, 1);
  });
});

for (const mode of ['then-early', 'public-then-early', 'source-then-early'])
test('private reader ignores a premature modified then return: ' + mode, async t => {
  const row = mode === 'then-early' ? observation.consumers : mode.startsWith('public-') ? observation.consumers.public : observation.consumers.source;
  row.held = false; const before = row.thenCalls;
  observation.consumerMode = mode;
  try {
    await fixture(t, async f => {
      f.releases.push(() => observation.releaseConsumer());
      const wire = 'data: {"model":"' + veniceUpstream + '","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\ndata: [DONE]\n\n';
      f.veniceResponse(wire, true);
      let completed = false;
      const response = f.request(payload({ model: veniceModelId, stream: true })).then(value => { completed = true; return value; });
      f.own(response);
      while (!row.held) await new Promise(resolve => setTimeout(resolve, 1));
      assert.ok(row.thenCalls > before); assert.equal(completed, false);
      assert.ok(bodyBudgetCharged() >= 32 * 1024 * 1024);
      observation.releaseConsumer();
      const result = await response; assert.equal(result.status, 200); assert.equal(result.text, wire);
      await f.drain(); assert.equal(f.events.length, 1); assert.equal(f.sent.length, 1);
    }, false, 'venice');
  } finally { observation.consumerMode = 'normal'; observation.releaseConsumer(); }
});


// UNRUN_CODE_ONLY_HOSTED. All delayed work below belongs to the Promise
// actually returned from send; fixture teardown opens the gate before joins.
test('private accounting hands one frozen graph to the real held queue sender', async t => {
  await fixture(t, async f => {
    const gate = deferred(), entered = deferred(), send = f.env.USAGE_QUEUE.send;
    let handed, wire, calls = 0, hooks = 0;
    f.releases.push(gate.resolve, entered.resolve, () => { handed = undefined; });
    f.env.USAGE_QUEUE.send = function (message) {
      assert.equal(this, f.env.USAGE_QUEUE); assert.equal(arguments.length, 1); calls++;
      assert.equal(Object.isFrozen(message), true); assert.equal(Object.getPrototypeOf(message), null);
      handed = message; wire = JSON.stringify(message); entered.resolve();
      return gate.promise.then(() => {
        assert.equal(Reflect.defineProperty(message, 'toJSON', { value() { hooks++; return {}; } }), false);
        assert.equal(Reflect.set(message, 'id', 'replaced-event'), false);
        assert.equal(Reflect.setPrototypeOf(message, { toJSON() { hooks++; return {}; } }), false);
        assert.equal(JSON.stringify(message), wire);
        return Reflect.apply(send, this, [message]);
      });
    };
    const response = await f.request(payload({})); assert.equal(response.status, 200);
    await entered.promise; assert.equal(f.events.length, 0);
    assert.ok(bodyBudgetCharged() > 0, 'held send still owns the graph and original');
    const id = handed.id, requestId = handed.request_id; gate.resolve(); await f.drain();
    assert.equal(calls, 1); assert.equal(hooks, 0); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].id, id); assert.equal(f.events[0].request_id, requestId);
    assert.equal(JSON.stringify(f.events[0]), wire); handed = undefined;
  });
});

for (const failure of ['mutation', 'undefined', 'shared'])
test('private sealed usage queue keeps same-ID ingest recovery after ' + failure + ' rejection', async t => {
  t.mock.method(console, 'error', () => {});
  await fixture(t, async f => {
    const shared = Object.freeze({ failure: 'same sender reason' });
    let sends = 0, ingests = 0, id;
    f.env.USAGE_LEDGER = { idFromName(name) { return name; }, get() { return { async fetch(url, init) {
      ingests++; assert.equal(new URL(url).pathname, '/ingest'); assert.equal(init.method, 'POST');
      const value = JSON.parse(init.body); assert.equal(value.id, id);
      return accessBytesResponse(JSON.stringify({ eventId: id, outcome: 'stored' }));
    } }; } };
    f.env.USAGE_QUEUE.send = function (message) {
      sends++; assert.equal(this, f.env.USAGE_QUEUE); assert.equal(arguments.length, 1);
      assert.equal(Object.isFrozen(message), true); id = message.id;
      if (failure === 'mutation') Object.defineProperty(message, 'toJSON', { value() { return {}; } });
      throw failure === 'undefined' ? undefined : shared;
    };
    const response = await f.request(payload({})); assert.equal(response.status, 200); await f.drain();
    assert.equal(sends, 1); assert.equal(ingests, 1); assert.equal(f.sent.length, 1);
  });
});


for (const shape of ['wide513', 'deep513'])
test('private HTTP pays variable traversal CONTROL for native ' + shape + ' without a new JSON cap', async t => {
  await fixture(t, async f => {
    let extra = shape === 'wide513' ? Array.from({ length: 513 }, () => ({})) : 0;
    if (shape === 'deep513') for (let index = 0; index < 513; index++) extra = [extra];
    const input = payload({ extra }), expected = JSON.stringify(transformed(input));
    const response = await f.request(input); assert.equal(response.status, 200); await f.drain();
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, expected); assert.equal(f.events.length, 1);
    assert.equal(f.calls.filter(row => row.kind === 'budget' && row.path === '/reserve').length, 1);
  });
});

test('private pricing retains Infinity ancestry and array-valued tool classification before native serialization', async t => {
  await fixture(t, async f => {
    const input = payload({ previous_response_id: Infinity, tools: [{ type: ['browser_search'] }] });
    const expected = ordinaryCost(input);
    const wire = JSON.stringify(input).replace('"previous_response_id":null', '"previous_response_id":1e400');
    const response = await f.request(wire); assert.equal(response.status, 200); await f.drain();
    const reserve = f.calls.find(row => row.kind === 'budget' && row.path === '/reserve');
    assert.equal(reserve.body.costMicros, expected.reserveMicros);
    assert.equal(JSON.parse(f.sent[0].text).previous_response_id, null);
    assert.deepEqual(JSON.parse(f.sent[0].text).tools, [{ type: ['browser_search'] }]);
  });
});

for (const kind of ['queue', 'upload-pipe']) for (const outcome of ['reject', 'fulfill'])
for (const reasonKind of ['distinct', 'equal', 'undefined']) {
  const name = `private independent installation ${kind} ${outcome} ${reasonKind}`;
  test(name, { timeout: 120000 }, async () => {
    if (process.env.CLAWROUTER_TERMINAL_UNKNOWN !== name) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)],
        { env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: name }, maxBuffer: 4 * 1024 * 1024 }); return;
    }
    const commands = await import('../http-identity-owner.ts');
    const row = await ownedSinkInstallationWitness(commands, kind, outcome, reasonKind, bodyBudgetCharged);
    assertOwnedSinkInstallation(assert, row, outcome, reasonKind);
  });
}

test('private preflight stages and clears the reply before the one source advance', async t => {
  const before = { ...observation.preflightTransfers };
  await fixture(t, async f => {
    const response = await f.request(payload({})); assert.equal(response.status, 200); await f.drain();
    for (const stage of ['staged', 'taken', 'advanced']) assert.equal(observation.preflightTransfers[stage] - before[stage], 1);
  });
});

for (const driver of ['OwnedNormalizerReader', 'CodecReader', 'OwnedVeniceSource', 'OwnedPublicReader', 'GenericUsageReader'])
for (const outcome of ['reject', 'fulfill']) for (const reasonKind of ['distinct', 'equal', 'undefined']) {
  const name = `private reached driver installation ${driver} ${outcome} ${reasonKind}`;
  test(name, { timeout: 120000 }, async t => {
    if (process.env.CLAWROUTER_TERMINAL_UNKNOWN !== name) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)],
        { env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: name }, maxBuffer: 4 * 1024 * 1024 }); return;
    }
    const codec = ['CodecReader', 'OwnedVeniceSource', 'OwnedRevalidationRpc'].includes(driver);
    observation.consumerMode = `driver-origin:${driver}:${outcome}:${reasonKind}`;
    try {
      await fixture(t, async f => {
        f.expectUnknownRetirement();
        if (codec) f.veniceResponse('{"model":"zai-org-glm-5-2","choices":[]}');
        if (driver === 'OwnedNormalizerReader') f.upstreamStatus(500);
        const response = await f.take(f.dispatch(payload(codec ? { model: 'venice/zai-org-glm-5-2' } : {})));
        try { await f.take(f.bodyRoot(response)); } catch { /* The installed failure may end delivery. */ }
        assertOwnedDriverOrigins(assert, observation.driverOrigins, outcome, reasonKind);
        assert.ok(bodyBudgetCharged() > 65536, 'UNKNOWN keeps the request debit');
      }, false, codec ? 'venice' : 'fireworks');
    } finally { observation.consumerMode = 'normal'; observation.releaseConsumer(); }
  });
}


for (const kind of ['put', 'pipe', 'cancel']) for (const outcome of ['reject', 'fulfill'])
for (const reasonKind of ['distinct', 'equal', 'undefined']) {
  const name = `private admitted archive ${kind} ${outcome} then install ${reasonKind}`;
  test(name, { timeout: 120000 }, async t => {
    if (process.env.CLAWROUTER_TERMINAL_UNKNOWN !== name) {
      await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern', '^' + name + '$', fileURLToPath(import.meta.url)],
        { env: { ...process.env, CLAWROUTER_TERMINAL_UNKNOWN: name }, maxBuffer: 4 * 1024 * 1024 }); return;
    }
    observation.consumerMode = `archive-install:${kind}:${outcome}:${reasonKind}`;
    try {
      await fixture(t, async f => {
        f.expectUnknownRetirement();
        try { await f.request(payload({ messages: [{ role: 'user', content: 'x'.repeat(40000) }] })); } catch { /* Installation UNKNOWN can prevent later publication. */ }
        for (;;) { if (observation.archiveFault.didThrow) break; await new Promise(resolve => setTimeout(resolve, 0)); }
        const row = observation.archiveFaultState();
        assert.equal(row.calls, 1); assert.equal(row.observations, 1); assert.equal(row.touched, 0);
        assert.equal(row.unknown, true); assert.equal(row.didThrow, true); assert.equal(row.phase, 3);
        assert.notEqual(row.originalOrdinal, row.installationOrdinal);
        assert.equal(row.installation.primaryIsUndefined, reasonKind === 'undefined');
        if (outcome === 'reject') assert.equal(row.original.primaryIsUndefined, reasonKind === 'undefined'); else assert.equal(row.original, null);
        if (kind === 'cancel') { assert.equal(row.thrown.origin, 'put'); assert.notEqual(row.thrown.ordinal, row.installationOrdinal); }
        else assert.equal(row.thrown.ordinal, outcome === 'reject' ? row.originalOrdinal : row.installationOrdinal);
        assert.ok(row.after >= row.before); assert.ok(bodyBudgetCharged() > 65536);
      }, true);
    } finally { observation.releaseArchiveFault(); observation.consumerMode = 'normal'; }
  });
}
for (const kind of ['put', 'pipe', 'cancel']) for (const returned of ['undefined', 'held', 'hostile'])
test(`private admitted archive ${kind} ignores ${returned} observer return and joins actual callback`, async t => {
  observation.consumerMode = `archive-return:${kind}:${returned}`;
  try {
    await fixture(t, async f => {
      f.releases.push(() => observation.releaseArchiveFault());
      const request = f.own(f.request(payload({ messages: [{ role: 'user', content: 'x'.repeat(40000) }] })));
      for (;;) { if (observation.archiveFault.entered) break; await new Promise(resolve => setTimeout(resolve, 0)); }
      const held = observation.archiveFaultState();
      assert.equal(held.calls, 1); assert.equal(held.observations, 1); assert.equal(held.touched, 0); assert.equal(held.fulfilled, false);
      assert.ok(bodyBudgetCharged() > 65536);
      observation.releaseArchiveFault(); await f.take(request); await f.drain();
      if (kind === 'cancel') for (const root of f.retirements) if ((await root.outcome).failed) await assert.rejects(f.take(root));
      assert.equal(observation.archiveFault.fulfilled, kind !== 'cancel'); assert.equal(observation.archiveFault.touched, 0);
      assert.equal(observation.archiveFault.commandRejected, observation.archiveFault.nativeFailed);
      assert.equal(observation.archiveFault.commandFulfilled, !observation.archiveFault.nativeFailed);
      assert.equal(observation.archiveFault.observations, 1); assert.equal(observation.archiveFault.calls, 1);
    }, true);
  } finally { observation.releaseArchiveFault(); observation.consumerMode = 'normal'; }
});


for (const target of ['getter', 'put']) for (const kind of ['undefined', 'large-string', 'opaque-object'])
test(`private archive ${target} ${kind} failure is bounded before held cancellation`, async t => {
  observation.consumerMode = `archive-failure:${target}:${kind}`;
  try {
    await fixture(t, async f => {
      f.releases.push(() => observation.releaseArchiveFault());
      const request = f.own(f.request(payload({ messages: [{ role: 'user', content: 'x'.repeat(40000) }] })));
      for (;;) { if (observation.archiveFault.entered) break; await new Promise(resolve => setTimeout(resolve, 0)); }
      const row = observation.archiveFaultState();
      assert.equal(row.awaitingBounded, true); assert.equal(row.didThrow, false); assert.equal(row.cancelCalls, 1);
      assert.equal(row.puts, target === 'put' ? 1 : 0); assert.equal(row.envGets, target === 'getter' ? 1 : 0);
      assert.equal(row.reasonReads, 0); assert.ok(bodyBudgetCharged() > 65536);
      const put = row.failures.find(record => record.origin === 'put'); assert.ok(put);
      assert.equal(put.primaryIsUndefined, kind === 'undefined');
      observation.releaseArchiveFault(); await f.take(request); await f.drain();
      for (const root of f.retirements) if ((await root.outcome).failed) await assert.rejects(f.take(root));
      assert.equal(row.didThrow, true); assert.equal(row.thrown.ordinal, put.ordinal);
      assert.ok(row.failures.some(record => record.origin === 'pipe')); assert.ok(row.failures.some(record => record.origin === 'cancel'));
      assert.equal(new Set(row.failures.map(record => record.ordinal)).size, row.failures.length);
      assert.equal(row.reasonReads, 0); assert.equal(row.cancelCalls, 1);
    }, true);
  } finally { observation.releaseArchiveFault(); observation.consumerMode = 'normal'; }
});


for (const variant of ['fireworks', 'venice', 'gmi'])
test(`private ${variant} named RPC subjects reject substitutions and replay before effects`, async t => {
  observation.consumerMode = 'subject-bindings';
  for (const key of Object.keys(observation.subjectFaults)) observation.subjectFaults[key] = 0;
  try {
    await fixture(t, async f => {
      const input = variant === 'venice' ? { model: 'venice/zai-org-glm-5-2' }
        : variant === 'gmi' ? { model: 'gmi/deepseek-ai/DeepSeek-V4-Pro' } : {};
      const response = await f.request(payload(input)); assert.equal(response.status, 200); await f.drain();
      const row = observation.subjectFaults;
      for (const kind of ['preflight', 'continuation', 'materialization', 'replay']) assert.ok(row[kind] > 0, kind);
      assert.equal(row.foreignGets, 0);
      if (variant !== 'fireworks') { assert.ok(row.snapshot > 0); assert.ok(row.inspect > 0); }
      assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    }, false, variant);
  } finally { observation.consumerMode = 'normal'; }
});
