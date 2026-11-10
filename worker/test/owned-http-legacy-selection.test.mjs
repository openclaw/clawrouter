import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteFixture } from './sqlite-storage.mjs';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { PolicyBindingIndexObject } from '../authority.ts';
import { resolveOwnedHttpAuthentication, evictCredentialGeneration, queueOwnedHttpSelectionRuntime } from '../credential-preflight.ts';
import { beginOwnedHttpRequest, finishOwnedHttpRequest } from '../http-identity-owner.ts';
import { selectOwnedHttpProvider, snapshot } from '../providers.ts';
import { bodyBudgetCharged } from '../body-budget.ts';
import { isIdentityFailure } from '../identity-admission.ts';

const digest = 'ab'.repeat(32), kid = 'owned-http-legacy';
const provider = snapshot.providers.find(value => value.id === 'openai');
const endpoint = provider.endpoints.find(value => value.request_format === 'openai.chat_completions');
const tokenRef = provider.auth.schemes.find(value => value.type === 'oauth')?.tokenRef ?? provider.id;
const policyId = 'http-legacy-policy', key = `oauth/${policyId}/${tokenRef}`;
const selection = () => ({ providerId: provider.id, endpointId: endpoint.id, mode: 'http', capability: 'llm.chat', model: 'gpt-fixture', catalogModelId: null });
const coverage = (value, snapshot = 'select') => ({ providers: [{ id: provider.id, tokenRef }], allConnections: false, snapshot, selection: value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); void promise.then(() => undefined, () => undefined); return { promise, resolve, reject }; };

async function fixture(t, run) {
  const resources = [];
  const { sql, transactionSync } = sqliteFixture({ after: close => resources.push(close) }), baseline = bodyBudgetCharged();
  const roots = [], origins = new WeakMap(), releases = [], requests = [], stored = new Map(), trace = { rpc: [], kv: [] };
  let cleanupPromise, finished = false, hasPrimary = false, primary, kvOverride, selectionReply;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { taken: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    origins.set(promise, root); roots.push(root); return root;
  };
  const take = async root => { const result = await root.outcome; root.taken = true; if (result.failed) throw result.error; return result.value; };
  const env = { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '60', POLICY_KV: { async get(name, type) {
    trace.kv.push([name, type]);
    if (kvOverride) { const override = kvOverride(name, type); if (override !== undefined) return override; }
    const value = stored.get(name); if (value == null) return null;
    return type === 'stream' ? accessBytesResponse(typeof value === 'string' ? value : JSON.stringify(value)).body : value;
  } } };
  let owner;
  env.ACCESS_CONTROL = { idFromName(name) { assert.equal(name, 'policy-bindings'); return name; }, get() { return { async fetch(url, init) {
    const path = new URL(url).pathname; trace.rpc.push(path);
    const ordinary = path === '/grant-pools/record' || path === '/grant-pools/feedback';
    const response = await take(own(owner.fetch(new Request(url, ordinary ? init : { ...init, body: accessBytesResponse(init.body).body, duplex: 'half' }))));
    // The synthetic owner reply is still OUR original body. Its one consumption
    // is joined even when a deliberate post-commit transport failure is injected.
    const text = await take(own(response.text()));
    if (path === '/grant-pools/select' && selectionReply) return selectionReply(text);
    return accessBytesResponse(text, '', { status: response.status, headers: response.headers });
  } }; } };
  owner = new PolicyBindingIndexObject({ storage: { sql, transactionSync } }, env);
  stored.set(`credentials/${kid}`, { enabled: true, secretSha256: digest, policyId, policyGeneration: 'legacy', principalId: null });
  stored.set(`policies/${policyId}`, { enabled: true, generation: 'legacy', providers: ['openai'], tenantId: 'default', grantRouting: { strategy: 'round_robin', stickiness: 'none', environmentFallback: false } });
  stored.set(key, { provider: 'openai', kind: 'api_key', credential: 'fixture-only-legacy-key', enabled: true, unknown: { retained: ['complete', null, 7] } });
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const item of requests) try { await take(own(finishOwnedHttpRequest(item.cap))); } catch (error) { failures.push(error); }
    for (let i = 0; i < roots.length; i++) await roots[i].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.taken) { root.taken = true; failures.push(result.error); } }
    try { evictCredentialGeneration(env, kid); } catch (error) { failures.push(error); }
    try { assert.equal(bodyBudgetCharged(), baseline, 'last selected/authentication owner retires'); } catch (error) { failures.push(error); }
    for (const release of resources) try { release(); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!finished) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'legacy fixture teardown'); } });
  const open = async (signal, snapshotMode) => {
    const request = new Request('https://router.example/v1/chat/completions', { signal }), cap = beginOwnedHttpRequest(request, env);
    requests.push({ cap, request }); const required = selection();
    const error = await take(own(resolveOwnedHttpAuthentication(cap, request, env, kid, digest, coverage(required, snapshotMode))));
    if (error) { await take(own(error.text())); assert.fail(`authentication status ${error.status}`); }
    return { request, cap, required };
  };
  const count = () => [...sql.exec('SELECT COALESCE(SUM(selected_count),0) AS n FROM upstream_grant_selection')][0].n;
  try { await run({ env, owner, sql, stored, trace, open, count, own, take, releases,
    overrideKv(value) { kvOverride = value; }, selectionReply(value) { selectionReply = value; } }); }
  catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); finished = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'legacy fixture outcomes');
  if (hasPrimary) throw primary;
}

test('real legacy KV and SQL choose exactly once without a duplicate record', async t => {
  await fixture(t, async f => {
    const current = await f.open(); assert.equal(f.count(), 0, 'private admission did not count missing-snapshot legacy selection');
    const before = f.trace.kv.length;
    const picked = await f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required)));
    assert.equal(picked.selected(), true); assert.equal(picked.matchesKey(key), true); assert.equal(picked.hasConfiguredGrant(), true);
    assert.equal(f.count(), 1); assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/select').length, 1);
    assert.equal(f.trace.rpc.includes('/grant-pools/record'), false);
    assert.deepEqual(f.trace.kv.slice(before).map(([name]) => name), [key, `oauth/tenants/default/${tokenRef}`]);
    assert.equal(Object.keys(picked).includes('grant'), false, 'selected capability exposes no graph');
  });
});

test('nonrecording legacy choice returns first active candidate without an SQL selection effect', async t => {
  await fixture(t, async f => {
    const current = await f.open();
    const picked = await f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required, false)));
    assert.equal(picked.matchesKey(key), true); assert.equal(f.count(), 0);
    assert.equal(f.trace.rpc.includes('/grant-pools/select'), false); assert.equal(f.trace.rpc.includes('/grant-pools/record'), false);
  });
});

test('lost selection reply remains uncertain and is never replayed', async t => {
  await fixture(t, async f => {
    const current = await f.open(); f.selectionReply(() => { throw undefined; });
    await assert.rejects(f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required))), isIdentityFailure);
    assert.equal(f.count(), 1); assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/select').length, 1);
    assert.equal(f.trace.rpc.includes('/grant-pools/record'), false);
  });
});

test('a caller abort cannot retire a held ORIGINAL legacy read or count a later selection', async t => {
  await fixture(t, async f => {
    const abort = new AbortController(), current = await f.open(abort.signal), entered = deferred(), release = deferred();
    f.releases.push(release.resolve);
    const bytes = new TextEncoder().encode(JSON.stringify(f.stored.get(key))); let body;
    f.overrideKv(name => name !== key ? undefined : body = new ReadableStream({ type: 'bytes', async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(bytes); controller.close();
    } }));
    const original = f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required));
    await Promise.race([entered.promise, original.outcome.then(() => { throw Error('selection settled before original read entry'); })]);
    abort.abort(); assert.equal(body.locked, true); assert.equal(f.count(), 0);
    release.resolve(); await assert.rejects(f.take(original)); assert.equal(body.locked, false); assert.equal(f.count(), 0);
  });
});

test('profile denial joins ORIGINAL FIRSTcancel before releasing its legacy workspace', async t => {
  await fixture(t, async f => {
    const current = await f.open(), entered = deferred(), release = deferred(); f.releases.push(release.resolve);
    let body, canceled = 0, sent = 0;
    f.overrideKv(name => name !== key ? undefined : body = new ReadableStream({ type: 'bytes', pull(controller) {
      if (sent > 1048576) return; const bytes = new Uint8Array(16384); bytes.fill(32); sent += bytes.length; controller.enqueue(bytes);
    }, cancel() { canceled++; entered.resolve(); return release.promise; } }));
    const before = bodyBudgetCharged(), original = f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required));
    await Promise.race([entered.promise, original.outcome.then(() => { throw Error('selection settled before original cancellation entry'); })]);
    assert.equal(canceled, 1); assert.equal(body.locked, true); assert.ok(bodyBudgetCharged() > before); assert.equal(f.count(), 0);
    release.resolve(); await assert.rejects(f.take(original), isIdentityFailure); assert.equal(body.locked, false); assert.equal(f.count(), 0);
  });
});


test('covered nonrecording preparation preserves first active key and does not consume the counter', async t => {
  await fixture(t, async f => {
    const grant = { provider: provider.id, kind: 'api_key', enabled: true, credentialStore: 'durable_object',
      credentialStatus: 'active', credentialGeneration: 1, credentialLineage: 'fixture-lineage', hasCredential: true,
      unknown: { retained: ['complete', null, 7] } };
    f.stored.set(key, grant);
    f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', key, 1, 7);
    f.sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)', key, JSON.stringify(grant));
    const current = await f.open(undefined, 'only'), before = f.trace.rpc.length;
    const picked = await f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required, false)));
    assert.equal(picked.matchesKey(key), true); assert.equal(f.count(), 0);
    assert.equal(f.trace.rpc.length, before, 'covered nonrecording selection performs no RPC');
    assert.equal(picked.flush.accepted, false); assert.equal(picked.flush.pending, undefined);
  });
});

test('legacy observations use the acquired grant revision across live owners without copying predecessor counts', async t => {
  await fixture(t, async f => {
    const revision = '2026-01-01T00:00:00.000Z';
    f.stored.set(key, { ...f.stored.get(key), updatedAt: revision });
    const a = await f.open(), picked = await f.take(f.own(selectOwnedHttpProvider(a.cap, a.request, f.env, a.required)));
    assert.equal(f.count(), 1);
    queueOwnedHttpSelectionRuntime(a.cap, a.request, f.env, picked, {
      grantRevision: revision, updatedAt: new Date().toISOString(), cooldownUntil: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal([...f.sql.exec('SELECT state_json FROM upstream_grant_runtime')].length, 0, 'unattempted observation is still independently owned');
    const b = await f.open(), blocked = await f.take(f.own(selectOwnedHttpProvider(b.cap, b.request, f.env, b.required)));
    assert.equal(blocked.selected(), false); assert.equal(blocked.hasConfiguredGrant(), true, 'cooldown is not environment permission');
    assert.equal(f.count(), 1, 'blocked owner does not count another selection');
    f.stored.set(key, { ...f.stored.get(key), updatedAt: '2026-01-02T00:00:00.000Z' });
    const rotated = await f.take(f.own(selectOwnedHttpProvider(b.cap, b.request, f.env, b.required)));
    assert.equal(rotated.matchesKey(key), true, 'old observation does not bind a new actual grant revision');
    assert.equal(f.count(), 2);
  });
});

test('a legacy selected capability cannot publish feedback for another acquired revision', async t => {
  await fixture(t, async f => {
    const a = await f.open(), picked = await f.take(f.own(selectOwnedHttpProvider(a.cap, a.request, f.env, a.required)));
    const before = bodyBudgetCharged();
    assert.throws(() => queueOwnedHttpSelectionRuntime(a.cap, a.request, f.env, picked,
      { grantRevision: 'foreign-revision', updatedAt: new Date().toISOString() }), isIdentityFailure);
    assert.equal(bodyBudgetCharged(), before); assert.equal(f.trace.rpc.includes('/grant-pools/feedback'), false);
  });
});

test('legacy and canonical candidates retain ordinary default-key order and round-robin choice', async t => {
  await fixture(t, async f => {
    const tenant = `oauth/tenants/default/${tokenRef}`;
    const grant = { provider: provider.id, kind: 'api_key', enabled: true, credentialStore: 'durable_object',
      credentialStatus: 'active', credentialGeneration: 1, credentialLineage: 'fixture-tenant', hasCredential: true,
      unknown: { retained: ['tenant', null, 11] } };
    f.stored.set(tenant, grant);
    f.sql.exec('INSERT INTO upstream_grant_pool_versions(grant_key,generation,revision) VALUES(?,?,?)', tenant, 1, 3);
    f.sql.exec('INSERT INTO upstream_grant_projections(grant_key,projection_json,legacy) VALUES(?,?,0)', tenant, JSON.stringify(grant));
    const current = await f.open(), before = f.trace.kv.length;
    const first = await f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required)));
    const second = await f.take(f.own(selectOwnedHttpProvider(current.cap, current.request, f.env, current.required)));
    assert.equal(first.matchesKey(key), true); assert.equal(second.matchesKey(tenant), true);
    assert.deepEqual(f.trace.kv.slice(before).map(([name]) => name), [key, tenant, key, tenant]);
    assert.equal(f.count(), 2); assert.equal(f.trace.rpc.filter(path => path === '/grant-pools/select').length, 2);
    assert.equal(f.trace.rpc.includes('/grant-pools/record'), false);
  });
});
