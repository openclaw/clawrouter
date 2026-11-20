import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { accessBytesResponse } from './access-byte-fixture.mjs';
const { readAuthorityUserResponse } = await import('../authority-user-response.ts');
const { parseAccessJson } = await import('../access-json.ts');
const { authorityCall, resolveUsers } = await import('../authority.ts');
const { fixture } = await import('./credential-fixture.mjs');
const { evaluateUserAssignments } = await import('../assignment-evaluator.ts');
const empty = { initialized: true, users: [], missingEmails: [] };
const text = JSON.stringify(empty), maximum = 1048576;
const bytes = (value = text, init) => accessBytesResponse(value, '', init);
const turn = () => new Promise(resolve => setImmediate(resolve));
const denied = reason => error => {
  assert.equal(error.code, 'authority_user_query_failed');
  assert.equal(error.message, 'Authority user query unavailable');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  if (reason) assert.equal(error.reason, reason);
  return true;
};
function ownership(t) {
  const releases = [], outcomes = [];
  t.after(async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    for (const result of await Promise.all(outcomes)) if (!result.ok && !result.expected) failures.push(result.error);
    if (failures.length) throw new AggregateError(failures, 'independent user-reply fixture cleanup');
  });
  return {
    gate() { const d = Promise.withResolvers(); releases.push(d.resolve); return d; },
    start(promise, expectedReason) {
      outcomes.push(promise.then(() => ({ ok: true }), error => ({ ok: false, error,
        expected: error?.code === 'authority_user_query_failed' && error.reason === expectedReason })));
      return promise;
    },
  };
}
async function arrival(gate, actual) {
  let timer;
  try { await Promise.race([gate, actual.then(() => { throw Error('operation completed before arrival'); }, error => { throw error; }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('arrival missing')), 5000); })]); }
  finally { clearTimeout(timer); }
}
function observe(response, hooks = {}) {
  const body = response.body, get = body.getReader.bind(body);
  const state = { reads: 0, pending: 0, cancels: 0, cancelPending: false, unlocks: 0 };
  body.getReader = options => {
    const reader = get(options), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.read = async (...args) => {
      state.reads++; state.pending++;
      try { return hooks.read ? await hooks.read(read, args, state) : await read(...args); } finally { state.pending--; }
    };
    reader.cancel = async (...args) => {
      state.cancels++; await cancel(...args); state.cancelPending = true;
      try { await hooks.cancel?.(); } finally { state.cancelPending = false; }
    };
    reader.releaseLock = () => {
      assert.equal(state.pending, 0); assert.equal(state.cancelPending, false); state.unlocks++;
      unlock(); hooks.unlocked?.();
    };
    return reader;
  };
  return state;
}

test('only the exact default users query uses the new reader after specialized branches', async () => {
  let calls = 0;
  const env = { ACCESS_CONTROL: { idFromName: n => n, get: name => ({ fetch: async (url, init) => {
    calls++; assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { emails: ['A@example.invalid'] });
    return name === 'policy-bindings' && new URL(url).pathname === '/users/resolve' ? bytes() : Response.json({ untouched: true });
  } }) } };
  assert.deepEqual(await authorityCall(env, '/users/resolve', { emails: ['A@example.invalid'] }), empty);
  for (const [path, name] of [['/users/resolve/', 'policy-bindings'], ['/users/resolve', 'other'], ['/users/list', 'policy-bindings']])
    assert.deepEqual(await authorityCall(env, path, { emails: ['A@example.invalid'] }, name), { untouched: true });
  assert.equal(calls, 4);
  for (const position of [5, 6, 7]) {
    const args = [env, '/users/resolve', {}, 'policy-bindings', undefined];
    args[position] = { controlJson: async () => ({ specialized: true }) };
    assert.deepEqual(await authorityCall(...args), { specialized: true });
  }
  assert.equal(calls, 4);
});

test('complete user graph preserves unknown fields, old large revisions and canonical mixed cold results', async t => {
  const f = await fixture(t, [], { legacy: true });
  const email = 'legacy@example.invalid', canonical = 'canonical@example.invalid';
  const user = { email, record: { enabled: false, role: 'user', tenantId: 'default', contentRetentionDisabled: false, groups: ['manual'] } };
  const rules = Array.from({ length: 1000 }, (_, i) => ({ ruleId: 'absent-' + i, enabled: true, kind: 'email_domain',
    subject: 'absent-' + i + '.invalid', groups: [], policyIds: [], generatedGroup: 'assignment/' + i, priority: i, revokeOnLoss: true, version: 1, provenance: 'cloudflare_access' }));
  const legacy = evaluateUserAssignments(user, rules).user;
  assert.ok(Buffer.byteLength(legacy.record.assignmentState.revision) > 65536);
  f.store.set('access/users/' + email, legacy.record);
  await f.call('/users/put', { email: canonical, record: { enabled: true, groups: ['current'], extra: 'SQL wins' } });
  f.store.set('access/users/' + canonical, { enabled: false, groups: ['stale'] });
  const result = await resolveUsers(f, [canonical, ' LEGACY@example.invalid ', canonical, 'missing@example.invalid']);
  assert.deepEqual(result.map(row => row.email), [canonical, email]);
  assert.deepEqual(result[1], legacy); assert.deepEqual(result[0].record.groups, ['current']);
  assert.deepEqual(await resolveUsers(f, [email]), [legacy]);
  assert.deepEqual((await f.call('/users/resolve', { emails: [email] })).users, [legacy]);
  assert.deepEqual(f.store.get('access/users/' + email), legacy.record);
});

test('closed user scanner counts discarded members and strings without Access-specific field rules', () => {
  const parse = value => parseAccessJson(value, 'authority_user');
  assert.equal(parse('{"kid":"' + 'x'.repeat(300) + '","keys":[{"n":"' + 'x'.repeat(2000) + '","e":"' + 'x'.repeat(32) + '"}]}').kid.length, 300);
  assert.equal(parse('{"' + 'k'.repeat(1024) + '":1}')['k'.repeat(1024)], 1);
  assert.throws(() => parse('{"' + 'k'.repeat(1025) + '":1}'), { code: 'access_limit' });
  assert.equal(parse('{"same":0,"same":1}').same, 1);
  for (const [ok, over] of [
    ['['.repeat(16) + '0' + ']'.repeat(16), '['.repeat(17) + '0' + ']'.repeat(17)],
    ['{' + Array(4096).fill('"k":0').join(',') + '}', '{' + Array(4097).fill('"k":0').join(',') + '}'],
    ['[' + Array(4096).fill('0').join(',') + ']', '[' + Array(4097).fill('0').join(',') + ']'],
    ['[' + Array(2047).fill('{}').join(',') + ']', '[' + Array(2048).fill('{}').join(',') + ']'],
    ['{"a":[' + Array(4095).fill('0').join(',') + '],' + Array(4095).fill('"k":0').join(',') + '}',
      '{"a":[' + Array(4096).fill('0').join(',') + '],' + Array(4095).fill('"k":0').join(',') + '}'],
    ['1'.repeat(64), '1'.repeat(65)],
  ]) { assert.doesNotThrow(() => parse(ok)); assert.throws(() => parse(over), { code: 'access_limit' }); }
  // Wire/text syntax overhead dominates the equal aggregate/scalar ceilings.
  assert.doesNotThrow(() => parse('"' + 'x'.repeat(maximum - 2) + '"'));
  assert.throws(() => parse('"' + 'x'.repeat(maximum - 1) + '"'), { code: 'access_limit' });
  assert.throws(() => parseAccessJson('{"kid":"' + 'x'.repeat(257) + '"}', 'header'), { code: 'access_limit' });
});

test('one MiB original wire, replacement expansion, BOM and non-JSON MIME preserve decoding', async () => {
  const complete = { ...empty, extra: { unknown: null }, users: [{ email: 'unknown@example.invalid', record: { enabled: false,
    metadata: { kid: 'k'.repeat(300), ['k'.repeat(100)]: ['unknown', null] } } }] };
  assert.deepEqual(await readAuthorityUserResponse(async () => bytes(JSON.stringify(complete))), complete);
  for (const status of [200, 201, 206, 299]) for (const mime of [undefined, 'text/plain', 'Application/JSON']) {
    assert.deepEqual(await readAuthorityUserResponse(async () => bytes('\ufeff' + text, { status, headers: mime ? { 'content-type': mime } : {} })), empty);
  }
  assert.deepEqual(await readAuthorityUserResponse(async () => bytes(text + ' '.repeat(maximum - text.length))), empty);
  await assert.rejects(readAuthorityUserResponse(async () => bytes(text + ' '.repeat(maximum - text.length + 1))), denied('limit'));
  const prefix = Buffer.from('{"initialized":true,"users":[],"missingEmails":[],"extra":"'), suffix = Buffer.from('"}');
  const value = Buffer.concat([prefix, Buffer.alloc(400000, 255), suffix]);
  const result = await readAuthorityUserResponse(async () => bytes(value));
  assert.equal(result.extra, '\ufffd'.repeat(400000)); // Re-encoding exceeds 1 MiB; ORIGINAL wire does not.
  const split = bytes(JSON.stringify({ ...empty, extra: 'é😀'.repeat(6000) }));
  assert.equal((await readAuthorityUserResponse(async () => split)).extra, 'é😀'.repeat(6000));
  for (const value of ['', 'null', '[]', '{}', text + 'x', '{"initialized":true,"users":[null],"missingEmails":[]}'])
    await assert.rejects(readAuthorityUserResponse(async () => bytes(value)), denied('protocol'));
});

test('headers, whole backings and EMPTY/EOF read count enforce exact boundaries', async () => {
  for (const headers of [Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['x' + i, 'a'])), { x: 'a'.repeat(4095) }])
    assert.deepEqual(await readAuthorityUserResponse(async () => bytes(text, { headers })), empty);
  for (const headers of [Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['x' + i, 'a'])), { x: 'a'.repeat(4096) }]) {
    const r = bytes(text, { headers }), s = observe(r);
    await assert.rejects(readAuthorityUserResponse(async () => r), denied('limit'));
    assert.deepEqual([s.reads, s.cancels, s.unlocks], [0, 1, 1]);
  }
  for (const count of [8192, 8193]) {
    const r = bytes(), s = observe(r, { read: async (_read, [view], state) => {
      if (state.reads === 1) { view.set(new TextEncoder().encode(text)); return { done: false, value: view.subarray(0, text.length) }; }
      return { done: state.reads === count, value: view.subarray(0, 0) };
    } });
    if (count === 8192) assert.deepEqual(await readAuthorityUserResponse(async () => r), empty);
    else await assert.rejects(readAuthorityUserResponse(async () => r), denied('limit'));
    assert.equal(s.reads, 8192); assert.equal(s.unlocks, 1);
  }
  const r = bytes(), s = observe(r, { read: async () => ({ done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 1) }) });
  await assert.rejects(readAuthorityUserResponse(async () => r), denied('limit'));
  assert.equal(s.cancels, 1); assert.equal(s.unlocks, 1);
});

test('status/default-reader failures own cancellation without reading or exposing errors', async () => {
  for (const r of [bytes('private response sentinel', { status: 503 }), new Response(new ReadableStream({}))]) {
    const s = observe(r);
    await assert.rejects(readAuthorityUserResponse(async () => r), denied());
    assert.deepEqual([s.reads, s.cancels, s.unlocks], [0, 1, 1]);
  }
  for (const start of [() => { throw { cause: 'private' }; }, () => Promise.reject(undefined)])
    await assert.rejects(readAuthorityUserResponse(start), denied('transport'));
  const valid = bytes(), state = observe(valid, { unlocked() { throw { cause: 'private cleanup' }; } });
  await assert.rejects(readAuthorityUserResponse(async () => valid), denied('cleanup'));
  assert.equal(state.unlocks, 1); assert.equal(valid.body.locked, false);
});

test('held read and rejected FIRST cancellation join before final query rejection', async t => {
  const o = ownership(t), entered = o.gate(), held = o.gate(), cleaning = o.gate(), cancelHeld = o.gate(), abort = new AbortController();
  const r = bytes(), s = observe(r, {
    read: async (read, args) => { const value = await read(...args); entered.resolve(); await held.promise; return value; },
    cancel: async () => { cleaning.resolve(); await cancelHeld.promise; throw { cause: 'private cleanup' }; },
  });
  const actual = o.start(readAuthorityUserResponse(async () => r, abort.signal), 'cleanup');
  let settled = false; void actual.then(() => { settled = true; }, () => { settled = true; });
  await arrival(entered.promise, actual); abort.abort({ cleanupFailed: true });
  await arrival(cleaning.promise, actual); await turn();
  assert.equal(settled, false); assert.equal(r.body.locked, true); assert.equal(s.cancels, 1); assert.equal(s.unlocks, 0);
  cancelHeld.resolve(); await turn(); assert.equal(settled, false); assert.equal(s.unlocks, 0);
  held.resolve(); await assert.rejects(actual, denied('cleanup'));
  assert.equal(s.pending, 0); assert.equal(s.unlocks, 1); assert.equal(r.body.locked, false);
});

test('late actual response is disposed and final cleanup interval rechecks supplied signal', async t => {
  const o = ownership(t), late = o.gate(), abort = new AbortController();
  const r = bytes(), s = observe(r); let calls = 0, settled = false;
  const actual = o.start(readAuthorityUserResponse(() => { calls++; return late.promise; }, abort.signal), 'aborted');
  void actual.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(); await turn(); assert.equal(settled, false);
  late.resolve(r); await assert.rejects(actual, denied('aborted'));
  assert.deepEqual([calls, s.reads, s.cancels, s.unlocks], [1, 0, 1, 1]);
  const final = new AbortController(), response = bytes(), state = observe(response);
  const remove = final.signal.removeEventListener.bind(final.signal);
  final.signal.removeEventListener = (...args) => { remove(...args); if (state.unlocks) final.abort(); };
  await assert.rejects(readAuthorityUserResponse(async () => response, final.signal), denied('aborted'));
  assert.equal(state.pending, 0); assert.equal(state.unlocks, 1);
  const pre = AbortSignal.abort();
  let starts = 0;
  await assert.rejects(readAuthorityUserResponse(async () => { starts++; throw Error('must not invoke'); }, pre), denied('aborted'));
  assert.equal(starts, 0);
});
