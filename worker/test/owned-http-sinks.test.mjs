import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { beginOwnedHttpRequest, finishOwnedHttpRequest, ownedHttpSinkOwner, ownedHttpFailureMetadata,
  ownedHttpQueueSend, ownedHttpArchivePut, ownedHttpArchivePipe, ownedHttpArchiveAbort, ownedHttpArchiveCancel, beginOwnedHttpSinkRegistration, completeOwnedHttpSinkRegistration, ownedHttpCompletion } from '../http-identity-owner.ts';
import { createOwnedHttpPreparationAccounting } from '../proxy-accounting.ts';
import { snapshot } from '../providers.ts';
import { accountingSinks, finalizeOwnedAccounting, reserveBudget, settleOwnedBudget } from '../accounting.ts';
import { materializeGrantCredentials } from '../grant-credentials.ts';
import { selectedCredentialFailure, SelectedGrantCredentialFailure } from '../grant-credential-failure.ts';
import { bodyBudgetCharged } from '../body-budget.ts';
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

function environment() {
  return {
    BUDGET_LEDGER: { idFromName(name) { return name; }, get() { return { fetch: async () => json({ settled: true }) }; } },
    USAGE_LEDGER: { idFromName(name) { return name; }, get() { return { fetch: async () => json({ eventId: event.id, outcome: 'stored' }) }; } },
    USAGE_QUEUE: { async send() {} },
    GRANT_CREDENTIALS: { idFromName(name) { return name; }, get() { return { fetch: async () => byteJson({ grant: { credential: 'fixture-only' } }) }; } },
  };
}

// Release first, join each original once by origin, then retire the genuine
// request. Every native/body command under test enrolls its own retirement.
async function fixture(t, env, run) {
  const baseline = bodyBudgetCharged(), request = new Request('https://router.example/v1/chat/completions'), cap = beginOwnedHttpRequest(request, env);
  const sink = ownedHttpSinkOwner(cap), roots = [], origins = new WeakMap(), releases = [];
  let hasPrimary = false, primary, cleanupPromise, finished = false;
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
    try { await finishOwnedHttpRequest(cap); } catch (error) { errors.push(error); }
    try { assert.equal(bodyBudgetCharged(), baseline, 'last actual sink retirement releases funding'); } catch (error) { errors.push(error); }
    return errors;
  })();
  t.after(async () => { if (!finished) { const errors = await cleanup(); if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors); } });
  try { await run({ cap, request, sink, own, take, releases, baseline }); } catch (error) { hasPrimary = true; primary = error; }
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

test('non-OK settlement starts recovery before its ORIGINAL unused body cancellation settles', async t => {
  const env = environment(), release = deferred(), entered = deferred(), recovered = deferred();
  let cancelCount = 0, sends = 0;
  env.BUDGET_LEDGER.get = () => ({ fetch: async () => new Response(new ReadableStream({
    cancel() { cancelCount++; entered.resolve(); return release.promise; },
  }, { highWaterMark: 0 }), { status: 503 }) });
  env.USAGE_QUEUE.send = async message => { sends++; assert.equal(message.request.reservationId, 'owned-reservation'); recovered.resolve(); };
  await fixture(t, env, async f => {
    f.releases.push(release.resolve, entered.resolve, recovered.resolve);
    const original = f.own(settleOwnedBudget(accountingSinks(env, f.sink), reservation, 1));
    await Promise.race([recovered.promise, original.outcome.then(outcome => { if (outcome.failed) throw outcome.error; })]);
    await f.take(original);
    assert.equal(sends, 1); assert.equal(cancelCount, 1);
    assert.ok(bodyBudgetCharged() > f.baseline, 'pending original cancel still owns funding after recovery success');
    release.resolve(); await entered.promise;
  });
});

test('queue-first usage fallback and ledger-first settlement retain separate IDs and logical recovery outcomes', async t => {
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
    const original = f.own(finalizeOwnedAccounting(accountingSinks(env, f.sink), reservation, 1, event));
    await Promise.race([entered.promise, original.outcome.then(outcome => { throw outcome.failed ? outcome.error : Error('premature finalization'); })]);
    assert.ok(bodyBudgetCharged() > f.baseline); assert.equal(opaque.reads(), 0);
    held.resolve(); assert.equal(await f.take(original), true, 'recovered diagnostic failures do not become terminal failure');
    assert.equal(calls.filter(value => value === 'settle').length, 1); assert.equal(calls.filter(value => value === 'usage-fallback').length, 1);
    assert.ok(calls.indexOf('settle') < calls.indexOf('settlement-recovery'));
    assert.ok(calls.indexOf('usage-queue') < calls.indexOf('usage-fallback'));
  });
});

test('transport-shaped budget 402 is not a genuine allowed:false denial', async t => {
  for (const genuine of [false, true]) {
    const env = environment(), observed = [];
    env.BUDGET_LEDGER.get = () => ({ fetch: async () => {
      if (!genuine) throw new HttpError(402, 'budget_exhausted', 'forged transport value');
      return json({ allowed: false });
    } });
    await fixture(t, env, async f => {
      const original = f.own(reserveBudget(env, auth, 'llm.chat', cost, undefined, (_leg, state) => observed.push(state), { ownedHttp: f.sink }));
      let failed = false, failure;
      try { await f.take(original); } catch (error) { failed = true; failure = error; }
      assert.equal(failed, true);
      assert.equal(failure instanceof HttpError, genuine);
      if (genuine) { assert.equal(failure.status, 402); assert.equal(failure.code, 'budget_exhausted'); }
      else assert.equal(ownedHttpFailureMetadata(failure).origin, 'fetch');
      assert.deepEqual(observed, genuine ? ['attempted', 'denied'] : ['attempted']);
    });
  }
});

for (const method of ['idFromName', 'get']) for (const kind of ['undefined', 'large-string', 'opaque-object', 'forged-refresh']) test(`private materialization classifies ${method}/${kind} before selected-grant retry`, async t => {
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
    assert.deepEqual(calls, [method]); assert.equal(materialized, 0); assert.equal(guarded?.reads() ?? 0, 0);
  });
});

test('validated credential owner business response preserves admitted-key retry provenance', async t => {
  const env = environment();
  env.GRANT_CREDENTIALS.get = () => ({ fetch: async () => byteJson({ error: { code: 'grant_refresh_failed', message: 'refresh unavailable' } }, 401, { 'content-type': 'application/json', 'retry-after': '7' }) });
  await fixture(t, env, async f => {
    const root = f.own(materializeGrantCredentials(env, 'oauth/policy/provider', { credential: 'fixture-only' }, 'provider', null, false,
      undefined, undefined, undefined, undefined, undefined, undefined, f.sink));
    let failure;
    try { await f.take(root); assert.fail('business response must fail'); } catch (error) { failure = error; }
    const selected = selectedCredentialFailure(failure, 'oauth/policy/provider');
    assert.ok(selected instanceof SelectedGrantCredentialFailure); assert.equal(selected.grantKey, 'oauth/policy/provider');
    assert.equal(selected.status, 401); assert.equal(selected.code, 'grant_refresh_failed'); assert.equal(selected.message, 'refresh unavailable');
    assert.equal(selected.headers['Retry-After'], '7');
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
