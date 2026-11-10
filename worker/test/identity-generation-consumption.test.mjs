import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { PolicyBindingIndexObject } = await import('../authority.ts');
const { preflightCredential, releaseCredentialPreflight, prepareCredentialGeneration, completeCredentialGeneration, completeConsumableCredentialGeneration, authenticateCredentialGeneration, selectCredentialGeneration, flushCredentialGenerationRuntime, queueCredentialGenerationRuntime, retainCredentialGenerationHint, borrowCredentialGeneration, evictCredentialGeneration, consumeCredentialPreflight, completeCredentialAdmission } = await import('../credential-preflight.ts');
const { GenerationMetadataCharge, preflightPayloadBytes, preflightControlSlots } = await import('../credential-preflight-arena.ts');
const { bodyBudgetCharged, ExactBodyCharge, bodyBudgetBytes } = await import('../body-budget.ts');
const { PrivateCacheReservation, privateCacheLimits, privateCacheCharged, setHotCacheClock } = await import('../hot-cache.ts');
const { generationFactoryCharges, measureGenerationGraph, freezeGenerationGraph } = await import('../identity-generations.ts');
const { identitySourceBudget, isIdentityFailure } = await import('../identity-admission.ts');
const digest = 'ab'.repeat(32), rotated = 'cd'.repeat(32);
const credential = (secretSha256 = digest) => ({ enabled: true, secretSha256, policyId: 'bridge-policy', policyGeneration: 'legacy', principalId: null });
const denied = error => isIdentityFailure(error) && error.status === 503;
const capacity = error => denied(error) && error.message === 'Identity admission failed (limit)';
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
  const fetch = async (url, init) => { trace.rpc.push(new URL(url).pathname); const response = await take(own(owner.fetch(new Request(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' }))));
    if (url.endsWith('/grant-pools/record') || url.endsWith('/grant-pools/feedback')) { const text = await take(own(response.text())); return accessBytesResponse(text, '', { status: response.status, headers: response.headers }); }
    return response; };
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

function seedPool(f) {
  seed(f);
  f.stored.set('policies/bridge-policy', { enabled: true, generation: 'legacy', providers: [], grantRouting: { strategy: 'round_robin' } });
  f.stored.set('connections/anthropic', { providerId: 'anthropic', enabled: true });
  for (const token of ['a', 'b']) {
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
  a = selectCredentialGeneration(auth, f.env, selectionRequest()); b = selectCredentialGeneration(auth, f.env, selectionRequest());
  assert.ok(a?.matchesKey('oauth/bridge-policy/a')); assert.ok(b?.matchesKey('oauth/bridge-policy/b'));
  assert.equal(f.trace.rpc.length, rpc); assert.equal(f.trace.writes.length, writes);
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
  auth.dispose(); auth = undefined; borrow.dispose(); borrow = undefined; evictCredentialGeneration(f.env, 'bridgekid');
  assert.ok(a.selected()); assert.ok(bodyBudgetCharged() > baseline);
  f.releases.push(() => { if (nextAuth) f.own(flushCredentialGenerationRuntime(nextAuth, f.env)); });
  successor = await generation(f, poolInput()); nextAuth = authenticateCredentialGeneration(successor, f.env, { ...poolInput(), allConnections: false });
  next = selectCredentialGeneration(nextAuth, f.env, selectionRequest()); assert.ok(next?.matchesKey('oauth/bridge-policy/a'));
  await f.take(f.own(flushCredentialGenerationRuntime(nextAuth, f.env)));
}));

test('selection capacity precedes count and cursor effects', async t => fixture(t, async f => {
  seedPool(f); let borrow, auth, selected, pressure;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => pressure?.release()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  const rpc = f.trace.rpc.length, writes = f.trace.writes.length;
  pressure = ExactBodyCharge.reserve(bodyBudgetBytes - bodyBudgetCharged() - 4095); assert.ok(pressure);
  assert.throws(() => selectCredentialGeneration(auth, f.env, selectionRequest()), capacity);
  assert.equal(f.trace.rpc.length, rpc); assert.equal(f.trace.writes.length, writes);
  pressure.release(); pressure = undefined;
  selected = selectCredentialGeneration(auth, f.env, selectionRequest()); assert.ok(selected?.matchesKey('oauth/bridge-policy/a'));
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
}));

test('a held hint owns the detached selection after both public consumers and publication retire', async t => fixture(t, async f => {
  seedPool(f); const baseline = bodyBudgetCharged(); let borrow, auth, selected, hint;
  cleanupGenerations(f, [() => borrow?.dispose(), () => auth?.dispose(), () => selected?.dispose(), () => hint?.dispose()]);
  f.releases.push(() => { if (auth) f.own(flushCredentialGenerationRuntime(auth, f.env)); });
  borrow = await generation(f, poolInput()); auth = authenticateCredentialGeneration(borrow, f.env, { ...poolInput(), allConnections: false });
  selected = selectCredentialGeneration(auth, f.env, selectionRequest()); hint = retainCredentialGenerationHint(selected);
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env)));
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
  queueCredentialGenerationRuntime(auth, key, runtimeState('2026-01-01T00:00:00.000Z', 8));
  first = f.own(flushCredentialGenerationRuntime(auth, f.env));
  const arrival = await Promise.race([entered.promise.then(() => ({ entered: true })), first.outcome.then(outcome => ({ entered: false, outcome }))]);
  if (!arrival.entered) { first.used = true; if (arrival.outcome.failed) throw arrival.outcome.error; assert.fail('original flush settled before ACK hold'); }
  queueCredentialGenerationRuntime(auth, key, runtimeState('2026-01-02T00:00:00.000Z', 3));
  evictCredentialGeneration(f.env, 'bridgekid'); release.resolve(); await f.take(first);
  second = f.own(flushCredentialGenerationRuntime(auth, f.env)); await f.take(second);
  assert.equal(calls, 2);
  const stored = JSON.parse(f.db.prepare('SELECT state_json FROM upstream_grant_runtime WHERE grant_key=?').get(key).state_json);
  assert.equal(stored.observedAt, '2026-01-02T00:00:00.000Z'); assert.equal(stored.windows[0].remaining, 3);
  await f.take(f.own(flushCredentialGenerationRuntime(auth, f.env))); assert.equal(calls, 2);
}));
