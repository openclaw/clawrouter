import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { authorityAck, readAuthorityAck } = await import('../authority-ack-response.ts');
const { authorityCall } = await import('../authority.ts');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const expectedFailure = (outcome = 'OUTCOME_UNKNOWN', reason) => error => {
  assert.equal(error.code, 'authority_ack_failed'); assert.equal(error.outcome, outcome);
  assert.equal(error.message, 'Authority acknowledgment unavailable'); assert.equal(Object.hasOwn(error, 'cause'), false);
  if (reason) assert.equal(error.reason, reason);
  return true;
};
function bytes(text, init) {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text; let at = 0;
  return new Response(new ReadableStream({ type: 'bytes', pull(c) {
    if (at === data.length) { c.close(); c.byobRequest?.respond(0); return; }
    const view = c.byobRequest.view, size = Math.min(view.byteLength, data.length - at);
    view.set(data.subarray(at, at + size)); at += size; c.byobRequest.respond(size);
  } }), init);
}
function observe(response, options = {}) {
  const body = response.body, get = body.getReader.bind(body);
  const state = { reads: 0, pending: 0, cancels: 0, cancelPending: false, unlocks: 0 };
  body.getReader = opts => {
    const r = get(opts), read = r.read.bind(r), cancel = r.cancel.bind(r), unlock = r.releaseLock.bind(r);
    r.read = async (...args) => { state.reads++; state.pending++; try { return options.read ? await options.read(read, args, state) : await read(...args); } finally { state.pending--; } };
    r.cancel = async (...args) => { state.cancels++; await cancel(...args); state.cancelPending = true;
      try { await options.cancel?.(); } finally { state.cancelPending = false; } };
    r.releaseLock = () => { state.unlocks++; assert.equal(state.pending, 0); assert.equal(state.cancelPending, false); if (options.unlock) options.unlock(unlock); else unlock(); };
    return r;
  };
  return state;
}

test('only the closed seventeen default-namespace ACK paths tighten the generic transport', async () => {
  const map = {
    '/initialize': 'initialized', '/initialize-all': 'initialized', '/users/initialize': 'initialized', '/users/initialize-all': 'initialized',
    '/policies/initialize': 'initialized', '/policies/initialize-all': 'initialized', '/credentials/initialize': 'initialized', '/credentials/initialize-all': 'initialized',
    '/connections/initialize': 'initialized', '/connections/initialize-all': 'initialized', '/mutate': 'updated', '/users/put': 'updated', '/policies/put': 'updated',
    '/grant-pools/feedback': 'updated', '/oauth-states/put': 'updated', '/grant-pools/record': 'recorded', '/submission-tickets/release': 'released',
  };
  assert.equal(Object.keys(map).length, 17);
  for (const [path, ack] of Object.entries(map)) {
    assert.equal(authorityAck(path), ack); let calls = 0;
    const env = { ACCESS_CONTROL: { idFromName: name => name, get: name => ({ fetch: async (url, init) => {
      calls++; assert.equal(name, 'policy-bindings'); assert.equal(url, 'https://clawrouter.internal' + path);
      assert.equal(init.method, 'POST'); assert.equal(init.body, '[]'); return bytes(ack);
    } }) } };
    assert.equal(await authorityCall(env, path, []), ack); assert.equal(calls, 1);
  }
  for (const path of ['/initialize-all/', '/initialize-all?x=1', '/list', 'toString', '__proto__']) assert.equal(authorityAck(path), undefined);
  const env = { ACCESS_CONTROL: { idFromName: name => name, get: () => ({ fetch: async () => new Response('{"arbitrary":true}', { headers: { 'content-type': 'application/json' } }) }) } };
  assert.deepEqual(await authorityCall(env, '/initialize-all', [], 'another-namespace'), { arbitrary: true });
  assert.deepEqual(await authorityCall(env, '/list', {}), { arbitrary: true });
  for (const position of [5, 6, 7]) {
    const args = [env, '/initialize-all', [], 'policy-bindings', undefined];
    args[position] = { controlJson: async () => ({ specialized: true }) };
    assert.deepEqual(await authorityCall(...args), { specialized: true });
  }
});

test('ACK syntax preserves case-sensitive JSON MIME, standard escapes, BOM and response.ok', async () => {
  for (const status of [200, 201, 206, 299]) for (const text of ['"initialized"', ' \t\r\n"\\u0069nitialized"\n']) {
    assert.equal(await readAuthorityAck(async () => bytes(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } }), 'initialized'), 'initialized');
  }
  for (const mime of [undefined, 'text/plain', 'Application/JSON']) assert.equal(await readAuthorityAck(async () => bytes('initialized', { headers: mime ? { 'content-type': mime } : {} }), 'initialized'), 'initialized');
  assert.equal(await readAuthorityAck(async () => bytes('\ufeffinitialized'), 'initialized'), 'initialized');
  assert.equal(await readAuthorityAck(async () => bytes('\ufeff"initialized"', { headers: { 'content-type': 'application/json' } }), 'initialized'), 'initialized');
  assert.equal(await readAuthorityAck(async () => bytes('"initialized"', { headers: { 'content-type': 'prefixapplication/jsonsuffix' } }), 'initialized'), 'initialized');
  for (const json of [false, true]) for (const text of ['', '{}', '[]', 'null', '1', 'true', 'updated', 'initialized ', '"initialized" trailing', '"\\u00q0"', '"initialized', '"abcdefghijkl"']) {
    await assert.rejects(readAuthorityAck(async () => bytes(text, { headers: json ? { 'content-type': 'application/json' } : {} }), 'initialized'), expectedFailure());
  }
  await assert.rejects(readAuthorityAck(async () => bytes(new Uint8Array([255])), 'initialized'), expectedFailure('OUTCOME_UNKNOWN', 'protocol'));
});

test('128 wire/text bytes and exact header limits remain bounded before parsing', async () => {
  const exact = '"initialized"' + ' '.repeat(115);
  assert.equal(Buffer.byteLength(exact), 128);
  assert.equal(await readAuthorityAck(async () => bytes(exact, { headers: { 'content-type': 'application/json' } }), 'initialized'), 'initialized');
  const over = bytes(exact + ' ', { headers: { 'content-type': 'application/json' } }), state = observe(over);
  await assert.rejects(readAuthorityAck(async () => over, 'initialized'), expectedFailure('OUTCOME_UNKNOWN', 'limit'));
  assert.equal(state.cancels, 1); assert.equal(state.unlocks, 1);
  for (const headers of [Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['x-' + i, 'x'])), { x: 'x'.repeat(4095) }]) {
    assert.equal(await readAuthorityAck(async () => bytes('initialized', { headers }), 'initialized'), 'initialized');
  }
  for (const headers of [Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['x-' + i, 'x'])), { x: 'x'.repeat(4096) }]) {
    const r = bytes('initialized', { headers }), s = observe(r);
    await assert.rejects(readAuthorityAck(async () => r, 'initialized'), expectedFailure('OUTCOME_UNKNOWN', 'limit'));
    assert.deepEqual([s.reads, s.cancels, s.unlocks], [0, 1, 1]);
  }
});

test('whole-backing and 8192 owned reads including empty/EOF deny before another read', async () => {
  for (const count of [8192, 8193]) {
    const r = bytes('initialized'), s = observe(r, { read: async (_read, [view], state) => {
      if (state.reads === 1) { view.set(new TextEncoder().encode('initialized')); return { done: false, value: view.subarray(0, 11) }; }
      return { done: state.reads === count, value: view.subarray(0, 0) };
    } });
    if (count === 8192) assert.equal(await readAuthorityAck(async () => r, 'initialized'), 'initialized');
    else await assert.rejects(readAuthorityAck(async () => r, 'initialized'), expectedFailure('OUTCOME_UNKNOWN', 'limit'));
    assert.equal(s.reads, 8192); assert.equal(s.cancels, count === 8192 ? 0 : 1); assert.equal(s.unlocks, 1);
  }
  const r = bytes('initialized'), s = observe(r, { read: async () => ({ done: false, value: new Uint8Array(new ArrayBuffer(129), 0, 1) }) });
  await assert.rejects(readAuthorityAck(async () => r, 'initialized'), expectedFailure('OUTCOME_UNKNOWN', 'limit'));
  assert.deepEqual([s.reads, s.cancels, s.unlocks], [1, 1, 1]);
});

test('pre-abort never invokes; synchronous/asynchronous invocation failure stays uncertain and sanitized', async () => {
  const abort = new AbortController(); abort.abort({ code: 'forged', outcome: 'NOT_INVOKED', cleanupFailed: true }); let calls = 0;
  await assert.rejects(readAuthorityAck(async () => { calls++; return bytes('initialized'); }, 'initialized', abort.signal), expectedFailure('NOT_INVOKED', 'aborted'));
  assert.equal(calls, 0);
  for (const asynchronous of [false, true]) {
    const raw = { outcome: 'NOT_INVOKED', cause: { arbitrary: 'not part of the retained failure' } };
    await assert.rejects(readAuthorityAck(() => { calls++; if (asynchronous) return Promise.reject(raw); throw raw; }, 'initialized'), expectedFailure());
  }
  assert.equal(calls, 2);
});

test('late original response is disposed with zero reads and held rejected FIRST cancellation', async t => {
  const fetch = deferred(), cleanup = deferred(), abort = new AbortController(); let pending, settled = false;
  const r = bytes('initialized'), s = observe(r, { cancel: async () => { await cleanup.promise; throw { cause: 'discarded' }; } });
  t.after(async () => { fetch.resolve(r); cleanup.resolve(); if (pending) await assert.rejects(pending, expectedFailure()); });
  pending = readAuthorityAck(() => fetch.promise, 'initialized', abort.signal); void pending.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(); await turn(); assert.equal(settled, false);
  fetch.resolve(r); await turn(); assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.equal(s.unlocks, 0); assert.equal(r.body.locked, true); assert.equal(settled, false);
  cleanup.resolve(); await assert.rejects(pending, expectedFailure('OUTCOME_UNKNOWN', 'cleanup'));
  assert.equal(s.cancels, 1); assert.equal(s.unlocks, 1); assert.equal(r.body.locked, false);
});

test('abort joins the original pending read and FIRST cancellation before unlock', async t => {
  const held = deferred(), cleanup = deferred(), entered = deferred(), abort = new AbortController(); let pending, settled = false;
  const r = bytes('initialized'), s = observe(r, { read: async (read, args) => { const part = await read(...args); entered.resolve(); await held.promise; return part; }, cancel: () => cleanup.promise });
  t.after(async () => { held.resolve(); cleanup.resolve(); if (pending) await assert.rejects(pending, expectedFailure()); });
  pending = readAuthorityAck(async () => r, 'initialized', abort.signal); void pending.then(() => { settled = true; }, () => { settled = true; });
  let timer;
  try { await Promise.race([entered.promise, pending.then(() => assert.fail('completed before read'), error => { throw error; }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('read did not start')), 5000); })]); }
  finally { clearTimeout(timer); }
  abort.abort(); await turn(); assert.equal(s.pending, 1); assert.equal(s.cancels, 1); assert.equal(s.unlocks, 0); assert.equal(settled, false);
  cleanup.resolve(); await turn(); assert.equal(s.unlocks, 0); assert.equal(settled, false);
  held.resolve(); await assert.rejects(pending, expectedFailure('OUTCOME_UNKNOWN', 'aborted')); assert.equal(s.unlocks, 1); assert.equal(r.body.locked, false);
  // This gate holds the wrapper AFTER native settlement; Workerd covers a true pending native read.
});

test('non-success/default bodies cancel without reads; unknown unlock keeps the facade pending', async () => {
  for (const r of [bytes('failure', { status: 503 }), new Response(new ReadableStream({}))]) {
    const s = observe(r); await assert.rejects(readAuthorityAck(async () => r, 'initialized'), expectedFailure());
    assert.deepEqual([s.reads, s.cancels, s.unlocks], [0, 1, 1]);
  }
  const r = bytes('initialized'), s = observe(r, { unlock() { throw Error('still locked'); } }); let settled = false;
  void readAuthorityAck(async () => r, 'initialized').then(() => { settled = true; }, () => { settled = true; });
  await turn(); assert.equal(s.unlocks, 1); assert.equal(r.body.locked, true); assert.equal(settled, false);
  // Deliberately unresolved fault-injection root, not runtime disposal as retirement.
});
