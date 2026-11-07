import './typescript-setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { PolicyBindingIndexObject, authorityCall, resolveBindings, resolvePolicies } from '../authority.ts';
import { normalizePolicyRecord } from '../authority-policy.ts';
import { parseAccessJson } from '../access-json.ts';
import { PolicyCollection, admitPolicyIds, admitEffectivePolicies, admitPolicyJson, admitPolicyBytes, parsePolicyRecord, policySourceBudget, policyCandidatePlan } from '../policy-collection.ts';

const marker = { 'x-clawrouter-policy-collection': 'v1' }, maximum = 2097152;
const bytes = text => accessBytesResponse(text, '').body;
const denied = kind => error => error?.code === 'policy_collection_unavailable' && error.message === `Policy collection failed (${kind})`;
const accessLimit = error => error?.code === 'access_limit';
const binding = (extra = {}) => ({ principalType: 'group', principalId: 'team', policyId: 'p', enabled: true, priority: 5, ...extra });

function fixture(t) {
  const db = new DatabaseSync(':memory:'), store = new Map(), roots = [], trace = [];
  const state = { writes: 0, markers: 0, gets: 0, beforeGet: undefined };
  let primary, hasPrimary = false;
  // Finite request AND original Response body consumption are registered together.
  // No early assertion can leave a successful reply body outside the drain root.
  t.after(async () => {
    const errors = (await Promise.all(roots)).filter(result => result.failed && (!hasPrimary || !Object.is(result.error, primary))).map(result => result.error);
    try { db.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'primary and independent fixture cleanup');
  });
  const sql = { exec(query, ...args) {
    trace.push(query);
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...args);
    statement.run(...args);
    if (/^INSERT OR REPLACE INTO (access_policies|policy_binding_entries)/.test(query)) state.writes++;
    if (/^INSERT OR IGNORE INTO policy_binding_(principals|meta)/.test(query)) state.markers++;
    return [];
  } };
  const owner = new PolicyBindingIndexObject({ storage: { sql } }, {});
  const track = actual => { roots.push(actual.then(() => ({ failed: false }), error => ({ failed: true, error }))); return actual; };
  const call = (path, body, headers = marker) => track((async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const r = await owner.fetch(new Request('https://clawrouter.internal' + path, { method: 'POST', headers,
      body: new Headers(headers).has('x-clawrouter-policy-collection') ? bytes(text) : text, duplex: 'half' }));
    return { status: r.status, headers: r.headers, text: await r.text() };
  })());
  const env = { ACCESS_CONTROL: { idFromName: name => name, get: () => ({ async fetch(url, init) {
    const result = await call(new URL(url).pathname, init.body, init.headers ?? {});
    // Explicit Node byte fixture. This is NOT the actual Workerd producer proof.
    return accessBytesResponse(result.text, '', { status: result.status, headers: result.headers });
  } }) }, POLICY_KV: {
    async get(key, type) { assert.equal(type, 'stream'); state.gets++; await state.beforeGet?.(key); return store.has(key) ? bytes(store.get(key)) : null; },
    async list({ prefix, cursor, limit }) {
      assert.equal(limit, 64); const names = [...store.keys()].filter(key => key.startsWith(prefix)), from = Number(cursor ?? 0);
      return { keys: names.slice(from, from + 64).map(name => ({ name })), list_complete: from + 64 >= names.length, cursor: String(from + 64) };
    },
  } };
  return { owner, db, store, state, trace, env, call,
    async run(fn) { try { await fn(); } catch (error) { primary = error; hasPrimary = true; throw error; } },
    insert(id, value) { db.prepare('INSERT OR REPLACE INTO access_policies(policy_id,policy_json) VALUES(?,?)').run(id, typeof value === 'string' ? value : JSON.stringify(value)); },
  };
}

test('protocol-position scanner keeps unknown ID names and nested bindings generic, including discarded members', () => {
  const unknown = { policyId: 'p'.repeat(1025), principalId: 'u'.repeat(1025), policyIds: 's'.repeat(1025) };
  assert.deepEqual(parsePolicyRecord(JSON.stringify({ unknown }), policySourceBudget()), { unknown });
  const record = binding({ metadata: { ...unknown, bindings: Array(4096).fill(0) } });
  assert.deepEqual(parsePolicyRecord(JSON.stringify(record), policySourceBudget(), true), record);
  assert.deepEqual(parseAccessJson(JSON.stringify([{ principal: { principalType: 'group', principalId: 'team' }, bindings: [record] }]), 'policy_bindings')[0].bindings, [record]);
  for (const [text, profile] of [
    ['{"principals":[{"principalType":"group","principalId":"' + 'x'.repeat(1025) + '","principalId":"team"}]}', 'policy_principals'],
    ['{"policyIds":["' + 'x'.repeat(1025) + '"],"policyIds":["p"]}', 'policy_ids'],
    ['[{"policyId":"' + 'x'.repeat(1025) + '","policyId":"p","policy":{}}]', 'policy_seeds'],
    ['{"policyId":"' + 'x'.repeat(1025) + '","policyId":"p"}', 'policy_binding_record'],
  ]) assert.throws(() => parseAccessJson(text, profile), accessLimit);
  const rows = Array(4096).fill(binding()), seed = { principal: { principalType: 'group', principalId: 'team' }, bindings: rows };
  assert.doesNotThrow(() => parseAccessJson(JSON.stringify([seed]), 'policy_bindings'));
  assert.throws(() => parseAccessJson(JSON.stringify([{ ...seed, bindings: [...rows, binding()] }]), 'policy_bindings'), accessLimit);
  const discarded = '[{"principal":{"principalType":"group","principalId":"team"},"bindings":' + JSON.stringify(rows) + ',"bindings":[' + JSON.stringify(binding()) + ']}]';
  assert.throws(() => parseAccessJson(discarded, 'policy_bindings'), accessLimit);
});

test('generic unknown graph still charges the same cumulative record and string budget', () => {
  const budget = policySourceBudget(true), text = ' '.repeat(maximum - 2) + '{}';
  for (let i = 0; i < 2; i++) { admitPolicyBytes(budget, maximum); assert.deepEqual(parsePolicyRecord(text, budget), {}); }
  assert.throws(() => admitPolicyBytes(budget, 1), denied('limit'));
  const graph = policySourceBudget(); parsePolicyRecord('{"unknown":{"policyIds":[' + '0,'.repeat(32765) + '0]}}', graph);
  assert.throws(() => parsePolicyRecord('{"unknown":0}', graph), denied('limit'));
  assert.throws(() => parsePolicyRecord(JSON.stringify({ unknown: { policyId: 'x'.repeat(1048577) } }), policySourceBudget()), denied('limit'));
});

test('SQL and cold canonical replies retain all unknown ID-named fields; cold binding metadata uses old projection', async t => {
  const f = fixture(t);
  await f.run(async () => {
    const unknown = { policyId: 'p'.repeat(1025), principalId: 'u'.repeat(1025), policyIds: 's'.repeat(1025) };
    const policy = { ...normalizePolicyRecord({}, false), unknown };
    f.insert('warm', policy);
    assert.deepEqual((await resolvePolicies(f.env, ['warm']))[0].policy.unknown, unknown);
    f.store.set('policies/cold', JSON.stringify({ ...policy, requestCostsMicros: 'ignored-invalid-seed' }));
    f.state.beforeGet = key => { if (key === 'policies/cold') { f.state.beforeGet = undefined; f.insert('cold', policy); } };
    assert.deepEqual((await resolvePolicies(f.env, ['cold']))[0].policy.unknown, unknown);
    assert.equal(f.state.writes, 0);
    f.store.set('access/bindings/group/team/p', JSON.stringify(binding({ metadata: { ...unknown, bindings: Array(4096).fill(0) } })));
    assert.deepEqual(await resolveBindings(f.env, [{ principalType: 'group', principalId: 'team' }], new PolicyCollection()), [binding()]);
    const stored = JSON.parse(f.db.prepare('SELECT binding_json FROM policy_binding_entries').get().binding_json);
    assert.deepEqual(stored, binding()); assert.equal(Object.hasOwn(stored, 'metadata'), false);
    const scalar = await f.call('/initialize', [{ principal: { principalType: 'group', principalId: 'empty' }, bindings: 'x' }]);
    assert.equal(scalar.status, 200); assert.equal(scalar.text, 'initialized');
    assert.ok(f.db.prepare('SELECT principal_key FROM policy_binding_principals WHERE principal_key=?').get('group:empty'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM policy_binding_entries WHERE principal_key=?').get('group:empty').n, 0);
  });
});

test('normalized candidate visitor hits the actual graph boundary before filter/copy, including the LAST candidate', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'filter'), original = descriptor.value; let copies = 0;
  t.after(() => { Object.defineProperty(Array.prototype, 'filter', descriptor); });
  Object.defineProperty(Array.prototype, 'filter', { ...descriptor, value: function (...args) {
    if (this[0] === 'projection-witness') copies++;
    return Reflect.apply(original, this, args);
  } });
  const exact = { providers: Array(32738).fill('projection-witness') };
  assert.doesNotThrow(() => policyCandidatePlan()('p', exact, false)); assert.equal(copies, 0);
  assert.doesNotThrow(() => admitPolicyJson([{ policyId: 'p', policy: normalizePolicyRecord(exact, false) }])); assert.equal(copies, 1);
  copies = 0;
  assert.throws(() => policyCandidatePlan()('p', { providers: Array(32739).fill('projection-witness') }, false), denied('limit')); assert.equal(copies, 0);
  const f = fixture(t);
  await f.run(async () => {
    for (const entries of [
      [{ policyId: 'p', policy: { providers: Array(32760).fill('projection-witness') } }],
      [{ policyId: 'first', policy: { providers: Array(16000).fill('projection-witness') } }, { policyId: 'last', policy: { providers: Array(16709).fill('projection-witness') } }],
    ]) {
      const result = await f.call('/policies/initialize', { entries, retainRequestContentDefault: false });
      assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error.code, 'policy_collection_unavailable');
      assert.equal(copies, 0); assert.equal(f.state.writes, 0); assert.equal(f.state.markers, 0);
    }
  });
});

test('candidate visitor matches exact normalized UTF8/text escaping limits and selected projection fields', t => {
  t.mock.method(Date, 'now', () => 1760000000000);
  const cases = [
    {},
    { models: ['b', 'a', 'b', 0, null], providers: ['a', 3, 'a'], serviceTiers: { unknown: true }, budgetMode: 'reserve', requestCostsMicros: { 'audio.generate': 0 } },
    { grantRouting: { strategy: 'threshold', stickiness: 'identity', eligibleGrants: { a: ['z', 'a', 'z'] }, sharedGrants: { a: ['oauth/a/z', 'oauth/tenants/a/q', 'bad'] }, switchAtUsedPercent: 0 } },
    { grantRouting: JSON.parse('{"eligibleGrants":{"__proto__":["a"],"p":["z"]},"sharedGrants":{"__proto__":["oauth/a/z"],"p":["oauth/a/q"]}}') },
    { upstreamRetention: { version: 'clawrouter.upstream-retention.v1', allow: [{ providerId: 'p', protocol: 'q' }] }, inputPublication: { version: 'clawrouter.input-publication.v1', allow: [{ providerId: 'openrouter', endpointId: 'music_generate', modelId: 'openrouter/google/lyria-3-clip-preview', publish: true, forward: false, expiresAt: '2030-01-01T00:00:00Z' }] } },
  ];
  for (const base of cases) for (const unit of ['x', 'é', '\0']) {
    const raw = { ...base, serviceTiers: 'x'.repeat(1048576), limitHint: '' };
    const overhead = Buffer.byteLength(JSON.stringify([{ policyId: 'p', policy: normalizePolicyRecord(raw, true) }]));
    const cost = Buffer.byteLength(JSON.stringify(unit)) - 2;
    raw.limitHint = unit.repeat(Math.floor((maximum - overhead) / cost));
    assert.doesNotThrow(() => policyCandidatePlan()('p', raw, true));
    assert.doesNotThrow(() => admitPolicyJson([{ policyId: 'p', policy: normalizePolicyRecord(raw, true) }]));
    raw.limitHint += unit;
    assert.throws(() => policyCandidatePlan()('p', raw, true), denied('limit'));
    assert.throws(() => admitPolicyJson([{ policyId: 'p', policy: normalizePolicyRecord(raw, true) }]), denied('limit'));
  }
});

test('expired publication reserves its structural branch before normalization across clock rollback', t => {
  let now = Date.parse('2031-01-01T00:00:00Z'), clockReads = 0, copies = 0;
  t.mock.method(Date, 'now', () => { clockReads++; return now; });
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'filter'), original = descriptor.value;
  t.after(() => { Object.defineProperty(Array.prototype, 'filter', descriptor); });
  Object.defineProperty(Array.prototype, 'filter', { ...descriptor, value: function (...args) { if (this[0] === 'clock-projection') copies++; return Reflect.apply(original, this, args); } });
  const publication = { version: 'clawrouter.input-publication.v1', allow: [
    { providerId: 'openrouter', endpointId: 'music_generate', modelId: 'openrouter/google/lyria-3-pro-preview', publish: true, forward: false, expiresAt: '2030-01-01T00:00:00Z' },
    { providerId: 'openrouter', endpointId: 'music_generate', modelId: 'openrouter/google/lyria-3-clip-preview', publish: false, forward: true, expiresAt: '2030-01-01T00:00:00.001Z' },
  ] };
  const first = { providers: Array(16000).fill('clock-projection'), inputPublication: publication };
  const last = { providers: Array(16674).fill('clock-projection'), inputPublication: publication };
  const plan = policyCandidatePlan(); plan('first', first, false); plan('last', last, false);
  assert.equal(clockReads, 0); assert.equal(copies, 0);
  // Preflight happened AFTER expiry. The actual unchanged normalizer now sees
  // BEFORE expiry, so the optional field really appears in the materialized graph.
  now = Date.parse('2029-01-01T00:00:00Z');
  const result = [{ policyId: 'first', policy: normalizePolicyRecord(first, false) }, { policyId: 'last', policy: normalizePolicyRecord(last, false) }];
  assert.equal(copies, 2); assert.ok(clockReads > 0); assert.doesNotThrow(() => admitPolicyJson(result));
  assert.equal(result[0].policy.inputPublication.allow.length, 2);
  assert.ok(result[0].policy.inputPublication.allow.every(row => row.expiresAt.length === 24));
  now = Date.parse('2031-01-01T00:00:00Z'); copies = 0; clockReads = 0;
  const overflow = policyCandidatePlan(); overflow('first', first, false);
  assert.throws(() => overflow('last', { ...last, providers: [...last.providers, 'clock-projection'] }, false), denied('limit'));
  assert.equal(copies, 0); assert.equal(clockReads, 0); // Pre-copy, not just zero SQL.
  // The intentional conservative denial does not extend expired permissions.
  assert.equal(normalizePolicyRecord(last, false).inputPublication, undefined);
});

test('one caller budget spans binding/policy/legacy streams and raw page/key counters never reset', async () => {
  const collection = new PolicyCollection(), text = ' '.repeat(maximum - 2) + '{}';
  let gets = 0;
  const env = { POLICY_KV: { async get(_key, type) { assert.equal(type, 'stream'); gets++; return bytes(text); } } };
  assert.deepEqual(await collection.read(env, 'access/bindings/group/g/p'), {});
  assert.deepEqual(await collection.read(env, 'policies/p'), {});
  await assert.rejects(collection.read(env, 'keys/p'), denied('limit')); assert.equal(gets, 3);
  let lists = 0;
  env.POLICY_KV.list = async ({ limit }) => { assert.equal(limit, 64); lists++; return { keys: [], list_complete: false, cursor: 'again' }; };
  await assert.rejects(new PolicyCollection().listBindings(env, 'access/bindings/group/g/'), denied('limit')); assert.equal(lists, 4096);
  lists = 0; gets = 0;
  env.POLICY_KV.get = async () => { gets++; return null; };
  env.POLICY_KV.list = async () => ({ keys: Array(64).fill({ name: 'same' }), list_complete: ++lists % 32 === 0, cursor: 'next' });
  const shared = new PolicyCollection();
  assert.deepEqual(await shared.listBindings(env, 'first/'), []); assert.deepEqual(await shared.listBindings(env, 'second/'), []);
  assert.equal(gets, 4096); await assert.rejects(shared.listBindings(env, 'third/'), denied('limit')); assert.equal(gets, 4096);
  for (const cursor of ['', null, 1, 'x'.repeat(16385), 'é'.repeat(8193)]) {
    env.POLICY_KV.list = async () => ({ keys: [], list_complete: false, cursor });
    await assert.rejects(new PolicyCollection().listBindings(env, 'prefix/'), denied(typeof cursor === 'string' && cursor ? 'limit' : 'protocol'));
  }
  env.POLICY_KV.list = async () => ({ keys: [null], list_complete: true });
  await assert.rejects(new PolicyCollection().listBindings(env, 'prefix/'), denied('protocol')); // Shape denial dominates any later key-count ceiling.
});

test('raw principals precede dedup; referenced IDs and complete overrides precede effective copies', () => {
  assert.doesNotThrow(() => new PolicyCollection('a@b', Array(1023).fill('same')));
  assert.throws(() => new PolicyCollection('a@b', Array(1024).fill('same')), denied('limit'));
  assert.throws(() => new PolicyCollection('a@b', ['x'.repeat(1025)]), denied('limit'));
  const ids = Array.from({ length: 2048 }, (_, i) => 'p' + i);
  assert.doesNotThrow(() => admitPolicyIds(ids)); assert.doesNotThrow(() => admitPolicyIds([...ids, ...ids]));
  assert.throws(() => admitPolicyIds([...ids, 'extra']), denied('limit'));
  const entry = { policyId: 'p', policy: { enabled: true, budgetScope: 'principal', dailyBudgetMicros: 99, unknown: 'x'.repeat(1048576) } };
  assert.doesNotThrow(() => admitEffectivePolicies([entry], ['p'], { unreferenced: { unknown: 'x'.repeat(1048577) }, p: { dailyBudgetMicros: 0, weeklyBudgetMicros: null, unknown: { policyId: 'x'.repeat(1025) } } }));
  assert.throws(() => admitEffectivePolicies([entry], ['p'], { p: { unknown: 'y'.repeat(1048576) } }), denied('limit'));
});
