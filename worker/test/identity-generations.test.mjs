import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { PolicyBindingIndexObject } = await import('../authority.ts');
const { preflightCredential, releaseCredentialPreflight, prepareCredentialGeneration, completeCredentialGeneration, borrowCredentialGeneration, evictCredentialGeneration, consumeCredentialPreflight, completeCredentialAdmission } = await import('../credential-preflight.ts');
const { GenerationMetadataCharge, preflightPayloadBytes, preflightControlSlots } = await import('../credential-preflight-arena.ts');
const { bodyBudgetCharged, ExactBodyCharge, bodyBudgetBytes } = await import('../body-budget.ts');
const { PrivateCacheReservation, privateCacheLimits, privateCacheCharged } = await import('../hot-cache.ts');
const { generationFactoryCharges, measureGenerationGraph, freezeGenerationGraph } = await import('../identity-generations.ts');
const { identitySourceBudget, isIdentityFailure } = await import('../identity-admission.ts');
const digest = 'ab'.repeat(32), rotated = 'cd'.repeat(32);
const credential = (secretSha256 = digest) => ({ enabled: true, secretSha256, policyId: 'bridge-policy', policyGeneration: 'legacy', principalId: null });
const denied = error => isIdentityFailure(error) && error.status === 503;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.then(() => undefined, () => undefined); return { promise, resolve, reject }; };
const on = { maxAgeMs: 60000, freshMs: 10000 }, off = { maxAgeMs: 0, freshMs: 0 };
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
  t.after(async () => { if (!finished) { const errors = await cleanup(); if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'generation fixture cleanup'); } });
  const { db, sql, transactionSync } = sqliteFixture(t), stored = new Map(), trace = { writes: [], reads: [], kv: [], rpc: [] };
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
  const fetch = (url, init) => { trace.rpc.push(new URL(url).pathname); return take(own(owner.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' })))); };
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { fetch }; } };
  const call = async (admission, source = identitySourceBudget(), raw) => {
    const response = await fetch('https://authority/admission/resolve', { method: 'POST', headers: { 'x-clawrouter-private-admission': 'v1' }, body: raw ?? JSON.stringify({ admission, source }) });
    const text = await take(own(response.text())); return { status: response.status, body: JSON.parse(text) };
  };
  try { await run({ db, sql, env, owner, stored, trace, call, own, take, releases, resources, beforeKv(fn) { beforeKv = fn; } }); }
  catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'generation fixture outcomes');
  if (hasPrimary) throw primary;
}
function seed(f) {
  f.stored.set('credentials/bridgekid', credential());
  f.stored.set('policies/bridge-policy', { enabled: true, generation: 'legacy', providers: [], requestCostMicros: 7 });
}
const input = () => ({ credentialId: 'bridgekid', secretSha256: digest, providers: [] });


async function prepare(f) {
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest)));
  assert.equal(result.outcome, 'matched');
  let proof = result.proof;
  try { const preparation = prepareCredentialGeneration(proof); proof = undefined; return preparation; }
  finally { if (proof) releaseCredentialPreflight(proof); }
}
function cleanupGenerations(f, resources) {
  f.resources.push(() => { evictCredentialGeneration(f.env, 'bridgekid'); const errors = []; for (const release of resources.reverse()) try { release(); } catch (error) { errors.push(error); } if (errors.length) throw new AggregateError(errors); });
}

test('private promotion freezes the SAME full graph and borrows without RPC; eviction retains each live borrower', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let prep, first, second, complete = false;
  cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { if (first) first.dispose(); }, () => { if (second) second.dispose(); }]);
  let frozenGraph, freezeCharge;
  const originalFreeze = Object.freeze;
  t.mock.method(Object, 'freeze', function (value) {
    if (value && Object.hasOwn(value, 'credential') && Object.hasOwn(value, 'connections') && Object.hasOwn(value, 'pools')) { frozenGraph = value; freezeCharge = bodyBudgetCharged(); }
    return Reflect.apply(originalFreeze, Object, [value]);
  });
  prep = await prepare(f); const operation = completeCredentialGeneration(prep, { providers: [] }, on); prep = undefined;
  first = await f.take(f.own(operation)); complete = true;
  assert.ok(frozenGraph); assert.ok(Object.isFrozen(frozenGraph)); assert.ok(Object.isFrozen(frozenGraph.credential.credential));
  assert.ok(freezeCharge - baseline >= preflightPayloadBytes);
  assert.ok(bodyBudgetCharged() > baseline); assert.ok(bodyBudgetCharged() - baseline < 1048576);
  assert.deepEqual(Object.keys(first), ['dispose']); assert.equal(JSON.stringify(first), '{}');
  const kv = f.trace.kv.length, reads = f.trace.reads.length;
  second = borrowCredentialGeneration(f.env, 'bridgekid', digest, on); assert.ok(second);
  assert.equal(f.trace.kv.length, kv); assert.equal(f.trace.reads.length, reads);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', rotated, on), undefined);
  assert.equal(borrowCredentialGeneration({ ACCESS_CONTROL: {} }, 'bridgekid', digest, on), undefined);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, off), undefined);
  const live = bodyBudgetCharged(); evictCredentialGeneration(f.env, 'bridgekid'); assert.equal(bodyBudgetCharged(), live);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
  first.dispose(); first = undefined; assert.ok(bodyBudgetCharged() > baseline);
  frozenGraph = undefined; const old = second; second.dispose(); second = undefined; assert.throws(() => old.dispose(), denied);
  assert.throws(() => old.dispose.call({}), denied); assert.equal(bodyBudgetCharged(), baseline);
  assert.deepEqual(privateCacheCharged(), { serializedBytes: 0, payloadBytes: 0, structure: 0 });
  assert.equal(complete, true);
}));

test('optional vector pressure preserves SAME admitted graph uncached under the original ticket, without another RPC', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let prep, borrow;
  const pressure = PrivateCacheReservation.reserve({ serializedBytes: 1, payloadBytes: privateCacheLimits.payloadBytes, structure: 1 }); assert.ok(pressure);
  f.resources.push(() => pressure.release()); cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { if (borrow) borrow.dispose(); }]);
  prep = await prepare(f); const operation = completeCredentialGeneration(prep, { providers: [] }, on); prep = undefined;
  borrow = await f.take(f.own(operation));
  assert.ok(bodyBudgetCharged() - baseline >= preflightPayloadBytes + privateCacheLimits.payloadBytes);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
  assert.equal(f.trace.rpc.filter(path => path === '/admission/resolve').length, 1);
  assert.equal(f.trace.rpc.filter(path => path === '/admission/credential-preflight').length, 1);
  pressure.release(); borrow.dispose(); borrow = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

test('A published/borrowed plus B constructing blocks C BEFORE hydration, including OFF; failed B preserves A', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let a, b, proof, initial;
  cleanupGenerations(f, [() => { if (initial) initial.dispose(); }, () => { if (b) b.dispose(); }, () => { if (a) a.dispose(); }, () => { if (proof) releaseCredentialPreflight(proof); }]);
  initial = await prepare(f); const loadA = completeCredentialGeneration(initial, { providers: [] }, on); initial = undefined; a = await f.take(f.own(loadA));
  b = await prepare(f);
  const third = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); assert.equal(third.outcome, 'matched'); proof = third.proof;
  const reads = f.trace.reads.length;
  assert.throws(() => prepareCredentialGeneration(proof), denied); assert.equal(f.trace.reads.length, reads);
  releaseCredentialPreflight(proof); proof = undefined;
  // Prevalidation failure is owned by B's cleanup and never unpublishes A.
  const bad = completeCredentialGeneration(b, { providers: [], credentialId: 'other' }, off); b = undefined;
  const root = f.own(bad), outcome = await root.outcome; root.used = true; assert.equal(outcome.failed, true); assert.ok(denied(outcome.error));
  const hit = borrowCredentialGeneration(f.env, 'bridgekid', digest, on); assert.ok(hit); hit.dispose();
  evictCredentialGeneration(f.env, 'bridgekid'); a.dispose(); a = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

test('forged and double preparation fail; disposed provisional owner releases its empty partition', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, preparation;
  cleanupGenerations(f, [() => { if (proof) releaseCredentialPreflight(proof); }, () => { if (preparation) preparation.dispose(); }]);
  assert.throws(() => prepareCredentialGeneration({}), denied);
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = result.proof;
  preparation = prepareCredentialGeneration(proof); const used = proof; proof = undefined;
  assert.throws(() => prepareCredentialGeneration(used), denied);
  assert.throws(() => completeCredentialGeneration({}, { providers: [] }, on), denied);
  const old = preparation; preparation.dispose(); preparation = undefined; assert.throws(() => old.dispose(), denied);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('wrong/unknown preverification resolves before generation capacity; valid proof expansion failure remains releasable', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, pressure;
  f.resources.push(() => { pressure?.release(); if (proof) releaseCredentialPreflight(proof); });
  const missing = await f.take(f.own(preflightCredential(f.env, 'missing', digest))); if (missing.outcome === 'matched') proof = missing.proof; assert.equal(missing.outcome, 'unknown');
  const wrong = await f.take(f.own(preflightCredential(f.env, 'bridgekid', rotated))); if (wrong.outcome === 'matched') proof = wrong.proof; assert.equal(wrong.outcome, 'invalid');
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = result.proof;
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged() - 65536); assert.ok(pressure);
  assert.throws(() => prepareCredentialGeneration(proof), denied);
  pressure.release(); pressure = undefined; releaseCredentialPreflight(proof); proof = undefined;
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('ready waits for ORIGINAL final read and unlock; abort at final read publishes no generation', async t => fixture(t, async f => {
  seed(f); let prep, borrow; const entered = deferred(), release = deferred(), caller = new AbortController();
  f.releases.push(() => { caller.abort(); release.resolve(); });
  cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { if (borrow) borrow.dispose(); }]);
  prep = await prepare(f); const originalGet = f.env.ACCESS_CONTROL.get;
  let unlocked = false, settled = false;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function (...args) {
    const stub = Reflect.apply(originalGet, this, args), originalFetch = stub.fetch;
    return { async fetch(url, init) {
      const response = await Reflect.apply(originalFetch, stub, [url, init]);
      if (url.endsWith('/admission/resolve')) {
        const originalReader = response.body.getReader.bind(response.body);
        response.body.getReader = options => {
          const reader = originalReader(options), read = reader.read.bind(reader), unlock = reader.releaseLock.bind(reader);
          reader.read = async (...values) => { const outcome = await read(...values); if (outcome.done) { entered.resolve(); await release.promise; } return outcome; };
          reader.releaseLock = () => { unlock(); unlocked = true; }; return reader;
        };
      }
      return response;
    } };
  });
  const operation = completeCredentialGeneration(prep, { providers: [] }, on, caller.signal); prep = undefined;
  const root = f.own(operation); void root.outcome.then(() => { settled = true; });
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), root.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { root.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; borrow = arrival.outcome.value; assert.fail('completed before original final read'); }
  assert.equal(settled, false); assert.equal(unlocked, false); assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
  caller.abort(); release.resolve(); const outcome = await root.outcome; root.used = true;
  if (!outcome.failed) borrow = outcome.value;
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error)); assert.equal(unlocked, true);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
}));

test('exact small charges and every shared vector boundary use the COMMON arena; no grow floor', () => {
  const baseline = bodyBudgetCharged(), zero = privateCacheCharged();
  const funding = GenerationMetadataCharge.reserve(17, 3); let adopted, value;
  try {
    assert.equal(bodyBudgetCharged() - baseline, 17);
    adopted = PrivateCacheReservation.adoptMetadata(funding); assert.ok(adopted);
    assert.equal(bodyBudgetCharged() - baseline, 17); assert.equal(PrivateCacheReservation.adoptMetadata(funding), null);
    assert.equal(PrivateCacheReservation.reserve({ serializedBytes: 2097153, payloadBytes: 1, structure: 1 }), null);
    assert.equal(PrivateCacheReservation.reserve({ serializedBytes: 1, payloadBytes: 8388608, structure: 1 }), null);
    assert.equal(PrivateCacheReservation.reserve({ serializedBytes: 1, payloadBytes: 1, structure: 524286 }), null);
    adopted.release(); adopted = undefined; funding.release();
    value = PrivateCacheReservation.reserve({ serializedBytes: 2097152, payloadBytes: 8388608, structure: 524288 }); assert.ok(value);
    assert.equal(bodyBudgetCharged() - baseline, 8388608);
    assert.equal(PrivateCacheReservation.reserve({ serializedBytes: 0, payloadBytes: 1, structure: 1 }), null);
  } finally { value?.release(); adopted?.release(); funding.release(); }
  assert.equal(bodyBudgetCharged(), baseline); assert.deepEqual(privateCacheCharged(), zero);
});

test('escaped-wire measure and deep-freeze preserve UNKNOWN fields and own __proto__ with no serialization copy', () => {
  const value = JSON.parse('{"__proto__":{"kept":true},"unknown":["\\u0001","\\ud800",7,null,false]}');
  const before = JSON.stringify(value), nested = value.__proto__, measured = measureGenerationGraph(value);
  assert.equal(measured.serializedBytes, Buffer.byteLength(before));
  assert.ok(measured.payloadBytes > 0); freezeGenerationGraph(value);
  assert.equal(value.__proto__, nested); assert.ok(Object.isFrozen(nested)); assert.ok(Object.isFrozen(value.unknown));
  assert.equal(JSON.stringify(value), before); assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

test('actual Worker generation CONTROL phases fit the existing four windows plus synchronous inventory', () => {
  const count = table => Object.values(table).reduce((sum, value) => sum + value, 0), persistent = count(generationFactoryCharges.persistent);
  assert.ok(persistent + count(generationFactoryCharges.rpc) <= preflightControlSlots.operation);
  for (const name of ['source', 'read', 'terminal']) assert.ok(count(generationFactoryCharges[name]) <= preflightControlSlots[name]);
  assert.ok(persistent + count(generationFactoryCharges.handoff) <= preflightControlSlots.synchronous);
});

test('atomic promotion succeeds at a FULL common arena using source credit, not extra destination allocation', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let prep, borrow, pressure;
  cleanupGenerations(f, [() => { pressure?.release(); }, () => { if (prep) prep.dispose(); }, () => { if (borrow) borrow.dispose(); }]);
  prep = await prepare(f);
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged()); assert.ok(pressure);
  assert.equal(bodyBudgetCharged(), bodyBudgetBytes);
  const operation = completeCredentialGeneration(prep, { providers: [] }, on); prep = undefined;
  borrow = await f.take(f.own(operation));
  assert.ok(bodyBudgetCharged() < bodyBudgetBytes - 16 * 1024 * 1024);
  pressure.release(); pressure = undefined;
  const hit = borrowCredentialGeneration(f.env, 'bridgekid', digest, on); assert.ok(hit); hit.dispose();
  evictCredentialGeneration(f.env, 'bridgekid'); borrow.dispose(); borrow = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

test('OFF generations occupy the same two slots across rotation; disposal releases only its own slot', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let prep, a, b, proof, bProof;
  cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { if (a) a.dispose(); }, () => { if (b) b.dispose(); }, () => { if (proof) releaseCredentialPreflight(proof); }, () => { if (bProof) releaseCredentialPreflight(bProof); }]);
  prep = await prepare(f); const loadA = completeCredentialGeneration(prep, { providers: [] }, off); prep = undefined; a = await f.take(f.own(loadA));
  f.db.prepare('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?').run(JSON.stringify(credential(rotated)), 'bridgekid');
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', rotated))); proof = result.proof;
  // Keep C's genuine scalar proof before B takes its full temporary ticket.
  const second = await f.take(f.own(preflightCredential(f.env, 'bridgekid', rotated))); bProof = second.proof;
  prep = prepareCredentialGeneration(bProof); bProof = undefined;
  const loadB = completeCredentialGeneration(prep, { providers: [] }, off); prep = undefined; b = await f.take(f.own(loadB));
  assert.throws(() => prepareCredentialGeneration(proof), denied);
  a.dispose(); a = undefined;
  prep = prepareCredentialGeneration(proof); proof = undefined; prep.dispose(); prep = undefined;
  assert.ok(bodyBudgetCharged() - baseline >= preflightPayloadBytes);
  b.dispose(); b = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

test('a DO-backed ticket cannot transfer funding into the Worker cache', async () => {
  const { PreflightTicket, PreflightInstanceArena } = await import('../credential-preflight-arena.ts');
  const baseline = bodyBudgetCharged(), arena = new PreflightInstanceArena(), ticket = PreflightTicket.reserve(arena);
  try {
    assert.throws(() => PrivateCacheReservation.transfer({ serializedBytes: 2, payloadBytes: 2, structure: 1 }, ticket), denied);
    assert.equal(bodyBudgetCharged(), baseline); assert.equal(arena.charged, preflightPayloadBytes);
  } finally { ticket.release(); }
  assert.equal(arena.charged, 0);
});

test('aggregate serialized eligibility reaches exactly 8 MiB independently of payload and structure', () => {
  const baseline = bodyBudgetCharged(), receipts = [];
  try {
    for (let i = 0; i < 4; i++) { const receipt = PrivateCacheReservation.reserve({ serializedBytes: 2097152, payloadBytes: 1, structure: 1 }); assert.ok(receipt); receipts.push(receipt); }
    assert.equal(privateCacheCharged().serializedBytes, 8388608);
    assert.equal(PrivateCacheReservation.reserve({ serializedBytes: 1, payloadBytes: 1, structure: 1 }), null);
  } finally { for (const receipt of receipts) receipt.release(); }
  assert.equal(bodyBudgetCharged(), baseline);
});

test('ordinary private continuation retains its existing full ticket without generation registration', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, continuation, handle;
  const { releaseCredentialPreflightContinuation } = await import('../credential-preflight.ts');
  f.resources.push(() => { if (handle) handle.dispose(); else if (continuation) releaseCredentialPreflightContinuation(continuation); else if (proof) releaseCredentialPreflight(proof); });
  const result = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = result.proof;
  continuation = consumeCredentialPreflight(proof, f.env, 'bridgekid', digest); proof = undefined;
  const operation = completeCredentialAdmission(continuation, { providers: [] }); continuation = undefined;
  handle = await f.take(f.own(operation));
  assert.equal(bodyBudgetCharged() - baseline, preflightPayloadBytes);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
  assert.deepEqual(privateCacheCharged(), { serializedBytes: 0, payloadBytes: 0, structure: 0 });
  handle.dispose(); handle = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

for (const reason of [undefined, new Error('shared generation fixture failure')]) test('generation failure preserves read/FIRSTcancel/unlock origins and holds its slot through ORIGINAL joins', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(), entered = deferred(), cancelGate = deferred(); let prep, unexpected;
  f.releases.push(() => cancelGate.resolve()); cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { unexpected?.dispose(); }]);
  prep = await prepare(f); let cancelCalls = 0, unlockCalls = 0, locked = true;
  const body = { get locked() { return locked; }, getReader(options) { assert.equal(options.mode, 'byob'); return {
    read() { entered.resolve(); return Promise.reject(reason); },
    cancel() { cancelCalls++; return cancelGate.promise.then(() => { throw reason; }); },
    releaseLock() { unlockCalls++; locked = false; throw reason; },
  }; } };
  t.mock.method(f.env.ACCESS_CONTROL, 'get', () => ({ fetch: async () => body }));
  const operation = completeCredentialGeneration(prep, { providers: [] }, on); prep = undefined;
  const root = f.own(operation), arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), root.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { root.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; unexpected = arrival.outcome.value; assert.fail('settled before original read'); }
  assert.ok(bodyBudgetCharged() - baseline >= preflightPayloadBytes);
  assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
  cancelGate.resolve(); const outcome = await root.outcome; root.used = true;
  if (!outcome.failed) unexpected = outcome.value;
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error));
  const { admissionBridgeFailureMetadata } = await import('../credential-preflight-source.ts');
  assert.deepEqual(admissionBridgeFailureMetadata(outcome.error), { primary: true, primaryIsUndefined: reason === undefined, origins: 14, originOrder: 0x234, category: 'cleanup' });
  assert.equal(cancelCalls, 1); assert.equal(unlockCalls, 1); assert.equal(Object.hasOwn(outcome.error, 'cause'), false);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('late ORIGINAL acquisition stays funded after caller abort and joins FIRSTcancel/unlock before freeing its generation', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(), acquisition = deferred(), cancelEntered = deferred(), cancelGate = deferred(), caller = new AbortController();
  let prep, unexpected, locked = true, cancels = 0, unlocks = 0;
  const body = { get locked() { return locked; }, getReader() { return {
    read() { assert.fail('aborted late body must not be read'); },
    cancel() { cancels++; cancelEntered.resolve(); return cancelGate.promise; },
    releaseLock() { unlocks++; locked = false; },
  }; } };
  f.releases.push(() => { caller.abort(); acquisition.resolve(body); cancelGate.resolve(); });
  cleanupGenerations(f, [() => { if (prep) prep.dispose(); }, () => { unexpected?.dispose(); }]);
  prep = await prepare(f);
  t.mock.method(f.env.ACCESS_CONTROL, 'get', () => ({ fetch: () => acquisition.promise }));
  const operation = completeCredentialGeneration(prep, { providers: [] }, on, caller.signal); prep = undefined;
  const root = f.own(operation); caller.abort();
  assert.ok(bodyBudgetCharged() - baseline >= preflightPayloadBytes);
  acquisition.resolve(body);
  const arrival = await Promise.race([cancelEntered.promise.then(() => ({ entered: true })), root.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { root.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; unexpected = arrival.outcome.value; assert.fail('settled before late original cancel'); }
  assert.equal(unlocks, 0); assert.ok(bodyBudgetCharged() - baseline >= preflightPayloadBytes);
  cancelGate.resolve(); const outcome = await root.outcome; root.used = true;
  if (!outcome.failed) unexpected = outcome.value;
  assert.equal(outcome.failed, true); assert.ok(denied(outcome.error)); assert.equal(cancels, 1); assert.equal(unlocks, 1);
  assert.equal(bodyBudgetCharged(), baseline); assert.equal(borrowCredentialGeneration(f.env, 'bridgekid', digest, on), undefined);
}));
