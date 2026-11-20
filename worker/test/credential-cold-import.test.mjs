import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { fixture, credential, digest, session, adminActor } from './credential-fixture.mjs';

const { credentialMutationResponse } = await import('../credentials.ts');
const { HttpError } = await import('../utils.ts');
const lists = ['/credentials/list', '/policies/list', '/users/list', '/list'];

async function controlled(t, scope, hook) {
  const calls = [], counts = new Map(), gates = new Map();
  let result, settled = false, failure, rejected = false, mutations = 0, closing = false;
  // Register release and join before starting any mutation/import work.
  const release = () => { closing = true; for (const g of gates.values()) g.resolve(); };
  t.signal.addEventListener('abort', release, { once: true });
  t.after(async () => {
    release();
    if (result) await result;
    t.signal.removeEventListener('abort', release);
  });
  const env = await fixture(t, [['legacy_key', credential()]], { legacy: true });
  const original = env.ACCESS_CONTROL;
  const state = { env, calls, counts, gates, get mutations() { return mutations; }, get settled() { return settled; },
    get failure() { return failure; }, get rejected() { return rejected; },
    hold(key) { const gate = Promise.withResolvers(); gates.set(key, gate); if (closing) gate.resolve(); return gate.promise; },
    release(key) { gates.get(key)?.resolve(); },
  };
  env.ACCESS_CONTROL = { idFromName: original.idFromName, get(id) {
    const stub = original.get(id);
    return { async fetch(input, init) {
      const path = new URL(input).pathname, count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count); calls.push(path);
      if (path === '/credentials/mutate') mutations++;
      return hook(state, path, count, () => stub.fetch(input, init));
    } };
  } };
  state.start = () => {
    const request = new Request('https://clawrouter.example/v1/session/credentials', {
      method: 'POST', body: JSON.stringify({ credentialId: 'new_key', policyId: 'maintainer_access', secretSha256: digest }),
    });
    result = credentialMutationResponse(request, env, null, scope === 'admin' ? adminActor : session, scope)
      .then(async response => ({ status: response.status, body: await response.json() }), error => {
        rejected = true; failure = error; return null;
      }).finally(() => { settled = true; });
    return result;
  };
  state.arrive = async promise => Promise.race([promise, result.then(() => { throw new Error('mutation completed before import arrival'); })]);
  return state;
}

for (const scope of ['admin', 'personal']) for (const undefinedReason of [false, true]) {
  test(`cold ${scope} joins all imports and preserves the first observed ${undefinedReason ? 'undefined' : 'HttpError'}`, { timeout: 10_000 }, async t => {
    const entered = Promise.withResolvers(), expected = undefinedReason ? undefined : new HttpError(409, 'fixture_safe', 'safe fixture denial');
    const count = scope === 'admin' ? 3 : 4;
    const f = await controlled(t, scope, async (s, path, n, next) => {
      if (lists.includes(path) && n === 1) {
        const hold = s.hold(path);
        if (s.gates.size === count) entered.resolve();
        await hold;
        if (path === '/users/list') throw expected;
        if (path === '/policies/list') throw new Error('later sibling failure');
      }
      return next();
    });
    const result = f.start(); await f.arrive(entered.promise);
    assert.deepEqual(f.calls.slice(0, count), lists.slice(0, count));
    f.release('/users/list'); await turn();
    f.release('/policies/list'); await turn();
    if (scope === 'personal') f.release('/list');
    await turn();
    assert.equal(f.settled, false); assert.equal(f.mutations, 0);
    f.release('/credentials/list'); await result;
    assert.equal(f.rejected, true); assert.equal(f.failure, expected); assert.equal(f.mutations, 0);
    assert.equal(f.env.credentials.has('legacy_key'), true, 'already imported sibling commits remain');
    assert.equal(f.env.credentials.has('new_key'), false);
  });
}

for (const scope of ['admin', 'personal']) {
  test(`cold ${scope} retains concurrent hydration and all final rereads before one mutation`, { timeout: 10_000 }, async t => {
    const entered = Promise.withResolvers(), count = scope === 'admin' ? 3 : 4;
    const f = await controlled(t, scope, async (s, path, n, next) => {
      if (lists.includes(path) && n === 1) {
        const hold = s.hold(path); if (s.gates.size === count) entered.resolve(); await hold;
      }
      if (path === '/credentials/mutate') for (const list of lists.slice(0, count)) assert.equal(s.counts.get(list), 2);
      return next();
    });
    const result = f.start(); await f.arrive(entered.promise);
    assert.deepEqual(f.calls, lists.slice(0, count)); assert.equal(f.mutations, 0);
    for (const path of lists.slice(1, count)) f.release(path);
    await turn(); assert.equal(f.settled, false); assert.equal(f.mutations, 0);
    f.release(lists[0]); const response = await result;
    assert.equal(f.rejected, false); assert.equal(response.status, 201); assert.equal(f.mutations, 1);
    assert.equal(f.env.credentials.has('legacy_key'), true); assert.equal(f.env.credentials.has('new_key'), true);
    assert.equal(response.body.policyId, 'maintainer_access');
    if (scope === 'personal') assert.equal(response.body.principalId, session.email);
  });
}

for (const phase of ['initial-list', 'kv-list', 'kv-get', 'initializer-ack', 'final-reread']) {
  test(`cold import ${phase} failure joins a held sibling without mutation`, { timeout: 10_000 }, async t => {
    const entered = Promise.withResolvers(), failed = Promise.withResolvers();
    const sentinel = new HttpError(409, 'fixture_safe', 'safe fixture denial');
    let committed = false;
    const fail = () => { failed.resolve(); throw sentinel; };
    const f = await controlled(t, 'admin', async (s, path, n, next) => {
      if (path === '/credentials/list' && n === 1) { const hold = s.hold(path); entered.resolve(); await hold; }
      if (path === '/users/list' && n === (phase === 'final-reread' ? 2 : 1) && ['initial-list', 'final-reread'].includes(phase)) return fail();
      const response = await next();
      if (path === '/users/initialize-all' && phase === 'initializer-ack') {
        committed = true; await response.body.cancel(); return fail();
      }
      return response;
    });
    const kv = f.env.POLICY_KV;
    f.env.POLICY_KV = { ...kv,
      async list(options) { if (phase === 'kv-list' && options.prefix === 'access/users/') return fail(); return kv.list(options); },
      async get(key, ...args) { if (phase === 'kv-get' && (Array.isArray(key) ? key : [key]).some(k => k.startsWith('access/users/'))) return fail(); return kv.get(key, ...args); },
    };
    const result = f.start(); await f.arrive(entered.promise); await f.arrive(failed.promise); await turn();
    assert.equal(f.settled, false); assert.equal(f.mutations, 0);
    f.release('/credentials/list'); await result;
    assert.equal(f.rejected, true); assert.equal(f.mutations, 0);
    if (phase === 'initializer-ack') {
      assert.equal(committed, true); assert.equal(f.failure.code, 'authority_ack_failed');
      assert.equal(f.failure.outcome, 'OUTCOME_UNKNOWN');
      assert.equal((await f.env.call('/users/list', {})).users.length, 1, 'raw owner read sees retained import commit');
    } else assert.equal(f.failure, sentinel);
    assert.equal(f.env.credentials.has('new_key'), false);
  });
}
