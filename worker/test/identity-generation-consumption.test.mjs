import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { PolicyBindingIndexObject } = await import('../authority.ts');
const { preflightCredential, releaseCredentialPreflight, prepareCredentialGeneration, completeCredentialGeneration, completeConsumableCredentialGeneration, authenticateCredentialGeneration, refreshCredentialGenerationAuthentication, selectCredentialGeneration, flushCredentialGenerationRuntime, queueCredentialGenerationRuntime, retainCredentialGenerationHint, prepareCredentialGenerationPrefetch, adoptCredentialGenerationDestination, borrowCredentialGeneration, evictCredentialGeneration, consumeCredentialPreflight, completeCredentialAdmission } = await import('../credential-preflight.ts');
const { GenerationMetadataCharge, preflightPayloadBytes, preflightControlSlots } = await import('../credential-preflight-arena.ts');
const { bodyBudgetCharged, ExactBodyCharge, bodyBudgetBytes } = await import('../body-budget.ts');
const { PrivateCacheReservation, privateCacheLimits, privateCacheCharged, setHotCacheClock } = await import('../hot-cache.ts');
const { generationFactoryCharges, generationConsumptionFactoryCharges, admitGenerationConsumptionFactories, measureGenerationGraph, freezeGenerationGraph } = await import('../identity-generations.ts');
const { tryRunInBackground, BACKGROUND_WORK_LIMIT, HotCache } = await import('../hot-cache.ts');
const { identitySourceBudget, isIdentityFailure, admitIdentity, identityPlan } = await import('../identity-admission.ts');
const { identityJsonProfiles } = await import('../access-json.ts');
const digest = 'ab'.repeat(32), rotated = 'cd'.repeat(32);
const credential = (secretSha256 = digest) => ({ enabled: true, secretSha256, policyId: 'bridge-policy', policyGeneration: 'legacy', principalId: null });
const denied = error => isIdentityFailure(error) && error.status === 503;
const capacity = error => denied(error) && error.message === 'Identity admission failed (limit)';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.then(() => undefined, () => undefined); return { promise, resolve, reject }; };
const on = { maxAgeMs: 60000, freshMs: 10000 }, off = { maxAgeMs: 0, freshMs: 0 };
async function fixture(t, run) {
  const roots = [], releases = [], resources = [], flushes = [], origins = new WeakMap(), pendingCaps = new Set();
  let cleanupPromise, finished = false, hasPrimary = false, primary;
  const own = promise => { const existing = origins.get(promise); if (existing) return existing; const root = { outcome: Promise.resolve(promise).then(value => ({ failed: false, value }), error => ({ failed: true, error })), used: false }; roots.push(root); origins.set(promise, root); return root; };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    for (const cap of pendingCaps) try { own(cap.drain()); pendingCaps.delete(cap); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.used) { root.used = true; failures.push(result.error); } }
    for (const cap of pendingCaps) try { cap.dispose(); } catch (error) { failures.push(error); }
    pendingCaps.clear();
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
  const fetch = async (url, init) => { trace.rpc.push(new URL(url).pathname); const response = await take(own(owner.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' }))));
    if (url.endsWith('/grant-pools/record') || url.endsWith('/grant-pools/feedback')) { const text = await take(own(response.text())); return accessBytesResponse(text, '', { status: response.status, headers: response.headers }); }
    return response; };
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { fetch }; } };
  const call = async (admission, source = identitySourceBudget(), raw) => {
    const response = await fetch('https://authority/admission/resolve', { method: 'POST', headers: { 'x-clawrouter-private-admission': 'v1' }, body: raw ?? JSON.stringify({ admission, source }) });
    const text = await take(own(response.text())); return { status: response.status, body: JSON.parse(text) };
  };
  try { await run({ db, sql, env, owner, stored, trace, call, own, take, releases, resources, flushes, pendingCaps, beforeKv(fn) { beforeKv = fn; } }); }
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

function selectOwned(f, auth, env, request) {
  const handle = selectCredentialGeneration(auth, env, request);
  if (handle?.flush.accepted) { const root = f.own(handle.flush.completed); f.flushes.push(root); }
  else if (handle?.flush.pending) f.pendingCaps.add(handle.flush.pending);
  return handle;
}
function queueOwned(f, auth, key, value) {
  const receipt = queueCredentialGenerationRuntime(auth, key, value);
  if (receipt.accepted) { const root = f.own(receipt.completed); f.flushes.push(root); }
  else if (receipt.pending) f.pendingCaps.add(receipt.pending);
  return receipt;
}
async function joinOwnFlushes(f, auth, env) {
  // Fixture coordinator only: these are the ACTUAL receipts created by this
  // fixture's own invocations, not shared generation promises or age polls.
  const manual = f.own(flushCredentialGenerationRuntime(auth, env));
  for (const root of f.flushes) await f.take(root);
  await f.take(manual);
}
const emptyCoverage = () => ({ providers: [], allConnections: false });
async function generation(f, request = { providers: [] }) {
  let prep = await prepare(f);
  try { const original = completeConsumableCredentialGeneration(prep, request, on); prep = undefined; return await f.take(f.own(original)); }
  finally { prep?.dispose(); }
}

test('owned authentication requires actual admitted coverage, not a preverification proof or an old unqualified borrow', async t => fixture(t, async f => {
  seed(f); const baseline = bodyBudgetCharged(); let proof, prep, old, borrow, auth;
  cleanupGenerations(f, [() => { if (proof) releaseCredentialPreflight(proof); }, () => prep?.dispose(), () => old?.dispose(), () => borrow?.dispose(), () => auth?.dispose()]);
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', digest))); proof = preflight.proof;
  assert.throws(() => authenticateCredentialGeneration(proof, f.env, emptyCoverage()), denied);
  prep = prepareCredentialGeneration(proof); proof = undefined;
  const original = completeCredentialGeneration(prep, { providers: [] }, on); prep = undefined;
  old = await f.take(f.own(original));
  assert.throws(() => authenticateCredentialGeneration(old, f.env, emptyCoverage()), denied);
  old.dispose(); old = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  borrow = await generation(f);
  assert.throws(() => authenticateCredentialGeneration(borrow, f.env, { providers: [], allConnections: true }), denied);
  assert.throws(() => authenticateCredentialGeneration(borrow, f.env, { providers: [{ id: 'anthropic', tokenRef: 'anthropic' }], allConnections: false }), denied);
  const rpc = f.trace.rpc.length;
  auth = authenticateCredentialGeneration(borrow, f.env, emptyCoverage());
  assert.equal(auth.status(), 200); assert.equal(auth.code(), undefined); assert.equal(f.trace.rpc.length, rpc);
  assert.deepEqual(Object.keys(auth), ['dispose', 'status', 'code']); assert.equal(JSON.stringify(auth), '{}');
  borrow.dispose(); borrow = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  assert.ok(bodyBudgetCharged() > baseline); assert.equal(auth.status(), 200);
  auth.dispose(); const disposed = auth; auth = undefined;
  assert.throws(() => disposed.dispose(), denied); assert.throws(() => disposed.status(), denied);
  assert.equal(bodyBudgetCharged(), baseline);
}));

for (const [name, patch, code] of [
  ['disabled', { enabled: false }, 'proxy_key_revoked'],
  ['expired', { expiresAt: '2000-01-01T00:00:00.000Z' }, 'proxy_key_expired'],
  ['stale generation', { policyGeneration: 'old' }, 'credential_policy_stale'],
]) test('owned authentication preserves ' + name + ' after correct secret preverification', async t => fixture(t, async f => {
  seed(f); f.stored.set('credentials/bridgekid', { ...credential(), ...patch });
  let borrow, auth;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose()]);
  borrow = await generation(f); auth = authenticateCredentialGeneration(borrow, f.env, emptyCoverage());
  assert.equal(auth.code(), code); assert.equal(auth.status(), name === 'expired' ? 401 : 403);
}));

test('owned auth common pressure precedes derived factories and preserves the borrower', async t => fixture(t, async f => {
  seed(f); let borrow, auth, pressure;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => pressure?.release()]);
  borrow = await generation(f); const before = bodyBudgetCharged(), rpc = f.trace.rpc.length;
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - before - 4095); assert.ok(pressure);
  assert.throws(() => authenticateCredentialGeneration(borrow, f.env, emptyCoverage()), capacity);
  assert.equal(f.trace.rpc.length, rpc); assert.equal(bodyBudgetCharged(), bodyBudgetBytes - 4095);
  pressure.release(); pressure = undefined;
  auth = authenticateCredentialGeneration(borrow, f.env, emptyCoverage()); assert.equal(auth.status(), 200);
}));

const { selectAdmissionCandidate, selectGenerationAdmissionCandidate } = await import('../authority-grant-selection.ts');
const { chooseGrantKey, normalizedChoiceCandidates } = await import('../grant-selection-strategies.ts');
const { normalizePolicyRecord } = await import('../authority-policy.ts');
const { snapshot: providerSnapshot } = await import('../providers.ts');
const { GenerationAdvisoryState } = await import('../admission-cache.ts');
const { admissionScratchBytes, GenerationConsumptionLease } = await import('../credential-preflight-arena.ts');
for (const strategy of ['priority', 'round_robin', 'least_used', 'most_remaining', 'threshold', 'weighted_random']) {
  test('owned local accepted-range parity: ' + strategy + ' with 129 complete candidates', t => {
    const provider = providerSnapshot.providers.find(item => item.id === 'anthropic'), endpoint = provider.endpoints.find(item => item.id === 'messages');
    const candidates = Array.from({ length: 129 }, (_, index) => ({ key: 'oauth/fixture/key' + index.toString().padStart(3, '0'), grant: {
      provider: 'anthropic', kind: 'api_key', enabled: true, credentialStore: 'durable_object', credentialStatus: 'ready', credentialGeneration: 1,
      credentialLineage: 'fixture_generation', hasCredential: true, extraUnknown: { retained: index }, priority: 4,
    } }));
    const input = { provider, endpoint, request: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', capability: 'llm.messages' },
      policy: { policyId: 'fixture', policy: normalizePolicyRecord({ grantRouting: { strategy } }, false) }, poolKey: 'fixture', candidates, states: {},
      identityHash: 'ab'.repeat(32), fallbackSessionHash: 'cd'.repeat(32) };
    t.mock.method(crypto, 'getRandomValues', array => { array.fill(1234567); return array; });
    const choose = value => chooseGrantKey(value, normalizedChoiceCandidates(value.candidates), { cursorKey: 'oauth/fixture/key100', counts: new Map() });
    const baseline = bodyBudgetCharged(), working = GenerationConsumptionLease.reserve(1048576);
    try {
      const ordinary = selectAdmissionCandidate({}, input, choose, () => 7);
      const owned = selectGenerationAdmissionCandidate({}, input, choose, () => 7, (vector, run) => {
        working.replace(1048576 + admissionScratchBytes(vector)); try { return run(); } finally { working.replace(1048576); }
      });
      assert.deepEqual(owned, ordinary); assert.ok(owned.selected); assert.ok(owned.selected.grant.extraUnknown);
      assert.equal(candidates.length, 129); assert.equal(candidates[0].grant.extraUnknown.retained, 0);
    } finally { working.release(); }
    assert.equal(bodyBudgetCharged(), baseline);
  });
}

function seedPool(f, size = 2) {
  seed(f);
  f.stored.set('policies/bridge-policy', { enabled: true, generation: 'legacy', providers: [], grantRouting: { strategy: 'round_robin' } });
  f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  for (let i = 0; i < size; i++) {
    const token = i === 0 ? 'a' : i === 1 ? 'b' : 'g' + String(i).padStart(2, '0');
    const key = 'oauth/bridge-policy/' + token, grant = { provider: 'anthropic', kind: 'api_key', enabled: true, priority: 4,
      credentialStore: 'durable_object', credentialStatus: 'active', credentialGeneration: 1, credentialLineage: 'fixture_generation', hasCredential: true,
      unknownGenerationField: { token } };
    f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', key, 1, 7);
    f.sql.exec('INSERT INTO upstream_grant_pool_members(scope,scope_id,provider_id,token_ref,status) VALUES(?,?,?,?,?)', 'policies', 'bridge-policy', 'anthropic', token, 'active');
    f.sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)', key, JSON.stringify(grant));
  }
}
const selectionRequest = () => ({ providerId: 'anthropic', endpointId: 'messages', mode: 'http', capability: 'llm.messages' });
const poolInput = () => ({ providers: [{ id: 'anthropic', tokenRef: 'anthropic' }], snapshot: 'only', selection: selectionRequest() });

test('closed selection retains its own parent after auth disposal and starts with authoritative successor counts', async t => fixture(t, async f => {
  seedPool(f); const baseline = bodyBudgetCharged(); let borrow, auth, a, b, successor, nextAuth, next;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => a?.dispose(), () => b?.dispose(), () => successor?.dispose(), () => nextAuth?.dispose(), () => next?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const rpc = f.trace.rpc.length, writes = f.trace.writes.length;
  a = selectOwned(f, auth, f.env, selectionRequest()); b = selectOwned(f, auth, f.env, selectionRequest());
  assert.ok(a?.matchesKey('oauth/bridge-policy/a')); assert.ok(b?.matchesKey('oauth/bridge-policy/b'));
  assert.equal(f.trace.rpc.length, rpc); assert.equal(f.trace.writes.length, writes);
  await joinOwnFlushes(f, auth, f.env);
  auth.dispose(); auth = undefined; borrow.dispose(); borrow = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  assert.ok(a.selected()); assert.ok(bodyBudgetCharged() > baseline);
  f.releases.push(() => { if (nextAuth) f.own(flushCredentialGenerationRuntime(nextAuth, f.env)); });
  successor = await generation(f, poolInput()); nextAuth = authenticateCredentialGeneration(successor, f.env, { ...poolInput(), allConnections: false });
  next = selectOwned(f, nextAuth, f.env, selectionRequest()); assert.ok(next?.matchesKey('oauth/bridge-policy/a'));
  await joinOwnFlushes(f, nextAuth, f.env);
}));

test('selection capacity precedes count and cursor effects', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, selected, pressure;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => pressure?.release()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const rpc = f.trace.rpc.length, writes = f.trace.writes.length;
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged() - 4095); assert.ok(pressure);
  assert.throws(() => selectOwned(f, auth, f.env, selectionRequest()), capacity);
  assert.equal(f.trace.rpc.length, rpc); assert.equal(f.trace.writes.length, writes);
  pressure.release(); pressure = undefined;
  selected = selectOwned(f, auth, f.env, selectionRequest()); assert.ok(selected?.matchesKey('oauth/bridge-policy/a'));
  await joinOwnFlushes(f, auth, f.env);
}));

test('a held hint owns the detached selection after both public consumers and publication retire', async t => fixture(t, async f => {
  seedPool(f); const baseline = bodyBudgetCharged(); let borrow, auth, selected, hint;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => hint?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  selected = selectOwned(f, auth, f.env, selectionRequest()); hint = retainCredentialGenerationHint(selected);
  await joinOwnFlushes(f, auth, f.env);
  selected.dispose(); selected = undefined; auth.dispose(); auth = undefined; borrow.dispose(); borrow = undefined;
  evictCredentialGeneration(f.env, 'bridgekid'); assert.ok(bodyBudgetCharged() > baseline);
  hint.dispose(); hint = undefined; assert.equal(bodyBudgetCharged(), baseline);
}));

const runtimeState = (observedAt, remaining) => ({ status: 'available', observedAt, source: 'provider_response', cooldownUntil: null,
  lastSignal: 'quota', grantRevision: null, windows: [{ id: 'tokens', kind: 'tokens', remaining, limit: 10, resetAt: null }] });
test('feedback replacement during an original ACK joins both origins and deletes only the exact pending value', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, first, second;
  const entered = deferred(), release = deferred();
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose()]);
  f.releases.push(() => release.resolve(), () => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const original = f.owner.fetch; let calls = 0;
  t.mock.method(f.owner, 'fetch', async function (request) {
    const response = await Reflect.apply(original, this, [request]);
    if (new URL(request.url).pathname === '/grant-pools/feedback' && ++calls === 1) { entered.resolve(); await release.promise; }
    return response;
  });
  const key = 'oauth/bridge-policy/a';
  const firstReceipt = queueOwned(f, auth, key, runtimeState('2026-01-01T00:00:00.000Z', 8)); assert.equal(firstReceipt.accepted, true);
  first = f.own(firstReceipt.completed);
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), first.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { first.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('original flush settled before ACK hold'); }
  const nextReceipt = queueOwned(f, auth, key, runtimeState('2026-01-02T00:00:00.000Z', 3)); assert.equal(nextReceipt.accepted, true);
  evictCredentialGeneration(f.env, 'bridgekid'); release.resolve(); await f.take(first);
  second = f.own(nextReceipt.completed); await f.take(second);
  assert.equal(calls, 2);
  const stored = JSON.parse(f.db.prepare('SELECT state_json FROM upstream_grant_runtime WHERE grant_key=?').get(key).state_json);
  assert.equal(stored.observedAt, '2026-01-02T00:00:00.000Z'); assert.equal(stored.windows[0].remaining, 3);
  await joinOwnFlushes(f, auth, f.env); assert.equal(calls, 2);
}));

test('rejected background registration starts no flush; accepted pending work keeps ownership for explicit draining', async t => fixture(t, async f => {
  seedPool(f); const release = deferred(), blockers = []; let borrow, auth, selected;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose()]);
  f.releases.push(() => release.resolve(), () => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  for (let i = 0; i < BACKGROUND_WORK_LIMIT; i++) {
    const root = f.own(release.promise.then(() => undefined)); blockers.push(root);
    assert.equal(tryRunInBackground(() => root.outcome), true);
  }
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const before = f.trace.rpc.length;
  selected = selectOwned(f, auth, f.env, selectionRequest()); assert.ok(selected.selected());
  assert.equal(f.trace.rpc.length, before); evictCredentialGeneration(f.env, 'bridgekid');
  await joinOwnFlushes(f, auth, f.env);
  assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/record').length, 1);
  release.resolve(); for (const root of blockers) await f.take(root);
}));

test('opaque refresh rejects rotated secret without changing the current authenticated owner', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, proof, prep, rotatedBorrow;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => rotatedBorrow?.dispose(), () => prep?.dispose(), () => { if (proof) releaseCredentialPreflight(proof); }]);
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  f.sql.exec('UPDATE proxy_credentials SET credential_json=? WHERE credential_id=?', JSON.stringify(credential(rotated)), 'bridgekid');
  const preflight = await f.take(f.own(preflightCredential(f.env, 'bridgekid', rotated))); assert.equal(preflight.outcome, 'matched'); proof = preflight.proof;
  prep = prepareCredentialGeneration(proof); proof = undefined;
  const operation = completeConsumableCredentialGeneration(prep, poolInput(), on); prep = undefined;
  rotatedBorrow = await f.take(f.own(operation));
  assert.throws(() => refreshCredentialGenerationAuthentication(auth, rotatedBorrow, f.env, { ...poolInput(), allConnections: false }), error => error?.status === 401 && error?.code === 'invalid_proxy_key');
  assert.equal(auth.status(), 200); assert.equal(auth.code(), undefined);
}));

test('runtime copies meter JSON-omitted undefined fields before any clone or accepted feedback effect', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth; cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const incoming = runtimeState('2026-01-01T00:00:00.000Z', 8);
  for (let i = 0; i < 16384; i++) incoming[String(i).padStart(5, '0') + 'x'.repeat(1019)] = undefined;
  let copies = 0; const clone = structuredClone;
  t.mock.method(globalThis, 'structuredClone', (...args) => { copies++; return Reflect.apply(clone, globalThis, args); });
  const rpc = f.trace.rpc.length;
  assert.throws(() => queueOwned(f, auth, 'oauth/bridge-policy/a', incoming), capacity);
  assert.equal(copies, 0); assert.equal(f.trace.rpc.length, rpc);
}));

const { prefetchOwnedGrantCredentials, borrowOwnedGrantCredentials, evictOwnedGrantCredentials, cachedGrantCredentials, evictGrantCredentials } = await import('../credential-cache.ts');
async function prefetchFixture(t, run) {
  return fixture(t, async f => {
    seedPool(f); let borrow, auth, selected, hint;
    const releases = [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => hint?.dispose()];
    cleanupGenerations(f, releases);
    f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
    borrow = await generation(f, poolInput());
    auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
    selected = selectOwned(f, auth, f.env, selectionRequest()); assert.ok(selected?.selected());
    hint = retainCredentialGenerationHint(selected);
    await joinOwnFlushes(f, auth, f.env);
    let calls = 0;
    f.env.GRANT_CREDENTIALS = { idFromName(key) { assert.equal(key, 'oauth/bridge-policy/a'); return key; }, get() { return { fetch(url, init) {
      calls++; const request = JSON.parse(init.body);
      assert.equal(new URL(url).pathname, '/materialize'); assert.equal(request.key, 'oauth/bridge-policy/a');
      assert.equal(request.force, false); assert.equal(request.providerId, 'anthropic');
      const grant = { ...request.grant, credential: 'fixture-only-token', credentialStore: undefined };
      Object.defineProperty(grant, '__proto__', { value: { unknownOwnedField: 'retained' }, enumerable: true });
      return Promise.resolve(accessBytesResponse(JSON.stringify({ grant }), ''));
    } }; } };
    evictGrantCredentials('oauth/bridge-policy/a');
    f.resources.push(() => { if (hint) evictOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint, f.env)); evictGrantCredentials('oauth/bridge-policy/a'); });
    const detach = () => { evictOwnedGrantCredentials(prepareCredentialGenerationPrefetch(hint, f.env)); hint.dispose(); hint = undefined; selected.dispose(); selected = undefined; auth.dispose(); auth = undefined; borrow.dispose(); borrow = undefined; evictCredentialGeneration(f.env, 'bridgekid'); };
    await run({ ...f, cap() { return prepareCredentialGenerationPrefetch(hint, f.env); }, calls() { return calls; }, adopt(value, env = f.env) { adoptCredentialGenerationDestination(selected, env, value); }, detach });
  });
}

test('owned prefetch OFF, HIT and saturated registration start nothing and consume only the provisional child', async t => prefetchFixture(t, async f => {
  const baseline = bodyBudgetCharged();
  f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '0';
  const disabled = f.cap(); assert.deepEqual(prefetchOwnedGrantCredentials(disabled), { accepted: false });
  assert.equal(f.calls(), 0); assert.equal(bodyBudgetCharged(), baseline); assert.throws(() => disabled.dispose(), denied);
  f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '60';
  const release = deferred(), blockers = [];
  f.releases.push(() => release.resolve());
  for (let i = 0; i < BACKGROUND_WORK_LIMIT; i++) {
    const work = release.promise.then(() => undefined); blockers.push(f.own(work));
    assert.equal(tryRunInBackground(() => work), true);
  }
  assert.deepEqual(prefetchOwnedGrantCredentials(f.cap()), { accepted: false });
  assert.equal(f.calls(), 0); assert.equal(bodyBudgetCharged(), baseline);
  release.resolve(); for (const root of blockers) await f.take(root);
  const accepted = prefetchOwnedGrantCredentials(f.cap()); assert.equal(accepted.accepted, true);
  assert.equal(await f.take(f.own(accepted.completed)), undefined); assert.equal(f.calls(), 1);
  assert.deepEqual(prefetchOwnedGrantCredentials(f.cap()), { accepted: false });
  assert.equal(f.calls(), 1); assert.ok(bodyBudgetCharged() > baseline); assert.ok(bodyBudgetCharged() < baseline + preflightPayloadBytes);
  evictOwnedGrantCredentials(f.cap()); assert.equal(bodyBudgetCharged(), baseline);
  assert.throws(() => prefetchOwnedGrantCredentials({}), denied);
}));

test('accepted synchronous load throw including undefined is observable after child cleanup', async t => prefetchFixture(t, async f => {
  const baseline = bodyBudgetCharged();
  t.mock.method(f.env.GRANT_CREDENTIALS, 'idFromName', function () { throw undefined; });
  const receipt = prefetchOwnedGrantCredentials(f.cap()); assert.equal(receipt.accepted, true);
  const root = f.own(receipt.completed); let failed = false, primary;
  try { await f.take(root); } catch (error) { failed = true; primary = error; }
  assert.equal(failed, true); assert.equal(primary, undefined); assert.equal(f.calls(), 0);
  assert.equal(bodyBudgetCharged(), baseline);
}));

test('prefetch original load and hint child survive hint/publication eviction and join before void receipt', async t => prefetchFixture(t, async f => {
  const entered = deferred(), release = deferred(); f.releases.push(() => release.resolve());
  const original = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = function (...args) {
    const stub = Reflect.apply(original, this, args), fetch = stub.fetch;
    return { fetch(url, init) { const work = fetch(url, init).then(async response => { entered.resolve(); await release.promise; return response; }); void work.then(() => undefined, () => undefined); return work; } };
  };
  const receipt = prefetchOwnedGrantCredentials(f.cap()); assert.equal(receipt.accepted, true);
  const root = f.own(receipt.completed);
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), root.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { root.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('prefetch settled before held original'); }
  f.detach(); evictGrantCredentials('oauth/bridge-policy/a');
  assert.ok(bodyBudgetCharged() >= preflightPayloadBytes);
  let settled = false; void receipt.completed.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release.resolve(); assert.equal(await f.take(root), undefined); assert.equal(f.calls(), 1);
  assert.equal(bodyBudgetCharged(), 0);
}));

test('joining prefetch holds its own child until scalar publication wait and its own load finish', async t => prefetchFixture(t, async f => {
  const entered = deferred(), release = deferred(); f.releases.push(() => release.resolve());
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = function (...args) { const stub = Reflect.apply(get, this, args), fetch = stub.fetch;
    return { fetch(url, init) { const work = fetch(url, init).then(async response => { entered.resolve(); await release.promise; return response; }); void work.then(() => undefined, () => undefined); return work; } }; };
  const first = prefetchOwnedGrantCredentials(f.cap()); assert.equal(first.accepted, true); const firstRoot = f.own(first.completed);
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), firstRoot.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { firstRoot.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('first prefetch completed before arrival'); }
  const second = prefetchOwnedGrantCredentials(f.cap()); assert.equal(second.accepted, true); const secondRoot = f.own(second.completed);
  release.resolve(); await f.take(firstRoot); await f.take(secondRoot);
  assert.equal(f.calls(), 1); assert.ok(bodyBudgetCharged() > 0); f.detach(); assert.equal(bodyBudgetCharged(), 0);
}));

test('independent load and child-cleanup failures retain shared reason occurrences', async t => prefetchFixture(t, async f => {
  const reason = new Error('fixture independent origins'), baseline = bodyBudgetCharged();
  const release = GenerationConsumptionLease.prototype.release;
  t.mock.method(f.env.GRANT_CREDENTIALS, 'idFromName', function () { throw reason; });
  const releaseMock = t.mock.method(GenerationConsumptionLease.prototype, 'release', function () {
    const own = this.bytes === preflightPayloadBytes; Reflect.apply(release, this, []); if (own) throw reason;
  });
  const receipt = prefetchOwnedGrantCredentials(f.cap()); assert.equal(receipt.accepted, true);
  let failure; try { await f.take(f.own(receipt.completed)); } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  const occurrences = error => error instanceof AggregateError ? error.errors.reduce((n, item) => n + occurrences(item), 0) : Number(error === reason);
  assert.equal(occurrences(failure), 2); assert.equal(bodyBudgetCharged(), baseline); releaseMock.mock.restore();
}));

const { mergeGrantRuntimeState } = await import('../grant-runtime.ts');
const { detachedGenerationRuntime, detachedGenerationFeedback, generationRuntimeWorkingBytes } = await import('../admission-cache.ts');
test('owned runtime and pending feedback preserve ordinary merge and detach account/snapshot aliases', () => {
  const previous = { ...runtimeState('2026-01-02T00:00:00.000Z', 8), account: { tier: 'old' }, extraUsage: { used: 3 }, windowSnapshots: { generic: { observedAt: '2026-01-02T00:00:00.000Z', ids: ['generic'] } } };
  const incoming = { ...runtimeState('2026-01-03T00:00:00.000Z', 3), account: { tier: 'new' }, extraUsage: { used: 9 }, windowSnapshots: { generic: { observedAt: '2026-01-03T00:00:00.000Z', ids: ['generic'] } } };
  const expected = mergeGrantRuntimeState(previous, incoming);
  const actual = detachedGenerationRuntime(previous, incoming), pending = detachedGenerationFeedback(previous, incoming);
  assert.deepEqual(actual, expected); assert.deepEqual(pending, expected);
  incoming.account.tier = 'changed'; incoming.extraUsage.used = 100; incoming.windowSnapshots.generic.ids.length = 0;
  assert.equal(actual.account.tier, 'new'); assert.equal(pending.extraUsage.used, 9); assert.deepEqual(actual.windowSnapshots.generic.ids, ['generic']);
});

test('refresh replaces only the public authentication owner while a previous hint retains its original generation', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, selected, hint, next;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => hint?.dispose(), () => next?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  selected = selectOwned(f, auth, f.env, selectionRequest()); hint = retainCredentialGenerationHint(selected);
  await joinOwnFlushes(f, auth, f.env);
  next = await generation(f, poolInput()); const same = auth;
  refreshCredentialGenerationAuthentication(auth, next, f.env, { ...poolInput(), allConnections: false });
  assert.equal(auth, same); assert.equal(auth.status(), 200);
  selected.dispose(); selected = undefined; borrow.dispose(); borrow = undefined;
  next.dispose(); next = undefined; auth.dispose(); auth = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  assert.ok(bodyBudgetCharged() > 0); hint.dispose(); hint = undefined; assert.equal(bodyBudgetCharged(), 0);
}));

test('fixed explicit cohort excludes an inflight A delta and never waits for A when B finishes first', async t => fixture(t, async f => {
  seedPool(f, 1); let borrow, auth, a, b;
  const entered = deferred(), release = deferred(); f.releases.push(() => release.resolve());
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => a?.dispose(), () => b?.dispose()]);
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const fetch = f.owner.fetch; let calls = 0;
  t.mock.method(f.owner, 'fetch', async function (request) {
    const response = await Reflect.apply(fetch, this, [request]);
    if (new URL(request.url).pathname === '/grant-pools/record' && ++calls === 1) { entered.resolve(); await release.promise; }
    return response;
  });
  a = selectOwned(f, auth, f.env, selectionRequest()); assert.equal(a.flush.accepted, true); const first = f.own(a.flush.completed);
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), first.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { first.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('first cohort ended before original ACK hold'); }
  b = selectOwned(f, auth, f.env, selectionRequest()); assert.equal(b.flush.accepted, true);
  await f.take(f.own(b.flush.completed));
  assert.equal(calls, 2); assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 2);
  let firstSettled = false; void a.flush.completed.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
  assert.equal(firstSettled, false); assert.equal(calls, 2);
  release.resolve(); await f.take(first); assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 2);
}));

test('fixed cohort cutoff retains every unclaimed observation and admits claims before any effects', async t => fixture(t, async f => {
  seedPool(f, 40); let borrow, auth, pressure;
  const release = deferred(), blockers = []; f.releases.push(() => { pressure?.release(); pressure = undefined; release.resolve(); });
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => pressure?.release()]);
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  f.releases.push(() => { if (auth) for (let i = 0; i < 11; i++) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  for (let i = 0; i < BACKGROUND_WORK_LIMIT; i++) { const work = release.promise.then(() => undefined); blockers.push(f.own(work)); assert.equal(tryRunInBackground(() => work), true); }
  for (let i = 0; i < 40; i++) { const selected = selectOwned(f, auth, f.env, selectionRequest()); assert.equal(selected.flush.accepted, false); selected.dispose(); }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upstream_grant_selection').get().n, 0);
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged() - 34815); assert.ok(pressure);
  assert.throws(() => flushCredentialGenerationRuntime(auth, f.env), capacity);
  pressure.release(); pressure = undefined;
  const first = f.own(flushCredentialGenerationRuntime(auth, f.env));
  // Claims are already fixed synchronously. This later delta is not part of A,
  // even though it replaces the same pending key while A's original is active.
  const later = selectOwned(f, auth, f.env, selectionRequest()); assert.equal(later.flush.accepted, false); later.dispose();
  await f.take(first); assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 4);
  for (let cohort = 2; cohort <= 10; cohort++) {
    await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
    assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 4 * cohort);
  }
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
  assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 41);
  const calls = f.trace.rpc.filter(path => path === '/grant-pools/record').length;
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env))); assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/record').length, calls);
  release.resolve(); for (const root of blockers) await f.take(root);
}));

function inertJsonChain(levels) {
  let value = { toJSON: null, leaf: 'fixture-deep-value' };
  for (let i = 1; i < levels; i++) value = { toJSON: null, next: value };
  return value;
}
test('cohort envelope alternate windows fund the full complete-profile visitor and descriptor fields', () => {
  const table = generationConsumptionFactoryCharges, depth = identityJsonProfiles.complete.depth;
  const sum = row => Object.values(row).reduce((total, value) => total + value, 0);
  admitGenerationConsumptionFactories();
  assert.equal(table.cohortPlanSource.recursiveItemFramesIncludingDeepestScalarOrFailure, depth);
  assert.equal(table.cohortPlanRead.inertToJsonDescriptorObjectsAndFourFields, 5 * (depth - 1));
  assert.equal(table.cohortPlanTerminal.activeChildDescriptorObjectsAndFourFields, 5 * (depth - 1));
  for (const row of [table.cohortPlanSource, table.cohortPlanRead, table.cohortPlanTerminal]) assert.ok(sum(row) <= 128);
  const plan = identityPlan(); plan.object(0, field => field('state', inertJsonChain(depth - 1)));
  assert.equal(plan.counts.containers, depth); // Root envelope + deepest accepted chain.
  assert.throws(() => identityPlan().object(0, field => field('state', inertJsonChain(depth))), capacity);
});

for (const levels of [14, identityJsonProfiles.record.depth - 1]) test('four live deep feedback records are fully planned before the first RPC: ' + levels, async t => fixture(t, async f => {
  seedPool(f, 4); let borrow, auth, inPlan = false, inertDescriptors = 0, calls = 0;
  const release = deferred(), blockers = [];
  f.releases.push(() => { inPlan = false; release.resolve(); });
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose()]);
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const state = { ...runtimeState('2026-01-03T00:00:00.000Z', 3), toJSON: null, extraUsage: inertJsonChain(levels) };
  admitIdentity(state, 'record');
  assert.throws(() => admitIdentity({ ...state, extraUsage: inertJsonChain(identityJsonProfiles.record.depth) }, 'record'), capacity);
  for (let i = 0; i < BACKGROUND_WORK_LIMIT; i++) { const work = release.promise.then(() => undefined); blockers.push(f.own(work)); assert.equal(tryRunInBackground(() => work), true); }
  const before = f.trace.rpc.length;
  for (const token of ['a', 'b', 'g02', 'g03']) { const receipt = queueOwned(f, auth, 'oauth/bridge-policy/' + token, state); assert.equal(receipt.accepted, false); assert.ok(receipt.pending); }
  assert.equal(f.trace.rpc.length, before); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upstream_grant_runtime').get().n, 0);
  const descriptor = Object.getOwnPropertyDescriptor;
  t.mock.method(Object, 'getOwnPropertyDescriptor', (value, key) => { const found = descriptor(value, key); if (inPlan && key === 'toJSON' && found?.value === null) inertDescriptors++; return found; });
  const get = f.env.ACCESS_CONTROL.get;
  t.mock.method(f.env.ACCESS_CONTROL, 'get', function(...args) { const stub = Reflect.apply(get, this, args); return { fetch(url, init) {
    if (new URL(url).pathname === '/grant-pools/feedback') {
      if (!calls) { assert.equal(inPlan, true); assert.ok(inertDescriptors >= 4 * (levels + 1)); inPlan = false; }
      calls++; const envelope = JSON.parse(init.body); admitIdentity(envelope, 'complete');
      let chain = envelope.state.extraUsage, seen = 0;
      while (chain) { assert.equal(chain.toJSON, null); seen++; if (chain.next) chain = chain.next; else { assert.equal(chain.leaf, 'fixture-deep-value'); break; } }
      assert.equal(seen, levels); assert.equal(envelope.state.toJSON, null);
    }
    return stub.fetch(url, init);
  } }; });
  inPlan = true; const flush = f.own(flushCredentialGenerationRuntime(auth, f.env));
  await f.take(flush); assert.equal(calls, 4);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upstream_grant_runtime').get().n, 4);
  release.resolve(); for (const root of blockers) await f.take(root);
}));

// A single admitted source string can expand into many NEW merge occurrences.
// Planning must refuse before the unchanged helper constructs those windows.
test('runtime preadmission funds observedAt once per prospective generated window', () => {
  const previous = runtimeState('2026-01-02T00:00:00.000Z', 8);
  const incoming = { ...runtimeState('2026-01-03T00:00:00.000Z', 3), observedAt: ' '.repeat(900000) + '2026-01-03T00:00:00.000Z',
    windows: Array.from({ length: 32 }, (_, i) => ({ id: 'window-' + i, kind: 'generic', remaining: 3, limit: 8 })) };
  admitIdentity(incoming, 'record');
  assert.throws(() => generationRuntimeWorkingBytes(previous, incoming), capacity);
  // No history truncation or new timestamp cap: modest repeated strings remain
  // admitted and the unchanged merge still decides their ordinary semantics.
  const normal = { ...incoming, observedAt: '2026-01-03T00:00:00.000Z' };
  assert.ok(generationRuntimeWorkingBytes(previous, normal) < preflightPayloadBytes);
  assert.deepEqual(detachedGenerationRuntime(previous, normal), mergeGrantRuntimeState(previous, normal));
});

test('generated runtime pressure precedes overlay, RPC and pending-feedback effects', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const key = 'oauth/bridge-policy/a';
  const first = queueOwned(f, auth, key, runtimeState('2026-01-01T00:00:00.000Z', 8));
  assert.equal(first.accepted, true); await f.take(f.own(first.completed));
  const state = f.db.prepare('SELECT state_json FROM upstream_grant_runtime WHERE grant_key=?').get(key).state_json;
  const before = bodyBudgetCharged(), calls = f.trace.rpc.length;
  const incoming = { ...runtimeState('2026-01-03T00:00:00.000Z', 3), observedAt: ' '.repeat(900000) + '2026-01-03T00:00:00.000Z',
    windows: Array.from({ length: 32 }, (_, i) => ({ id: 'window-' + i, kind: 'generic', remaining: 3, limit: 8 })) };
  admitIdentity(incoming, 'record');
  assert.throws(() => queueOwned(f, auth, key, incoming), capacity);
  assert.equal(bodyBudgetCharged(), before); assert.equal(f.trace.rpc.length, calls);
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
  assert.equal(f.trace.rpc.length, calls);
  assert.equal(f.db.prepare('SELECT state_json FROM upstream_grant_runtime WHERE grant_key=?').get(key).state_json, state);
}));


test('origin snapshot-select receipt preserves A and its single authority count; later borrower selects B', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, first, cached, laterAuth, second;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => first?.dispose(), () => cached?.dispose(), () => laterAuth?.dispose(), () => second?.dispose()]);
  const request = { ...poolInput(), snapshot: 'select' }, coverage = { ...request, allConnections: false };
  borrow = await generation(f, request);
  assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 1);
  auth = authenticateCredentialGeneration(borrow, f.env, coverage);
  const rpc = f.trace.rpc.length;
  first = selectOwned(f, auth, f.env, selectionRequest()); assert.ok(first.matchesKey('oauth/bridge-policy/a'));
  assert.equal(first.flush.accepted, false); assert.equal(first.flush.pending, undefined);
  assert.equal(f.trace.rpc.length, rpc);
  assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 1);
  cached = borrowCredentialGeneration(f.env, 'bridgekid', digest, on); assert.ok(cached);
  laterAuth = authenticateCredentialGeneration(cached, f.env, coverage);
  second = selectOwned(f, laterAuth, f.env, selectionRequest()); assert.ok(second.matchesKey('oauth/bridge-policy/b'));
  await joinOwnFlushes(f, laterAuth, f.env);
  assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 2);
}));

test('late selection funding failure rolls back the old overlay debit on every attempt', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, first, next, pressure;
  f.releases.push(() => { pressure?.release(); pressure = undefined; });
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => first?.dispose(), () => next?.dispose()]);
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  first = selectOwned(f, auth, f.env, selectionRequest()); await joinOwnFlushes(f, auth, f.env);
  const original = GenerationAdvisoryState.prototype.admitSelection; let deny = true, admitted = 0;
  t.mock.method(GenerationAdvisoryState.prototype, 'admitSelection', function(plan) {
    const debit = Reflect.apply(original, this, [plan]);
    if (deny) { admitted++; pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged()); assert.ok(pressure); }
    return debit;
  });
  const charged = bodyBudgetCharged(), rpc = f.trace.rpc.length, writes = f.trace.writes.length;
  for (let i = 0; i < 3; i++) {
    assert.throws(() => selectOwned(f, auth, f.env, selectionRequest()), capacity);
    pressure.release(); pressure = undefined;
    assert.equal(bodyBudgetCharged(), charged); assert.equal(f.trace.rpc.length, rpc); assert.equal(f.trace.writes.length, writes);
  }
  assert.equal(admitted, 3); deny = false;
  next = selectOwned(f, auth, f.env, selectionRequest()); assert.ok(next.matchesKey('oauth/bridge-policy/b'));
  await joinOwnFlushes(f, auth, f.env);
  assert.equal(f.db.prepare('SELECT SUM(selected_count) AS n FROM upstream_grant_selection').get().n, 2);
}));

for (const revised of [false, true]) test('pending runtime crosses live successors only for matching authority and revision: ' + revised, async t => fixture(t, async f => {
  seedPool(f); let a, authA, b, authB, choice, later, laterAuth, laterChoice, oldChoice;
  cleanupGenerations(f, [() => a?.dispose(), () => authA?.dispose(), () => b?.dispose(), () => authB?.dispose(), () => choice?.dispose(), () => later?.dispose(), () => laterAuth?.dispose(), () => laterChoice?.dispose(), () => oldChoice?.dispose()]);
  const entered = deferred(), release = deferred(); f.releases.push(() => release.resolve());
  a = await generation(f, poolInput()); authA = authenticateCredentialGeneration(a, f.env, { ...poolInput(), allConnections: false });
  const fetch = f.owner.fetch;
  t.mock.method(f.owner, 'fetch', async function(request) {
    if (new URL(request.url).pathname === '/grant-pools/feedback') { entered.resolve(); await release.promise; }
    return Reflect.apply(fetch, this, [request]);
  });
  const receipt = queueOwned(f, authA, 'oauth/bridge-policy/a', { ...runtimeState(new Date().toISOString(), 10),
    status: 'cooldown', lastSignal: 'rate_limited', cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  assert.equal(receipt.accepted, true); const held = f.own(receipt.completed);
  const arrived = await Promise.race([entered.promise.then(() => true), held.outcome.then(() => false)]);
  if (!arrived) { await f.take(held); assert.fail('feedback completed before its original hold'); }
  if (revised) {
    const key = 'oauth/bridge-policy/a', row = f.db.prepare('SELECT projection_json FROM upstream_grant_projections WHERE grant_key=?').get(key);
    f.sql.exec('UPDATE upstream_grant_projections SET projection_json=? WHERE grant_key=?', JSON.stringify({ ...JSON.parse(row.projection_json), updatedAt: '2026-02-01T00:00:00.000Z' }), key);
  }
  const request = { ...poolInput(), snapshot: 'select' };
  b = await generation(f, request); authB = authenticateCredentialGeneration(b, f.env, { ...request, allConnections: false });
  // Pending feedback prevents authority-side selection, then the owned local
  // view applies the matching observation without copying predecessor counts.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM upstream_grant_selection').get().n, 0);
  choice = selectOwned(f, authB, f.env, selectionRequest()); assert.ok(choice.matchesKey('oauth/bridge-policy/' + (revised ? 'a' : 'b')));
  if (choice.flush.accepted) await f.take(f.own(choice.flush.completed));
  await fixture(t, async other => {
    seedPool(other); let foreign, foreignAuth, selected;
    cleanupGenerations(other, [() => foreign?.dispose(), () => foreignAuth?.dispose(), () => selected?.dispose()]);
    foreign = await generation(other, poolInput()); foreignAuth = authenticateCredentialGeneration(foreign, other.env, { ...poolInput(), allConnections: false });
    selected = selectOwned(other, foreignAuth, other.env, selectionRequest()); assert.ok(selected.matchesKey('oauth/bridge-policy/a'));
    await joinOwnFlushes(other, foreignAuth, other.env);
  });
  release.resolve(); await f.take(held);
  oldChoice = selectOwned(f, authA, f.env, selectionRequest()); assert.ok(oldChoice.matchesKey('oauth/bridge-policy/b'));
  if (oldChoice.flush.accepted) await f.take(f.own(oldChoice.flush.completed));
  choice.dispose(); choice = undefined; authB.dispose(); authB = undefined; b.dispose(); b = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  later = await generation(f, poolInput()); laterAuth = authenticateCredentialGeneration(later, f.env, { ...poolInput(), allConnections: false });
  laterChoice = selectOwned(f, laterAuth, f.env, selectionRequest()); assert.ok(laterChoice.matchesKey('oauth/bridge-policy/' + (revised ? 'a' : 'b')));
  await joinOwnFlushes(f, laterAuth, f.env);
}));

test('refused pending cap drains after all public owners and publication are disposed, releasing both slots', async t => fixture(t, async f => {
  seedPool(f); const baseline = bodyBudgetCharged(), release = deferred(), blockers = [], caps = [];
  let borrow, auth, selected, next;
  f.releases.push(() => release.resolve());
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => next?.dispose()]);
  for (let i = 0; i < BACKGROUND_WORK_LIMIT; i++) { const root = f.own(release.promise.then(() => undefined)); blockers.push(root); assert.equal(tryRunInBackground(() => root.outcome), true); }
  for (let i = 0; i < 2; i++) {
    borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
    selected = selectOwned(f, auth, f.env, selectionRequest()); assert.equal(selected.flush.accepted, false); assert.ok(selected.flush.pending);
    caps.push(selected.flush.pending);
    selected.dispose(); selected = undefined; auth.dispose(); auth = undefined; borrow.dispose(); borrow = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  }
  assert.ok(bodyBudgetCharged() > baseline);
  assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/record').length, 0);
  for (const cap of caps) { const original = cap.drain(); f.pendingCaps.delete(cap); await f.take(f.own(original)); assert.throws(() => cap.drain(), denied); }
  assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/record').length, 2);
  assert.equal(bodyBudgetCharged(), baseline);
  next = await generation(f, poolInput()); next.dispose(); next = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  release.resolve(); for (const root of blockers) await f.take(root);
  assert.equal(bodyBudgetCharged(), baseline);
}));


for (const pressureKind of ['payload', 'structure']) test('private destination optional ' + pressureKind + ' refusal preserves old entry and common-funded borrowers', async t => prefetchFixture(t, async f => {
  const originalNow = Date.now(); let now = originalNow, pressure, old, fresh;
  setHotCacheClock(() => now); f.releases.push(() => { pressure?.release(); pressure = undefined; setHotCacheClock(); });
  f.resources.push(() => { fresh?.dispose(); old?.dispose(); });
  const first = prefetchOwnedGrantCredentials(f.cap()); assert.equal(first.accepted, true); await f.take(f.own(first.completed));
  old = borrowOwnedGrantCredentials(f.cap()); assert.ok(old);
  const charged = bodyBudgetCharged(), vector = privateCacheCharged();
  const used = privateCacheCharged(); pressure = PrivateCacheReservation.reserve({ serializedBytes: 0,
    payloadBytes: pressureKind === 'payload' ? privateCacheLimits.payloadBytes - used.payloadBytes : 1,
    structure: pressureKind === 'structure' ? privateCacheLimits.structure - used.structure : 1 }); assert.ok(pressure);
  const withPressure = bodyBudgetCharged();
  now += 10001; // Stale but still usable: refresh must preserve old publication.
  const refresh = prefetchOwnedGrantCredentials(f.cap()); assert.equal(refresh.accepted, true); await f.take(f.own(refresh.completed));
  assert.equal(f.calls(), 2); assert.equal(bodyBudgetCharged(), withPressure);
  fresh = borrowOwnedGrantCredentials(f.cap()); assert.ok(fresh); assert.equal(f.calls(), 2);
  assert.deepEqual(Object.keys(fresh), ['dispose']); assert.equal(JSON.stringify(fresh), '{}');
  assert.ok(bodyBudgetCharged() > withPressure);
  fresh.dispose(); fresh = undefined; pressure.release(); pressure = undefined;
  assert.equal(bodyBudgetCharged(), charged); assert.deepEqual(privateCacheCharged(), vector);
  evictOwnedGrantCredentials(f.cap()); assert.ok(bodyBudgetCharged() > 0);
  old.dispose(); old = undefined;
}));

test('private destination borrowing is RPC-free and adoption binds genuine selected provenance with no raw alias', async t => prefetchFixture(t, async f => {
  let value, wrong; f.resources.push(() => { value?.dispose(); wrong?.dispose(); });
  let freezes = 0, cloneCalls = 0; const freeze = Object.freeze, clone = structuredClone;
  t.mock.method(Object, 'freeze', item => { if (item && typeof item === 'object' && Object.hasOwn(item, 'credential')) { freezes++; assert.ok(bodyBudgetCharged() >= preflightPayloadBytes); assert.equal(Object.getPrototypeOf(item), Object.prototype); assert.equal(item.__proto__.unknownOwnedField, 'retained'); assert.ok(Object.isFrozen(item.__proto__)); assert.equal(item.unknownGenerationField.token, 'a'); } return freeze(item); });
  t.mock.method(globalThis, 'structuredClone', (...args) => { cloneCalls++; return Reflect.apply(clone, globalThis, args); });
  const receipt = prefetchOwnedGrantCredentials(f.cap()); assert.equal(receipt.accepted, true); await f.take(f.own(receipt.completed));
  assert.ok(freezes > 0); assert.equal(cloneCalls, 0);
  const calls = f.calls(), charged = bodyBudgetCharged();
  value = borrowOwnedGrantCredentials(f.cap()); assert.ok(value); assert.equal(f.calls(), calls); assert.ok(bodyBudgetCharged() > charged);
  assert.deepEqual(Object.keys(value), ['dispose']); assert.equal(JSON.stringify(value), '{}');
  assert.throws(() => f.adopt({}, f.env), denied);
  assert.throws(() => f.adopt(value, { ...f.env, GRANT_CREDENTIALS: {} }), denied);
  f.adopt(value); const consumed = value; value = undefined;
  assert.throws(() => consumed.dispose(), denied); assert.throws(() => f.adopt(consumed), denied);
  evictOwnedGrantCredentials(f.cap()); assert.ok(bodyBudgetCharged() > 0);
  f.detach(); assert.equal(bodyBudgetCharged(), 0);
}));

for (const kind of ['expire', 'evict', 'replace']) test('private destination ' + kind + ' unpublishes while old borrower remains funded', async t => prefetchFixture(t, async f => {
  let now = Date.now(), old, current; setHotCacheClock(() => now); f.releases.push(() => setHotCacheClock());
  f.resources.push(() => { current?.dispose(); old?.dispose(); });
  const first = prefetchOwnedGrantCredentials(f.cap()); await f.take(f.own(first.completed));
  old = borrowOwnedGrantCredentials(f.cap()); assert.ok(old);
  if (kind === 'expire') { now += 60001; assert.equal(borrowOwnedGrantCredentials(f.cap()), undefined); }
  else if (kind === 'evict') evictOwnedGrantCredentials(f.cap());
  else { now += 10001; const second = prefetchOwnedGrantCredentials(f.cap()); await f.take(f.own(second.completed)); current = borrowOwnedGrantCredentials(f.cap()); assert.ok(current); evictOwnedGrantCredentials(f.cap()); }
  const held = bodyBudgetCharged(); assert.ok(held > 0);
  old.dispose(); old = undefined; assert.ok(bodyBudgetCharged() < held);
  current?.dispose(); current = undefined;
}));

test('private warming does not populate ordinary foreground credentials and late invalidation fences publication', async t => prefetchFixture(t, async f => {
  const entered = deferred(), release = deferred(); f.releases.push(() => release.resolve());
  const get = f.env.GRANT_CREDENTIALS.get;
  f.env.GRANT_CREDENTIALS.get = function(...args) { const stub = Reflect.apply(get, this, args), fetch = stub.fetch;
    return { fetch(url, init) { return fetch(url, init).then(async response => { entered.resolve(); await release.promise; return response; }); } }; };
  const receipt = prefetchOwnedGrantCredentials(f.cap()), root = f.own(receipt.completed);
  const arrival = await Promise.race([entered.promise.then(() => true), root.outcome.then(() => false)]);
  if (!arrival) { await f.take(root); assert.fail('original materialization finished before invalidation hold'); }
  evictOwnedGrantCredentials(f.cap()); release.resolve(); await f.take(root);
  assert.equal(borrowOwnedGrantCredentials(f.cap()), undefined);
  const next = prefetchOwnedGrantCredentials(f.cap()); await f.take(f.own(next.completed));
  let loads = 0;
  const ordinary = await f.take(f.own(cachedGrantCredentials(f.env, 'oauth/bridge-policy/a', { credentialGeneration: 1 }, async () => { loads++; return { kind: 'api_key', enabled: true, credential: 'fixture-ordinary-only' }; })));
  assert.equal(loads, 1); assert.equal(ordinary.credential, 'fixture-ordinary-only');
}));

test('prefetch temporary admission precedes index, traversal and original materialization', async t => prefetchFixture(t, async f => {
  const charged = bodyBudgetCharged(), cache = privateCacheCharged(); let pressure;
  f.releases.push(() => { pressure?.release(); pressure = undefined; });
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - charged - preflightPayloadBytes + 1); assert.ok(pressure);
  assert.throws(() => f.cap(), capacity); assert.equal(f.calls(), 0); assert.deepEqual(privateCacheCharged(), cache);
  pressure.release(); pressure = undefined; assert.equal(bodyBudgetCharged(), charged);
}));


test('private borrower metadata capacity refuses before increment and preserves the published destination', async t => prefetchFixture(t, async f => {
  let pressure; f.releases.push(() => { pressure?.release(); pressure = undefined; });
  const first = prefetchOwnedGrantCredentials(f.cap()); await f.take(f.own(first.completed));
  const charged = bodyBudgetCharged(), vector = privateCacheCharged(), calls = f.calls();
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - charged - preflightPayloadBytes - 4095); assert.ok(pressure);
  const held = bodyBudgetCharged();
  assert.throws(() => borrowOwnedGrantCredentials(f.cap()), capacity);
  assert.equal(bodyBudgetCharged(), held); assert.deepEqual(privateCacheCharged(), vector); assert.equal(f.calls(), calls);
  pressure.release(); pressure = undefined;
  const borrow = borrowOwnedGrantCredentials(f.cap()); assert.ok(borrow); borrow.dispose();
  assert.equal(bodyBudgetCharged(), charged);
}));


test('private credential destination does not cross actual credential-owner binding identity', async t => prefetchFixture(t, async f => {
  const original = f.env.GRANT_CREDENTIALS; f.releases.push(() => { f.env.GRANT_CREDENTIALS = original; });
  const first = prefetchOwnedGrantCredentials(f.cap()); await f.take(f.own(first.completed)); const calls = f.calls();
  f.env.GRANT_CREDENTIALS = { idFromName: original.idFromName, get: original.get };
  assert.equal(borrowOwnedGrantCredentials(f.cap()), undefined); assert.equal(f.calls(), calls);
  f.env.GRANT_CREDENTIALS = original;
  const own = borrowOwnedGrantCredentials(f.cap()); assert.ok(own); own.dispose(); assert.equal(f.calls(), calls);
}));
