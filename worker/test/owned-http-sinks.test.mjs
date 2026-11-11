import { createOwnedHttpCodecUsageResponse, createOwnedHttpGenericUsageResponse, bindOwnedHttpGenericBodylessResponse, beginOwnedHttpProxyPublicationHeaders, checkOwnedHttpProxyPublicationBody, finishOwnedHttpProxyPublication, beginOwnedHttpFinalMetadata, ownOwnedHttpMetadataPublicResponse, withOwnedHttpVersion } from '../http-identity-owner.ts';
import { withOwnedNativeLocalError, markLocalError } from '../native-errors.ts';
import { withOwnedRequestId, withOwnedBackgroundRecovery, setBackgroundRecovery } from '../correlation.ts';
import { ownedErrorResponse, ownedExpiryResponse, ownedHttpError, caughtOwnedResponse, withOwnedCors } from '../utils.ts';
import { ownedStaticHeld } from '../../test/helpers/owned-static-custody-observer.mjs';
import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { discardOwnedHttpInitialError, tryBeginOwnedHttpRequest, ownedHttpPlatformFailure, beginOwnedHttpRequest, finishOwnedHttpRequest, ownedHttpSinkOwner, ownedHttpFailureMetadata,
  ownedHttpQueueSend, ownedHttpArchivePut, ownedHttpArchivePipe, ownedHttpArchiveAbort, ownedHttpArchiveCancel, cancelOwnedHttpResponse, discardOwnedHttpSinkResponse,
  beginOwnedHttpSinkRegistration, completeOwnedHttpSinkRegistration, ownedHttpCompletion, ownedHttpLedgerAcknowledgment,
  consumeOwnedHttpPreflight, consumeOwnedHttpGrantMaterialization, admitOwnedHttpMaterializationPayload,
  prepareOwnedHttpContinuation, consumeOwnedHttpContinuation } from '../http-identity-owner.ts';
import { resolveOwnedHttpAuthentication, evictCredentialGeneration } from '../credential-preflight.ts';
import { PolicyBindingIndexObject } from '../authority.ts';
import { sqliteFixture } from './sqlite-storage.mjs';
import { createOwnedHttpPreparationAccounting } from '../proxy-accounting.ts';
import { snapshot } from '../providers.ts';
import { accountingSinks, finalizeOwnedAccounting, reserveBudget, settleOwnedBudget } from '../accounting.ts';
import { materializeGrantCredentials } from '../grant-credentials.ts';
import { proxyResponseHeaders, observeOwnedGenericUsage, GenericUsageReader, normalizeOwnedHttpPreStreamError, OwnedNormalizerReader } from '../proxy-response.ts';
import { HttpOperation } from '../http-operation.ts';
import { selectedCredentialFailure, SelectedGrantCredentialFailure } from '../grant-credential-failure.ts';
import { bodyBudgetBytes, ExactBodyCharge, bodyBudgetCharged } from '../body-budget.ts';
import { HttpError } from '../utils.ts';
import { accessBytesResponse } from './access-byte-fixture.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.then(() => undefined, () => undefined);
  return { promise, resolve, reject };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const byteJson = (value, status = 200, headers) => accessBytesResponse(JSON.stringify(value), 'https://clawrouter.internal/materialize', { status, ...(headers ? { headers } : {}) });
const event = { id: 'owned-event', type: 'clawrouter.usage.v1', tenant_id: 'tenant', policy_id: 'policy', request_id: 'owned-request' };
const reservation = { reservations: [{ objectName: 'tenant:policy', reservationId: 'owned-reservation' }], reservedMicros: 1 };
const auth = { policyId: 'policy', credentialId: 'credential', principalId: null, policy: { tenantId: 'tenant', monthlyBudgetMicros: 100 } };
const cost = { reserveMicros: 1, basis: 'manifest_pricing', inputTokens: 1, outputTokens: 1 };

test('private receipt factories reject unregistered and mixed parent permits before acquisition', async t => {
  const env = environment(); let effects = 0, ticketReads = 0;
  const binding = { idFromName() { effects++; throw Error('unregistered acquisition'); }, get() { effects++; throw Error('unregistered acquisition'); } };
  env.ACCESS_CONTROL = binding; env.GRANT_CREDENTIALS = binding;
  const ticket = { get bytes() { ticketReads++; throw Error('duck-typed funding'); }, enter() { ticketReads++; throw Error('unregistered source factory'); } };
  await fixture(t, env, async f => {
    for (const permit of [{}, f.cap, f.sink]) {
      assert.throws(() => consumeOwnedHttpPreflight(f.cap, f.sink, permit, ticket, binding, '{}', {}),
        error => error?.code === 'identity_admission_unavailable');
      assert.throws(() => consumeOwnedHttpGrantMaterialization(f.sink, f.cap, permit, binding, 'fixture', '{}'),
        error => error?.code === 'identity_admission_unavailable');
      assert.throws(() => admitOwnedHttpMaterializationPayload(f.sink, f.cap, permit, env, 'fixture', {}, 4096),
        error => error?.code === 'identity_admission_unavailable');
      assert.throws(() => prepareOwnedHttpContinuation(f.cap, permit, {}, ticket, binding, 'policy-bindings'),
        error => error?.code === 'identity_admission_unavailable');
      assert.throws(() => consumeOwnedHttpContinuation(f.cap, permit, {}, '{}'),
        error => error?.code === 'identity_admission_unavailable');
    }
    assert.equal(effects, 0); assert.equal(ticketReads, 0);
  });
});

// UNRUN_CODE_ONLY_HOSTED: a saved callback cannot transfer a second Response,
// including after its genuine owner and request have physically retired.
for (const phase of ['cleanup', 'retired', 'rejected-first'])
test(`private ledger FIRST leaves a ${phase} duplicate Response untouched`, async t => {
  const env = environment(), held = deferred();
  let accepted, rejected, observations = 0, posts = 0, touched = 0;
  const foreign = new Response(null);
  for (const key of ['body', 'headers', 'ok', 'status']) Object.defineProperty(foreign, key, {
    get() { touched++; throw Error('foreign duplicate Response was inspected'); },
  });
  env.BUDGET_LEDGER.get = () => ({ fetch() {
    posts++;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"settled":true}')); controller.close();
    } });
    const getReader = body.getReader;
    body.getReader = function (...args) {
      const reader = Reflect.apply(getReader, this, args);
      Object.defineProperty(reader, 'closed', { get() { return held.promise; } });
      return reader;
    };
    const original = phase === 'rejected-first' ? Promise.reject(undefined) : Promise.resolve(new Response(body));
    const then = original.then;
    original.then = function (yes, no) {
      observations++; accepted = yes; rejected = no;
      void Reflect.apply(then, this, [yes, no]);
      return undefined;
    };
    return original;
  } });
  await fixture(t, env, async f => {
    f.releases.push(held.resolve, () => { accepted = undefined; rejected = undefined; });
    const work = f.own(ownedHttpLedgerAcknowledgment(f.sink, env.BUDGET_LEDGER, 'fixture', '/settle', '{}'));
    if (phase === 'rejected-first') {
      await assert.rejects(f.take(work), error => ownedHttpFailureMetadata(error)?.primaryIsUndefined === true);
    } else assert.equal((await f.take(work)).settled, true);
    if (phase !== 'cleanup') { held.resolve(); await f.finish(); }
    const before = bodyBudgetCharged();
    accepted(foreign); rejected(undefined);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(touched, 0); assert.equal(posts, 1); assert.equal(observations, 1);
    assert.equal(bodyBudgetCharged(), before, 'duplicate cannot acquire a new owner or release the real one');
    held.resolve();
  });
});

function environment() {
  return {
    BUDGET_LEDGER: { idFromName(name) { return name; }, get() { return { fetch: async () => json({ settled: true }) }; } },
    USAGE_LEDGER: { idFromName(name) { return name; }, get() { return { fetch: async () => json({ eventId: event.id, outcome: 'stored' }) }; } },
    USAGE_QUEUE: { async send() {} },
    GRANT_CREDENTIALS: { idFromName(name) { return name; }, get() { return { fetch: async () => byteJson({ grant: { credential: 'fixture-only' } }) }; } },
  };
}

// UNRUN_CODE_ONLY_HOSTED: successful private ACK construction is bounded
// before JSON.parse. Ordinary ledger JSON and provider profiles are unchanged.
for (const [path, payload, expectedId, field] of [
  ['/reserve', { allowed: true, dispatched: true }, undefined, 'allowed'],
  ['/dispatch', { dispatched: true }, undefined, 'dispatched'],
  ['/charge', { charged: true, chargeId: 'fixture-charge' }, 'fixture-charge', 'charged'],
  ['/settle', { settled: true }, undefined, 'settled'],
  ['/ingest', { eventId: 'fixture-event', outcome: 'stored' }, 'fixture-event', 'outcome'],
]) test(`private ${path} uses bounded bytes and preserves its successful scalar acknowledgment`, async t => {
  const env = environment(); let posts = 0, jsonCalls = 0;
  const namespace = path === '/ingest' ? env.USAGE_LEDGER : env.BUDGET_LEDGER;
  namespace.get = () => ({ fetch(url, init) {
    posts++; assert.equal(new URL(url).pathname, path); assert.equal(init.method, 'POST');
    const response = new Response(JSON.stringify(payload));
    response.json = () => { jsonCalls++; throw Error('private ACK must not construct an unbounded native JSON graph'); };
    return Promise.resolve(response);
  } });
  await fixture(t, env, async f => {
    const reply = await f.take(f.own(ownedHttpLedgerAcknowledgment(f.sink, namespace, 'fixture', path, '{}', undefined, expectedId)));
    assert.equal(reply.ok, true); assert.equal(reply[field], payload[field]);
    if (expectedId) assert.equal(reply.chargeId ?? reply.eventId, expectedId);
    assert.equal(posts, 1); assert.equal(jsonCalls, 0);
  });
});

for (const bytes of [32768, 32769]) test(`private ACK ${bytes} wire bytes is ${bytes === 32768 ? 'accepted' : 'rejected before native parse'}`, async t => {
  const env = environment(), prefix = '{"settled":true,"unused":"', suffix = '"}';
  const text = prefix + 'x'.repeat(bytes - prefix.length - suffix.length) + suffix;
  let parses = 0;
  const parse = JSON.parse;
  JSON.parse = function (input, ...rest) { if (input === text) parses++; return Reflect.apply(parse, this, [input, ...rest]); };
  t.after(() => { JSON.parse = parse; });
  env.BUDGET_LEDGER.get = () => ({ fetch: async () => new Response(text) });
  await fixture(t, env, async f => {
    const work = f.own(ownedHttpLedgerAcknowledgment(f.sink, env.BUDGET_LEDGER, 'fixture', '/settle', '{}'));
    if (bytes === 32768) assert.equal((await f.take(work)).settled, true);
    else { const reply = await f.take(work); assert.equal(reply.ok, true); assert.equal(reply.settled, undefined); }
    assert.equal(parses, bytes === 32768 ? 1 : 0);
  });
});

for (const backing of [65536, 65537]) test(`private ACK checks the whole ${backing}-byte default-reader backing`, async t => {
  const env = environment(), text = '{"settled":true}', encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(backing), chunk = new Uint8Array(buffer, 7, encoded.length); chunk.set(encoded);
  env.BUDGET_LEDGER.get = () => ({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close(); } })) });
  await fixture(t, env, async f => {
    const work = f.own(ownedHttpLedgerAcknowledgment(f.sink, env.BUDGET_LEDGER, 'fixture', '/settle', '{}'));
    if (backing === 65536) assert.equal((await f.take(work)).settled, true);
    else { const reply = await f.take(work); assert.equal(reply.ok, true); assert.equal(reply.settled, undefined); }
  });
});

for (const text of [
  '{"settled":true,"unknown":' + '['.repeat(160) + '0' + ']'.repeat(160) + '}',
  '{"settled":true,"' + 'k'.repeat(4097) + '":' + '9'.repeat(4097) + '}',
  '\ufeff{"settled":false,"settled":true,"__proto__":{"settled":false},"unknown":"\\ud800"}',
]) test(`private ACK ignores codec-only limits and preserves bounded native JSON semantics (${text.length} units)`, async t => {
  const env = environment(); env.BUDGET_LEDGER.get = () => ({ fetch: async () => new Response(text) });
  await fixture(t, env, async f => {
    const reply = await f.take(f.own(ownedHttpLedgerAcknowledgment(f.sink, env.BUDGET_LEDGER, 'fixture', '/settle', '{}')));
    assert.equal(reply.settled, true);
  });
});

for (const path of ['/charge', '/settle', '/ingest']) test(`private ${path} preserves fetch rejection separately from invalid ACK recovery`, async t => {
  const env = environment(), reason = Object.freeze({ opaque: 'transport' });
  const namespace = path === '/ingest' ? env.USAGE_LEDGER : env.BUDGET_LEDGER;
  await fixture(t, env, async f => {
    namespace.get = () => ({ fetch: () => Promise.reject(reason) });
    const rejected = f.own(ownedHttpLedgerAcknowledgment(f.sink, namespace, 'fixture', path, '{}'));
    await assert.rejects(f.take(rejected), error => ownedHttpFailureMetadata(error)?.origin === 'fetch');
    namespace.get = () => ({ fetch: async () => new Response('{invalid') });
    const invalid = await f.take(f.own(ownedHttpLedgerAcknowledgment(f.sink, namespace, 'fixture', path, '{}')));
    assert.deepEqual(invalid, { ok: true });
  });
});

test('the former ignored-array ACK counterexample exceeds the ticket by source arithmetic only', () => {
  const emptyObjects = 2097152;
  assert.equal(3 * emptyObjects + 27, 6291483);
  assert.equal(16 * emptyObjects + 82, 33554514);
  assert.ok(16 * emptyObjects + 82 > 32 * 1024 * 1024);
  // No huge string, array, graph or native parser invocation is constructed.
});

// Release first, join each original once by origin, then retire the genuine
// request. Every native/body command under test enrolls its own retirement.
async function fixture(t, env, run, requestOverride) {
  const sharedBefore = ownedStaticHeld(), baseline = bodyBudgetCharged(), request = requestOverride ?? new Request('https://router.example/v1/chat/completions'), cap = beginOwnedHttpRequest(request, env);
  const sink = ownedHttpSinkOwner(cap), roots = [], origins = new WeakMap(), releases = [];
  let hasPrimary = false, primary, cleanupPromise, retirement, finished = false;
  const finish = () => retirement ??= finishOwnedHttpRequest(cap);
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    origins.set(promise, root); roots.push(root); return root;
  };
  const take = async root => { const outcome = await root.outcome; root.used = true; if (outcome.failed) throw outcome.error; return outcome.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const errors = [];
    for (const release of releases) try { release(); } catch (error) { errors.push(error); }
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index], outcome = await root.outcome;
      if (outcome.failed && !root.used) { root.used = true; errors.push(outcome.error); }
    }
    try { await finish(); } catch (error) { errors.push(error); }
    try { assert.equal(bodyBudgetCharged(), baseline + ownedStaticHeld() - sharedBefore, 'exact sink retirement plus the permanent fixed-custody claim'); } catch (error) { errors.push(error); }
    return errors;
  })();
  t.after(async () => { if (!finished) { const errors = await cleanup(); if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors); } });
  try { await run({ cap, request, sink, own, take, releases, baseline, finish }); } catch (error) { hasPrimary = true; primary = error; }
  const errors = await cleanup(); finished = true;
  if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'owned sink fixture cleanup');
  if (hasPrimary) throw primary;
}

test('a genuine sink does not authorize caller-supplied preparation identity or request', async t => {
  const env = environment();
  await fixture(t, env, async f => {
    const provider = snapshot.providers.find(value => value.id === 'fireworks');
    const endpoint = provider.endpoints.find(value => value.request_format === 'openai.chat_completions');
    const completion = ownedHttpCompletion(f.cap).fork();
    f.releases.push(() => completion.seal());
    const options = { env, request: f.request, context: { waitUntil: value => { f.own(value); } },
      completion, ownedHttp: f.sink,
      auth: { ...auth, authType: 'proxy_key', policy: { ...auth.policy, requestCostMicros: 1 } },
      selection: { provider, endpoint, model: null, capability: 'llm.chat', method: 'POST', body: { messages: [] } } };
    const before = bodyBudgetCharged();
    for (const request of [f.request, new Request('https://router.example/other')]) {
      assert.throws(() => createOwnedHttpPreparationAccounting(f.cap, { ...options, request }));
      assert.equal(bodyBudgetCharged(), before, 'closed invocation provenance precedes metadata factories');
    }
    completion.seal();
  });
});

for (const kind of ['undefined', 'shared']) test(`retired sink diagnostics consume every ${kind} origin once in acquisition order`, async t => {
  const reports = [], first = deferred(), second = deferred(), env = environment();
  let calls = 0, reads = 0;
  const reason = kind === 'undefined' ? undefined : Object.freeze({
    get message() { reads++; throw Error('foreign failure must stay opaque'); },
    get stack() { reads++; throw Error('foreign failure must stay opaque'); },
  });
  t.mock.method(console, 'warn', function (...fields) { reports.push(fields); });
  env.USAGE_QUEUE.send = function () { return ++calls === 1 ? first.promise : second.promise; };
  await fixture(t, env, async f => {
    f.releases.push(() => first.reject(reason), () => second.reject(reason));
    const a = f.own(ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, event));
    const b = f.own(ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, event));
    second.reject(reason); await assert.rejects(f.take(b), error => ownedHttpFailureMetadata(error)?.origin === 'queue');
    first.reject(reason); await assert.rejects(f.take(a), error => ownedHttpFailureMetadata(error)?.origin === 'queue');
    assert.equal(reports.length, 0, 'reporting waits for actual request retirement');
  });
  assert.equal(reads, 0); assert.equal(calls, 2); assert.equal(reports.length, 2);
  assert.ok(reports.every(row => row[0] === 'owned_http_diagnostic' && row[1] === 'queue'
    && row[3] === true && row[4] === true && row[5] === (kind === 'undefined') && row[6] === 0));
  assert.ok(reports[0][2] < reports[1][2], 'arrival order does not reorder acquired origins');
});

function guardedReason() {
  let reads = 0;
  const reason = Object.create(null);
  for (const key of ['message', 'stack', 'cause', 'errors', 'toJSON', Symbol.toPrimitive]) {
    Object.defineProperty(reason, key, { get() { reads++; throw Error('reason must remain opaque'); } });
  }
  reason.payload = 'x'.repeat(17 * 1024 * 1024);
  return { reason, reads: () => reads };
}

for (const kind of ['undefined', 'large-string', 'opaque-object']) test(`private first observers preserve independent ${kind} origins without retaining the reason`, async t => {
  const guarded = kind === 'opaque-object' ? guardedReason() : undefined;
  const reason = kind === 'undefined' ? undefined : guarded?.reason ?? 'x'.repeat(17 * 1024 * 1024);
  const env = environment();
  env.USAGE_QUEUE.send = function () { assert.equal(this, env.USAGE_QUEUE); return Promise.reject(reason); };
  await fixture(t, env, async f => {
    const first = f.own(ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, event));
    const second = f.own(ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, event));
    const failures = [];
    for (const root of [first, second]) { try { await f.take(root); assert.fail('expected rejection'); } catch (error) { failures.push(error); } }
    assert.notEqual(failures[0], reason); assert.notEqual(failures[1], reason);
    const rows = failures.map(ownedHttpFailureMetadata);
    assert.ok(rows.every(row => row.failed && row.primary && row.origin === 'queue' && row.primaryIsUndefined === (reason === undefined)));
    assert.notEqual(rows[0].ordinal, rows[1].ordinal, 'shared reason never deduplicates distinct originals');
    assert.equal(guarded?.reads() ?? 0, 0);
    for (const failure of failures) assert.deepEqual(Object.keys(failure).sort(), ['disposition', 'failed', 'ordinal', 'origin', 'primary', 'primaryIsUndefined']);
  });
});

test('a sink without a plan-bound rollback right starts no settlement or queue original', async t => {
  const env = environment(); let acquisitions = 0, sends = 0;
  env.BUDGET_LEDGER.get = () => { acquisitions++; throw Error('unexpected unregistered settlement'); };
  env.USAGE_QUEUE.send = async () => { sends++; };
  await fixture(t, env, async f => {
    const original = f.own(settleOwnedBudget(accountingSinks(env, f.sink), reservation, 1));
    await assert.rejects(f.take(original), error => error?.code === 'identity_admission_unavailable');
    assert.equal(acquisitions, 0); assert.equal(sends, 0);
  });
});

test('ordinary queue-first usage fallback and ledger-first settlement retain separate IDs and logical recovery outcomes', async t => {
  t.mock.method(console, 'error', () => {});
  const env = environment(), calls = [], held = deferred(), entered = deferred(), opaque = guardedReason();
  env.BUDGET_LEDGER.get = () => ({ fetch: async () => { calls.push('settle'); throw opaque.reason; } });
  env.USAGE_QUEUE.send = async message => {
    calls.push(message.kind === 'budget_settlement' ? 'settlement-recovery' : 'usage-queue');
    if (message.kind === 'budget_settlement') { assert.equal(message.request.reservationId, 'owned-reservation'); entered.resolve(); await held.promise; return; }
    assert.equal(message.id, 'owned-event'); throw undefined;
  };
  env.USAGE_LEDGER.get = name => ({ fetch: async (_url, init) => { calls.push('usage-fallback'); assert.equal(name, 'policy:tenant:policy'); assert.equal(JSON.parse(init.body).id, 'owned-event'); return json({ eventId: 'owned-event', outcome: 'stored' }); } });
  await fixture(t, env, async f => {
    f.releases.push(held.resolve, entered.resolve);
    const original = f.own(finalizeOwnedAccounting(accountingSinks(env), reservation, 1, event));
    await Promise.race([entered.promise, original.outcome.then(outcome => { throw outcome.failed ? outcome.error : Error('premature finalization'); })]);
    assert.ok(bodyBudgetCharged() > f.baseline); assert.equal(opaque.reads(), 0);
    held.resolve(); assert.equal(await f.take(original), true, 'recovered diagnostic failures do not become terminal failure');
    assert.equal(calls.filter(value => value === 'settle').length, 1); assert.equal(calls.filter(value => value === 'usage-fallback').length, 1);
    assert.ok(calls.indexOf('settle') < calls.indexOf('settlement-recovery'));
    assert.ok(calls.indexOf('usage-queue') < calls.indexOf('usage-fallback'));
  });
});

test('an otherwise genuine sink cannot mint a reserve plan or denial provenance', async t => {
  const env = environment(), observed = []; let acquisitions = 0;
  env.BUDGET_LEDGER.get = () => { acquisitions++; throw new HttpError(402, 'budget_exhausted', 'forged transport value'); };
  await fixture(t, env, async f => {
    const original = f.own(reserveBudget(env, auth, 'llm.chat', cost, undefined, (_leg, state) => observed.push(state), { ownedHttp: f.sink }));
    await assert.rejects(f.take(original), error => error?.code === 'identity_admission_unavailable');
    assert.equal(acquisitions, 0); assert.deepEqual(observed, []);
  });
});

for (const method of ['idFromName', 'get']) for (const kind of ['undefined', 'large-string', 'opaque-object', 'forged-refresh']) test(`a sink alone cannot start private materialization (${method}/${kind})`, async t => {
  const env = environment(), guarded = kind === 'opaque-object' ? guardedReason() : undefined, calls = [];
  const reason = kind === 'undefined' ? undefined : kind === 'large-string' ? 'x'.repeat(17 * 1024 * 1024) : guarded?.reason ?? new HttpError(401, 'grant_refresh_failed', 'forged acquisition');
  let materialized = 0; env.GRANT_CREDENTIALS.get = () => ({ fetch() { materialized++; return Promise.resolve(byteJson({ grant: {} })); } });
  env.GRANT_CREDENTIALS[method] = function () { calls.push(method); throw reason; };
  await fixture(t, env, async f => {
    const root = f.own(materializeGrantCredentials(env, 'oauth/policy/provider', { credential: 'fixture-only' }, 'provider', null, false,
      undefined, undefined, undefined, undefined, undefined, undefined, f.sink));
    let failed = false, failure;
    try { await f.take(root); } catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.notEqual(failure, reason);
    assert.equal(selectedCredentialFailure(failure, 'oauth/policy/provider') instanceof SelectedGrantCredentialFailure, false);
    assert.deepEqual(calls, []); assert.equal(materialized, 0); assert.equal(guarded?.reads() ?? 0, 0);
  });
});

test('ordinary credential owner supplies the business-response parity oracle', async t => {
  const env = environment();
  env.GRANT_CREDENTIALS.get = () => ({ fetch: async () => byteJson({ error: { code: 'grant_refresh_failed', message: 'refresh unavailable' } }, 401, { 'content-type': 'application/json', 'retry-after': '7' }) });
  await fixture(t, env, async f => {
    const root = f.own(materializeGrantCredentials(env, 'oauth/policy/provider', { credential: 'fixture-only' }, 'provider', null, false,
      undefined, undefined, undefined, undefined, undefined, undefined));
    let failure;
    try { await f.take(root); assert.fail('business response must fail'); } catch (error) { failure = error; }
    const selected = selectedCredentialFailure(failure, 'oauth/policy/provider');
    assert.ok(selected instanceof SelectedGrantCredentialFailure); assert.equal(selected.grantKey, 'oauth/policy/provider');
    assert.equal(selected.status, 401); assert.equal(selected.code, 'grant_refresh_failed'); assert.equal(selected.message, 'refresh unavailable');
    assert.equal(selected.headers, undefined, 'the ordinary materialization callback remains unchanged');
  });
});

test('registration rejection after start retains the ORIGINAL work and a distinct bounded origin', async t => {
  const env = environment(), held = deferred(), opaque = guardedReason();
  await fixture(t, env, async f => {
    f.releases.push(held.resolve);
    const receipt = beginOwnedHttpSinkRegistration(f.sink);
    const original = held.promise.then(() => true), root = f.own(original);
    let failure;
    try { completeOwnedHttpSinkRegistration(receipt, { waitUntil(work) { assert.equal(work, original); throw opaque.reason; } }, original); }
    catch (error) { failure = error; }
    assert.equal(ownedHttpFailureMetadata(failure).origin, 'registration'); assert.equal(opaque.reads(), 0);
    assert.ok(bodyBudgetCharged() > f.baseline);
    held.resolve(); assert.equal(await f.take(root), true);
  });
});

// UNRUN_CODE_ONLY_HOSTED: the private observer-return amendment is deliberate.
// These originals are real Promises; only their actual observer method changes.
for (const command of ['put', 'pipe', 'cancel', 'queue', 'body-cancel', 'detached-cancel']) {
  for (const returned of ['undefined', 'held', 'hostile']) {
    test(`private ${command} ignores ${returned} observer return and joins the actual callback`, async t => {
      const env = environment(), actual = deferred(), external = deferred();
      await fixture(t, env, async f => {
        f.releases.push(actual.resolve, external.resolve);
        const actualThen = Promise.prototype.then;
        let invocations = 0, observations = 0, touched = 0;
        const hostile = Object.defineProperty({}, 'then', { get() { touched++; throw Error('discarded observer return was inspected'); } });
        actual.promise.then = function (yes, no) {
          observations++; assert.equal(this, actual.promise); assert.equal(arguments.length, 2);
          void Reflect.apply(actualThen, this, [yes, no]);
          return returned === 'held' ? external.promise : returned === 'hostile' ? hostile : undefined;
        };
        const invoke = () => { invocations++; return actual.promise; };
        let ready;
        if (command === 'put') {
          env.CONTENT_ARCHIVE = { put: invoke };
          ready = ownedHttpArchivePut(f.sink, env.CONTENT_ARCHIVE, 'fixture', 'wire', '2099-01-01');
        } else if (command === 'queue') {
          env.USAGE_QUEUE.send = invoke;
          ready = ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, event);
        } else {
          const source = new ReadableStream();
          if (command === 'pipe') {
            source.pipeTo = invoke;
            ready = ownedHttpArchivePipe(f.sink, source, new WritableStream(), new AbortController().signal);
          } else {
            source.cancel = invoke;
            if (command === 'cancel') ready = ownedHttpArchiveCancel(f.sink, source);
            else {
              const response = new Response(source);
              if (command === 'body-cancel') ready = cancelOwnedHttpResponse(f.sink, response);
              else discardOwnedHttpSinkResponse(f.sink, response);
            }
          }
        }
        assert.equal(invocations, 1); assert.equal(observations, 1); assert.equal(touched, 0);
        const root = ready && f.own(ready);
        let retired = false;
        const retirement = f.own(f.finish().then(() => { retired = true; }));
        await Promise.resolve(); await Promise.resolve();
        assert.equal(retired, false, 'the observer return is not original settlement');
        actual.resolve({ ignored: 'successful native result' });
        if (root) assert.equal(await f.take(root), undefined);
        await f.take(retirement);
        assert.equal(retired, true, 'an unrelated held observer return supplies no custody');
        assert.equal(touched, 0); assert.equal(invocations, 1); assert.equal(observations, 1);
      });
    });
  }
}

for (const returned of ['undefined', 'held', 'hostile']) {
  test(`private registration passes exact work and ignores its ${returned} observer return`, async t => {
    const env = environment(), actual = deferred(), external = deferred();
    await fixture(t, env, async f => {
      f.releases.push(actual.resolve, external.resolve);
      const actualThen = Promise.prototype.then;
      let observed = 0, registered = 0, touched = 0;
      const hostile = Object.defineProperty({}, 'then', { get() { touched++; throw Error('external observer product'); } });
      actual.promise.then = function (yes, no) {
        observed++; assert.equal(this, actual.promise); assert.equal(arguments.length, 2);
        void Reflect.apply(actualThen, this, [yes, no]);
        return returned === 'held' ? external.promise : returned === 'hostile' ? hostile : undefined;
      };
      const context = { get waitUntil() {
        assert.equal(observed, 1, 'work observation precedes the actual registration getter');
        return function (work) { registered++; assert.equal(this, context); assert.equal(work, actual.promise); };
      } };
      completeOwnedHttpSinkRegistration(beginOwnedHttpSinkRegistration(f.sink), context, actual.promise);
      let ended = false;
      const retirement = f.own(f.finish().then(() => { ended = true; }));
      await Promise.resolve(); await Promise.resolve(); assert.equal(ended, false);
      actual.reject(undefined); await f.take(retirement);
      assert.equal(observed, 1); assert.equal(registered, 1); assert.equal(touched, 0);
    });
  });
}


test('ordinary materialization acquisition keeps its existing outcome; private mixed owners acquire nothing', async t => {
  const env = environment(), reason = new HttpError(401, 'grant_refresh_failed', 'ordinary acquisition');
  let acquisitions = 0;
  env.GRANT_CREDENTIALS.idFromName = () => { acquisitions++; throw reason; };
  let caught, failed = false;
  try { await materializeGrantCredentials(env, 'oauth/policy/provider', {}, 'provider', null, false); }
  catch (error) { failed = true; caught = error; }
  assert.equal(failed, true); assert.equal(caught, reason); assert.equal(acquisitions, 1);
  await fixture(t, env, async f => {
    for (const supplied of [null, false, 0, {}, f.sink]) {
      const root = f.own(materializeGrantCredentials(env, 'oauth/policy/provider', {}, 'provider', null, false,
        undefined, undefined, supplied === f.sink ? {} : undefined, undefined, undefined, undefined, supplied));
      let rejected = false;
      try { await f.take(root); } catch { rejected = true; }
      assert.equal(rejected, true);
    }
    assert.equal(acquisitions, 1, 'invalid/mixed owners are rejected before namespace acquisition');
  });
});


for (const kind of ['undefined', 'large-string', 'opaque-object']) test(`archive ${kind} failure does not retain the reason while its original cancellation is held`, async t => {
  const env = environment(), gate = deferred(), entered = deferred(), guarded = kind === 'opaque-object' ? guardedReason() : undefined;
  const reason = kind === 'undefined' ? undefined : guarded?.reason ?? 'x'.repeat(17 * 1024 * 1024);
  let puts = 0, cancels = 0;
  env.CONTENT_ARCHIVE = { put() { puts++; return Promise.reject(reason); } };
  await fixture(t, env, async f => {
    f.releases.push(gate.resolve);
    const source = new ReadableStream({ cancel() { cancels++; entered.resolve(); return gate.promise.then(() => { throw reason; }); } }, { highWaterMark: 0 });
    const destination = new TransformStream(), abort = new AbortController();
    const pipe = f.own(ownedHttpArchivePipe(f.sink, source, destination.writable, abort.signal));
    const put = f.own(ownedHttpArchivePut(f.sink, env.CONTENT_ARCHIVE, 'fixture/archive', destination.readable, '123'));
    let putFailure, putFailed = false;
    try { await f.take(put); } catch (error) { putFailed = true; putFailure = error; }
    assert.equal(putFailed, true); assert.equal(ownedHttpFailureMetadata(putFailure).origin, 'put');
    ownedHttpArchiveAbort(f.sink, abort);
    const cancel = f.own(ownedHttpArchiveCancel(f.sink, destination.readable));
    // The pipe's original cancel is pending. No fulfilled headers/put response
    // or bounded failure carrier gives the source lease retirement credit.
    await Promise.race([entered.promise, pipe.outcome.then(outcome => {
      pipe.used = true;
      if (outcome.failed) throw outcome.error;
      throw new Error('original pipe fulfilled before cancel entry');
    })]);
    assert.ok(bodyBudgetCharged() > f.baseline);
    gate.resolve();
    const failures = [putFailure];
    for (const root of [pipe, cancel]) try { await f.take(root); } catch (error) { failures.push(error); }
    assert.ok(failures.every(error => ownedHttpFailureMetadata(error)?.failed));
    assert.ok(failures.some(error => error.origin === 'pipe'));
    assert.equal(new Set(failures.map(error => error.ordinal)).size, failures.length);
    assert.equal(puts, 1); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(guarded?.reads() ?? 0, 0);
  });
});


test('private archive preparation rejects forged or unrelated owners before input, binding or byte factories', async t => {
  const { prepareOwnedHttpContentRetention } = await import('../content-retention.ts');
  const env = environment();
  await fixture(t, env, async f => {
    let reads = 0;
    const foreignAuth = { get policy() { reads++; throw Error('foreign archive auth'); } };
    const foreignSelection = { get capability() { reads++; throw Error('foreign archive selection'); } };
    for (const cap of [{}, f.sink, f.cap]) assert.throws(() =>
      prepareOwnedHttpContentRetention(cap, env, foreignAuth, foreignSelection, 'unregistered'),
      error => error?.code === 'identity_admission_unavailable');
    assert.equal(reads, 0);
  });
});


// UNRUN_CODE_ONLY_HOSTED. Clean Node semantics only; hostile Headers storage
// ownership is qualified separately on the exact Workerd build.
function metadataThroughVersion(f, env, response, path = '/v1/chat/completions', id = 'owned-metadata') {
  beginOwnedHttpFinalMetadata(f.cap, f.request, env, response, path, id);
  response = withOwnedNativeLocalError(f.cap, response, path, id);
  response = ownOwnedHttpMetadataPublicResponse(f.cap, response);
  response = withOwnedRequestId(f.cap, response, id);
  response = withOwnedBackgroundRecovery(f.cap, response, f.request);
  return withOwnedHttpVersion(f.cap, response, env);
}
for (const path of ['/v1/chat/completions', '/v1/messages']) for (const branded of [false, true])
test(`private final ${path} formatting requires the genuine local-error brand: ${branded}`, async t => {
  const env = environment(), payload = { error: { code: 'fixture_code', message: 'synthetic error' } };
  await fixture(t, env, async f => {
    let original = new Response(JSON.stringify(payload), { status: 429, headers: { 'content-type': 'application/json', 'content-length': '999' } });
    if (branded) original = markLocalError(original, payload.error.code, payload.error.message);
    const response = withOwnedCors(f.cap, metadataThroughVersion(f, env, original, path), path);
    const body = f.own(response.text());
    assert.equal(response.status, 429);
    const parsed = JSON.parse(await f.take(body));
    if (!branded) { assert.deepEqual(parsed, payload); assert.equal(response.headers.has('x-clawrouter-error-code'), false); }
    else {
      assert.equal(response.headers.get('x-clawrouter-error-code'), 'fixture_code'); assert.equal(response.headers.has('content-length'), false);
      assert.equal(parsed.error.message, 'synthetic error'); assert.equal(parsed.error.type, 'rate_limit_error');
      if (path === '/v1/messages') { assert.equal(parsed.type, 'error'); assert.equal(parsed.request_id, 'owned-metadata'); assert.equal(response.headers.get('request-id'), 'owned-metadata'); }
      else { assert.equal(parsed.error.code, 'fixture_code'); assert.equal(parsed.error.param, null); }
    }
  });
});
for (const existing of [null, 'x-request-id', 'request-id']) test(`private final headers retain provider ID ${existing}`, async t => {
  const env = environment();
  await fixture(t, env, async f => {
    const headers = new Headers({ 'x-clawrouter-request-id': 'untrusted', 'x-ratelimit-new': '7', 'anthropic-ratelimit-unseen': '9', 'x-clawrouter-background-recovery': 'untrusted' });
    if (existing) headers.set(existing, 'provider-id');
    headers.append('set-cookie', 'first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT'); headers.append('set-cookie', 'second=2');
    const locator = 'synthetic-locator-' + 'x'.repeat(8192); setBackgroundRecovery(f.request, locator);
    const foreign = new Request(f.request.url); setBackgroundRecovery(foreign, 'wrong-request');
    const response = withOwnedCors(f.cap, metadataThroughVersion(f, env, new Response(null, { headers })), '/v1/chat/completions');
    assert.equal(response.headers.get('x-clawrouter-request-id'), 'owned-metadata');
    assert.equal(response.headers.get('x-request-id'), existing === 'x-request-id' ? 'provider-id' : existing ? null : 'owned-metadata');
    if (existing === 'request-id') assert.equal(response.headers.get(existing), 'provider-id');
    assert.equal(response.headers.get('x-clawrouter-background-recovery'), locator);
    assert.deepEqual(response.headers.getSetCookie(), ['first=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'second=2']);
    const exposed = response.headers.get('access-control-expose-headers').split(',');
    assert.equal(exposed.filter(name => name === 'x-ratelimit-new').length, 1);
    assert.deepEqual(exposed.slice(-2), ['anthropic-ratelimit-unseen', 'x-ratelimit-new']);
  });
});
for (const value of ['version', 0, -0, NaN, Infinity, true, false, null, undefined])
test(`private version preserves the SECOND primitive operand ${String(value)}`, async t => {
  const env = environment(); let parentGets = 0, idGets = 0;
  Object.defineProperty(env, 'CF_VERSION_METADATA', { get() {
    parentGets++; return { get id() { idGets++; return idGets === 1 ? 'truthy-first' : value; } };
  } });
  await fixture(t, env, async f => {
    const response = withOwnedCors(f.cap, metadataThroughVersion(f, env, new Response(null)), '/v1/chat/completions');
    assert.equal(response.headers.get('x-clawrouter-version-id'), String(value));
    assert.equal(parentGets, 2); assert.equal(idGets, 2);
  });
});
for (const kind of ['object', 'bigint', 'symbol']) test(`private version rejects ${kind} before conversion`, async t => {
  const env = environment(); let calls = 0, coercions = 0;
  const value = kind === 'bigint' ? 1n : kind === 'symbol' ? Symbol('fixture') : { toString() { coercions++; throw Error('foreign conversion'); } };
  Object.defineProperty(env, 'CF_VERSION_METADATA', { get() { return { get id() { return ++calls === 1 ? true : value; } }; } });
  await fixture(t, env, async f => {
    assert.throws(() => metadataThroughVersion(f, env, new Response(null)), error => error.code === 'identity_admission_unavailable');
    assert.equal(calls, 2); assert.equal(coercions, 0);
  });
});
test('private final metadata cannot use a forged owner or replay a completed stage', async t => {
  const env = environment(); let effects = 0;
  const response = new Response(null); Object.defineProperty(response, 'headers', { get() { effects++; throw Error('foreign header inspection'); } });
  assert.throws(() => withOwnedRequestId({}, response, 'fixture')); assert.equal(effects, 0);
  await fixture(t, env, async f => {
    const current = metadataThroughVersion(f, env, new Response(null));
    assert.throws(() => withOwnedRequestId(f.cap, current, 'owned-metadata')); assert.equal(effects, 0);
  });
});


test('private native envelope excludes inherited toJSON without changing ordinary prototypes', async t => {
  const env = environment();
  await fixture(t, env, async f => {
    const original = markLocalError(new Response('initial error body', { status: 500 }), 'fixture_code', 'synthetic message');
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'); let calls = 0, response;
    const restore = () => { if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor); else delete Object.prototype.toJSON; };
    f.releases.push(restore);
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { calls++; return 'foreign replacement'; } });
      response = metadataThroughVersion(f, env, original);
    } finally { restore(); }
    const body = f.own(response.text());
    assert.equal(calls, 0); assert.equal(JSON.parse(await f.take(body)).error.message, 'synthetic message');
  });
});

for (const status of [401, 403, 402, 503]) test('funded private initial error has no inherited serializer at ' + status, async t => {
  await fixture(t, {}, async f => {
    const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    let calls = 0, response;
    const restore = () => {
      if (objectHook) Object.defineProperty(Object.prototype, 'toJSON', objectHook); else delete Object.prototype.toJSON;
      if (arrayHook) Object.defineProperty(Array.prototype, 'toJSON', arrayHook); else delete Array.prototype.toJSON;
    };
    f.releases.push(restore);
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { calls++; throw Error('initial object hook'); } });
      Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { calls++; return 'expanded'; } });
      response = ownedErrorResponse(f.cap, 'fixture_error', 'fixed \"message\"', status, status === 503 ? '1' : undefined);
    } finally { restore(); }
    const work = f.own(response.text());
    assert.equal(calls, 0); assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), status === 503 ? '1' : null);
    assert.deepEqual(JSON.parse(await f.take(work)), { error: { code: 'fixture_error', message: 'fixed \"message\"' } });
  });
});
test('private expiry keeps its initial fields and only genuine caught failures retain status', async t => {
  await fixture(t, {}, async f => {
    const expiry = ownedExpiryResponse(f.cap, 'proxy_key_expired', 'expired', '2026-01-01T00:00:00Z');
    assert.deepEqual(JSON.parse(await f.take(f.own(expiry.text()))), { error: { code: 'proxy_key_expired', message: 'expired' }, expiresAt: '2026-01-01T00:00:00Z', expired: true, active: false });
    const genuine = ownedHttpError(f.cap, 403, 'denied', 'denied');
    const accepted = caughtOwnedResponse(f.cap, genuine);
    assert.equal(accepted.status, 403); await f.take(f.own(accepted.text()));
    const foreign = caughtOwnedResponse(f.cap, new HttpError(402, 'forged', 'must not become a denial'));
    assert.equal(foreign.status, 500);
    assert.equal(JSON.parse(await f.take(f.own(foreign.text()))).error.code, 'internal_error');
  });
});
test('first request reservation refusal returns a scalar without fixed-custody activation', t => {
  const request = new Request('https://router.example/v1/chat/completions'), before = bodyBudgetCharged(), fixed = ownedStaticHeld();
  const pressure = ExactBodyCharge.reserve(bodyBudgetBytes - before - 14335);
  assert.ok(pressure);
  t.after(() => pressure.release());
  try {
    const charged = bodyBudgetCharged();
    assert.equal(tryBeginOwnedHttpRequest(request, {}), undefined);
    assert.equal(bodyBudgetCharged(), charged);
    assert.equal(ownedStaticHeld(), fixed);
  } finally { pressure.release(); }
  assert.equal(bodyBudgetCharged(), before);
});
test('failed terminal rendering stays refused and does not recursively allocate another response', async t => {
  await fixture(t, {}, async f => {
    const before = bodyBudgetCharged();
    const pressure = ExactBodyCharge.reserve(bodyBudgetBytes - before);
    assert.ok(pressure); f.releases.push(() => pressure.release());
    try {
      assert.throws(() => ownedErrorResponse(f.cap, 'large', 'x'.repeat(4096), 503), error => error === ownedHttpPlatformFailure);
      assert.throws(() => caughtOwnedResponse(f.cap, undefined), error => error === ownedHttpPlatformFailure);
      assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
    } finally { pressure.release(); }
  });
});


// UNRUN_CODE_ONLY_HOSTED: this fixed queue entry also serves preparation
// rollback, independently of the final accounting terminal's queue slots.
test('private rollback queue retains an immutable nested copy through its actual held send', async t => {
  const env = environment(), gate = deferred(), entered = deferred();
  const source = { kind: 'budget_settlement', ledger: { objectName: 'tenant:policy' }, request: {
    reservationId: 'owned-reservation', actualCostMicros: 0, unknown: { array: [null, { toJSON: 'inert', value: 7 }] }, omitted: undefined,
  } };
  const wire = JSON.stringify(source); let calls = 0, hooks = 0;
  env.USAGE_QUEUE.send = function (message) {
    calls++; assert.equal(this, env.USAGE_QUEUE); assert.equal(arguments.length, 1); assert.notEqual(message, source);
    for (const value of [message, message.ledger, message.request, message.request.unknown, message.request.unknown.array, message.request.unknown.array[1]]) {
      assert.equal(Object.getPrototypeOf(value), null); assert.equal(Object.isFrozen(value), true);
    }
    entered.resolve();
    return gate.promise.then(() => {
      for (const value of [message, message.request.unknown.array[1]])
        assert.equal(Reflect.defineProperty(value, 'toJSON', { value() { hooks++; return {}; } }), false);
      assert.equal(Reflect.set(message.request.unknown.array, 'length', 0), false);
      assert.equal(JSON.stringify(message), wire);
    });
  };
  await fixture(t, env, async f => {
    f.releases.push(gate.resolve, entered.resolve);
    const work = f.own(ownedHttpQueueSend(f.sink, env.USAGE_QUEUE, source));
    await entered.promise; assert.ok(bodyBudgetCharged() > f.baseline);
    assert.equal(JSON.stringify(source), wire); assert.equal(Object.isFrozen(source), false);
    gate.resolve(); await f.take(work); assert.equal(calls, 1); assert.equal(hooks, 0);
  });
});

test('superseded private initial error starts one cancellation and retains the source until its original joins', async t => {
  const env = environment(), gate = deferred();
  await fixture(t, env, async f => {
    try {
      const response = ownedErrorResponse(f.cap, 'model_not_found', 'fixture missing model', 404), original = response.body.cancel;
      let calls = 0;
      response.body.cancel = function (...args) { calls++; assert.equal(args.length, 0); return gate.promise.then(() => Reflect.apply(original, this, args)); };
      discardOwnedHttpInitialError(f.cap, response); discardOwnedHttpInitialError(f.cap, response);
      assert.equal(calls, 1);
      assert.throws(() => discardOwnedHttpInitialError(f.cap, new Response(null)), error => error?.code === 'identity_admission_unavailable');
    } finally { gate.resolve(); }
  });
});


// UNRUN_CODE_ONLY_HOSTED: use the real authority admission/SQLite producer and
// the genuine HTTP authentication route, not a fabricated lower receipt parent.
for (const mode of ['held-return', 'undefined-return', 'hostile-return', 'unlock-before', 'unlock-after', 'null-body', 'malformed', 'private503', 'non-success', 'unknown-envelope', 'late-abort'])
test(`private continuation uses a VOID handoff and joins ${mode}`, { timeout: 45000 }, async t => {
  const env = environment(), gate = deferred(), entered = deferred(), cleanupGate = deferred(), cancelEntered = deferred();
  const digest = 'ab'.repeat(32), abort = new AbortController();
  const { sql, transactionSync } = sqliteFixture(t), stored = new Map([
    ['credentials/continuation-fixture', { enabled: true, secretSha256: digest, policyId: 'continuation-policy', policyGeneration: 'legacy', principalId: null }],
    ['policies/continuation-policy', { enabled: true, generation: 'legacy', providers: [], requestCostMicros: 7 }],
  ]);
  env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '0';
  env.POLICY_KV = { async get(key, type) { const value = stored.get(key); return value === undefined ? null
    : type === 'stream' ? accessBytesResponse(JSON.stringify(value), '').body : value; } };
  const authority = new PolicyBindingIndexObject({ storage: { transactionSync, sql } }, env);
  const nativeThen = Promise.prototype.then;
  let posts = 0, observers = 0, returnReads = 0, unlocks = 0, nativeUnlocks = 0, cancels = 0, reads = 0, saved, completed = false;
  const foreign = new Response(null);
  for (const key of ['body', 'headers', 'ok', 'status']) Object.defineProperty(foreign, key, {
    get() { throw Error('duplicate continuation Response was inspected'); },
  });
  const hostile = { get then() { returnReads++; throw Error('observer return must remain untouched'); } };
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { fetch(url, init) {
    const path = new URL(url).pathname;
    const work = authority.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' }));
    if (path !== '/admission/resolve') return work;
    posts++; assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['x-clawrouter-private-admission'], 'v1');
    let delivered = work;
    if (['null-body', 'malformed', 'private503', 'non-success', 'unknown-envelope'].includes(mode)) delivered = work.then(async response => {
      if (mode === 'unknown-envelope') {
        const value = await response.json(); value.admission.unknown = { retained: 'x'.repeat(65536), toJSON: 'inert', nested: [null, true] };
        return byteJson(value);
      }
      await response.body?.cancel();
      if (mode === 'null-body') return new Response(null);
      if (mode === 'malformed') return accessBytesResponse('{invalid', '');
      return byteJson({ error: { code: mode === 'private503' ? 'identity_admission_unavailable' : 'fixture_refusal',
        message: mode === 'private503' ? 'Identity admission failed (limit)' : 'fixture authority refusal' } }, mode === 'private503' ? 503 : 409);
    });
    if (mode === 'late-abort') delivered = work.then(response => {
      const body = response.body, getReader = body.getReader;
      body.getReader = function (...args) {
        const reader = Reflect.apply(getReader, this, args), read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
        reader.read = function (...args) { reads++; return Reflect.apply(read, this, args); };
        reader.cancel = function (...args) {
          cancels++; assert.equal(this, reader); assert.deepEqual(args, ['private admission stopped']);
          return Reflect.apply(cancel, this, args).then(() => { cancelEntered.resolve(); return cleanupGate.promise; });
        };
        reader.releaseLock = function (...args) { unlocks++; assert.equal(this, reader); assert.equal(args.length, 0); return Reflect.apply(unlock, this, args); };
        return reader;
      };
      return response;
    });
    if (mode.startsWith('unlock-')) delivered = work.then(response => {
      const body = response.body, getReader = body.getReader;
      body.getReader = function (...args) {
        const reader = Reflect.apply(getReader, this, args), unlock = reader.releaseLock;
        reader.releaseLock = function (...args) {
          unlocks++;
          const native = () => { Reflect.apply(unlock, this, args); nativeUnlocks++; };
          if (mode === 'unlock-before') native();
          entered.resolve();
          return gate.promise.then(() => { if (mode === 'unlock-after') native(); });
        };
        return reader;
      };
      return response;
    });
    Object.defineProperty(delivered, 'then', { value(yes, no) {
      observers++; assert.equal(this, delivered); assert.equal(arguments.length, 2); saved = yes;
      void Reflect.apply(nativeThen, this, [value => {
        if (mode === 'late-abort') { entered.resolve(); void gate.promise.then(() => { yes(value); value = undefined; }); }
        else { yes(value); if (!mode.startsWith('unlock-')) entered.resolve(); }
      }, no]);
      return mode === 'held-return' ? gate.promise : mode === 'hostile-return' ? hostile : undefined;
    } });
    return delivered;
  } }; } };
  await fixture(t, env, async f => {
    f.releases.push(gate.resolve, cleanupGate.resolve, cancelEntered.resolve, entered.resolve);
    try {
      const work = f.own(resolveOwnedHttpAuthentication(f.cap, f.request, env, 'continuation-fixture', digest, { providers: [], allConnections: false })
        .then(value => { completed = true; return value; }, error => { completed = true; throw error; }));
      await entered.promise;
      if (mode.startsWith('unlock-')) {
        assert.equal(completed, false); assert.equal(unlocks, 1);
        assert.equal(nativeUnlocks, mode === 'unlock-before' ? 1 : 0); assert.ok(bodyBudgetCharged() > f.baseline);
        gate.resolve();
      }
      if (mode === 'late-abort') {
        abort.abort(); assert.equal(completed, false); assert.ok(bodyBudgetCharged() > f.baseline); gate.resolve();
        await cancelEntered.promise;
        assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(unlocks, 0); assert.equal(completed, false);
        const held = bodyBudgetCharged(); saved(foreign); assert.equal(bodyBudgetCharged(), held);
        assert.equal(cancels, 1); cleanupGate.resolve();
      }
      if (['null-body', 'malformed', 'private503', 'non-success', 'late-abort'].includes(mode)) {
        await assert.rejects(f.take(work), error => mode === 'malformed' ? error instanceof SyntaxError
          : mode === 'non-success' ? error.message === 'Authority identity query failed'
          : error?.code === 'identity_admission_unavailable' && error.message === 'Identity admission failed (' + (mode === 'private503' ? 'limit' : mode === 'late-abort' ? 'transport' : 'protocol') + ')');
      } else assert.equal(await f.take(work), null);
      assert.equal(posts, 1); assert.equal(observers, 1); assert.equal(returnReads, 0);
      if (mode === 'late-abort') { assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(reads, 0); }
      const retiredCharge = bodyBudgetCharged(); saved(foreign); assert.equal(bodyBudgetCharged(), retiredCharge); assert.equal(posts, 1);
    } finally { gate.resolve(); cleanupGate.resolve(); cancelEntered.resolve(); evictCredentialGeneration(env, 'continuation-fixture'); }
  }, new Request('https://router.example/v1/chat/completions', { signal: abort.signal }));
});

test('generic normalizer rejects forged, mixed and unassociated receipts before response getters or reader factories', async t => {
  const env = environment();
  await fixture(t, env, async f => {
    let gets = 0;
    const response = new Response(null), operation = new HttpOperation();
    for (const key of ['body', 'headers', 'status']) Object.defineProperty(response, key, { get() { gets++; throw Error('unregistered response access'); } });
    try {
      for (const cap of [{}, f.cap, f.sink]) {
        const before = bodyBudgetCharged();
        assert.throws(() => OwnedNormalizerReader.limited(cap));
        assert.throws(() => OwnedNormalizerReader.sniff(cap));
        assert.throws(() => GenericUsageReader.create(cap, response, operation));
        assert.throws(() => observeOwnedGenericUsage(cap, response, operation));
        const headers = new Headers();
        assert.throws(() => createOwnedHttpCodecUsageResponse(cap, {}, operation, response, null, 200, '', headers));
        assert.throws(() => createOwnedHttpGenericUsageResponse(cap, {}, response, null, 200, '', headers));
        assert.throws(() => bindOwnedHttpGenericBodylessResponse(cap, {}, response));
        assert.throws(() => beginOwnedHttpProxyPublicationHeaders(cap, response, 'fixture'));
        assert.throws(() => checkOwnedHttpProxyPublicationBody(cap, response, null));
        assert.throws(() => finishOwnedHttpProxyPublication(cap, response, null, 200, '', headers));
        await assert.rejects(normalizeOwnedHttpPreStreamError(cap, f.sink, response, true, operation));
        assert.equal(bodyBudgetCharged(), before); assert.equal(gets, 0);
      }
    } finally { operation.stop('complete'); }
  });
});


test('clean Node ordinary proxy header regression retains native case, cookies and strip semantics', () => {
  const source = new Response(null, { headers: { 'X-Mixed-Case': 'one', 'X-Unicode': 'héllo', 'x-clawrouter-error-code': 'spoof' } });
  source.headers.append('x-mixed-case', 'two'); source.headers.append('Set-Cookie', 'one=1'); source.headers.append('Set-Cookie', 'two=2');
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'trailer', 'transfer-encoding', 'upgrade',
    'x-clawrouter-grant-failover', 'openai-organization', 'openai-project', 'anthropic-organization-id', 'anthropic-workspace-id']) source.headers.set(name, 'fixture');
  const output = proxyResponseHeaders(source, 'fixture');
  assert.equal(output.get('x-mixed-case'), 'one, two'); assert.equal(output.get('x-unicode'), 'héllo');
  assert.deepEqual(output.getSetCookie(), []); assert.equal(output.get('x-clawrouter-upstream-provider'), 'fixture');
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'trailer', 'transfer-encoding', 'upgrade',
    'x-clawrouter-grant-failover', 'x-clawrouter-error-code', 'openai-organization', 'openai-project', 'anthropic-organization-id', 'anthropic-workspace-id']) assert.equal(output.get(name), null, name);
  assert.deepEqual(source.headers.getSetCookie(), ['one=1', 'two=2']);
});
