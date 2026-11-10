import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { PolicyBindingIndexObject } = await import('../authority.ts');
const { preflightCredential, consumeCredentialPreflight, completeCredentialAdmission, releaseCredentialPreflight, releaseCredentialPreflightContinuation } = await import('../credential-preflight.ts');
const { PreflightTicket, PreflightInstanceArena, admissionScratchBytes, reserveAdmissionScratch, retireAdmissionScratch, transferAdmissionScratch, preflightPayloadBytes, admissionBridgeFactoryCharges, admissionBridgeChoiceFactoryCharges, admissionBridgeCopyFactoryCharges, admissionBridgeBoundaryFactoryCharges, admissionBridgeSerializationFactoryCharges, admissionBridgePassiveExamples, admissionBridgePhasePayload, preflightControlSlots } = await import('../credential-preflight-arena.ts');
const { consumeAdmissionBridge, admissionBridgeFailureMetadata } = await import('../credential-preflight-source.ts');
const { bodyBudgetCharged } = await import('../body-budget.ts');
const { identitySourceBudget, identityPlan, planPrivateIdentityString, admitGeneratedRuntime, foldIdentitySqlHistory, isIdentityFailure } = await import('../identity-admission.ts');
const { normalizedChoiceCandidates, consumeOwnedChoiceCandidates, chooseGrantKey, chooseOwnedGrantKey, GRANT_SELECTION_STRATEGIES } = await import('../grant-selection-strategies.ts');
const { normalizePolicyRecord, normalizePrivatePolicyRecord } = await import('../authority-policy.ts');
const { grantRoutingPolicy, privateGrantRoutingPolicy, privateGrantKey, validGrantKey } = await import('../grant-routing.ts');
const { normalizeUser, normalizePrivateUser } = await import('../authority-users.ts');
const { normalizeGrantRuntimeState, normalizePrivateGrantRuntimeState } = await import('../grant-runtime.ts');
const { selectAdmissionCandidate, selectPrivateAdmissionCandidate, privatePreparationScratch, privateHashScratch, privateSnapshotScratch, privateChoiceScratch } = await import('../authority-grant-selection.ts');
const { default: providerSnapshot } = await import('../generated/provider-snapshot.json', { with: { type: 'json' } });
const digest = 'ab'.repeat(32), rotated = 'cd'.repeat(32);
const credential = (secretSha256 = digest) => ({ enabled: true, secretSha256, policyId: 'bridge-policy', policyGeneration: 'legacy', principalId: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const denied = error => isIdentityFailure(error) && error.status === 503;

async function fixture(t, run) {
  const roots = [], releases = [], resources = [];
  let cleanupPromise, finished = false, hasPrimary = false, primary;
  const own = promise => { const root = { outcome: Promise.resolve(promise).then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); return root; };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.used) { root.used = true; failures.push(result.error); } }
    for (const release of resources.reverse()) try { release(); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const errors = await cleanup(); if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'bridge fixture cleanup'); } });
  const { db, sql, transactionSync } = sqliteFixture(t), stored = new Map(), trace = { writes: [], reads: [], kv: [] };
  let beforeKv;
  const env = { POLICY_KV: { async get(key, mode) {
    trace.kv.push([key, mode]); await beforeKv?.(key);
    const value = stored.get(key);
    if (value == null) return null;
    return mode === 'stream' ? accessBytesResponse(typeof value === 'string' ? value : JSON.stringify(value), '').body : value;
  } } };
  const owner = new PolicyBindingIndexObject({ storage: { transactionSync, sql: { exec(query, ...args) {
    trace.reads.push(query); if (/^(INSERT|UPDATE|DELETE)/.test(query)) trace.writes.push(query);
    return sql.exec(query, ...args);
  } } } }, env);
  trace.writes.length = 0; trace.reads.length = 0;
  const fetch = (url, init) => take(own(owner.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' }))));
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { fetch }; } };
  const call = async (admission, source = identitySourceBudget(), raw) => {
    const response = await fetch('https://authority/admission/resolve', { method: 'POST', headers: { 'x-clawrouter-private-admission': 'v1' }, body: raw ?? JSON.stringify({ admission, source }) });
    const text = await take(own(response.text())); return { status: response.status, body: JSON.parse(text) };
  };
  try { await run({ db, sql, env, owner, stored, trace, call, own, take, releases, resources, beforeKv(fn) { beforeKv = fn; } }); }
  catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'bridge fixture outcomes');
  if (hasPrimary) throw primary;
}
function seed(f) {
  f.stored.set('credentials/bridgekid', credential());
  f.stored.set('policies/bridge-policy', { enabled: true, generation: 'legacy', providers: [], requestCostMicros: 7 });
}
const input = () => ({ credentialId: 'bridgekid', secretSha256: digest, providers: [] });

test('private full bridge keeps a full charge until explicit opaque disposal; no raw result or clone authority', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged();
  let proof, continuation, handle;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); assert.equal(result.outcome, 'matched'); proof = result.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  assert.throws(() => completeCredentialAdmission({}, { providers: [] }), denied);
  assert.throws(() => completeCredentialAdmission(continuation, { credentialId: 'different', providers: [] }), denied);
  const original = continuation, operation = completeCredentialAdmission(original, { providers: [] }); continuation = undefined;
  handle = await f.take(f.own(operation));
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  assert.deepEqual(Object.keys(handle), ['dispose']); assert.ok(Object.isFrozen(handle));
  assert.equal(JSON.stringify(handle), '{}'); assert.throws(() => handle.dispose.call({}), denied);
  assert.throws(() => completeCredentialAdmission(original, { providers: [] }), denied);
  const disposed = handle; handle.dispose(); handle = undefined; assert.throws(() => disposed.dispose(), denied);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('BOTH private RPCs share the same cumulative source owner with no reset or full-admission effect on exhaustion', async t => fixture(t, async f => {
  seed(f); f.stored.set('credentials/bridgekid', { ...credential(), retainedUnknown: 'x'.repeat(600000) });
  const baseline = bodyBudgetCharged(); let proof, continuation, handle;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest)));
  assert.equal(preflight.outcome, 'matched'); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  // The discarded cold-field bytes remain charged, but the canonical record is
  // small. Add a separately valid request whose original intake crosses BOTH RPCs.
  const admission = { providers: [], retainedUnknown: 'y'.repeat(1600000) };
  assert.doesNotThrow(() => identityPlan().item(admission, 0));
  let sentSource, calls = 0; const get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) {
    const stub = Reflect.apply(get, this, args), original = stub.fetch;
    return { fetch(url, init) {
      if (url.endsWith('/admission/resolve')) { calls++; sentSource = JSON.parse(init.body).source; }
      return Reflect.apply(original, stub, [url, init]);
    } };
  });
  f.trace.writes.length = 0;
  const operation = completeCredentialAdmission(continuation, admission); continuation = undefined;
  const root = f.own(operation), outcome = await root.outcome; root.used = true;
  if (!outcome.failed) handle = outcome.value; // cleanup owns even an unexpected success
  assert.equal(calls, 1); assert.ok(sentSource.bytes >= 600000);
  assert.ok(sentSource.bytes + Buffer.byteLength(JSON.stringify(admission)) > 2097152);
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error)); assert.deepEqual(f.trace.writes, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM proxy_credentials').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_policies').get().n, 0);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('no-selection final canonical winner after KV await; private result keeps complete unknown fields', async t => fixture(t, async f => {
  seed(f); const entered = deferred(), released = deferred(); f.releases.push(() => released.resolve());
  f.beforeKv(async key => { if (key.startsWith('policies/')) { entered.resolve(); await released.promise; } });
  const operation = f.own(f.call(input()));
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), operation.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { operation.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('private operation settled before policy acquisition'); }
  f.db.prepare('INSERT OR REPLACE INTO proxy_credentials(credential_id,credential_json) VALUES(?,?)').run('bridgekid', JSON.stringify({ ...credential(rotated), retainedUnknown: { exact: ['whole', 7] } }));
  released.resolve(); const response = await f.take(operation);
  assert.equal(response.status, 200); assert.equal(response.body.admission.credential.credential.secretSha256, rotated);
  assert.deepEqual(response.body.admission.credential.credential.retainedUnknown, { exact: ['whole', 7] });
  assert.equal(response.body.admission.selection, undefined); assert.deepEqual(response.body.admission.pools, {});
}));

test('prospective complete envelope plus actual reply allowance denies before ANY staged seed or marker', async t => fixture(t, async f => {
  seed(f); const budget = identitySourceBudget(); budget.values = 131050;
  const response = await f.call(input(), budget);
  assert.equal(response.status, 503); assert.equal(response.body.error.code, 'identity_admission_unavailable');
  assert.deepEqual(f.trace.writes, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM proxy_credentials').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM policy_binding_meta').get().n, 0);
}));

test('near-limit prospective REPLY denial follows final canonical reread and precedes every deferred SQL effect', async t => fixture(t, async f => {
  seed(f);
  const baseline = await f.call(input()); assert.equal(baseline.status, 200);
  const reply = identityPlan(); reply.item(baseline.body, 0);
  const inherited = identitySourceBudget();
  inherited.values = 131072 - baseline.body.source.values - reply.counts.values + 1;
  assert.ok(inherited.values > 0); assert.ok(baseline.body.source.values + inherited.values < 131072);
  // Repeat the identical cold operation. Only the inherited numeric value differs;
  // that changes encoded digits, not the number of source/output JSON values.
  f.sql.exec('DELETE FROM proxy_credentials'); f.sql.exec('DELETE FROM access_policies'); f.sql.exec('DELETE FROM policy_binding_meta');
  f.trace.writes.length = 0; f.trace.reads.length = 0;
  let finalDecisions = 0, effects = 0;
  const final = f.owner.finalPrivateAdmission, execute = f.owner.executeAdmissionJournal;
  t.mock.method(f.owner, 'finalPrivateAdmission', function (...args) { const result = Reflect.apply(final, this, args); finalDecisions++; return result; });
  t.mock.method(f.owner, 'executeAdmissionJournal', function (...args) { effects++; return Reflect.apply(execute, this, args); });
  const response = await f.call(input(), inherited);
  assert.equal(response.status, 503); assert.equal(response.body.error.code, 'identity_admission_unavailable');
  assert.equal(finalDecisions, 1); assert.equal(effects, 0); assert.deepEqual(f.trace.writes, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM proxy_credentials').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_policies').get().n, 0);
}));

test('unknown and wrong secret stop before policy work; duplicate original occurrences consume inherited source', async t => fixture(t, async f => {
  assert.equal((await f.take(f.own(preflightCredential(f.env, 'unknownkid', digest)))).outcome, 'unknown');
  seed(f); assert.equal((await f.take(f.own(preflightCredential(f.env, 'bridgekid', rotated)))).outcome, 'invalid');
  assert.equal(f.trace.kv.some(([key]) => key.startsWith('policies/')), false);
  const raw = JSON.stringify({ admission: input(), source: identitySourceBudget() }).replace('"providers":[]', '"discarded":"first","discarded":"last","providers":[]');
  const response = await f.call(input(), identitySourceBudget(), raw);
  assert.equal(response.status, 200); assert.ok(response.body.source.bytes >= Buffer.byteLength(raw));
  assert.ok(response.body.source.units >= 'discardedfirstdiscardedlast'.length);
}));

test('sparse 900-record generated expansion rejects prospectively without changing runtime normalizer semantics', () => {
  const plan = identityPlan(); let admitted = 0;
  const state = { status: 'available', observedAt: '2026-01-01T00:00:00Z', source: 'provider_probe', lastSignal: 'quota', windows: Array.from({ length: 32 }, () => ({ kind: 'generic' })) };
  assert.throws(() => { for (let i = 0; i < 900; i++) { admitGeneratedRuntime(state, plan, 'key' + i); admitted++; } }, denied);
  assert.ok(admitted > 0 && admitted < 900);
});

test('private history fold preserves more than 2048 rows and charges original row vectors', async t => fixture(t, async f => {
  for (let i = 0; i < 2200; i++) f.sql.exec('INSERT INTO upstream_grant_selection(pool_key,grant_key,selected_count,last_selected_ms) VALUES(?,?,?,?)', 'fixture-pool', 'key-' + i, i, i + 1);
  const budget = identitySourceBudget(), counts = foldIdentitySqlHistory(f.sql, 'fixture-pool', budget);
  assert.equal(Object.keys(counts).length, 2200); assert.deepEqual(counts['key-2199'], { count: 2199, lastMs: 2200 });
  assert.equal(budget.values, 8800); assert.equal(budget.containers, 2200); assert.equal(budget.members, 6600);
  const exhausted = identitySourceBudget(); exhausted.values = 131072 - 8799;
  assert.throws(() => foldIdentitySqlHistory(f.sql, 'fixture-pool', exhausted), denied);
}));

for (const reason of [undefined, new Error('shared fixture failure')]) test('bounded bridge preserves original read/cancel/unlock origin flags without raw reasons', async t => fixture(t, async f => {
  const baseline = bodyBudgetCharged(), ticket = PreflightTicket.reserve(), entered = deferred(), cancelGate = deferred();
  f.releases.push(() => cancelGate.resolve()); f.resources.push(() => ticket.release());
  let cancelCalls = 0, unlockCalls = 0, locked = true;
  const body = { get locked() { return locked; }, getReader(options) { assert.equal(options.mode, 'byob'); return {
    read() { entered.resolve(); return Promise.reject(reason); },
    cancel() { cancelCalls++; return cancelGate.promise.then(() => { throw reason; }); },
    releaseLock() { unlockCalls++; locked = false; throw reason; },
  }; } };
  const operation = f.own(consumeAdmissionBridge(ticket, async () => body, identitySourceBudget(), 'record', value => value));
  const arrival = await Promise.race([entered.promise.then(() => true), operation.outcome.then(outcome => ({ outcome }))]);
  if (arrival !== true) { operation.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('premature source fulfillment'); }
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  cancelGate.resolve(); const outcome = await operation.outcome; operation.used = true;
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error));
  assert.deepEqual(admissionBridgeFailureMetadata(outcome.error), { primary: true, primaryIsUndefined: reason === undefined, origins: 14, originOrder: 0x234, category: 'cleanup' });
  assert.equal(cancelCalls, 1); assert.equal(unlockCalls, 1);
  assert.equal(Object.hasOwn(outcome.error, 'cause'), false); ticket.release(); assert.equal(bodyBudgetCharged(), baseline);
}));

test('private consuming choices preserve normalized collisions, stable order, defaults and every key validation', () => {
  const raw = [{ key: ' B ', weight: 3, remainingRatio: 0.5 }, { key: 'a', weight: NaN, remainingRatio: -1 },
    { key: 'b', weight: 7, remainingRatio: 0.8 }, { key: 'A', weight: Infinity }, { key: ' a ', weight: 0, remainingRatio: null }];
  const normalize = key => key.trim().toLowerCase(), owned = raw.map(value => ({ ...value })), first = owned[0], second = owned[1];
  const calls = [], actual = consumeOwnedChoiceCandidates(owned, key => { calls.push(key); return normalize(key); });
  assert.equal(actual, owned); assert.deepEqual(actual, normalizedChoiceCandidates(raw, normalize));
  assert.equal(actual[0], second); assert.equal(actual[1], first); assert.deepEqual(calls, raw.map(value => value.key));
  assert.deepEqual(raw.map(value => value.key), [' B ', 'a', 'b', 'A', ' a ']);
  const invalid = [{ key: 'valid' }, { key: 'bad' }, { key: 'valid' }], reason = new Error('synthetic key rejection');
  assert.throws(() => consumeOwnedChoiceCandidates(invalid, key => { if (key === 'bad') throw reason; return key; }), error => error === reason);
});

test('private stable folds match all six ordinary strategies, fallback, sticky, threshold and random draws', t => {
  let draw = 0, calls = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', array => { calls++; array[0] = draw; return array; });
  const inputs = [
    [{ key: 'z', weight: 3, remainingRatio: 0.1 }, { key: 'a', weight: 1, remainingRatio: 0.8 }, { key: 'm', weight: 2, remainingRatio: null }],
    [{ key: 'z', remainingRatio: null }, { key: 'a', remainingRatio: null }, { key: 'm', remainingRatio: null }],
    [{ key: 'z', remainingRatio: 0.1 }, { key: 'a', remainingRatio: 0.2 }, { key: 'm', remainingRatio: 0.2 }],
    [{ key: 'a', remainingRatio: 0.100000001 }, { key: 'b', remainingRatio: 0.2 }, { key: 'c', remainingRatio: 1 }],
  ];
  const counts = { a: { count: 2, lastMs: 7 }, m: { count: 2, lastMs: 6 } };
  for (const candidates of inputs) for (const strategy of [...GRANT_SELECTION_STRATEGIES, 'unknown'])
    for (const cursorKey of [null, 'a', 'm', 'z', 'missing']) for (const stickyHash of [null, 'f'.repeat(64), 'invalid'])
      for (draw of [0, 0x80000000, 0xffffffff]) {
        const request = { strategy, stickyHash, switchAtUsedPercent: 90, hysteresisPercent: 10, candidates };
        const normalized = normalizedChoiceCandidates(candidates), expected = chooseGrantKey(request, normalized, { cursorKey, counts: new Map(Object.entries(counts)) });
        const owned = candidates.map(candidate => ({ ...candidate })); consumeOwnedChoiceCandidates(owned, String);
        assert.deepEqual(chooseOwnedGrantKey(request, owned, cursorKey, key => counts[key]), expected);
      }
  assert.ok(calls > 0);
});

test('private policy normalization preserves first 1024 UNIQUE models, raw providers and every default field', () => {
  const models = [null, 7, ...Array.from({ length: 1100 }, (_, i) => 'duplicate-' + (i % 10)), ...Array.from({ length: 1100 }, (_, i) => 'unique-' + i)];
  const cases = [{}, { models: null }, { models: 7, providers: [null, 'a', 'a', 9, 'b'] },
    { enabled: false, generation: 'g7', providers: ['x', false, 'y'], models, poolStatus: 'visible', tenantId: 't', tokenRole: 'r',
      monthlyBudgetMicros: 5, dailyBudgetMicros: 6, weeklyBudgetMicros: 7, serviceTiers: { mode: 'strict' }, limitHint: 'limit',
      requestCostMicros: 9, requestCostsMicros: { 'llm.chat': 7 }, budgetMode: 'soft', budgetScope: 'principal', retainRequestContent: false,
      upstreamRetention: { version: 'clawrouter.upstream-retention.v1', allow: [{ providerId: 'openai', protocol: 'http' }] } },
    { inputPublication: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => ['unknown' + i, null])) }];
  for (const value of cases) for (const retain of [false, true]) {
    const before = JSON.stringify(value), expected = normalizePolicyRecord(value, retain);
    let planned = 0;
    const actual = normalizePrivatePolicyRecord(value, retain, emit => { const plan = identityPlan('record'); emit(plan); planned++; });
    assert.deepEqual(actual, expected); assert.deepEqual(Object.keys(actual), Object.keys(expected)); assert.equal(JSON.stringify(value), before); assert.ok(planned > 0);
  }
  const result = normalizePrivatePolicyRecord({ models }, false, emit => emit(identityPlan('record')));
  assert.equal(result.models.length, 1024); assert.equal(result.models[10], 'unique-0'); assert.equal(result.models.at(-1), 'unique-1013');
});

test('private routing preserves ordered unique prefixes, exhausted shared EMPTY properties and proto assignment semantics', () => {
  const value = JSON.parse('{"strategy":"threshold","stickiness":"identity","eligibleGrants":{"__proto__":["prototype-ref"],"z":["b","a","b",null,"bad/ref"]},"sharedGrants":{"__proto__":["oauth/p/proto"],"first":[],"later":["oauth/p/last"]}}');
  value.sharedGrants.first = Array.from({ length: 45 }, (_, i) => 'oauth/p/key-' + Math.floor(i / 1.1));
  const cases = [undefined, null, 7, [], {}, value, { eligibleGrants: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => ['provider-' + i, []])) }];
  for (const input of cases) {
    const before = JSON.stringify(input), expected = grantRoutingPolicy(input);
    const actual = privateGrantRoutingPolicy(input, emit => emit(identityPlan('record'), 0));
    assert.deepEqual(actual, expected); assert.deepEqual(Object.keys(actual.eligibleGrants), Object.keys(expected.eligibleGrants));
    assert.deepEqual(Object.getPrototypeOf(actual.eligibleGrants), Object.getPrototypeOf(expected.eligibleGrants));
    if (expected.sharedGrants) { assert.deepEqual(Object.keys(actual.sharedGrants), Object.keys(expected.sharedGrants)); assert.deepEqual(Object.getPrototypeOf(actual.sharedGrants), Object.getPrototypeOf(expected.sharedGrants)); }
    assert.equal(JSON.stringify(input), before);
  }
  const actual = privateGrantRoutingPolicy(value, emit => emit(identityPlan('record'), 0));
  assert.ok(Object.hasOwn(actual.sharedGrants, 'later')); assert.deepEqual(actual.sharedGrants.later, []);
});

test('private key scan preserves exact three/four segment grammar without a malformed slash vector', () => {
  for (const value of ['oauth/p/key', 'oauth/tenants/t/key', 'oauth/tenants/key', 'oauth//key', 'oauth/p/key/', 'oauth/p/a/b',
    'oauth/' + 'x'.repeat(256) + '/' + 'y'.repeat(256), 'oauth/p/' + 'y'.repeat(257), 'oauth/p/a\u0000b', 'oauth/' + '/'.repeat(100000)]) assert.equal(privateGrantKey(value), validGrantKey(value));
});

for (const abortAt of ['last-read', 'unlock']) test(`actual private intake ${abortAt} abort race denies before seed effects`, async t => fixture(t, async f => {
  seed(f); const controller = new AbortController();
  const body = accessBytesResponse(JSON.stringify({ admission: input(), source: identitySourceBudget() }), '').body;
  const get = body.getReader.bind(body); let reads = 0, cancels = 0, unlocks = 0;
  body.getReader = options => {
    const reader = get(options), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.read = (...args) => { reads++; const original = read(...args); void original.then(part => { if (abortAt === 'last-read' && part.done) controller.abort(); }, () => undefined); return original; };
    reader.cancel = (...args) => { cancels++; return cancel(...args); };
    reader.releaseLock = () => { const result = unlock(); unlocks++; if (abortAt === 'unlock') controller.abort(); return result; };
    return reader;
  };
  const request = new Request('https://authority/admission/resolve', { method: 'POST', headers: { 'x-clawrouter-private-admission': 'v1' }, body, duplex: 'half', signal: controller.signal });
  const response = await f.take(f.own(f.owner.fetch(request)));
  const payload = JSON.parse(await f.take(f.own(response.text())));
  assert.equal(response.status, 503); assert.equal(payload.error.code, 'identity_admission_unavailable');
  assert.ok(reads > 0); assert.equal(unlocks, 1); assert.ok(cancels <= 1);
  assert.deepEqual(f.trace.writes, []); assert.deepEqual(f.trace.kv, []);
}));

test('complete wrapper is prospectively admitted before request copying/RPC; original unknown key order is preserved', async t => fixture(t, async f => {
  seed(f); let proof, continuation;
  f.resources.push(() => { if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const borrowed = { providers: [], first: 'a'.repeat(1048500), second: 'b'.repeat(1048500) };
  const plan = identityPlan(); plan.item(borrowed, 0); // input fits; owner/envelope additions do not
  const before = f.trace.kv.length, consumed = continuation, started = completeCredentialAdmission(consumed, borrowed); continuation = undefined;
  const operation = f.own(started);
  const result = await operation.outcome; operation.used = true;
  assert.equal(result.failed, true); assert.ok(denied(result.error)); assert.equal(f.trace.kv.length, before);
}));

test('JSON-omitted enumerable keys exceed private COPY capacity before the destination factory or RPC', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, continuation;
  f.resources.push(() => { if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  // This existing borrowed allocation is not the new copy being budgeted.
  const borrowed = { providers: [] };
  for (let index = 0; index < 16384; index++) borrowed[String(index).padStart(5, '0') + 'x'.repeat(1019)] = undefined;
  const plan = identityPlan(); plan.item(borrowed, 0); assert.deepEqual(plan.counts, (() => { const p = identityPlan(); p.item({ providers: [] }, 0); return p.counts; })());
  assert.equal(admissionScratchBytes({ C: 1, P: 32768, N: 16384, U: 16777216, B: 0 }), 33947656);
  let copyFactories = 0, rpcOwners = 0;
  const create = Object.create;
  t.mock.method(Object, 'create', function (prototype, ...args) { if (prototype === null) copyFactories++; return Reflect.apply(create, this, [prototype, ...args]); });
  const get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) { rpcOwners++; return Reflect.apply(get, this, args); });
  const original = completeCredentialAdmission(continuation, borrowed); continuation = undefined;
  const root = f.own(original), outcome = await root.outcome; root.used = true;
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error));
  assert.equal(copyFactories, 0); assert.equal(rpcOwners, 0);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('private envelope preserves own __proto__, unknown fields and owner replacement or append positions', async t => fixture(t, async f => {
  seed(f); const captured = [], get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) {
    const stub = Reflect.apply(get, this, args), fetch = stub.fetch;
    return { ...stub, fetch(url, init) {
      if (new URL(url).pathname === '/admission/resolve') captured.push(JSON.parse(init.body).admission);
      return Reflect.apply(fetch, stub, [url, init]);
    } };
  });
  const existing = JSON.parse('{"__proto__":{"kept":true},"credentialId":"bridgekid","providers":[],"secretSha256":"' + digest + '","unknown":{"kept":7}}');
  const appended = JSON.parse('{"providers":[],"__proto__":{"kept":true},"unknown":{"kept":7}}');
  Object.defineProperty(appended, 'credentialId', { value: 'bridgekid', enumerable: false });
  appended.omitted = undefined; appended.symbolValue = Symbol('omitted-value'); // copied, still omitted from JSON
  const ignored = Symbol('fixture-only'), symbolValue = { large: 'x'.repeat(4 * 1048576) };
  symbolValue.self = symbolValue; // not JSON data; must never be traversed for a Symbol key
  let symbolReads = 0;
  Object.defineProperty(existing, ignored, { enumerable: true, get() { symbolReads++; throw undefined; } });
  appended[ignored] = symbolValue;
  for (const borrowed of [existing, appended]) {
    let proof, continuation, handle;
    f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
    const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
    continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
    const operation = completeCredentialAdmission(continuation, borrowed); continuation = undefined;
    handle = await f.take(f.own(operation)); handle.dispose(); handle = undefined;
  }
  assert.equal(captured.length, 2);
  assert.equal(symbolReads, 0); assert.equal(appended[ignored], symbolValue); assert.equal(Object.getOwnPropertyDescriptor(existing, ignored).enumerable, true);
  assert.equal(appended.omitted, undefined); assert.ok(Object.hasOwn(appended, 'omitted'));
  assert.deepEqual(Object.keys(captured[0]), ['__proto__', 'credentialId', 'providers', 'secretSha256', 'unknown']);
  assert.deepEqual(Object.keys(captured[1]), ['providers', '__proto__', 'unknown', 'credentialId', 'secretSha256']);
  for (const admission of captured) {
    assert.ok(Object.hasOwn(admission, '__proto__')); assert.deepEqual(admission.__proto__, { kept: true });
    assert.deepEqual(admission.unknown, { kept: 7 }); assert.equal(admission.credentialId, 'bridgekid'); assert.equal(admission.secretSha256, digest);
  }
}));

test('private legacy/null projection journal publishes the whole post-hash pool in original seed order', async t => fixture(t, async f => {
  seed(f); f.stored.set('oauth/bridge-policy/anthropic', { provider: 'anthropic', kind: 'subscription', enabled: true, accessToken: 'synthetic-fixture-only' });
  const admission = { ...input(), providers: [{ id: 'anthropic', tokenRef: 'anthropic' }], selection: { providerId: 'anthropic', endpointId: 'messages', mode: 'http', model: 'claude-sonnet-5', catalogModelId: 'anthropic/claude-sonnet-5', capability: 'llm.chat' } };
  const response = await f.call(admission); assert.equal(response.status, 200);
  assert.deepEqual(f.db.prepare('SELECT grant_key,projection_json,legacy FROM upstream_grant_projections ORDER BY grant_key').all().map(row => ({ ...row })), [
    { grant_key: 'oauth/bridge-policy/anthropic', projection_json: null, legacy: 1 },
    { grant_key: 'oauth/tenants/default/anthropic', projection_json: null, legacy: 0 },
  ]);
  assert.match(f.trace.writes[0], /proxy_credentials/); assert.match(f.trace.writes[1], /access_policies/);
  assert.match(f.trace.writes[2], /upstream_grant_projections/); assert.match(f.trace.writes[3], /upstream_grant_projections/);
  assert.equal(f.trace.writes.length, 4); assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_selection').get().n, 0);
  f.trace.kv.length = 0; assert.equal((await f.call(admission)).status, 200);
  assert.equal(f.trace.kv.some(([key]) => key.startsWith('oauth/')), false);
}));

test('maximal typed journal charges all 231 entries, denies entry 232 and cannot replay an attempted effect', async t => fixture(t, async f => {
  const ticket = PreflightTicket.reserve(); f.resources.push(() => ticket.release());
  const bound = { bytes: 0, identity: identitySourceBudget(), bridge: { ticket, entries: [], attempted: false } };
  for (let i = 0; i < 131; i++) f.owner.appendAdmissionJournal(bound, { kind: 'seed', family: 3, key: 'provider-' + i, value: {}, text: '{}', marker: 'connections_global_initialized' });
  for (let i = 0; i < 98; i++) f.owner.appendAdmissionJournal(bound, { kind: 'projection', key: 'oauth/fixture/' + i, text: null, legacy: 0, revision: 0, eligible: true });
  f.owner.appendAdmissionJournal(bound, { kind: 'marker', key: 'connections_global_initialized' });
  f.owner.appendAdmissionJournal(bound, { kind: 'selection', poolKey: 'fixture/policy/tenant', selectedKey: 'oauth/fixture/0', cursorKey: 'oauth/fixture/0', nowMs: 7, attempted: false });
  assert.equal(bound.bridge.entries.length, 231); assert.throws(() => f.owner.appendAdmissionJournal(bound, { kind: 'marker', key: 'extra' }), denied);
  f.owner.executeAdmissionJournal(bound);
  assert.equal(f.db.prepare('SELECT count(*) n FROM provider_connections').get().n, 131);
  assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_projections').get().n, 98);
  assert.deepEqual({ ...f.db.prepare('SELECT selected_count,last_selected_ms FROM upstream_grant_selection').get() }, { selected_count: 1, last_selected_ms: 7 });
  assert.throws(() => f.owner.executeAdmissionJournal(bound), denied);
  assert.equal(f.db.prepare('SELECT selected_count n FROM upstream_grant_selection').get().n, 1);
  bound.bridge.entries.length = 0;
}));


test('private user normalization deduplicates RAW groups before transform without capping output', () => {
  const groups = [' X ', 'x', 'X', ' X ', '', '  ', ...Array.from({ length: 1025 }, (_, i) => 'Group-' + i)];
  for (const raw of [groups, null, 'AaA', '\u{10000}\ud800', []]) {
    const value = { email: ' FIXTURE@EXAMPLE.COM ', record: { groups: raw, role: 'owner', tenantId: 't', enabled: false,
      contentRetentionDisabled: true, assignmentState: 'assigned', budgetOverrides: { requestCostMicros: 7 } } };
    const before = JSON.stringify(value), expected = normalizeUser(value);
    const actual = normalizePrivateUser(value, emit => emit(identityPlan('record')));
    assert.deepEqual(actual, expected); assert.equal(JSON.stringify(value), before);
    if (raw === groups) { assert.equal(actual.record.groups.filter(group => group === 'x').length, 3); assert.equal(actual.record.groups.length, 1028); }
  }
  for (const groups of [[7], [null], [true], [NaN], [undefined], [7, 7]]) {
    const value = { email: 'fixture@example.com', record: { groups } };
    assert.throws(() => normalizeUser(value), TypeError);
    assert.throws(() => normalizePrivateUser(value, emit => emit(identityPlan('record'))), TypeError);
  }
});


test('private policy prechecks retain null versus ordinary error and all 64 valid tariff entries', () => {
  const large = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => ['field_' + i, null]));
  const cases = [
    { upstreamRetention: large }, { upstreamRetention: { version: 'clawrouter.upstream-retention.v1', allow: [large] } },
    { inputPublication: large }, { inputPublication: { version: 'clawrouter.input-publication.v1', allow: [large] } },
    { requestCostsMicros: null }, { requestCostsMicros: Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['llm.case_' + i, i])) },
  ];
  for (const value of cases) assert.deepEqual(normalizePrivatePolicyRecord(value, false, emit => emit(identityPlan('record'))), normalizePolicyRecord(value, false));
  for (const requestCostsMicros of [[], 7, large, { invalid: 1 }, { 'llm.chat': -1 }]) {
    let expected, actual;
    try { normalizePolicyRecord({ requestCostsMicros }, false); } catch (error) { expected = error; }
    try { normalizePrivatePolicyRecord({ requestCostsMicros }, false, emit => emit(identityPlan('record'))); } catch (error) { actual = error; }
    assert.ok(expected instanceof Error); assert.equal(actual?.constructor, expected.constructor);
    assert.equal(actual?.message, expected.message); assert.equal(isIdentityFailure(actual), false);
  }
});

test('private cold user reaches RAW-dedup normalization with complete output and no lower group cap', async t => fixture(t, async f => {
  seed(f); f.stored.set('credentials/bridgekid', { ...credential(), principalId: 'fixture@example.com' });
  const record = { enabled: true, groups: [' X ', 'x', 'X', ' X ', ...Array.from({ length: 1025 }, (_, i) => 'Group-' + i)] };
  f.stored.set('access/users/fixture@example.com', record);
  const response = await f.call(input()); assert.equal(response.status, 200);
  assert.deepEqual(response.body.admission.owner, JSON.parse(JSON.stringify(normalizeUser({ email: 'fixture@example.com', record }))));
  assert.equal(response.body.admission.owner.record.groups.filter(group => group === 'x').length, 3);
  assert.ok(f.trace.kv.some(([key, mode]) => key === 'access/users/fixture@example.com' && mode === 'stream'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_users').get().n, 1);
}));

test('private singleton selection preserves shared filtering, priority, exclusions, retry and original grant identity', () => {
  const provider = providerSnapshot.providers.find(item => item.id === 'anthropic');
  const endpoint = provider.endpoints.find(item => item.id === 'messages'); assert.ok(endpoint);
  const grant = (priority, extras = {}) => ({ provider: 'anthropic', kind: 'api_key', enabled: true,
    credentialStore: 'durable_object', credentialStatus: 'active', hasCredential: true, credentialLineage: 'synthetic', credentialGeneration: 1,
    priority, ...extras });
  const candidates = [
    { key: 'oauth/fixture/z', grant: grant(9) }, { key: 'oauth/fixture/b', grant: grant(2) },
    { key: 'oauth/fixture/a', grant: grant(2) }, { key: 'oauth/fixture/off', grant: grant(0, { enabled: false }) },
    { key: 'oauth/fixture/missing', grant: null },
  ];
  const seen = [], choose = choice => { seen.push(choice.candidates.map(value => ({ ...value }))); return { selectedKey: choice.candidates[0].key }; };
  const now = Date.now(), states = { 'oauth/fixture/a': { status: 'cooldown', source: 'provider_probe', lastSignal: 'rate_limited',
    grantRevision: null, observedAt: new Date(now).toISOString(), cooldownUntil: new Date(now + 60000).toISOString(), windows: [] } };
  for (const excludedKeys of [[], ['oauth/fixture/b'], candidates.map(item => item.key)]) for (const pinnedKey of [undefined, null, 'oauth/fixture/a']) {
    const input = { provider, endpoint, request: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', excludedKeys, pinnedKey },
      policy: { policyId: 'fixture', policy: normalizePolicyRecord({}, false) }, poolKey: 'fixture', candidates, states,
      identityHash: 'ab'.repeat(32), fallbackSessionHash: 'cd'.repeat(32) };
    seen.length = 0;
    const expected = selectAdmissionCandidate({}, input, choose, () => 7), expectedChoice = seen[0];
    seen.length = 0;
    const actual = selectPrivateAdmissionCandidate({}, input, choose, () => 7);
    assert.deepEqual(actual, expected); assert.deepEqual(seen[0], expectedChoice);
    if (actual.selected) assert.equal(actual.selected.grant, candidates.find(item => item.key === actual.selected.key).grant);
  }
});

test('private runtime preserves all 128 snapshots without the ordinary pair-index intermediates', () => {
  const observedAt = '2026-01-01T00:00:00Z';
  const windowSnapshots = Object.fromEntries(Array.from({ length: 128 }, (_, i) => ['scope_' + i, { observedAt, ids: ['scope_' + i] }]));
  const raw = { status: 'available', observedAt, source: 'provider_probe', lastSignal: 'quota', windows: [], windowSnapshots };
  const plan = identityPlan('record'); plan.item(raw, 0);
  const normalized = normalizeGrantRuntimeState(raw);
  assert.equal(Object.keys(normalized.windowSnapshots).length, 128);
  assert.deepEqual(normalized.windowSnapshots, windowSnapshots);
  let planned = 0;
  const actual = normalizePrivateGrantRuntimeState(raw, state => { const prospective = identityPlan('record'); admitGeneratedRuntime(state, prospective, 'runtime'); planned++; });
  assert.deepEqual(actual, normalized); assert.equal(planned, 1);
});


test('private runtime parity retains validation errors, prefix scope and first-occurrence IDs', () => {
  const observedAt = '2026-01-01T00:00:00Z';
  const base = { status: 'available', observedAt, source: 'provider_probe', lastSignal: 'quota', windows: [{ kind: 'generic' }] };
  const valid = [base, { ...base, cooldownUntil: 'invalid', grantRevision: 'invalid', windows: [{ kind: 'requests', id: 'requests-x', unit: 'r', window: 'minute',
    remaining: 2, limit: 7, resetAt: observedAt, models: ['model'], observedAt }],
    windowSnapshots: { 'request-*': { observedAt, ids: ['request-a', 'request-b', 'request-a'] }, empty: { observedAt, ids: [] } },
    account: { email: 'fixture@example.com', extraUsageEnabled: true, ignored: 'original unknown' },
    extraUsage: { enabled: false, usedCredits: 7, spendLimitReached: true, currency: 'credits' } }];
  for (const raw of valid) {
    const before = JSON.stringify(raw), expected = normalizeGrantRuntimeState(raw);
    const actual = normalizePrivateGrantRuntimeState(raw, state => admitGeneratedRuntime(state, identityPlan('record'), 'runtime'));
    assert.deepEqual(actual, expected); assert.equal(JSON.stringify(raw), before);
    if (raw.windowSnapshots) assert.deepEqual(actual.windowSnapshots['request-*'].ids, ['request-a', 'request-b']);
  }
  const invalid = [null, [], {}, { ...base, windows: Array.from({ length: 129 }, () => ({ kind: 'generic' })) },
    { ...base, windows: [{ kind: 'generic', remaining: true }] }, { ...base, windows: [{ kind: 'generic', limit: -1 }] },
    { ...base, windows: [{ kind: 'generic', models: [] }] },
    { ...base, cooldownUntil: { toString: 7, valueOf: null }, windows: null },
    { ...base, windows: [{ kind: 'generic', resetAt: { toString: 7, valueOf: null }, models: [] }] },
    { ...base, windows: [{ kind: 'generic', observedAt: { toString: 7, valueOf: null } }] }, { ...base, windowSnapshots: null },
    { ...base, windowSnapshots: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['scope_' + i, { observedAt, ids: [] }])) },
    { ...base, windowSnapshots: { 'request-*': { observedAt, ids: ['other'] } } }];
  for (const raw of invalid) {
    let expected, actual, plans = 0;
    try { normalizeGrantRuntimeState(raw); } catch (error) { expected = error; }
    try { normalizePrivateGrantRuntimeState(raw, () => { plans++; }); } catch (error) { actual = error; }
    assert.ok(expected); assert.equal(actual?.constructor, expected.constructor);
    assert.equal(actual?.status, expected.status); assert.equal(actual?.code, expected.code); assert.equal(actual?.message, expected.message);
    assert.equal(plans, 0); assert.equal(isIdentityFailure(actual), false);
  }
});


test('private PASSIVE_SCRATCH_DATA uses exact occurrence/backing formula and admits before factory/effects', () => {
  const baseline = bodyBudgetCharged(), ticket = PreflightTicket.reserve();
  const vector = { C: 2, P: 5, N: 3, U: 7, B: 32 }, bytes = 126;
  assert.equal(admissionScratchBytes(vector), bytes);
  let factories = 0, effects = 0, lease;
  try {
    assert.throws(() => {
      lease = reserveAdmissionScratch(ticket, preflightPayloadBytes - bytes + 1, vector);
      factories++; effects++;
    }, denied);
    assert.equal(factories, 0); assert.equal(effects, 0);
    lease = reserveAdmissionScratch(ticket, preflightPayloadBytes - bytes, vector);
    assert.equal(lease.bytes, bytes); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
    ticket.release(); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
    lease.retain(); // returning data remains funded beyond synchronous return
    ticket.release(); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
    retireAdmissionScratch(ticket); ticket.release(); assert.equal(bodyBudgetCharged(), baseline);
    assert.throws(() => lease.retire(), denied);
    for (const invalid of [{ ...vector, C: -1 }, { ...vector, P: 0.5 }, { ...vector, N: NaN }, { ...vector, U: Infinity }, { ...vector, B: () => {} }]) assert.throws(() => admissionScratchBytes(invalid), denied);
  } finally { retireAdmissionScratch(ticket); ticket.release(); }
});

test('scratch UNKNOWN retains its SAME instance ticket and does not enlarge the common or instance arena', () => {
  const arena = new PreflightInstanceArena(), ticket = PreflightTicket.reserve(arena);
  const lease = reserveAdmissionScratch(ticket, 0, { C: 1, P: 1, N: 0, U: 0, B: 0 });
  lease.holdUnknown(); retireAdmissionScratch(ticket); ticket.release();
  assert.equal(arena.charged, preflightPayloadBytes);
  const second = PreflightTicket.reserve(arena), third = PreflightTicket.reserve(arena);
  assert.throws(() => PreflightTicket.reserve(arena), denied);
  second.release(); third.release(); assert.equal(arena.charged, preflightPayloadBytes);
  // Deliberately UNKNOWN application ownership has no synthetic release/GC ACK.
});

test('private derived-string planner preserves actual UTF16/UTF8 escaping across borrowed fragments', () => {
  for (const parts of [['oauth/', 'p', '/', 'token'], ['a', '\u0307'], ['\ud800', '\udc00'], ['\ud800', '/', '\udc00'], ['"', '\\', '\n', '\u0000'], ['', '\u{1f98a}', '']]) {
    const actual = identityPlan(), expected = identityPlan();
    planPrivateIdentityString(actual, parts); expected.item(parts.join(''), 0);
    assert.deepEqual(actual.counts, expected.counts);
  }
});


test('private actual configuration owner rejects oversized Env CSV before ordinary configuration suppression or choice', () => {
  const provider = providerSnapshot.providers.find(provider => provider.id === 'anthropic');
  const endpoint = provider.endpoints.find(endpoint => endpoint.id === 'messages');
  assert.ok(provider); assert.ok(endpoint);
  const grant = { provider: 'anthropic', kind: 'api_key', enabled: true, credentialStore: 'durable_object',
    credentialStatus: 'ready', credentialGeneration: 1, credentialLineage: 'fixture_generation', hasCredential: true };
  const candidates = [{ key: 'oauth/fixture/a', grant }];
  const input = { provider, endpoint, request: { providerId: provider.id, endpointId: endpoint.id, mode: 'http' },
    policy: { policyId: 'fixture', policy: normalizePolicyRecord({}, false) }, poolKey: 'fixture', candidates, states: {},
    identityHash: 'ab'.repeat(32), fallbackSessionHash: 'cd'.repeat(32) };
  const baseline = bodyBudgetCharged(), ticket = PreflightTicket.reserve();
  let reads = 0, choices = 0, guards = 0, live = 0;
  const scratch = (vector, run) => {
    const lease = reserveAdmissionScratch(ticket, 0, vector); guards++; live++;
    try { return run(); } finally { live--; lease.retire(); }
  };
  const env = { get CLAWROUTER_OPTIONAL_CONFIG_KEYS() { reads++; return 'A,'.repeat(1677721) + 'A'; } };
  const choose = value => { choices++; return { selectedKey: value.candidates[0].key }; };
  try {
    assert.throws(() => selectPrivateAdmissionCandidate(env, input, choose, () => 1, candidates,
      key => candidates.find(candidate => candidate.key === key), () => true, scratch), denied);
    assert.equal(reads, 1); assert.equal(choices, 0); assert.equal(live, 0); assert.equal(guards, 2);
    const pressure = (_vector, _run) => { throw Object.assign(new Error('fixture pressure'), { fixed: true }); };
    reads = 0;
    assert.throws(() => selectPrivateAdmissionCandidate(env, input, choose, () => 1, candidates,
      key => candidates.find(candidate => candidate.key === key), () => true, pressure), /fixture pressure/);
    assert.equal(reads, 0); assert.equal(choices, 0);
    // The ordinary missing-config HttpError still excludes this candidate.
    const unavailable = { ...provider, base_urls: { ...provider.base_urls, default: '${BRIDGE_MISSING_CONFIG}' } };
    const ordinary = selectAdmissionCandidate({}, { ...input, provider: unavailable }, choose, () => 1);
    const bounded = selectPrivateAdmissionCandidate({}, { ...input, provider: unavailable }, choose, () => 1,
      candidates, key => candidates.find(candidate => candidate.key === key), () => true, scratch);
    assert.deepEqual(bounded, ordinary); assert.equal(bounded.selected, null); assert.equal(choices, 0);
    const vector = privatePreparationScratch({ provider, endpoint, mode: 'http' }, grant);
    assert.ok(vector.U >= 256 * 16384); // repeated replacement references receive no string-alias discount
  } finally { retireAdmissionScratch(ticket); ticket.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test('both hash inputs are funded prospectively and only joined hex residue transfers atomically', () => {
  const identity = 'x'.repeat(1048576), vector = privateHashScratch(identity);
  assert.equal(2 * (2 * identity.length + 17) + 2 * identity.length + 17, 6291507);
  assert.equal(vector.B, 2 * identity.length + 17 + 64);
  const baseline = bodyBudgetCharged(), ticket = PreflightTicket.reserve();
  const lease = reserveAdmissionScratch(ticket, 0, vector);
  try {
    lease.retain({ C: 1, P: 2, N: 0, U: 128, B: 0 });
    ticket.release(); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
    assert.throws(() => lease.retain(), denied);
    retireAdmissionScratch(ticket); ticket.release(); assert.equal(bodyBudgetCharged(), baseline);
  } finally { retireAdmissionScratch(ticket); ticket.release(); }
});


test('actual private DO selected configuration capacity remains branded and commits no staged effects', async t => fixture(t, async f => {
  seed(f);
  f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  f.stored.set('oauth/bridge-policy/anthropic', { provider: 'anthropic', kind: 'api_key', enabled: true,
    credentialStore: 'durable_object', credentialStatus: 'active', credentialGeneration: 1,
    credentialLineage: 'fixture_generation', hasCredential: true });
  f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', 'oauth/bridge-policy/anthropic', 1, 7);
  let configReads = 0;
  Object.defineProperty(f.env, 'CLAWROUTER_OPTIONAL_CONFIG_KEYS', { get() { configReads++; return 'A,'.repeat(1677721) + 'A'; } });
  const result = await f.call({ ...input(), providers: [{ id: 'anthropic', tokenRef: 'anthropic' }],
    selection: { providerId: 'anthropic', endpointId: 'messages', mode: 'http', capability: 'llm.messages' } });
  assert.equal(result.status, 503); assert.equal(result.body.error.code, 'identity_admission_unavailable');
  assert.equal(configReads, 1); assert.equal(f.trace.writes.length, 0);
  for (const table of ['proxy_credentials', 'access_policies', 'provider_connections', 'upstream_grant_projections', 'upstream_grant_selection']) {
    assert.equal(f.db.prepare('SELECT count(*) n FROM ' + table).get().n, 0);
  }
}));

test('passive vector examples do not reclassify journal ownership, guards or native controllers', () => {
  assert.equal(admissionScratchBytes(admissionBridgePassiveExamples.choices), 213060);
  assert.equal(admissionScratchBytes(admissionBridgePassiveExamples.quotaReset), 3088);
  assert.equal(admissionScratchBytes(admissionBridgePassiveExamples.quotaRatio), 2080);
  assert.equal(admissionBridgeFactoryCharges.synchronous.journalEntries, 231);
  assert.equal(admissionBridgeFactoryCharges.synchronous.journalIndexSlots, 231);
  assert.ok(admissionBridgeChoiceFactoryCharges.source.preparationOwnerAndScalarState >= 14);
  assert.ok(admissionBridgeChoiceFactoryCharges.source.scratchVectorGuardWeakOwnerLeaseCloseAndMethods > 0);
  for (const table of [admissionBridgeFactoryCharges, admissionBridgeChoiceFactoryCharges, admissionBridgeCopyFactoryCharges, admissionBridgeBoundaryFactoryCharges, admissionBridgeSerializationFactoryCharges]) for (const [window, entries] of Object.entries(table)) {
    assert.ok(Object.values(entries).reduce((total, value) => total + value, 0) <= preflightControlSlots[window], window);
  }
  assert.equal(Object.values(admissionBridgePhasePayload.workerReply).reduce((total, value) => total + value, 0), 21020672);
});


test('canonical history scratch pressure occurs after metadata and before ORIGINAL SQL values or effects', async t => fixture(t, async f => {
  f.sql.exec("INSERT INTO upstream_grant_selection(pool_key,grant_key,selected_count,last_selected_ms) VALUES(?,?,?,?)", 'pressure', 'oauth/p/a', 1, 7);
  const observed = [], source = identitySourceBudget(), ticket = PreflightTicket.reserve();
  const held = reserveAdmissionScratch(ticket, preflightPayloadBytes - 8, { C: 1, P: 0, N: 0, U: 0, B: 0 });
  let entered = 0, ran = 0;
  try {
    assert.throws(() => foldIdentitySqlHistory({ exec(query, ...args) { observed.push(query); return f.sql.exec(query, ...args); } }, 'pressure', source,
      (_bytes, run) => {
        entered++;
        const next = reserveAdmissionScratch(ticket, preflightPayloadBytes - 8, { C: 1, P: 0, N: 0, U: 0, B: 0 });
        try { ran++; return run(); } finally { next.retire(); }
      }), denied);
    assert.equal(entered, 1); assert.equal(ran, 0);
    assert.equal(observed.length, 1); assert.match(observed[0], /^SELECT count\(\*\)/);
    assert.equal(source.values, 0); assert.equal(source.containers, 0);
    assert.equal(f.db.prepare('SELECT selected_count FROM upstream_grant_selection WHERE pool_key=?').get('pressure').selected_count, 1);
  } finally { held.retire(); retireAdmissionScratch(ticket); ticket.release(); }
}));

test('scratch growth is prospective and producer transfer cannot release or reuse active funding', () => {
  const baseline = bodyBudgetCharged(), ticket = PreflightTicket.reserve();
  const lease = reserveAdmissionScratch(ticket, preflightPayloadBytes - 128, { C: 1, P: 1, N: 1, U: 0, B: 0 });
  let active = true;
  try {
    assert.equal(lease.bytes, 24);
    assert.throws(() => lease.admit({ C: 1, P: 16, N: 0, U: 0, B: 0 }), denied);
    assert.equal(lease.bytes, 24);
    assert.throws(() => transferAdmissionScratch(ticket, { C: 0, P: 0, N: 0, U: 1, B: 1 }), denied);
    assert.equal(ticket.bytes, preflightPayloadBytes);
    lease.admit({ C: 1, P: 3, N: 0, U: 0, B: 0 }); assert.equal(lease.bytes, 32);
    lease.retain({ C: 1, P: 1, N: 0, U: 0, B: 0 }); active = false;
    ticket.release(); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
    // The fixture has cleared the old owner. Actual producer code performs the
    // same handoff only after request/result/journal application aliases clear.
    transferAdmissionScratch(ticket, { C: 0, P: 0, N: 0, U: 2, B: 3 });
    assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  } finally { if (active) lease.retire(); retireAdmissionScratch(ticket); ticket.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test('private default-key rejection measures borrowed megabyte tokenRef before materialization or journal effects', async t => fixture(t, async f => {
  seed(f);
  const result = await f.call({ ...input(), providers: [{ id: 'anthropic', tokenRef: 'x'.repeat(1000000) }] });
  assert.equal(result.status, 400); assert.equal(result.body.error.code, 'authority_error');
  assert.equal(result.body.error.message, 'grant key is invalid');
  assert.equal(f.trace.writes.length, 0);
  assert.equal(f.trace.kv.some(([key]) => key.startsWith('oauth/')), false);
}));

for (const advance of [true, false]) for (const snapshot of [undefined, 'only']) test('final private boundary rejects ' + (advance ? 'new-generation' : 'SAME-generation') + ' unselected publication after ' + (snapshot ?? 'choice'), async t => fixture(t, async f => {
  seed(f);
  f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  const a = 'oauth/bridge-policy/a', b = 'oauth/bridge-policy/b';
  const grant = priority => ({ provider: 'anthropic', kind: 'api_key', enabled: true, priority,
    credentialStore: 'durable_object', credentialStatus: 'active', credentialGeneration: 1,
    credentialLineage: 'fixture_generation', hasCredential: true });
  for (const [key, token, value] of [[a, 'a', grant(2)], [b, 'b', grant(5)]]) {
    f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', key, 1, 7);
    f.sql.exec('INSERT INTO upstream_grant_pool_members(scope,scope_id,provider_id,token_ref,status) VALUES(?,?,?,?,?)', 'policies', 'bridge-policy', 'anthropic', token, 'active');
    f.sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)', key, JSON.stringify(value));
  }
  const admitted = f.owner.admitGrantAttachment({ key: b, generation: 1, revision: 7, provider: 'anthropic', status: 'active' });
  assert.equal(admitted.revision, 8); assert.equal(admitted.pending, false);
  let observed = 0;
  const originalStore = f.owner.admissionStore;
  t.mock.method(f.owner, 'admissionStore', function (...args) {
    const store = Reflect.apply(originalStore, this, args), finish = store.finishSelection;
    store.finishSelection = (...selectionArgs) => {
      const original = Reflect.apply(finish, store, selectionArgs);
      // Register on the ORIGINAL finish promise before the parent's await. This
      // is the pending publication's real synchronous completion between phases.
      f.own(original.then(prior => {
        observed++;
        if (snapshot) {
          assert.equal(prior.selection, undefined);
          assert.equal(prior.snapshots.anthropic.revisions[b], 8);
        } else assert.equal(prior.selection.selected.key, a);
        const published = f.owner.publishGrantAttachment({ key: b, generation: advance ? 2 : 1, revision: 8,
          admissionRevision: 8, provider: 'anthropic', status: 'active', projection: { ...grant(0), credentialGeneration: advance ? 2 : 1 } });
        assert.equal(published.revision, advance ? 9 : 8); assert.equal(published.pending, false);
      }, () => undefined));
      return original;
    };
    return store;
  });
  const result = await f.call({ ...input(), providers: [{ id: 'anthropic', tokenRef: 'a' }],
    selection: { providerId: 'anthropic', endpointId: 'messages', mode: 'http', capability: 'llm.messages' },
    ...(snapshot ? { snapshot } : {}) });
  assert.equal(observed, 1); assert.equal(result.status, 200);
  assert.equal(Object.hasOwn(result.body.admission, 'selection'), false);
  assert.equal(Object.hasOwn(result.body.admission, 'snapshots'), false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_selection').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_pool_cursors').get().n, 0);
  assert.equal(f.db.prepare('SELECT revision FROM upstream_grant_pool_versions WHERE grant_key=?').get(b).revision, advance ? 9 : 8);
  assert.equal(f.db.prepare("SELECT status FROM upstream_grant_pool_members WHERE token_ref='b'").get().status, 'active');
  assert.equal(f.db.prepare('SELECT count(*) n FROM proxy_credentials').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM access_policies').get().n, 1); // earlier seed contract remains; no rollback claim
}));

test('candidate dependency receipts share the bounded execution journal, never a second passive index', async t => fixture(t, async f => {
  const ticket = PreflightTicket.reserve(); f.resources.push(() => ticket.release());
  const bound = { bytes: 0, identity: identitySourceBudget(), bridge: { ticket, entries: [], attempted: false } };
  for (let index = 0; index < 98; index++) f.owner.appendAdmissionJournal(bound,
    { kind: 'projection', key: 'oauth/fixture/' + index, text: null, legacy: 0, revision: 7, eligible: true });
  for (let index = 0; index < 98; index++) f.owner.appendAdmissionJournal(bound,
    { kind: 'dependency', key: 'oauth/fixture/' + index, revision: 7, text: null, legacy: 0 });
  assert.equal(bound.bridge.entries.length, 98);
  assert.ok(bound.bridge.entries.every(entry => entry.kind === 'projection'));
  f.owner.appendAdmissionJournal(bound, { kind: 'dependency', key: 'oauth/fixture/new', revision: 8, text: null, legacy: 0 });
  f.owner.appendAdmissionJournal(bound, { kind: 'dependency', key: 'oauth/fixture/new', revision: 9, text: null, legacy: 0 });
  assert.equal(bound.bridge.entries.length, 99); assert.equal(bound.bridge.entries[98].revision, 8);
  bound.bridge.entries[0].eligible = false;
  f.owner.appendAdmissionJournal(bound, { kind: 'dependency', key: 'oauth/fixture/0', revision: 9, text: null, legacy: 0 });
  assert.equal(bound.bridge.entries.length, 99); assert.equal(bound.bridge.entries[0].kind, 'dependency');
  assert.equal(bound.bridge.entries[0].revision, 9);
  bound.bridge.entries[1].eligible = false;
  f.owner.appendAdmissionJournal(bound, { kind: 'dependency', key: 'oauth/fixture/1', revision: 7, text: null, legacy: 0 });
  assert.equal(bound.bridge.entries[1].kind, 'dependency'); assert.equal(bound.bridge.entries[1].revision, 7);
  bound.bridge.entries.length = 0;
}));


test('unobserved unpublishable staging is not a dependency of the final current result', async t => fixture(t, async f => {
  seed(f);
  const request = { ...input(), providers: [{ id: 'anthropic', tokenRef: 'anthropic' }],
    selection: { providerId: 'anthropic', endpointId: 'messages', mode: 'http', capability: 'llm.messages' } };
  const response = await f.call(request); assert.equal(response.status, 200);
  const prior = response.body.admission; assert.ok(prior.selection);
  f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', 'oauth/old-pool/unused', 2, 9);
  const ticket = PreflightTicket.reserve();
  const bound = { bytes: 0, identity: identitySourceBudget(), bridge: { ticket, attempted: false, result: prior,
    entries: [{ kind: 'projection', key: 'oauth/old-pool/unused', text: null, legacy: 0, revision: 7, eligible: false }] } };
  f.resources.push(() => { bound.bridge.entries.length = 0; bound.bridge.result = undefined; bound.bridge.prior = undefined; retireAdmissionScratch(ticket); ticket.release(); });
  const fresh = f.owner.finalPrivateAdmission(request, prior, bound);
  assert.deepEqual(fresh.selection, prior.selection);
  assert.equal(bound.bridge.entries.length, 1); assert.equal(bound.bridge.entries[0].eligible, false);
}));


for (const pressure of [false, true]) test('1025 JSON-omitted callables stage funded undefined, without invocation: pressure=' + pressure, async t => fixture(t, async f => {
  seed(f); let proof, continuation, handle, calls = 0, copied = 0, rpc = 0;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const borrowed = { providers: [] };
  for (let i = 0; i < 1025; i++) borrowed[String(i).padStart(4, '0') + (pressure ? 'x'.repeat(6396) : '')] = () => { calls++; throw undefined; };
  const stringify = JSON.stringify, get = f.env.ACCESS_CONTROL.get;
  t.mock.method(JSON, 'stringify', function (value, ...args) {
    if (value?.admission && Object.hasOwn(value.admission, '0000' + (pressure ? 'x'.repeat(6396) : ''))) {
      copied++;
      for (let i = 0; i < 1025; i++) assert.equal(value.admission[String(i).padStart(4, '0')], undefined);
      assert.equal(Object.keys(value.admission).length, 1028);
    }
    return Reflect.apply(stringify, this, [value, ...args]);
  });
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) { rpc++; return Reflect.apply(get, this, args); });
  const operation = completeCredentialAdmission(continuation, borrowed); continuation = undefined;
  const root = f.own(operation), outcome = await root.outcome; root.used = true;
  if (pressure) { assert.equal(outcome.failed, true); assert.ok(denied(outcome.error)); assert.equal(copied, 0); assert.equal(rpc, 0); }
  else { assert.equal(outcome.failed, false); handle = outcome.value; assert.equal(copied, 1); assert.equal(rpc, 1); handle.dispose(); handle = undefined; }
  assert.equal(calls, 0); assert.equal(typeof borrowed[Object.keys(borrowed)[1]], 'function');
}));

test('private JSON data refuses own custom serializers and accessors before any callback execution', async t => fixture(t, async f => {
  seed(f); let continuation, calls = 0;
  f.resources.push(() => { if (continuation) releaseCredentialPreflightContinuation(continuation); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest)));
  continuation = consumeCredentialPreflight(preflight.proof, f.env, 'bridgekid', digest);
  for (const value of [{ toJSON() { calls++; throw undefined; } }, Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; throw undefined; } })]) {
    assert.throws(() => completeCredentialAdmission(continuation, { providers: [], unknown: value }), denied);
  }
  assert.equal(calls, 0);
}));

for (const snapshot of ['only', 'select']) test('snapshot output pressure precedes candidate factories and every effect: ' + snapshot, async t => fixture(t, async f => {
  seed(f); f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  let guards = 0, afterGuardValues = 0;
  const scratch = f.owner.privateScratchPhase, base = f.owner.privatePayloadBase;
  const sql = f.owner.sql.exec;
  t.mock.method(f.owner.sql, 'exec', function (query, ...args) {
    if (guards && /^SELECT projection_json, legacy/.test(query)) afterGuardValues++;
    return Reflect.apply(sql, this, [query, ...args]);
  });
  t.mock.method(f.owner, 'privateScratchPhase', function (bound, vector, run, retained) {
    const fresh = bound.bridge.result;
    if (fresh?.pools?.anthropic && vector.C === fresh.pools.anthropic.keys.length + 5 && vector.P === 7 * fresh.pools.anthropic.keys.length + 2 * Object.keys(fresh).length + 24) {
      guards++;
      const mock = t.mock.method(this, 'privatePayloadBase', () => preflightPayloadBytes);
      try { return Reflect.apply(scratch, this, [bound, vector, run, retained]); } finally { mock.mock.restore(); }
    }
    return Reflect.apply(scratch, this, [bound, vector, run, retained]);
  });
  const result = await f.call({ ...input(), providers: [{ id: 'anthropic', tokenRef: 'anthropic' }], snapshot,
    selection: { providerId: 'anthropic', endpointId: 'messages', mode: 'http', capability: 'llm.messages' } });
  assert.equal(guards, 1); assert.equal(result.status, 503); assert.equal(result.body.error.code, 'identity_admission_unavailable');
  assert.equal(afterGuardValues, 0); assert.deepEqual(f.trace.writes, []); assert.equal(f.owner.privatePayloadBase, base);
}));

test('snapshot-output vector funds candidates, revisions, pool-key intermediates, hashes and wrapper fields', () => {
  const fresh = { credential: null, policy: null, owner: null, connections: [], pools: {} };
  const keys = Array.from({ length: 98 }, (_, i) => 'oauth/fixture/' + i);
  const vector = privateSnapshotScratch(fresh, 'anthropic', 'policy', 'default', keys, 'a'.repeat(64), 'b'.repeat(64), true);
  const units = keys.reduce((sum, key) => sum + key.length, 0);
  assert.ok(admissionScratchBytes(vector) > 16 + 32 * keys.length + 2 * units);
  assert.equal(vector.C, 103); assert.ok(vector.P >= 7 * keys.length); assert.ok(vector.N >= keys.length);
  const ticket = PreflightTicket.reserve(); let lease;
  try { lease = reserveAdmissionScratch(ticket, 0, vector); lease.retain(); ticket.release(); assert.equal(ticket.bytes, preflightPayloadBytes); }
  finally { retireAdmissionScratch(ticket); ticket.release(); }
});

for (const valid of [false, true]) test('private principal transforms are funded before trim/lowercase, including long padding: ' + valid, async t => fixture(t, async f => {
  const principal = valid ? ' '.repeat(200000) + 'FIXTURE@EXAMPLE.COM' + ' '.repeat(200000) : ' ' + 'A'.repeat(400000) + ' ';
  const ticket = PreflightTicket.reserve(), bound = { bytes: 0, identity: identitySourceBudget(), bridge: { ticket, entries: [], attempted: false } };
  f.resources.push(() => { retireAdmissionScratch(ticket); ticket.release(); });
  let transforms = 0; const trim = String.prototype.trim;
  t.mock.method(String.prototype, 'trim', function (...args) { if (String(this) === principal) transforms++; return Reflect.apply(trim, this, args); });
  const pressure = t.mock.method(f.owner, 'privatePayloadBase', () => preflightPayloadBytes);
  assert.throws(() => f.owner.privatePrincipal(bound, principal), denied); assert.equal(transforms, 0); pressure.mock.restore();
  assert.equal(f.owner.privatePrincipal(bound, principal), valid ? 'fixture@example.com' : null); assert.equal(transforms, 1);
  ticket.release(); assert.equal(ticket.bytes, preflightPayloadBytes); // returned occurrence remains owned across future cold awaits
}));

test('actual private cold principal keeps padded-email semantics across hydration and final checks', async t => fixture(t, async f => {
  seed(f); f.stored.set('credentials/bridgekid', { ...credential(), principalId: ' '.repeat(4096) + 'FIXTURE@EXAMPLE.COM' + ' '.repeat(4096) });
  f.stored.set('access/users/fixture@example.com', { enabled: true, groups: [] });
  const response = await f.call(input()); assert.equal(response.status, 200); assert.equal(response.body.admission.owner.email, 'fixture@example.com');
  assert.equal(f.trace.kv.filter(([key]) => key === 'access/users/fixture@example.com').length, 1);
}));

for (const model of ['A'.repeat(1048576), '\u0130'.repeat(131072)]) test('private model-scoped quota funds requirement plus lowercase before shared helper: ' + (model.length === 1048576 ? 'max ASCII' : 'Unicode'), t => {
  const provider = providerSnapshot.providers.find(value => value.id === 'anthropic'), endpoint = provider.endpoints.find(value => value.id === 'messages');
  const key = 'oauth/fixture/a', grant = { provider: 'anthropic', kind: 'api_key', enabled: true, credentialStore: 'durable_object', credentialStatus: 'active', hasCredential: true, credentialGeneration: 1, credentialLineage: 'synthetic' };
  const now = new Date().toISOString(), candidates = [{ key, grant }];
  const input = { provider, endpoint, request: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model },
    policy: { policyId: 'fixture', policy: normalizePolicyRecord({}, false) }, poolKey: 'fixture', candidates,
    states: { [key]: { grantRevision: null, observedAt: now, windows: [{ models: [model.length === 1048576 ? 'a' : 'i'], remaining: 7, limit: 10, resetAt: null }] } }, identityHash: '', fallbackSessionHash: '' };
  const zero = privateChoiceScratch(input.policy.policy.grantRouting), vector = privateChoiceScratch(input.policy.policy.grantRouting, model);
  assert.equal(vector.U - zero.U, model.length + Buffer.byteLength(model));
  const ticket = PreflightTicket.reserve(); let lowered = 0, choices = 0;
  const lower = String.prototype.toLowerCase;
  t.mock.method(String.prototype, 'toLowerCase', function (...args) { if (String(this) === model) lowered++; return Reflect.apply(lower, this, args); });
  const choose = value => { choices++; assert.equal(value.candidates[0].remainingRatio, 0.7); return { selectedKey: key }; };
  let pressure = true;
  const scratch = (next, run) => {
    const lease = reserveAdmissionScratch(ticket, pressure ? preflightPayloadBytes - admissionScratchBytes(vector) + 1 : 0, next);
    try { return run(); } finally { lease.retire(); }
  };
  try {
    assert.throws(() => selectPrivateAdmissionCandidate({}, input, choose, () => 1, candidates, () => candidates[0], () => true, scratch), denied);
    assert.equal(lowered, 0); assert.equal(choices, 0); pressure = false;
    const result = selectPrivateAdmissionCandidate({}, input, choose, () => 1, candidates, () => candidates[0], () => true, scratch);
    assert.equal(result.selected.key, key); assert.ok(lowered > 0); assert.equal(choices, 1);
  } finally { retireAdmissionScratch(ticket); ticket.release(); }
});


test('final projection receipt distinguishes present-null, legacy, text and absent staging without revision credit', async t => fixture(t, async f => {
  const ticket = PreflightTicket.reserve(), bound = { bytes: 0, identity: identitySourceBudget(), bridge: { ticket, entries: [], attempted: false } };
  f.resources.push(() => { retireAdmissionScratch(ticket); ticket.release(); });
  const key = 'oauth/fixture/a', text = JSON.stringify({ provider: 'anthropic', priority: 5 });
  const entry = { kind: 'dependency', key, revision: 7, text, legacy: 0 };
  f.sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)', key, text);
  assert.equal(f.owner.privateProjectionCurrent(bound, entry), true); assert.ok(bound.identity.values > 0);
  f.sql.exec('UPDATE upstream_grant_projections SET projection_json=? WHERE grant_key=?', JSON.stringify({ provider: 'anthropic', priority: 0 }), key);
  assert.equal(f.owner.privateProjectionCurrent(bound, entry), false);
  f.sql.exec('UPDATE upstream_grant_projections SET projection_json=NULL WHERE grant_key=?', key);
  assert.equal(f.owner.privateProjectionCurrent(bound, entry), false);
  const absent = { ...entry, text: null };
  assert.equal(f.owner.privateProjectionCurrent(bound, absent), true);
  f.sql.exec('UPDATE upstream_grant_projections SET legacy=1 WHERE grant_key=?', key);
  assert.equal(f.owner.privateProjectionCurrent(bound, absent), false);
  f.sql.exec('DELETE FROM upstream_grant_projections WHERE grant_key=?', key);
  assert.equal(f.owner.privateProjectionCurrent(bound, absent), false);
  assert.equal(f.owner.privateProjectionCurrent(bound, { ...absent, kind: 'projection', eligible: true }), true);
}));


for (const location of ['top', 'object', 'array']) for (const inherited of [false, true]) for (const hook of ['getter', 'setter', 'data'])
test('private callable serializer rejects before invocation/RPC and retains continuation: ' + [location, inherited, hook].join('/'), async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, continuation, handle, invoked = 0, rpc = 0;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const fn = () => { invoked++; throw undefined; }, holder = inherited ? Object.create(Function.prototype) : fn;
  Object.defineProperty(holder, 'toJSON', hook === 'getter' ? { get() { invoked++; throw undefined; } } : hook === 'setter' ? { set(_value) { invoked++; throw undefined; } } : { value() { invoked++; return 'X'.repeat(20000000); } });
  if (inherited) Object.setPrototypeOf(fn, holder);
  const admission = { providers: [], extra: location === 'top' ? fn : location === 'object' ? { fn } : [fn] };
  const get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) { rpc++; return Reflect.apply(get, this, args); });
  assert.throws(() => completeCredentialAdmission(continuation, admission), error => denied(error) && error.message === 'Identity admission failed (protocol)');
  assert.equal(invoked, 0); assert.equal(rpc, 0); assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  const operation = completeCredentialAdmission(continuation, { providers: [] }); continuation = undefined;
  handle = await f.take(f.own(operation)); handle.dispose(); handle = undefined;
  assert.equal(bodyBudgetCharged(), baseline); assert.equal(invoked, 0);
}));

test('plain nested functions retain omission/array-null wire, including inert serializer properties', async t => fixture(t, async f => {
  seed(f); let proof, continuation, handle, invoked = 0, wire;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) {
    const stub = Reflect.apply(get, this, args), original = stub.fetch;
    return { fetch(url, init) { if (url.endsWith('/admission/resolve')) wire = JSON.parse(init.body).admission; return Reflect.apply(original, stub, [url, init]); } };
  });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const fn = () => { invoked++; throw undefined; };
  Object.defineProperty(fn, 'toJSON', { value: 'inert' });
  const admission = { providers: [], extra: { omitted: fn, array: [fn, undefined, Symbol('value')], kept: 7 } };
  Object.defineProperty(admission.extra, Symbol('unread'), { get() { invoked++; throw undefined; }, enumerable: true });
  const operation = completeCredentialAdmission(continuation, admission); continuation = undefined;
  handle = await f.take(f.own(operation)); handle.dispose(); handle = undefined;
  assert.deepEqual(wire.extra, { array: [null, null, null], kept: 7 }); assert.equal(invoked, 0);
}));


test('private nonempty permitted provider without selection finishes sequential final windows', async t => fixture(t, async f => {
  seed(f); f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  const entered = [], enter = PreflightTicket.prototype.enter;
  t.mock.method(PreflightTicket.prototype, 'enter', function (window) {
    assert.equal(this.windows[window], false, 'no overlapping ' + window + ' owner');
    entered.push(window); return Reflect.apply(enter, this, [window]);
  });
  const response = await f.call({ ...input(), providers: [{ id: 'anthropic', tokenRef: 'anthropic' }] });
  assert.equal(response.status, 200); assert.equal(response.body.admission.selection, undefined);
  assert.equal(response.body.admission.connections[0].providerId, 'anthropic');
  assert.ok(response.body.admission.pools.anthropic.keys.includes('oauth/bridge-policy/anthropic'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_selection').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM upstream_grant_pool_cursors').get().n, 0);
  assert.ok(entered.filter(window => window === 'source').length > 1); assert.ok(entered.includes('read'));
}));

for (const location of ['top', 'object', 'array']) for (const inert of ['large', 'number', 'null', 'undefined', 'object', 'empty-accessor']) for (const ancestor of ['accessors', 'callable'])
test('inert callable serializer shadow has no JS value descriptor: ' + location + '/' + inert + '/' + ancestor, async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, continuation, handle, invoked = 0, descriptors = 0, rpc = 0, wire;
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const inherited = Object.create(Function.prototype), fn = () => { invoked++; throw undefined; };
  Object.defineProperty(inherited, 'toJSON', ancestor === 'callable' ? { value() { invoked++; throw undefined; } } : { get() { invoked++; throw undefined; }, set(_value) { invoked++; throw undefined; } });
  Object.setPrototypeOf(fn, inherited);
  const value = inert === 'large' ? 'x'.repeat(16777217) : inert === 'number' ? 7 : inert === 'null' ? null : inert === 'object' ? { get ignored() { invoked++; throw undefined; } } : undefined;
  Object.defineProperty(fn, 'toJSON', inert === 'empty-accessor' ? { get: undefined, set: undefined } : { value });
  assert.equal(typeof Object.prototype.__lookupGetter__, 'function'); assert.equal(typeof Object.prototype.__lookupSetter__, 'function');
  assert.equal(Reflect.apply(Object.prototype.__lookupGetter__, fn, ['toJSON']), undefined);
  assert.equal(Reflect.apply(Object.prototype.__lookupSetter__, fn, ['toJSON']), undefined);
  const descriptor = Object.getOwnPropertyDescriptor, get = f.env.ACCESS_CONTROL.get;
  t.mock.method(Object, 'getOwnPropertyDescriptor', function (target, key) {
    if ((target === fn || target === inherited) && key === 'toJSON') descriptors++;
    return Reflect.apply(descriptor, this, [target, key]);
  });
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) {
    const stub = Reflect.apply(get, this, args), original = stub.fetch;
    return { fetch(url, init) { if (url.endsWith('/admission/resolve')) { rpc++; wire = JSON.parse(init.body).admission; } return Reflect.apply(original, stub, [url, init]); } };
  });
  const admission = { providers: [], extra: location === 'top' ? fn : location === 'object' ? { fn } : [fn] };
  const operation = completeCredentialAdmission(continuation, admission); continuation = undefined;
  handle = await f.take(f.own(operation));
  assert.equal(rpc, 1); assert.equal(descriptors, 0); assert.equal(invoked, 0);
  if (location === 'top') assert.equal(Object.hasOwn(wire, 'extra'), false);
  else assert.deepEqual(wire.extra, location === 'array' ? [null] : {});
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  handle.dispose(); handle = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));
