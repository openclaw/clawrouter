import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { sqliteFixture } from './sqlite-storage.mjs';
const { admitIdentity, admitAdmission, identityJson, identityPlan, copyIdentity, identitySourceBudget, admitIdentityBytes,
  parseIdentity, readIdentityKv, readIdentityRequest, readIdentityResponse, identitySqlRows, identityFailure, isIdentityFailure, admittedEffectivePolicy } = await import('../identity-admission.ts');
const { parseAccessJson } = await import('../access-json.ts');
const { authenticateProxyKey, admittedGrantSelection, proxyAdmission } = await import('../proxy-auth.ts');
const { admissionFixture, admissionHeaders, admissionProvider } = await import('./admission-fixture.mjs');
const { providerById } = await import('../providers.ts');
const { coloGet } = await import('../colo-cache.ts');
const denied = error => { assert.ok(isIdentityFailure(error)); assert.equal(error.status, 503); assert.equal(error.code, 'identity_admission_unavailable'); assert.equal(Object.hasOwn(error, 'cause'), false); return true; };
const empty = () => ({ credential: null, policy: null, owner: null, connections: [], pools: {} });
const parse = (raw, profile = 'record', budget = identitySourceBudget()) => { admitIdentityBytes(budget, Buffer.byteLength(raw), profile === 'record' ? 1048576 : 2097152); return parseIdentity(raw, budget, profile); };

for (const [profile, wire, depth, members, entries, containers] of [
  ['record', 1048576, 16, 32768, 16384, 16384], ['complete', 2097152, 24, 65536, 32768, 32768],
]) {
  test(`identity ${profile}: ORIGINAL wire/text and cumulative repeated reads`, () => {
    const raw = ' '.repeat(wire - 2) + '{}'; assert.deepEqual(parse(raw, profile), {});
    assert.throws(() => parse(raw + ' ', profile), denied);
    const budget = identitySourceBudget(), record = ' '.repeat(1048574) + '{}';
    parse(record, 'record', budget); parse(record, 'record', budget);
    assert.throws(() => parse('{}', 'record', budget), denied);
    assert.equal(budget.bytes, 2097152);
  });
  test(`identity ${profile}: duplicate/discarded members, arrays, containers and depth`, () => {
    const raw = '{' + '"a":0,'.repeat(members - 1) + '"a":1}'; assert.equal(parse(raw, profile).a, 1);
    assert.throws(() => parse(raw.slice(0, -1) + ',"a":2}', profile), denied);
    assert.equal(parse('[' + '0,'.repeat(entries - 1) + '0]', profile).length, entries);
    assert.throws(() => parse('[' + '0,'.repeat(entries) + '0]', profile), denied);
    assert.equal(parse('[' + '{},'.repeat(containers - 2) + '{}]', profile).length, containers - 1);
    assert.throws(() => parse('[' + '{},'.repeat(containers - 1) + '{}]', profile), denied);
    parse('['.repeat(depth) + '0' + ']'.repeat(depth), profile);
    assert.throws(() => parse('['.repeat(depth + 1) + '0' + ']'.repeat(depth + 1), profile), denied);
    // Combined ceilings equal members + entries; value ceilings are earlier
    // dominated by these occurrence ceilings for this JSON grammar.
    const combined = '{' + '"a":0,'.repeat(members - 1) + '"a":[' + '0,'.repeat(entries - 1) + '0]}';
    assert.equal(parse(combined, profile).a.length, entries);
  });
}

test('unknown names/__proto__/nonfinite/lone surrogate preserve existing plain JSON semantics; Access goldens unchanged', () => {
  const raw = '{"unknown":{"candidates":[' + '0,'.repeat(256) + '0],"policyId":"' + 'x'.repeat(1025) + '","__proto__":{"kept":true}},"kid":"' + 'k'.repeat(300) + '","n":1e999,"s":"\\ud800"}';
  const result = parse(raw);
  assert.equal(result.unknown.candidates.length, 257); assert.equal(result.unknown.policyId.length, 1025);
  assert.equal(Object.getPrototypeOf(result.unknown), Object.prototype); assert.equal(Object.hasOwn(result.unknown, '__proto__'), true);
  assert.equal(result.n, Infinity); assert.equal(result.s.charCodeAt(0), 0xd800);
  assert.equal(identityJson(result), JSON.stringify(result));
  assert.throws(() => parseAccessJson(raw, 'jwks'));
  assert.deepEqual(parseAccessJson('{"alg":"RS256","kid":"ok"}', 'header'), { alg: 'RS256', kid: 'ok' });
  assert.equal(parse('{"' + 'k'.repeat(1024) + '":0}')['k'.repeat(1024)], 0);
  assert.throws(() => parse('{"' + 'k'.repeat(1025) + '":0}'), denied);
  parse('1' + '0'.repeat(63)); assert.throws(() => parse('1' + '0'.repeat(64)), denied);
});

test('escaped bytes/UTF16 preflight precedes serializer/clone; independent maxima are not a simultaneous-fit promise', t => {
  const value = { x: '\0'.repeat(174761) }; // 1,048,574 serialized bytes.
  assert.equal(Buffer.byteLength(JSON.stringify(value)), 1048574); admitIdentity(value, 'record');
  const oversized = { x: value.x + '\0' };
  let clones = 0; t.mock.method(globalThis, 'structuredClone', () => { clones++; throw Error('must not clone'); });
  assert.throws(() => copyIdentity(oversized), denied); assert.equal(clones, 0);
  assert.throws(() => identityJson({ x: 'é'.repeat(1048576) }), denied);
  // An individual 1 MiB string and aggregate 1 MiB strings are earlier dominated
  // by record serialization framing; complete admits a single 1 MiB scalar.
  admitIdentity({ x: 'x'.repeat(1048576) });
  assert.throws(() => admitIdentity({ x: 'x'.repeat(1048577) }), denied);
  const plan = identityPlan(); plan.array(0, entry => { entry('x'.repeat(1048576)); entry('x'.repeat(1048569)); });
  assert.throws(() => identityPlan().array(0, entry => { entry('x'.repeat(1048576)); entry('x'.repeat(1048576)); }), denied);
});

for (const dimension of ['connections', 'pools', 'perPool', 'total']) test(`actual semantic ${dimension} exact/+1: no partial prefix`, () => {
  const a = empty();
  if (dimension === 'connections') a.connections = Array.from({ length: 128 }, (_, i) => ({ providerId: 'p' + i, enabled: true }));
  else if (dimension === 'pools') for (let i = 0; i < 128; i++) a.pools['p' + i] = { keys: [], states: {}, hasAttachment: false };
  else for (let i = 0; i < (dimension === 'total' ? 4 : 1); i++) a.pools['p' + i] = { keys: Array.from({ length: 256 }, (_, j) => `oauth/p${i}/k${j}`), states: {}, hasAttachment: true };
  const before = JSON.stringify(a); admitAdmission(a); assert.equal(JSON.stringify(a), before);
  if (dimension === 'connections') a.connections.push({ providerId: 'overflow', enabled: true });
  else if (dimension === 'pools') a.pools.overflow = { keys: [], states: {}, hasAttachment: false };
  else if (dimension === 'perPool') a.pools.p0.keys.push('oauth/p0/overflow');
  else a.pools.overflow = { keys: ['oauth/overflow/key'], states: {}, hasAttachment: true };
  assert.throws(() => admitAdmission(a), denied);
});

test('real SQL metadata preflight rejects a late oversized row before ANY value load', t => {
  const { sql } = sqliteFixture(t); sql.exec('CREATE TABLE fixture_records (value TEXT)');
  sql.exec('INSERT INTO fixture_records VALUES (?)', '{"ok":1}');
  sql.exec('INSERT INTO fixture_records VALUES (?)', ' '.repeat(1048575) + '{}');
  const trace = [], wrapped = { exec(query, ...values) { trace.push(query); return sql.exec(query, ...values); } };
  assert.throws(() => identitySqlRows(wrapped, 'SELECT value FROM fixture_records', [], identitySourceBudget()), denied);
  assert.equal(trace.length, 1); assert.match(trace[0], /count\(\*\).*length\(CAST\(value AS BLOB\)\)/);
  sql.exec('DELETE FROM fixture_records');
  for (let i = 0; i < 3; i++) sql.exec('INSERT INTO fixture_records VALUES (?)', ' '.repeat(800000) + '{}');
  trace.length = 0;
  assert.throws(() => identitySqlRows(wrapped, 'SELECT value FROM fixture_records', [], identitySourceBudget()), denied);
  assert.equal(trace.length, 1);
});

test('canonical SQL unknown fields and >64 KiB legacy revision stay complete and byte-identical', async () => {
  const f = await admissionFixture(), revision = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: 'rule-' + i, match: 'nonmatching-' + 'x'.repeat(60), groups: [] })));
  assert.ok(revision.length > 65536);
  const raw = '{"enabled":true,"groups":[],"assignmentRevision":' + JSON.stringify(revision) + ',"unknown":{"__proto__":{"kept":true},"candidates":[1,2]}}';
  f.authority.sql.exec('UPDATE access_users SET user_json = ? WHERE email = ?', raw, f.credential.principalId);
  const identity = await authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]);
  assert.equal(proxyAdmission(identity).owner.record.assignmentRevision, revision);
  assert.equal(Object.hasOwn(proxyAdmission(identity).owner.record.unknown, '__proto__'), true);
  assert.equal([...f.authority.sql.exec('SELECT user_json FROM access_users WHERE email = ?', f.credential.principalId)][0].user_json, raw);
});

test('ordinary malformed policy remains unavailable; genuine capacity failure never takes that fallback', async () => {
  const f = await admissionFixture();
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', '{invalid', 'fixture');
  await assert.rejects(authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]), /admission policy resolution failed/);
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', ' '.repeat(1048575) + '{}', 'fixture');
  await assert.rejects(authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]), denied);
  assert.equal(isIdentityFailure(Object.assign(Error('synthetic'), { status: 503, code: 'identity_admission_unavailable' })), false);
});

test('effective policy counts complete unknown override fields and preserves OWN zero/null before atomic refresh', async () => {
  const f = await admissionFixture(), p = providerById('anthropic'), endpoint = p.endpoints.find(e => e.id === 'messages');
  const policy = { ...f.policy, budgetScope: 'principal', dailyBudgetMicros: 9, weeklyBudgetMicros: 8 };
  const overrides = { fixture: { dailyBudgetMicros: 0, weeklyBudgetMicros: null, unknown: { kept: true } } };
  const effective = admittedEffectivePolicy('fixture', policy, overrides);
  assert.equal(effective.dailyBudgetMicros, 0); assert.equal(effective.weeklyBudgetMicros, null); assert.equal(effective.budgetOverride, overrides.fixture);
  const auth = await authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]);
  const previous = { policy: auth.policy, admission: proxyAdmission(auth), principal: auth.principalId, tiers: auth.serviceTiers };
  const huge = { ...policy, metadata: 'x'.repeat(1048576) };
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', JSON.stringify(huge), 'fixture');
  await assert.rejects(admittedGrantSelection(auth, f.env, { provider: p, endpoint, mode: 'http', model: 'claude-sonnet-5' }, new Set(['oauth/fixture/excluded'])), denied);
  assert.equal(auth.policy, previous.policy); assert.equal(proxyAdmission(auth), previous.admission);
  assert.equal(auth.principalId, previous.principal); assert.equal(auth.serviceTiers, previous.tiers);
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', JSON.stringify(policy), 'fixture');
  await admittedGrantSelection(auth, f.env, { provider: p, endpoint, mode: 'http', model: 'claude-sonnet-5' }, new Set(['oauth/fixture/excluded']));
  assert.notEqual(auth.policy, previous.policy); assert.notEqual(proxyAdmission(auth), previous.admission);
});

test('admission colo capacity failure is terminal; ordinary cache error remains a miss', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'caches', prior); else delete globalThis.caches; });
  let mode = 'healthy'; const value = empty();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: { async match() {
    if (mode === 'ordinary') throw Error('ordinary cache miss');
    return accessBytesResponse(JSON.stringify({ version: 1, fetchedAt: Date.now(), value, ignored: mode === 'overflow' ? 'x'.repeat(2097152) : '' }), '');
  } } } });
  const config = { maxAgeMs: 60000, freshMs: 10000 };
  assert.deepEqual((await coloGet('admission', 'fixture', config)).value, value);
  mode = 'overflow'; await assert.rejects(coloGet('admission', 'fixture', config), denied);
  mode = 'ordinary'; assert.equal(await coloGet('admission', 'fixture', config), undefined);
});

test('ORIGINAL byte source, split UTF8/BOM and escaped input keep independent wire/text accounting', async () => {
  const raw = '\ufeff{"value":"é","unknown":"\\ud800"}', budget = identitySourceBudget();
  const value = await readIdentityKv(() => Promise.resolve(accessBytesResponse(raw, '').body), budget);
  assert.equal(value.value, 'é'); assert.equal(value.unknown.charCodeAt(0), 0xd800);
  assert.equal(budget.bytes, Buffer.byteLength(raw)); assert.equal(budget.text, raw.length - 1);
});

test('FIRST cancellation rejection including undefined is joined; unlock is attempted once', async t => {
  let release, arrive; const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { arrive = resolve; });
  let cancels = 0, unlocks = 0, done = false;
  const original = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123])); } });
  const get = original.getReader.bind(original); original.getReader = options => {
    const reader = get(options), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.cancel = (...args) => { cancels++; return cancel(...args).then(async () => { arrive(); await held; throw undefined; }); };
    reader.releaseLock = () => { unlocks++; unlock(); }; return reader;
  };
  const outcomes = []; t.after(async () => { release(); const errors = []; for (const result of await Promise.all(outcomes)) if (result.failed) errors.push(result.error); if (errors.length) throw new AggregateError(errors, 'independent fixture cleanup'); });
  const actual = readIdentityResponse(() => Promise.resolve(new Response(original)));
  const verdict = assert.rejects(actual, error => { denied(error); assert.match(error.message, /cleanup/); return true; });
  outcomes.push(verdict.then(() => ({ failed: false }), error => ({ failed: true, error })));
  void actual.then(() => { done = true; }, () => { done = true; });
  await Promise.race([entered, actual.then(() => { throw Error("premature fulfillment"); }, error => { throw error; })]);
  assert.equal(done, false); release(); await verdict;
  assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(original.locked, false);
});

test('malformed discarded source still charges processed occurrences before ordinary fallback', () => {
  const budget = identitySourceBudget(), raw = '{' + '"x":0,'.repeat(100) + 'invalid';
  assert.throws(() => parse(raw, 'record', budget), SyntaxError);
  assert.equal(budget.members, 101); assert.equal(budget.values, 101);
  assert.equal(budget.text, raw.length); assert.equal(budget.bytes, Buffer.byteLength(raw));
  parse('{}', 'record', budget); assert.equal(budget.containers, 2);
});

test('late source denial commits no staged cold imports; concurrent canonical winner remains authoritative', async () => {
  const f = await admissionFixture();
  f.authority.sql.exec('DELETE FROM proxy_credentials');
  f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', 'credentials_global_initialized');
  f.records.set('credentials/fixture', f.credential);
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', ' '.repeat(1048576) + '{}', 'fixture');
  await assert.rejects(f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] }), denied);
  assert.equal([...f.authority.sql.exec('SELECT count(*) AS n FROM proxy_credentials')][0].n, 0);
  const winner = { ...f.credential, enabled: false };
  f.beforeRead(key => {
    assert.equal(key, 'credentials/fixture');
    f.authority.sql.exec('INSERT INTO proxy_credentials (credential_id, credential_json) VALUES (?, ?)', 'fixture', JSON.stringify(winner));
  });
  f.records.set('credentials/fixture', { enabled: 'invalid but ignored' });
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', JSON.stringify(f.policy), 'fixture');
  const admission = await f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] });
  assert.deepEqual(admission.credential.credential, winner);
  assert.equal([...f.authority.sql.exec('SELECT credential_json FROM proxy_credentials')][0].credential_json, JSON.stringify(winner));
});

test('existing 98/99 business guard remains narrower than semantic pool profile; no prefix success', async () => {
  const f = await admissionFixture(), input = { providerId: 'anthropic', policyId: 'fixture', tenantId: 'fixture', defaultKeys: Array.from({ length: 98 }, (_, i) => `oauth/fixture/k${i}`) };
  const pool = await f.call('/grant-pools/resolve', input);
  assert.deepEqual(pool.keys, input.defaultKeys);
  input.defaultKeys.push('oauth/fixture/k98');
  await assert.rejects(f.call('/grant-pools/resolve', input), error => !isIdentityFailure(error));
  input.defaultKeys = Array.from({ length: 257 }, (_, i) => `oauth/fixture/k${i}`);
  await assert.rejects(f.call('/grant-pools/resolve', input), denied);
  assert.equal([...f.authority.sql.exec('SELECT count(*) AS n FROM upstream_grant_selection')][0].n, 0);
});

test('historical selection metadata is admitted before values and counter/cursor writes', async () => {
  const f = await admissionFixture(), poolKey = 'anthropic/fixture/fixture';
  f.authority.sql.exec('INSERT INTO upstream_grant_selection (pool_key, grant_key, selected_count, last_selected_ms) VALUES (?, ?, 1, 0)', poolKey, 'x'.repeat(1048576));
  const original = f.authority.sql.exec, trace = [];
  f.authority.sql.exec = function(query, ...values) { trace.push(query); return original.call(this, query, ...values); };
  try {
    await assert.rejects(f.call('/grant-pools/select', { poolKey, strategy: 'round_robin', candidates: [{ key: 'oauth/fixture/anthropic', weight: 1 }] }), denied);
    assert.ok(trace.some(query => query.startsWith('SELECT count(*)') && query.includes('upstream_grant_selection')));
    assert.equal(trace.some(query => query.startsWith('SELECT json_object') && query.includes('upstream_grant_selection')), false);
    assert.equal(trace.some(query => /^(INSERT|UPDATE)/.test(query)), false);
  } finally { f.authority.sql.exec = original; }
});


test('canonical null credential remains a present malformed row, never a cold missing-key import', async () => {
  const f = await admissionFixture();
  f.authority.sql.exec('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?', 'null', 'fixture');
  f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', 'credentials_global_initialized');
  let reads = 0; f.beforeRead(() => { reads++; }); f.records.set('credentials/fixture', f.credential);
  await assert.rejects(f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] }), error => !isIdentityFailure(error));
  assert.equal(reads, 0); assert.equal([...f.authority.sql.exec('SELECT credential_json FROM proxy_credentials')][0].credential_json, 'null');
});

for (const [position, wrap] of [
  ['credential', raw => '{"credential":{"credential":' + raw + '}}'],
  ['policy', raw => '{"policy":{"policy":' + raw + '}}'],
  ['owner', raw => '{"owner":{"record":' + raw + '}}'],
  ['connection', raw => '{"connections":[' + raw + ']}'],
  ['grant reply', raw => '{"grant":' + raw + '}'],
  ['selected grant', raw => '{"selection":{"selected":{"grant":' + raw + '}}}'],
  ['snapshot grant', raw => '{"snapshots":{"p":{"candidates":[{"grant":' + raw + '}]}}}'],
]) test(`embedded ${position}: record limit before JSON.parse under the complete-envelope limit`, async t => {
  const raw = wrap('{"a":"' + 'x'.repeat(600000) + '","b":"' + 'y'.repeat(600000) + '"}');
  assert.ok(Buffer.byteLength(raw) < 2097152);
  const original = JSON.parse; let parses = 0;
  t.mock.method(JSON, 'parse', (...args) => { parses++; return original(...args); });
  await assert.rejects(readIdentityResponse(() => Promise.resolve(accessBytesResponse(raw, '')), undefined, undefined, undefined, position === 'grant reply' ? 'grant' : 'identity'), denied);
  assert.equal(parses, 0);
});

test('embedded raw occurrences include discarded records and duplicate members; unknown names stay generic', async () => {
  const read = (raw, envelope = 'identity') => readIdentityResponse(() => Promise.resolve(accessBytesResponse(raw, '')), undefined, undefined, undefined, envelope);
  const duplicates = '{' + '"x":0,'.repeat(32768) + '"x":1}';
  await assert.rejects(read('{"owner":{"record":' + duplicates + ',"record":{}}}'), denied);
  const array = '[' + '0,'.repeat(16384) + '0]';
  await assert.rejects(read('{"grant":{"values":' + array + '}}', 'grant'), denied);
  await assert.rejects(read('{"grant":' + '['.repeat(17) + '0' + ']'.repeat(17) + '}', 'grant'), denied);
  const unknown = await read('{"unknown":{"owner":{"record":{"a":"' + 'x'.repeat(600000) + '","b":"' + 'y'.repeat(600000) + '"}}}}');
  assert.equal(unknown.unknown.owner.record.a.length, 600000);
  const raw = '{"x":"' + 'x'.repeat(1048568) + '"}';
  assert.equal(Buffer.byteLength(raw), 1048576);
  assert.equal((await read('{"grant":' + raw + '}', 'grant')).grant.x.length, 1048568);
  await assert.rejects(read('{"grant":' + raw.slice(0, -1) + ' } }', 'grant'), denied);
});

test('closed envelope selection guards materialization records, not similarly named unknown fields', async () => {
  const record = '{"a":"' + 'x'.repeat(600000) + '","b":"' + 'y'.repeat(600000) + '"}';
  const read = (raw, envelope) => readIdentityResponse(() => Promise.resolve(accessBytesResponse(raw, '')), undefined, undefined, undefined, envelope);
  assert.equal((await read('{"grant":' + record + '}', 'identity')).grant.a.length, 600000);
  assert.equal((await read('{"owner":{"record":' + record + '}}', 'generic')).owner.record.b.length, 600000);
  for (const key of ['grant', 'legacy']) {
    const request = new Request('https://fixture.example/materialize', { method: 'POST', headers: { 'x-clawrouter-identity-admission': 'v1' },
      body: accessBytesResponse('{"' + key + '":' + record + '}', '').body, duplex: 'half' });
    await assert.rejects(readIdentityRequest(request, true), denied);
    assert.equal(request.body.locked, false);
  }
});

test('embedded ORIGINAL wire offsets preserve BOM/replacement/split UTF8 without re-encoding as source bytes', async () => {
  const prefix = Buffer.from('\ufeff{"unknown":"😀","grant":{"x":"'), suffix = Buffer.from('"}}');
  const bytes = Buffer.concat([prefix, Buffer.alloc(1048568, 0x80), suffix]);
  const value = await readIdentityResponse(() => Promise.resolve(accessBytesResponse(bytes, '')), undefined, undefined, undefined, 'grant');
  assert.equal(value.unknown, '😀'); assert.equal(value.grant.x.length, 1048568);
  assert.equal(value.grant.x.charCodeAt(0), 0xfffd);
  // Raw source admission is distinct from prospective reserialization/copy.
  assert.throws(() => admitIdentity(value.grant, 'record'), denied);
});

test('admission colo embedded oversize is terminal; bodyless and empty-byte malformed entries are ordinary misses', async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'caches', prior); else delete globalThis.caches; });
  const config = { maxAgeMs: 60000, freshMs: 10000 }; let mode = 'null';
  const value = { ...empty(), owner: { email: 'fixture@example.invalid', record: { a: 'x'.repeat(600000), b: 'y'.repeat(600000) } } };
  const raw = JSON.stringify({ version: 1, fetchedAt: Date.now(), value }); assert.ok(Buffer.byteLength(raw) < 2097152);
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: { async match() {
    return mode === 'null' ? new Response(null) : accessBytesResponse(mode === 'empty' ? '' : raw, '');
  } } } });
  assert.equal(await coloGet('admission', 'fixture', config), undefined);
  mode = 'empty'; assert.equal(await coloGet('admission', 'fixture', config), undefined);
  mode = 'oversize'; await assert.rejects(coloGet('admission', 'fixture', config), denied);
  assert.throws(() => admitAdmission(value), denied);
});


test('FINAL combined refresh denial: admitted new principal, tiers and policy leave EVERY old published field intact', async () => {
  const f = await admissionFixture(), provider = providerById('anthropic'), endpoint = provider.endpoints.find(e => e.id === 'messages');
  const auth = await authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]);
  // Labelled request-owned unknown fields. Each old identity and refresh reply
  // fits independently; only their actual final replacement exceeds 2 MiB.
  auth.retainedFixtureA = 'a'.repeat(900000); auth.retainedFixtureB = 'b'.repeat(900000); admitIdentity(auth);
  const oldFields = { ...auth }, oldAdmission = proxyAdmission(auth);
  const policy = { ...f.policy, metadata: 'p'.repeat(400000) };
  const credential = { ...f.credential, principalId: 'new-owner@example.com', serviceTiers: ['default'] };
  f.authority.sql.exec('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?', JSON.stringify(policy), 'fixture');
  f.authority.sql.exec('UPDATE proxy_credentials SET credential_json = ? WHERE credential_id = ?', JSON.stringify(credential), 'fixture');
  f.authority.sql.exec('INSERT INTO access_users (email,user_json) VALUES (?,?)', credential.principalId, '{"enabled":true}');
  const input = { credentialId: 'fixture', secretSha256: credential.secretSha256, providers: [admissionProvider],
    selection: { providerId: provider.id, endpointId: endpoint.id, mode: 'http', model: 'claude-sonnet-5', catalogModelId: 'anthropic/claude-sonnet-5', capability: 'llm.messages', excludedKeys: ['oauth/fixture/excluded'] } };
  const refresh = await f.call('/admission/resolve', input); admitAdmission(refresh);
  const next = { serviceTiers: refresh.credential.credential.serviceTiers, principalId: refresh.credential.credential.principalId,
    policyId: refresh.policy.policyId, policy: admittedEffectivePolicy(refresh.policy.policyId, refresh.policy.policy, refresh.owner?.record.budgetOverrides) };
  admitIdentity(next); assert.notEqual(next.principalId, oldFields.principalId); assert.notDeepEqual(next.serviceTiers, oldFields.serviceTiers);
  assert.equal(next.policy.metadata, policy.metadata);
  assert.throws(() => admitIdentity({ ...auth, ...next }), denied);
  await assert.rejects(admittedGrantSelection(auth, f.env, { provider, endpoint, mode: 'http', model: 'claude-sonnet-5' }, new Set(input.selection.excludedKeys)), denied);
  assert.deepEqual(Object.keys(auth), Object.keys(oldFields));
  for (const key of Object.keys(oldFields)) assert.equal(auth[key], oldFields[key], 'unpublished field: ' + key);
  assert.equal(proxyAdmission(auth), oldAdmission);
  auth.retainedFixtureB = ''; // Same canonical refresh now fits the final representation.
  await admittedGrantSelection(auth, f.env, { provider, endpoint, mode: 'http', model: 'claude-sonnet-5' }, new Set(input.selection.excludedKeys));
  assert.equal(auth.principalId, credential.principalId); assert.deepEqual(auth.serviceTiers, credential.serviceTiers);
  assert.equal(auth.policy.metadata, policy.metadata); assert.notEqual(proxyAdmission(auth), oldAdmission);
});

const protoRouting = mode => JSON.parse('{' + [
  ...(mode !== 'shared' ? ['"eligibleGrants":{"__proto__":["token"],"anthropic":["anthropic"]}'] : []),
  ...(mode !== 'eligible' ? ['"sharedGrants":{"__proto__":' + JSON.stringify(Array.from({ length: 32 }, (_, i) => 'oauth/shared/k' + i)) + ',"anthropic":["oauth/shared/later"]}'] : []),
].join(',') + '}');
for (const mode of ['eligible', 'shared', 'both']) test('fresh routing dictionary canonicalization at actual cold SQL admission: ' + mode, async () => {
  const { normalizePolicyRecord } = await import('../authority-policy.ts');
  const f = await admissionFixture(), raw = { ...f.policy, grantRouting: protoRouting(mode) }, before = JSON.stringify(raw);
  const expected = JSON.stringify(normalizePolicyRecord(raw, false));
  f.authority.sql.exec('DELETE FROM access_policies');
  f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', 'policies_global_initialized');
  f.records.set('policies/fixture', raw);
  const admission = await f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] });
  assert.equal(JSON.stringify(admission.policy.policy), expected);
  assert.equal([...f.authority.sql.exec('SELECT policy_json FROM access_policies WHERE policy_id = ?', 'fixture')][0].policy_json, expected);
  assert.equal(JSON.stringify(raw), before); assert.equal(Object.hasOwn(raw.grantRouting[mode === 'shared' ? 'sharedGrants' : 'eligibleGrants'], '__proto__'), true);
  if (mode !== 'eligible') assert.deepEqual(admission.policy.policy.grantRouting.sharedGrants.anthropic, [], 'prototype references consumed all 32 slots before the later own provider');
  if (mode !== 'shared') assert.deepEqual(admission.policy.policy.grantRouting.eligibleGrants.anthropic, ['anthropic']);
});

test('cold routing canonical winner and prototype-only omission preserve normalizer bytes; generic prototypes remain rejected', async () => {
  const { normalizePolicyRecord } = await import('../authority-policy.ts');
  const f = await admissionFixture(), raw = { ...f.policy, grantRouting: JSON.parse('{"sharedGrants":{"__proto__":["oauth/shared/token"]}}') }, before = JSON.stringify(raw);
  const expected = normalizePolicyRecord(raw, false); assert.equal(Object.hasOwn(expected.grantRouting, 'sharedGrants'), false);
  f.authority.sql.exec('DELETE FROM access_policies'); f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', 'policies_global_initialized');
  f.records.set('policies/fixture', raw);
  let admission = await f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] });
  assert.equal(JSON.stringify(admission.policy.policy), JSON.stringify(expected)); assert.equal(JSON.stringify(raw), before);
  f.authority.sql.exec('DELETE FROM access_policies'); f.authority.sql.exec('DELETE FROM policy_binding_meta WHERE meta_key = ?', 'policies_global_initialized');
  const winner = { ...f.policy, unknown: { kept: true } }, winnerBytes = JSON.stringify(winner);
  f.beforeRead(key => { assert.equal(key, 'policies/fixture'); f.authority.sql.exec('INSERT INTO access_policies (policy_id,policy_json) VALUES (?,?)', 'fixture', winnerBytes); });
  admission = await f.call('/admission/resolve', { credentialId: 'fixture', secretSha256: f.credential.secretSha256, providers: [admissionProvider] });
  assert.deepEqual(admission.policy.policy, winner); assert.equal(JSON.stringify(raw), before);
  assert.equal([...f.authority.sql.exec('SELECT policy_json FROM access_policies WHERE policy_id = ?', 'fixture')][0].policy_json, winnerBytes);
  for (const prototype of [[], { unexpected: true }]) {
    const borrowed = Object.setPrototypeOf({ own: 'kept' }, prototype);
    assert.throws(() => admitIdentity({ grantRouting: { eligibleGrants: borrowed } }), denied);
    assert.equal(Object.getPrototypeOf(borrowed), prototype); assert.equal(borrowed.own, 'kept');
  }
});

for (const copilot of [false, true]) test('actual selection double-normalization preserves fresh routing output: ' + (copilot ? 'Copilot' : 'generic'), async () => {
  const { resolveGrantSelection, selectCopilotPublicGrant } = await import('../grant-selection.ts');
  const provider = copilot ? 'github-copilot' : 'anthropic', key = 'oauth/fixture/token';
  const grant = copilot ? { provider, enabled: true, kind: 'oauth', credentialStore: 'durable_object', credentialStatus: 'reauth_required', credentialGeneration: 3, credentialLineage: 'original-lineage-fixture' }
    : { provider, enabled: true, kind: 'api_key', credential: 'synthetic-token' };
  const routing = protoRouting('both'); routing.eligibleGrants[provider] = ['token'];
  const before = JSON.stringify(routing), calls = [];
  const env = { ACCESS_CONTROL: { idFromName: name => name, get: () => ({ async fetch(url, init) {
    const path = new URL(url).pathname, input = JSON.parse(init.body); calls.push(path);
    if (path === '/grant-pools/select') { assert.deepEqual(input.candidates.map(row => row.key), [key]); return accessBytesResponse(JSON.stringify({ selectedKey: key }), ''); }
    assert.equal(path, '/grant-pools/resolve'); return accessBytesResponse(JSON.stringify({ keys: [key], states: {} }), '');
  } }) }, POLICY_KV: { async get(requested, type) { assert.equal(type, 'stream'); return requested === key ? accessBytesResponse(JSON.stringify(grant), '').body : null; } } };
  const selected = copilot ? await selectCopilotPublicGrant('fixture', { grantRouting: routing }, env, 'token')
    : (await resolveGrantSelection(provider, 'fixture', 'default', 'token', env, new Set(), routing)).selected;
  assert.equal(selected.key, key); assert.deepEqual(selected.grant, grant); assert.equal(JSON.stringify(routing), before);
  assert.deepEqual(calls, ['/grant-pools/resolve', '/grant-pools/select']);
});


for (const failure of ['record-limit', 'ordinary-selection']) test('PUBLIC alternate identity admission: ' + failure, async t => {
  const { fixture } = await import('./http-continuation-fixture.mjs');
  const { default: handler } = await import('../index.ts');
  const f = await fixture(t, true, { limit: 1000000, fixedCost: 7 });
  // This Node namespace CONSTRUCTS its own Request/Response bodies. Make those
  // selected synthetic producers explicit bytes; actual Workerd bodies stay original.
  const kvGet = f.env.POLICY_KV.get.bind(f.env.POLICY_KV);
  f.env.POLICY_KV.get = async (key, type) => {
    const value = await kvGet(key, type);
    return type === 'stream' && value !== null ? accessBytesResponse(JSON.stringify(value), '').body : value;
  };
  const get = f.env.ACCESS_CONTROL.get.bind(f.env.ACCESS_CONTROL);
  f.env.ACCESS_CONTROL.get = name => {
    const stub = get(name);
    return { ...stub, async fetch(url, init) {
      if (!new Headers(init?.headers).has('x-clawrouter-identity-admission')) return stub.fetch(url, init);
      // Inspect the existing serialized input before constructing its BYOB-only body.
      if (new URL(url).pathname === '/admission/resolve' && JSON.parse(init.body).selection?.excludedKeys?.length) {
        alternateCalls++;
        if (failure === 'ordinary-selection') return accessBytesResponse(JSON.stringify({ error: { code: 'authority_error', message: 'synthetic ordinary selection failure' } }), '', { status: 500 });
      }
      const response = await stub.fetch(url, { ...init, body: accessBytesResponse(init.body, '').body, duplex: 'half' });
      return accessBytesResponse(await response.text(), '', { status: response.status, headers: response.headers });
    } };
  };
  const namespace = f.env.BUDGET_LEDGER, budgetGet = namespace.get.bind(namespace), originalIds = [], dispatchedIds = [], settledIds = [];
  namespace.get = name => {
    const stub = budgetGet(name);
    return { ...stub, async fetch(url, init) {
      const path = new URL(url).pathname, body = JSON.parse(init.body);
      if (path === '/reserve') originalIds.push(body.reservationId);
      if (path === '/dispatch') dispatchedIds.push(body.reservationId);
      if (path === '/settle') settledIds.push(body.reservationId);
      return stub.fetch(url, init);
    } };
  };
  const sql = f.env.ACCESS_CONTROL.objects.get('policy-bindings').db;
  let alternateCalls = 0, response, consume;
  const requestId = 'identity-alternate-' + failure;
  let hasPrimary = false, primary; const roots = [];
  const track = actual => { roots.push(Promise.resolve(actual).then(() => ({ failed: false }), error => ({ failed: true, error }))); return actual; };
  const body = () => consume ??= track(response.text());
  t.after(async () => {
    const errors = [];
    if (response) try { await body(); } catch (error) { errors.push(error); }
    let index = 0;
    while (index < roots.length) { const batch = roots.slice(index); index = roots.length; for (const outcome of await Promise.all(batch)) if (outcome.failed) errors.push(outcome.error); }
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'primary and independent public fixture roots');
  });
  f.response = request => {
    assert.equal(originalIds.length, 2);
    if (failure === 'record-limit') {
      const raw = JSON.stringify({ ...f.policy, unknownA: 'a'.repeat(600000), unknownB: 'b'.repeat(600000) });
      assert.ok(Buffer.byteLength(raw) > 1048576 && Buffer.byteLength(raw) < 2097152);
      // Real canonical source changes AFTER the one original provider request.
      sql.prepare('UPDATE access_policies SET policy_json = ? WHERE policy_id = ?').run(raw, 'fixture');
    }
    return Response.json({ error: 'original nonbillable rejection' }, { status: 429 });
  };
  try {
    response = await track(handler.fetch(new Request('https://router.example/v1/responses', { method: 'POST',
      headers: { authorization: 'Bearer clawrouter-live-fixture-fixture-secret', 'content-type': 'application/json', 'x-request-id': requestId },
      body: JSON.stringify({ model: 'openai/gpt-6-astra', input: 'fixture' }),
    }), f.env, { waitUntil: track }));
    const text = await body(); let index = 0;
    while (index < roots.length) { const batch = roots.slice(index); index = roots.length; for (const outcome of await Promise.all(batch)) if (outcome.failed) throw outcome.error; }
    assert.equal(response.status, failure === 'record-limit' ? 503 : 429);
    const value = JSON.parse(text);
    if (failure === 'record-limit') assert.equal(value.error.code, 'identity_admission_unavailable');
    else assert.deepEqual(value, { error: 'original nonbillable rejection' });
    assert.equal(alternateCalls, 1); assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    const event = f.events[0]; assert.equal(event.actual_cost_micros, 0); assert.equal(event.status, failure === 'record-limit' ? 'provider_error' : 'client_error');
    assert.equal(event.request_id, response.headers.get('x-clawrouter-request-id'));
    assert.equal(event.request_id, requestId);
    assert.ok(event.request_id); assert.equal(new Set(originalIds).size, 2);
    assert.deepEqual([...dispatchedIds].sort(), [...originalIds].sort()); assert.deepEqual([...settledIds].sort(), [...originalIds].sort());
    const rows = ['default:fixture', 'provider:openai'].flatMap(owner => budgetGet(owner).reservations());
    assert.deepEqual(rows.map(row => row.reservation_id).sort(), [...originalIds].sort());
    for (const row of rows) { assert.equal(row.settled, 1); assert.equal(row.dispatch_started, 1); assert.equal(row.reserved_micros, 0); }
  } catch (error) { hasPrimary = true; primary = error; throw error; }
});


for (const dimension of ['count', 'bytes']) for (const overflow of [false, true]) test(`bodyless admission colo headers ${dimension} exact/+1: overflow=${overflow}`, async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'caches', prior); else delete globalThis.caches; });
  const headers = dimension === 'count' ? new Headers(Array.from({ length: overflow ? 33 : 32 }, (_, i) => ['x-' + i, 'v']))
    : new Headers({ x: 'v'.repeat(overflow ? 4096 : 4095) });
  if (dimension === 'count') assert.equal([...headers].length, overflow ? 33 : 32);
  else assert.equal([...headers].reduce((n, [key, value]) => n + Buffer.byteLength(key) + Buffer.byteLength(value), 0), overflow ? 4097 : 4096);
  let lookups = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: { async match() { lookups++; return new Response(null, { headers }); } } } });
  const f = await admissionFixture(); f.env.CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS = '60';
  const { clearHotCaches } = await import('../hot-cache.ts'); clearHotCaches();
  const work = authenticateProxyKey(new Headers(admissionHeaders), f.env, [admissionProvider]);
  if (overflow) {
    await assert.rejects(work, error => { denied(error); assert.match(error.message, /\(limit\)/); return true; });
    assert.equal(f.calls.length, 0, 'no authority rescue after genuine header capacity denial');
  } else {
    const identity = await work; assert.equal(identity.policyId, 'fixture');
    assert.ok(f.calls.includes('/admission/resolve'), 'within-limit bodyless cache remains an ordinary miss');
  }
  assert.equal(lookups, 1);
});
