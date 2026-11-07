import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { accessBytesResponse } from './access-byte-fixture.mjs';
import { PolicyBindingIndexObject, authorityCall } from '../authority.ts';
import { listAssignmentRules, reconcileUserAssignments } from '../assignments.ts';
import { assignmentRulesRevision, captureAdmittedAssignmentRules, prepareAssignmentRules, evaluatePreparedUserAssignments, evaluateUserAssignments } from '../assignment-evaluator.ts';
import { assignmentSourceBudget, admitAssignmentBytes, parseAssignmentSource, admitAssignmentCursor, assignmentJsonText, readAssignmentResponse, readAssignmentRequest, readAssignmentKv } from '../assignment-source.ts';
import { parseAccessJson } from '../access-json.ts';
import { normalizeUser } from '../authority-users.ts';

const maximum = 2097152, complete = 1048576, email = 'member@example.invalid';
const marker = { 'x-clawrouter-assignment-materialization': 'v1' };
const rule = (extra = {}) => ({ ruleId: 'member', generatedGroup: 'assignment.member', version: 1, enabled: true, kind: 'email_domain', subject: 'example.invalid', groups: ['automatic'], policyIds: [], priority: 10, revokeOnLoss: true, provenance: 'fixture', ...extra });
const user = { email, record: { enabled: true, role: 'user', tenantId: 'fixture', groups: ['manual'], contentRetentionDisabled: false } };
const payload = (rules = [rule()], extra = {}) => ({ email, rules, legacy: null, force: false, ...extra });
const denied = kind => error => error?.status === 503 && error.code === 'assignment_materialization_unavailable' && error.message === `Assignment materialization failed (${kind})`;
const bytes = text => accessBytesResponse(text, '').body;
const req = (value, headers = marker, path = '/users/reconcile-assignments') => new Request('https://clawrouter.internal' + path, { method: 'POST', headers,
  body: new Headers(headers).has('x-clawrouter-assignment-materialization') ? bytes(typeof value === 'string' ? value : JSON.stringify(value)) : JSON.stringify(value), duplex: 'half' });

function ownership(t) {
  const roots = [], releases = []; let primary, hasPrimary = false;
  t.after(async () => {
    for (const release of releases) release();
    const errors = [];
    for (const state of await Promise.all(roots)) if (state.failed && !state.expected && !(hasPrimary && Object.is(primary, state.error))) errors.push(state.error);
    if (errors.length) throw new AggregateError(hasPrimary ? [primary, ...errors] : errors, 'primary and independent cleanup failures');
  });
  return {
    hold() { const gate = Promise.withResolvers(); releases.push(gate.resolve); return gate; },
    start(actual, expected) { roots.push(actual.then(value => ({ failed: false, value }), error => ({ failed: true, error, expected: !!expected?.(error) }))); return actual; },
    async run(fn) { try { return await fn(); } catch (error) { hasPrimary = true; primary = error; throw error; } },
  };
}
async function arrival(entered, actual) {
  let timer;
  try { await Promise.race([entered, actual.then(() => { throw Error('premature fulfillment'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('arrival missing')), 2000); })]); }
  finally { clearTimeout(timer); }
}
function fixture(t) {
  const db = new DatabaseSync(':memory:'), store = new Map(), calls = [], trace = [];
  const state = { writes: 0, throwAfterWrite: false, beforeGet: undefined };
  t.after(() => db.close());
  const sql = { exec(query, ...args) {
    trace.push(query.includes('length(CAST') ? 'size' : query.startsWith('SELECT user_json') ? 'value' : 'other');
    const statement = db.prepare(query);
    if (statement.columns().length) return statement.all(...args);
    const result = statement.run(...args);
    if (query.startsWith('INSERT OR REPLACE INTO access_users')) { state.writes++; if (state.throwAfterWrite) throw Error('injected SQL acknowledgment failure'); }
    return result && [];
  } };
  const owner = new PolicyBindingIndexObject({ storage: { sql } });
  const insert = (record, id = email) => db.prepare('INSERT OR REPLACE INTO access_users(email,user_json) VALUES(?,?)').run(id, typeof record === 'string' ? record : JSON.stringify(record));
  const stored = () => db.prepare('SELECT user_json FROM access_users WHERE email=?').get(email)?.user_json;
  const env = { ACCESS_CONTROL: { idFromName: n => n, get: () => ({ async fetch(url, init) {
    calls.push({ path: new URL(url).pathname, headers: init.headers });
    const r = await owner.fetch(req(init.body, init.headers ?? {}, new URL(url).pathname));
    // Explicit Node byte fixture; healthy Workerd replies remain ORIGINAL.
    return accessBytesResponse(await r.text(), '', { status: r.status, headers: r.headers });
  } }) }, POLICY_KV: {
    async list({ cursor, limit }) { assert.equal(limit, 64); const keys = [...store.keys()].filter(x => x.startsWith('access/assignment-rules/')); const offset = Number(cursor ?? 0); return { keys: keys.slice(offset, offset + limit).map(name => ({ name })), list_complete: offset + limit >= keys.length, cursor: String(offset + limit) }; },
    async get(key, type) { assert.equal(type, 'stream'); await state.beforeGet?.(); const value = store.get(key); return value === undefined ? null : bytes(typeof value === 'string' ? value : JSON.stringify(value)); },
  } };
  return { db, owner, store, calls, trace, state, insert, stored, env, call: value => authorityCall(env, '/users/reconcile-assignments', value) };
}

test('closed assignment scanner counts combined occurrences and cumulative raw phases; old profiles unchanged', () => {
  const budget = assignmentSourceBudget(), text = ' '.repeat(maximum - 2) + '{}';
  admitAssignmentBytes(budget, maximum); assert.deepEqual(parseAssignmentSource(text, budget), {});
  assert.throws(() => admitAssignmentBytes(budget, 1), denied('limit'));
  assert.throws(() => parseAssignmentSource('{}', budget), denied('limit'));
  const exact = '{' + '"x":0,'.repeat(16383) + '"x":[' + '0,'.repeat(16383) + '0]}';
  assert.equal(parseAssignmentSource(exact).x.length, 16384);
  assert.throws(() => parseAssignmentSource(exact.slice(0, -1) + ',"x":0}'), denied('limit'));
  const shared = assignmentSourceBudget(); parseAssignmentSource('{"a":[' + '0,'.repeat(16382) + '0]}', shared);
  parseAssignmentSource('[' + '0,'.repeat(16383) + '0]', shared);
  assert.throws(() => parseAssignmentSource('[0]', shared), denied('limit'));
  assert.equal(parseAssignmentSource('{"' + 'k'.repeat(1024) + '":"' + 'x'.repeat(257) + '"}')['k'.repeat(1024)].length, 257);
  assert.throws(() => parseAssignmentSource('{"' + 'k'.repeat(1025) + '":0}'), denied('limit'));
  assert.throws(() => parseAssignmentSource('"' + 'x'.repeat(complete + 1) + '"'), denied('limit'));
  assert.doesNotThrow(() => parseAccessJson('{"kid":"' + 'k'.repeat(300) + '"}', 'authority_user'));
  assert.throws(() => parseAccessJson('{"kid":"' + 'k'.repeat(300) + '"}', 'header'), { code: 'access_limit' });
});

test('preflight measures exact JSON escapes/UTF8/omissions and legacy revision before capture or digest', async () => {
  for (const value of [null, [undefined, Infinity, NaN], { x: undefined, z: '\ud800', y: '😀', n: -0 }]) assert.equal(assignmentJsonText(value), JSON.stringify(value));
  assert.equal(assignmentJsonText('x'.repeat(complete - 2), true).length, complete);
  assert.throws(() => assignmentJsonText('x'.repeat(complete - 1), true), denied('limit'));
  assert.throws(() => assignmentJsonText('é'.repeat(complete / 2), true), denied('limit'));
  assert.throws(() => assignmentJsonText('\0'.repeat(Math.ceil(complete / 6)), true), denied('limit'));
  const base = rule({ subject: '' }), overhead = assignmentRulesRevision([base]).length;
  const exact = [rule({ subject: 'x'.repeat(complete - overhead) })];
  const prepared = await prepareAssignmentRules(captureAdmittedAssignmentRules(exact));
  assert.ok(prepared); assert.equal(assignmentRulesRevision(exact).length, complete);
  assert.throws(() => captureAdmittedAssignmentRules([rule({ subject: exact[0].subject + 'x' })]), denied('limit'));
  const r = rule({ enabled: undefined, priority: Infinity, provenance: undefined });
  const expected = 'assignment-rules.v1:sha256:' + Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(assignmentRulesRevision([r])))).toString('hex');
  const result = evaluatePreparedUserAssignments(user, await prepareAssignmentRules(captureAdmittedAssignmentRules([r])));
  assert.equal(result.user.record.assignmentState.revision, expected);
  assert.throws(() => evaluatePreparedUserAssignments(user, {}), /invalid prepared/);
});

test('sequential listing counts null/duplicate keys, empty pages, cursors and later cumulative overflow without partial results', async t => {
  const f = fixture(t); f.store.set('access/assignment-rules/member', rule());
  let lists = 0, gets = 0;
  f.env.POLICY_KV.list = async ({ cursor, limit }) => { assert.equal(limit, 64); lists++; return lists === 1 ? { keys: [], list_complete: false, cursor: 'next' } : { keys: [null, { name: 'access/assignment-rules/member' }, { name: 'access/assignment-rules/member' }], list_complete: true }; };
  const get = f.env.POLICY_KV.get; f.env.POLICY_KV.get = (...args) => { gets++; return get(...args); };
  assert.equal((await listAssignmentRules(f.env)).length, 2); assert.equal(lists, 2); assert.equal(gets, 2);
  for (const cursor of ['', null, 1, 'x'.repeat(16385), 'é'.repeat(8193)]) { f.env.POLICY_KV.list = async () => ({ keys: [], list_complete: false, cursor }); await assert.rejects(listAssignmentRules(f.env)); }
  assert.doesNotThrow(() => admitAssignmentCursor('x'.repeat(16384))); assert.throws(() => admitAssignmentCursor('é'.repeat(8193)), denied('limit'));
  lists = 0; f.env.POLICY_KV.list = async () => { lists++; return { keys: [], list_complete: false, cursor: 'same' }; };
  await assert.rejects(listAssignmentRules(f.env), denied('limit')); assert.equal(lists, 128);
  lists = 0; f.env.POLICY_KV.list = async () => ({ keys: Array(64).fill(null), list_complete: ++lists === 64, cursor: 'more' });
  assert.deepEqual(await listAssignmentRules(f.env), []); assert.equal(lists, 64);
  lists = 0; f.env.POLICY_KV.list = async () => ({ keys: Array(64).fill(null), list_complete: ++lists === 65, cursor: 'more' });
  await assert.rejects(listAssignmentRules(f.env), denied('limit')); assert.equal(lists, 65);
  f.env.POLICY_KV.list = async () => ({ keys: [{ name: 'access/assignment-rules/first' }, { name: 'access/assignment-rules/last' }], list_complete: true });
  f.store.set('access/assignment-rules/first', ' '.repeat(1100000) + JSON.stringify(rule())); f.store.set('access/assignment-rules/last', ' '.repeat(1000000) + JSON.stringify(rule()));
  await assert.rejects(listAssignmentRules(f.env), denied('limit'));
});

test('selected error status, complete unknown reply and exact projected storage/no-op compatibility', async t => {
  const f = fixture(t);
  await assert.rejects(f.call(payload()), { status: 404, code: 'unknown_user', message: 'access user not found' });
  f.insert({ ...user.record, groups: [' A ', 'a'], unknown: { preserve: 'reply only' } });
  const changed = await f.call(payload());
  assert.equal(changed.changed, true); assert.deepEqual(changed.user.record.unknown, { preserve: 'reply only' });
  assert.deepEqual(JSON.parse(f.stored()), normalizeUser(changed.user).record); assert.equal(JSON.parse(f.stored()).unknown, undefined);
  const before = f.stored(), writes = f.state.writes;
  assert.equal((await f.call(payload())).changed, false); assert.equal(f.stored(), before); assert.equal(f.state.writes, writes);
  const large = Array.from({ length: 1000 }, (_, i) => rule({ ruleId: 'absent-' + i, generatedGroup: 'assignment.' + i, subject: 'absent-' + i + '.invalid', policyIds: [] }));
  const legacy = evaluateUserAssignments(user, large).user.record; assert.ok(Buffer.byteLength(legacy.assignmentState.revision) > 65536);
  f.insert({ ...legacy, unknown: 'no-op unchanged' }); const legacyBytes = f.stored();
  assert.equal((await f.call(payload(large, { force: true }))).changed, false); assert.equal(f.stored(), legacyBytes);
  const org = rule({ kind: 'github_org', subject: 'example', revokeOnLoss: true });
  f.insert(evaluateUserAssignments(user, [org], { source: 'github', verified: true, githubOrgs: ['example'], githubTeams: [] }, true).user.record);
  const retained = await f.call(payload([org])); assert.equal(retained.changed, false);
  const revoked = await f.call(payload([org], { force: true, evidence: { source: 'github', verified: true, githubOrgs: [], githubTeams: [] } }));
  assert.deepEqual(revoked.user.record.groups, ['manual']);
});

test('SQL size precedes loading; complete store/reply overflow writes zero; committed SQL failure is uncertain', async t => {
  const f = fixture(t); f.insert(' '.repeat(maximum) + '{}'); f.trace.length = 0;
  await assert.rejects(f.call(payload()), denied('limit')); assert.deepEqual(f.trace.filter(x => x !== 'other'), ['size']);
  f.insert({ ...user.record, groups: ['x'.repeat(900000)] });
  await assert.rejects(f.call(payload([rule({ groups: ['y'.repeat(200000)] })])), denied('limit')); assert.equal(f.state.writes, 0);
  f.insert({ ...user.record, first: 'x'.repeat(950000), second: 'y'.repeat(950000) });
  await assert.rejects(f.call(payload([rule({ groups: ['z'.repeat(300000)] })])), denied('limit')); assert.equal(f.state.writes, 0);
  f.insert(user.record); f.state.throwAfterWrite = true;
  await assert.rejects(f.call(payload()), denied('transport')); assert.equal(f.state.writes, 1); assert.ok(JSON.parse(f.stored()).assignmentState);
});

test('four actual intakes retain admission; fifth cancels without semantic read; invalid markers still own bodies', async t => {
  const owned = ownership(t); return owned.run(async () => {
    const f = fixture(t), gates = [], started = [];
    for (let i = 0; i < 4; i++) {
      const hold = owned.hold(), entered = Promise.withResolvers(); gates.push(hold);
      const body = new ReadableStream({ type: 'bytes', async pull(c) { entered.resolve(); await hold.promise; c.close(); c.byobRequest?.respond(0); } });
      const request = new Request('https://clawrouter.internal/users/reconcile-assignments', { method: 'POST', headers: marker, body, duplex: 'half' });
      const actual = owned.start(f.owner.fetch(request)); started.push(actual); await arrival(entered.promise, actual);
    }
    assert.equal(f.owner.assignmentAdmissions, 4);
    let reads = 0, cancels = 0;
    const body = new ReadableStream({ type: 'bytes', pull() { reads++; }, cancel() { cancels++; } });
    const fifth = await f.owner.fetch(new Request('https://clawrouter.internal/users/reconcile-assignments', { method: 'POST', headers: marker, body, duplex: 'half' }));
    assert.equal(fifth.status, 503); assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(body.locked, false); assert.equal(f.owner.assignmentAdmissions, 4);
    for (const gate of gates) gate.resolve(); for (const root of started) { const r = await root; await r.text(); }
    assert.equal(f.owner.assignmentAdmissions, 0); assert.equal(f.state.writes, 0);
    for (const [path, headers] of [['/users/list', marker], ['/users/reconcile-assignments', { 'x-clawrouter-assignment-materialization': 'v2' }]]) {
      const request = req('{', headers, path), r = await f.owner.fetch(request); assert.equal(r.status, 503); assert.equal(request.body.locked, false);
    }
  });
});

test('selected FIFO captures before wait, joins undefined snapshot failure and reads CURRENT canonical after digest', async t => {
  const owned = ownership(t); return owned.run(async () => {
    const f = fixture(t); f.insert(user.record);
    const held = owned.hold(), entered = Promise.withResolvers(), digest = crypto.subtle.digest.bind(crypto.subtle); let hashes = 0;
    t.mock.method(crypto.subtle, 'digest', async (...args) => { const result = await digest(...args); if (++hashes === 1) { entered.resolve(); await held.promise; } return result; });
    const a = owned.start(f.owner.reconcileUserAssignments(payload(), true)); await arrival(entered.promise, a);
    const b = owned.start(f.owner.reconcileUserAssignments({ get rules() { throw undefined; } }, true), e => e === undefined);
    const mutable = rule({ enabled: false }); const c = owned.start(f.owner.reconcileUserAssignments(payload([mutable]), true)); mutable.enabled = true;
    let bDone = false, cDone = false; b.then(() => { bDone = true; }, () => { bDone = true; }); c.then(() => { cDone = true; }, () => { cDone = true; });
    await Promise.resolve(); assert.equal(bDone, false); assert.equal(cDone, false); assert.equal(hashes, 1); assert.equal(f.state.writes, 0);
    f.insert({ ...user.record, enabled: false, tenantId: 'current', groups: ['new-manual'], unknown: true });
    held.resolve(); await a; await b.then(() => assert.fail('undefined failure expected'), reason => assert.equal(reason, undefined));
    const result = JSON.parse(await c); assert.equal(result.user.record.enabled, false); assert.equal(result.user.record.tenantId, 'current'); assert.deepEqual(result.user.record.groups, ['new-manual']);
  });
});

for (const field of ['groups', 'policyIds']) test(`admitted ${field} scalar cannot expand before preflight and its failure joins the FIFO`, async t => {
  const owned = ownership(t); return owned.run(async () => {
    const f = fixture(t); f.insert(user.record);
    const digest = crypto.subtle.digest.bind(crypto.subtle), hold = owned.hold(), entered = Promise.withResolvers(); let hashes = 0;
    t.mock.method(crypto.subtle, 'digest', async (...args) => { hashes++; const value = await digest(...args); entered.resolve(); await hold.promise; return value; });
    const invalid = [rule({ [field]: 'x'.repeat(300000) })];
    assert.throws(() => captureAdmittedAssignmentRules(invalid), denied('protocol')); assert.equal(hashes, 0);
    const deniedReply = await f.owner.fetch(req(payload(invalid))); assert.equal(deniedReply.status, 503); assert.equal((await deniedReply.json()).error.message, 'Assignment materialization failed (protocol)');
    assert.equal(hashes, 0); assert.equal(f.state.writes, 0); assert.equal(f.owner.assignmentAdmissions, 0);
    const a = owned.start(f.owner.fetch(req(payload()))); await arrival(entered.promise, a);
    // Await intake completion using the actual direct postparse entry seam.
    const captured = Promise.withResolvers(), original = f.owner.reconcileUserAssignments.bind(f.owner);
    f.owner.reconcileUserAssignments = (...args) => { const actual = original(...args); if (args[0].rules[0][field] === invalid[0][field]) captured.resolve(); return actual; };
    const b = owned.start(f.owner.fetch(req(payload(invalid)))); let settled = false; b.then(() => { settled = true; }, () => { settled = true; });
    await arrival(captured.promise, b);
    assert.equal(settled, false); assert.equal(hashes, 1); assert.equal(f.state.writes, 0); assert.equal(f.owner.assignmentAdmissions, 2);
    hold.resolve(); await (await a).text(); const result = await b;
    assert.equal(result.status, 503); assert.equal((await result.json()).error.message, 'Assignment materialization failed (protocol)');
    assert.equal(hashes, 1); assert.equal(f.owner.assignmentAdmissions, 0); assert.equal(f.state.writes, 1, 'only the valid predecessor writes');
  });
});

test('late fetch and FIRST cancellation rejection remain owned; default-reader is cancellation-only', async t => {
  const owned = ownership(t); return owned.run(async () => {
    const late = owned.hold(), cancellation = owned.hold(), entered = Promise.withResolvers();
    const controller = new AbortController(); let cancels = 0, reads = 0, unlocks = 0, done = false;
    const response = accessBytesResponse('{}', ''); const get = response.body.getReader.bind(response.body);
    response.body.getReader = options => { const reader = get(options); return {
      read(...args) { reads++; return reader.read(...args); },
      async cancel(reason) { cancels++; await reader.cancel(reason); entered.resolve(); await cancellation.promise; throw undefined; },
      releaseLock() { unlocks++; reader.releaseLock(); },
    }; };
    const work = owned.start(readAssignmentResponse(() => late.promise.then(() => response), controller.signal), denied('cleanup'));
    work.then(() => { done = true; }, () => { done = true; }); controller.abort(); late.resolve(); await arrival(entered.promise, work);
    assert.equal(reads, 0); assert.equal(done, false); assert.equal(cancels, 1); assert.equal(unlocks, 0); assert.equal(response.body.locked, true);
    cancellation.resolve(); await assert.rejects(work, denied('cleanup')); assert.equal(unlocks, 1); assert.equal(response.body.locked, false);
    const body = new ReadableStream({ cancel() { cancels++; }, pull() { reads++; } }, { highWaterMark: 0 });
    await assert.rejects(readAssignmentKv(async () => body, assignmentSourceBudget()), denied('transport'));
    assert.equal(reads, 0); assert.equal(cancels, 2); assert.equal(body.locked, false);
  });
});

test('original signal is fenced after reader cleanup and bounded business errors survive', async () => {
  const controller = new AbortController(), response = accessBytesResponse(JSON.stringify({ changed: false, user, matchedRuleIds: [], retainedRuleIds: [] }), '');
  const get = response.body.getReader.bind(response.body);
  response.body.getReader = options => { const reader = get(options), release = reader.releaseLock.bind(reader); reader.releaseLock = () => { release(); controller.abort(); }; return reader; };
  await assert.rejects(readAssignmentResponse(async () => response, controller.signal), denied('transport')); assert.equal(response.body.locked, false);
  let starts = 0; await assert.rejects(readAssignmentResponse(async () => { starts++; return response; }, controller.signal), denied('transport')); assert.equal(starts, 0);
  const bad = req('{}', { 'x-clawrouter-assignment-materialization': 'v2' }); await assert.rejects(readAssignmentRequest(bad, '/users/reconcile-assignments', true), denied('protocol')); assert.equal(bad.body.locked, false);
});

test('original-byte replacement/BOM, whole backing, read-count and header guards remain independent', async () => {
  const value = { changed: false, user, matchedRuleIds: [], retainedRuleIds: [] }, text = JSON.stringify(value);
  const bom = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]);
  assert.deepEqual(await readAssignmentResponse(async () => accessBytesResponse(bom, '')), value);
  assert.equal((await readAssignmentKv(async () => bytes(Buffer.from([34, 255, 34])), assignmentSourceBudget())), '\ufffd');
  for (const empty of [8190, 8191]) {
    const response = accessBytesResponse('{}', ''), get = response.body.getReader.bind(response.body); let reads = 0, cancels = 0;
    response.body.getReader = options => { const reader = get(options); return {
      // Labelled Node counter injection: empty-result accounting, not native
      // transport evidence. Actual data/EOF and cancellation use this reader.
      read(view) { if (reads++ < empty) return Promise.resolve({ done: false, value: new Uint8Array(view.buffer, 0, 0) }); return reader.read(view); },
      cancel(reason) { cancels++; return reader.cancel(reason); }, releaseLock() { reader.releaseLock(); },
    }; };
    if (empty === 8190) { assert.deepEqual(await readAssignmentKv(async () => response.body, assignmentSourceBudget()), {}); assert.equal(reads, 8192); assert.equal(cancels, 0); }
    else { await assert.rejects(readAssignmentKv(async () => response.body, assignmentSourceBudget()), denied('limit')); assert.equal(reads, 8192); assert.equal(cancels, 1); }
    assert.equal(response.body.locked, false);
  }
  const oversized = accessBytesResponse('{}', ''), get = oversized.body.getReader.bind(oversized.body);
  oversized.body.getReader = options => { const reader = get(options); return { async read(view) { const part = await reader.read(view); if (part.value?.length) return { ...part, value: new Uint8Array(16385).subarray(0, 2) }; return part; }, cancel: reason => reader.cancel(reason), releaseLock: () => reader.releaseLock() }; };
  await assert.rejects(readAssignmentKv(async () => oversized.body, assignmentSourceBudget()), denied('limit')); assert.equal(oversized.body.locked, false);
  for (const count of [32, 33]) {
    const headers = Object.fromEntries(Array.from({ length: count }, (_, i) => ['x-' + i, 'a']));
    const read = () => readAssignmentResponse(async () => accessBytesResponse(text, '', { headers }));
    if (count === 32) assert.deepEqual(await read(), value); else await assert.rejects(read(), denied('limit'));
  }
  for (const size of [4096, 4097]) {
    const read = () => readAssignmentResponse(async () => accessBytesResponse(text, '', { headers: { x: 'a'.repeat(size - 1) } }));
    if (size === 4096) assert.deepEqual(await read(), value); else await assert.rejects(read(), denied('limit'));
  }
});
