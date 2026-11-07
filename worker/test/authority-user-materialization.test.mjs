import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { sqliteFixture } from './sqlite-storage.mjs';
const { PolicyBindingIndexObject, authorityCall, resolveUsers } = await import('../authority.ts');
const { parseAccessJson } = await import('../access-json.ts');
const { userRecordBudget, parseUserRecord, admitUserRecordBytes, userJsonText, admitUserJson,
  readUserKvRecord, readUserMaterializationRequest } = await import('../authority-user-materialization.ts');
const { evaluateUserAssignments } = await import('../assignment-evaluator.ts');
const marker = { 'x-clawrouter-user-materialization': 'v1' }, maximum = 2097152;
const email = 'source@example.invalid', raw = { role: 'user', tenantId: 'fixture', enabled: true, groups: [' A ', 'a'], contentRetentionDisabled: false };
const bytes = text => accessBytesResponse(text, '').body;
const denied = kind => error => { assert.equal(error.code, 'user_materialization_unavailable'); assert.equal(error.message, `User materialization failed (${kind})`); assert.equal(Object.hasOwn(error, 'cause'), false); return true; };
const request = (path, text, headers = marker) => new Request('https://clawrouter.internal' + path, { method: 'POST', headers, body: new Headers(headers).has('x-clawrouter-user-materialization') ? bytes(text) : text, duplex: 'half' });
function fixture(t) {
  const { db, sql } = sqliteFixture(t), trace = [], state = { writes: 0, failWrite: 0, reads: 0, beforeGet: null, calls: [] }, store = new Map();
  const owner = new PolicyBindingIndexObject({ storage: { sql: { exec(query, ...args) {
    trace.push(query.startsWith('SELECT length') ? 'size' : query.startsWith('SELECT user_json') ? 'value' : 'other');
    if (query.startsWith('INSERT OR REPLACE INTO access_users')) { state.writes++; if (state.failWrite === state.writes) throw Error('private SQL sentinel'); }
    return sql.exec(query, ...args);
  } } } });
  const call = (path, body, headers = marker) => owner.fetch(request(path, typeof body === 'string' ? body : JSON.stringify(body), headers));
  const env = { ACCESS_CONTROL: { idFromName: n => n, get: () => ({ fetch(url, init) { state.calls.push({ path: new URL(url).pathname, headers: init.headers }); return call(new URL(url).pathname, init.body, init.headers ?? {}); } }) },
    POLICY_KV: { async get(key, type) { assert.equal(type, 'stream'); state.reads++; const text = store.get(key); await state.beforeGet?.(); return text === undefined ? null : bytes(text); } } };
  const insert = (id, text) => db.prepare('INSERT OR REPLACE INTO access_users (email,user_json) VALUES (?,?)').run(id, text);
  const stored = id => db.prepare('SELECT user_json FROM access_users WHERE email=?').get(id)?.user_json;
  return { db, trace, state, store, call, env, insert, stored };
}

test('source scanner has separate cumulative original bytes/text/occurrences; Access profiles unchanged', () => {
  const budget = userRecordBudget(), text = '{"' + 'k'.repeat(1024) + '":"' + 'x'.repeat(300) + '","kid":"' + 'k'.repeat(300) + '","n":"' + 'n'.repeat(1400) + '"}';
  admitUserRecordBytes(budget, Buffer.byteLength(text)); assert.equal(parseUserRecord(text, budget).kid.length, 300);
  assert.throws(() => parseAccessJson(text, 'jwks'));
  const padded = ' '.repeat(maximum - 2) + '{}', exact = userRecordBudget();
  admitUserRecordBytes(exact, maximum); assert.deepEqual(parseUserRecord(padded, exact), {});
  assert.throws(() => admitUserRecordBytes(exact, 1), denied('limit'));
  assert.throws(() => parseUserRecord('{}', exact), denied('limit'));
  const shared = userRecordBudget();
  parseUserRecord('{' + '"a":0,'.repeat(4095) + '"a":0}', shared);
  parseUserRecord('{' + '"a":0,'.repeat(4095) + '"a":0}', shared);
  assert.throws(() => parseUserRecord('{"a":0}', shared), denied('limit'));
  const duplicates = '{"emails":[' + '"a@b",'.repeat(4095) + '"a@b"],"emails":["a@b"]}';
  assert.throws(() => parseAccessJson(duplicates, 'user_query'), error => error.code === 'access_limit');
  assert.throws(() => parseAccessJson('[{"email":"' + 'x'.repeat(1025) + '","email":"a@b"}]', 'user_init'), error => error.code === 'access_limit');
});

test('pre-serialization counts exact escaping and UTF8 independently, before copying raw emails', () => {
  const exact = 'x'.repeat(1048574); assert.equal(userJsonText(exact, 'complete').length, 1048576);
  assert.throws(() => userJsonText(exact + 'x', 'complete'), denied('limit'));
  assert.throws(() => userJsonText('é'.repeat(524288), 'complete'), denied('limit'));
  assert.throws(() => userJsonText('\0'.repeat(174763), 'complete'), denied('limit'));
  assert.throws(() => userJsonText({ emails: ['x'.repeat(1025)] }, 'query'), denied('limit'));
  assert.doesNotThrow(() => admitUserJson({ emails: Array(4096).fill('x@y') }, 'query'));
  assert.throws(() => admitUserJson({ emails: Array(4097).fill('x@y') }, 'query'), denied('limit'));
  for (const value of [null, false, 0, { x: '\ud800', y: '😀', missing: undefined }, [undefined, Infinity]]) assert.equal(userJsonText(value, 'complete'), JSON.stringify(value));
  let calls = 0; assert.throws(() => userJsonText({ toJSON() { calls++; return {}; } }, 'query'), denied('protocol')); assert.equal(calls, 0);
});

test('private marker rejects unsupported versions/paths; default query only; generic init remains untouched', async t => {
  const f = fixture(t);
  for (const [path, headers] of [['/users/list', marker], ['/users/initialize-all', marker], ['/users/resolve', { 'x-clawrouter-user-materialization': 'v2' }]]) {
    const r = await f.call(path, '{', headers); assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'user_materialization_unavailable');
  }
  assert.equal((await f.call('/users/initialize', [{ email, record: raw }], {})).status, 200);
  assert.deepEqual((await authorityCall(f.env, '/users/resolve', { emails: [email] })).users.map(x => x.email), [email]);
  assert.deepEqual(f.state.calls.at(-1).headers, marker);
  await authorityCall(f.env, '/users/resolve', { emails: [email] }, 'other'); assert.equal(f.state.calls.at(-1).headers, undefined);
  assert.equal((await f.call('/users/initialize-all', [], {})).status, 200);
});

test('cold KV winner/current canonical, normalization order, malformed canonical and all-before-insert', async t => {
  const f = fixture(t); f.store.set('access/users/' + email, JSON.stringify({ groups: [42] }));
  f.state.beforeGet = async () => { f.state.beforeGet = null; f.insert(email, JSON.stringify({ ...raw, enabled: false, extra: { kept: true } })); };
  const users = await resolveUsers(f.env, [' SOURCE@example.invalid ', email, 'invalid']);
  assert.deepEqual(users.map(x => x.email), [email]); assert.equal(users[0].record.enabled, false); assert.equal(users[0].record.extra.kept, true);
  assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0); assert.equal(f.state.calls.filter(x => x.path === '/users/initialize').length, 1);
  const first = 'first@example.invalid';
  let r = await f.call('/users/initialize', [{ email: first, record: raw }, { email: first, record: { groups: [42] } }]);
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(f.stored(first)).groups, ['a', 'a']);
  const before = f.state.writes;
  r = await f.call('/users/initialize', [{ email: 'new@example.invalid', record: raw }, { email: 'bad@example.invalid', record: { groups: [42] } }]);
  assert.equal(r.status, 503); assert.equal(f.state.writes, before); assert.equal(f.stored('new@example.invalid'), undefined);
  f.insert('broken@example.invalid', '{');
  r = await f.call('/users/initialize', [{ email: 'new@example.invalid', record: raw }, { email: 'broken@example.invalid', record: raw }]);
  assert.equal(r.status, 503); assert.equal(f.state.writes, before);
  f.insert('null@example.invalid', 'null'); r = await f.call('/users/initialize', [{ email: 'null@example.invalid', record: { groups: [42] } }]);
  assert.equal(r.status, 200); assert.equal(f.stored('null@example.invalid'), 'null');
});

test('SQL metadata precedes values; aggregate source/query output/batch preflight and partial SQL uncertainty', async t => {
  const f = fixture(t); f.insert(email, ' '.repeat(maximum) + '{}'); f.trace.length = 0;
  let r = await f.call('/users/resolve', { emails: [email] }); assert.equal(r.status, 503); assert.deepEqual(f.trace.filter(x => x !== 'other'), ['size']);
  for (const [id, count] of [['a@b', 1100000], ['c@d', 1000000]]) f.insert(id, ' '.repeat(count) + '{}');
  r = await f.call('/users/initialize', [{ email: 'new@b', record: raw }, { email: 'a@b', record: raw }, { email: 'c@d', record: raw }]);
  assert.equal(r.status, 503); assert.equal(f.state.writes, 0);
  r = await f.call('/users/initialize', [{ email: 'new@b', record: raw }, { email: 'big@b', record: { ...raw, assignmentState: { revision: 'x'.repeat(1048576) } } }]);
  assert.equal(r.status, 503); assert.equal(f.state.writes, 0);
  f.insert(email, JSON.stringify({ ...raw, extra: 'x'.repeat(1048576) }));
  r = await f.call('/users/resolve', { emails: [email] }); assert.equal(r.status, 503);
  f.state.failWrite = 2;
  r = await f.call('/users/initialize', [{ email: 'one@b', record: raw }, { email: 'two@b', record: raw }]);
  assert.equal(r.status, 503); assert.ok(f.stored('one@b')); assert.equal(f.stored('two@b'), undefined); assert.equal(f.state.writes, 2);
});

test('valid 1000-rule legacy revision remains complete and unchanged through cold/warm hydration', async t => {
  const f = fixture(t), rules = Array.from({ length: 1000 }, (_, i) => ({ ruleId: 'absent-' + i, version: 1, enabled: true, kind: 'email_domain', subject: 'absent-' + i + '.invalid', groups: [], policyIds: [], generatedGroup: 'assignment.' + i, priority: i, revokeOnLoss: true, provenance: 'cloudflare_access' }));
  const record = evaluateUserAssignments({ email, record: raw }, rules).user.record;
  assert.ok(Buffer.byteLength(record.assignmentState.revision) > 65536);
  f.store.set('access/users/' + email, JSON.stringify(record));
  for (let i = 0; i < 2; i++) assert.equal((await resolveUsers(f.env, [email]))[0].record.assignmentState.revision, record.assignmentState.revision);
  assert.equal(f.state.reads, 1); assert.equal(JSON.parse(f.stored(email)).assignmentState.revision, record.assignmentState.revision);
});

test('KV original bytes versus replacement text, shared stream budget and default cancellation-only', async () => {
  const budget = userRecordBudget();
  assert.deepEqual(await readUserKvRecord(async () => bytes(new Uint8Array([0xef, 0xbb, 0xbf, 34, 0xff, 34])), budget), '�');
  assert.equal(budget.bytes, 6); assert.equal(budget.text, 3);
  const aggregate = userRecordBudget();
  await readUserKvRecord(async () => bytes(' '.repeat(1100000) + '{}'), aggregate);
  await assert.rejects(readUserKvRecord(async () => bytes(' '.repeat(1000000) + '{}'), aggregate), denied('limit'));
  let pulls = 0, cancels = 0; const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
  await assert.rejects(readUserKvRecord(async () => body, userRecordBudget()), denied('transport'));
  assert.equal(pulls, 0); assert.equal(cancels, 1); assert.equal(body.locked, false);
});

test('rejected FIRST cancellation holds the reader facade until actual cleanup; failures sanitized', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers(), outcomes = []; let primary, hasPrimary = false;
  t.after(async () => { release.resolve(); const independent = (await Promise.all(outcomes)).filter(x => x.failed && (!hasPrimary || !Object.is(x.error, primary))).map(x => x.error); if (independent.length) throw new AggregateError(hasPrimary ? [primary, ...independent] : independent, 'primary and independent cleanup'); });
  const body = bytes(' '.repeat(maximum + 1)), get = body.getReader.bind(body); let cancels = 0, unlocks = 0, settled = false;
  body.getReader = options => { const reader = get(options), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.cancel = async (...args) => { cancels++; await cancel(...args); entered.resolve(); await release.promise; throw undefined; };
    reader.releaseLock = () => { unlocks++; unlock(); }; return reader; };
  const actual = readUserKvRecord(async () => body, userRecordBudget());
  outcomes.push(actual.then(() => { settled = true; return { failed: true, error: Error('unexpected success') }; }, error => { settled = true; return error?.message === 'User materialization failed (cleanup)' ? { failed: false } : { failed: true, error }; }));
  let timer;
  try {
    await Promise.race([entered.promise, actual.then(() => { throw Error('premature success'); }, error => { throw error; }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('missing cancel')), 5000); })]);
    assert.equal(settled, false); assert.equal(body.locked, true); assert.equal(cancels, 1); assert.equal(unlocks, 0);
    release.resolve(); await assert.rejects(actual, denied('cleanup')); assert.equal(unlocks, 1); assert.equal(body.locked, false);
  } catch (error) { hasPrimary = true; primary = error; throw error; } finally { clearTimeout(timer); }
});


test('closed source structural guards count discarded occurrences before parsing', () => {
  const scan = text => parseAccessJson(text, 'user_record');
  assert.doesNotThrow(() => scan('['.repeat(16) + '0' + ']'.repeat(16)));
  assert.throws(() => scan('['.repeat(17) + '0' + ']'.repeat(17)));
  assert.doesNotThrow(() => scan('[' + '[],'.repeat(4094) + '[]]'));
  assert.throws(() => scan('[' + '[],'.repeat(4095) + '[]]'));
  assert.doesNotThrow(() => scan('[' + '0,'.repeat(8191) + '0]'));
  assert.throws(() => scan('[' + '0,'.repeat(8192) + '0]'));
  assert.doesNotThrow(() => scan('1'.repeat(64)));
  assert.throws(() => scan('1'.repeat(65)));
  const valueLimit = n => '{"a":[' + '0,'.repeat(n - 1) + '0],' + '"x":0,'.repeat(8190) + '"x":0}';
  assert.doesNotThrow(() => scan(valueLimit(8191)));
  assert.throws(() => scan(valueLimit(8192)));
  // Scanner-only row occurrences: null rows are not valid initializer candidates.
  assert.equal(parseAccessJson('[' + 'null,'.repeat(4095) + 'null]', 'user_init').length, 4096);
  assert.throws(() => parseAccessJson('[' + 'null,'.repeat(4096) + 'null]', 'user_init'));
});

test('invalid marker owns and cancels its ORIGINAL request body without parsing', async () => {
  const body = bytes('{'), get = body.getReader.bind(body); let reads = 0, cancels = 0, unlocks = 0;
  body.getReader = options => { const reader = get(options), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.read = (...args) => { reads++; return read(...args); }; reader.cancel = (...args) => { cancels++; return cancel(...args); };
    reader.releaseLock = () => { unlocks++; unlock(); }; return reader; };
  const input = new Request('https://clawrouter.internal/users/initialize-all', { method: 'POST', headers: marker, body, duplex: 'half' });
  await assert.rejects(readUserMaterializationRequest(input, '/users/initialize-all'), denied('protocol'));
  assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(unlocks, 1); assert.equal(body.locked, false);
});

test('falsy KV records retain existing skip semantics; a later source overflow never initializes earlier seeds', async t => {
  const f = fixture(t);
  for (const [index, value] of [null, false, 0, ''].entries()) f.store.set('access/users/f' + index + '@b', JSON.stringify(value));
  assert.deepEqual(await resolveUsers(f.env, ['f0@b', 'f1@b', 'f2@b', 'f3@b']), []);
  assert.equal(f.state.calls.some(x => x.path === '/users/initialize'), false);
  f.store.set('access/users/good@b', JSON.stringify(raw)); f.store.set('access/users/big@b', ' '.repeat(maximum) + '{}');
  await assert.rejects(resolveUsers(f.env, ['good@b', 'big@b']), denied('limit'));
  assert.equal(f.state.writes, 0); assert.equal(f.state.calls.some(x => x.path === '/users/initialize'), false);
});

test('read/backing ceilings include empty and EOF wrapper calls without a default-read fallback', async () => {
  for (const [mode, target, expected] of [['exact', 8192, null], ['over', 8193, 'limit'], ['backing', 1, 'limit']]) {
    const body = bytes('{}'), get = body.getReader.bind(body); let reads = 0, cancels = 0, unlocks = 0, ended = false;
    body.getReader = options => { const reader = get(options), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
      reader.read = async (...args) => {
        reads++; const part = ended ? { done: true, value: args[0].subarray(0, 0) } : await read(...args);
        if (mode === 'backing') return { done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 1) };
        if (part.done) { ended = true; return { done: reads === target, value: part.value }; } return part;
      };
      reader.cancel = (...args) => { cancels++; return cancel(...args); }; reader.releaseLock = () => { unlocks++; unlock(); }; return reader;
    };
    // Empty-call injection follows settled native EOF; this is NOT native pending-read evidence.
    const actual = readUserKvRecord(async () => body, userRecordBudget());
    if (expected) await assert.rejects(actual, denied(expected)); else assert.deepEqual(await actual, {});
    assert.equal(reads, mode === 'backing' ? 1 : 8192); assert.equal(cancels, expected ? 1 : 0); assert.equal(unlocks, 1); assert.equal(body.locked, false);
  }
  for (const start of [() => { throw undefined; }, async () => { throw { cause: 'private sentinel' }; }]) await assert.rejects(readUserKvRecord(start, userRecordBudget()), denied('transport'));
});

test('terminal cold source failure prevents local-login creation/session despite valid admin credentials', async t => {
  const { fixture: credentialFixture } = await import('./credential-fixture.mjs');
  const f = await credentialFixture(t, [], { legacy: true }); f.CLAWROUTER_LOCAL_ADMIN_EMAIL = email;
  f.store.set('access/users/' + email, { ...raw, ignored: 'x'.repeat(maximum) });
  const stub = f.ACCESS_CONTROL.get(), paths = []; let sessions = 0;
  f.ACCESS_CONTROL.get = () => ({ fetch(url, init) { paths.push(new URL(url).pathname); return stub.fetch(url, init); } });
  const put = f.POLICY_KV.put; f.POLICY_KV.put = (key, value) => { if (key.startsWith('local/sessions/')) sessions++; return put(key, value); };
  const response = await f.http('/v1/session/login', 'POST', { token: 'fixture-admin-token' });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'user_materialization_unavailable');
  assert.equal(response.headers.has('set-cookie'), false); assert.equal(sessions, 0);
  assert.deepEqual(paths, ['/users/resolve']);
});

test('known empty selected body is a protocol failure, not transport', async () => {
  const input = new Request('https://clawrouter.internal/users/resolve', { method: 'POST', headers: marker });
  await assert.rejects(readUserMaterializationRequest(input, '/users/resolve'), denied('protocol'));
});
