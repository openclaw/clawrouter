import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { parseSoftStatus, admitSoftStatusRequest } = await import('../soft-budget-json.ts');
const { readSoftStatus } = await import('../soft-budget-response.ts');
const { softBudget, softBudgetPreflight } = await import('../soft-budget.ts');
const { isAccountingAdmissionFailure } = await import('../json-body.ts');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function bytes(text, init) {
  const data = new TextEncoder().encode(text); let at = 0;
  return new Response(new ReadableStream({ type: 'bytes', pull(c) {
    if (at === data.length) { c.close(); c.byobRequest?.respond(0); return; }
    const view = c.byobRequest.view, size = Math.min(view.byteLength, data.length - at);
    view.set(data.subarray(at, at + size)); at += size; c.byobRequest.respond(size);
  } }), init);
}
function observe(response, options = {}) {
  const body = response.body, get = body.getReader.bind(body);
  const state = { reads: 0, cancels: 0, unlocks: 0, pending: 0, cancelPending: false };
  body.getReader = opts => {
    const reader = get(opts), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), unlock = reader.releaseLock.bind(reader);
    reader.read = async (...args) => { state.reads++; state.pending++; try { return options.read ? await options.read(read, args, state) : await read(...args); } finally { state.pending--; } };
    reader.cancel = async (...args) => { state.cancels++; await cancel(...args); state.cancelPending = true;
      try { await options.cancel?.(); } finally { state.cancelPending = false; } };
    reader.releaseLock = () => { state.unlocks++; assert.equal(state.pending, 0); assert.equal(state.cancelPending, false); if (options.unlock) options.unlock(unlock); else unlock(); };
    return reader;
  };
  return state;
}

test('status JSON keeps partial/primitive/duplicate meaning and counts discarded occurrences', () => {
  for (const text of ['null', '[]', 'true', '1e999', '{"spentMicros":17}', '{"spentMicros":1,"spentMicros":17}']) assert.deepEqual(parseSoftStatus(text), JSON.parse(text));
  assert.equal(parseSoftStatus(' '.repeat(16382) + '{}').constructor, Object);
  for (const text of [' '.repeat(16383) + '{}', '{"a":"' + 'x'.repeat(1025) + '"}', '{"' + 'k'.repeat(65) + '":0}', '[0,]', '{"a":0} trailing', '"\\u00q0"']) assert.throws(() => parseSoftStatus(text));
  assert.doesNotThrow(() => parseSoftStatus('{' + Array(64).fill('"a":0').join(',') + '}'));
  assert.throws(() => parseSoftStatus('{' + Array(65).fill('"a":0').join(',') + '}'));
  assert.doesNotThrow(() => parseSoftStatus('[' + Array(64).fill('0').join(',') + ']'));
  assert.throws(() => parseSoftStatus('[' + Array(65).fill('0').join(',') + ']'));
  assert.doesNotThrow(() => parseSoftStatus('[[[[]]]]'));
  assert.throws(() => parseSoftStatus('[[[[[]]]]]'));
  assert.doesNotThrow(() => parseSoftStatus('[' + Array(4).fill('"' + 'x'.repeat(1024) + '"').join(',') + ']'));
  assert.throws(() => parseSoftStatus('[' + Array(4).fill('"' + 'x'.repeat(1024) + '"').join(',') + ',"x"]'));
  assert.doesNotThrow(() => parseSoftStatus('1'.repeat(64)));
  assert.throws(() => parseSoftStatus('1'.repeat(65)));
  assert.doesNotThrow(() => parseSoftStatus('[' + Array(31).fill('{}').join(',') + ']'));
  assert.throws(() => parseSoftStatus('[' + Array(32).fill('{}').join(',') + ']'));
  const object = n => '{' + Array(n).fill('"x":0').join(',') + '}';
  assert.doesNotThrow(() => parseSoftStatus('[' + Array(63).fill('0').concat(object(63)).join(',') + ']'));
  assert.throws(() => parseSoftStatus('[' + Array(63).fill('0').concat(object(64)).join(',') + ']'));
});

test('request bounds precede encoding and idFromName, including multibyte and lone surrogates', async () => {
  assert.doesNotThrow(() => admitSoftStatusRequest('o'.repeat(1024), 'p'.repeat(1024), 'w'.repeat(1024), 's'.repeat(1023), '1'));
  assert.throws(() => admitSoftStatusRequest('o'.repeat(1025), 'p', 'w', 's', '1'));
  assert.throws(() => admitSoftStatusRequest('o'.repeat(1024), 'p'.repeat(1024), 'w'.repeat(1024), 's'.repeat(1024), '1'));
  assert.throws(() => admitSoftStatusRequest('o', '\ud800'.repeat(1024), '界'.repeat(1024), 's', '1'));
  const prefix = new URL('https://clawrouter.internal/status');
  for (const key of ['policy_id', 'window_key', 'scope_key', 'limit_micros']) prefix.searchParams.set(key, key === 'limit_micros' ? '1' : '');
  const policy = '界'.repeat(1024), remaining = 16384 - prefix.href.length - 9 * 1024;
  const window = '界'.repeat(Math.floor(remaining / 9)) + 'a'.repeat(remaining % 9);
  const exact = new URL(prefix); exact.searchParams.set('policy_id', policy); exact.searchParams.set('window_key', window);
  assert.equal(exact.href.length, 16384);
  assert.doesNotThrow(() => admitSoftStatusRequest('o', policy, window, '', '1'));
  assert.throws(() => admitSoftStatusRequest('o', policy, window + 'a', '', '1'));
  let io = 0;
  const env = { BUDGET_LEDGER: { idFromName() { io++; throw Error('must not allocate a DO identity'); } } };
  assert.throws(() => softBudget(env, { policyId: 'p'.repeat(1025), policy: { monthlyBudgetMicros: 1 } }, 'llm.chat', { providerId: 'openai' }, 'bounded'),
    error => isAccountingAdmissionFailure(error) && error.status === 503 && error.code === 'accounting_preflight_unavailable');
  assert.equal(io, 0);
});

test('status response preserves ok/partial/media/empty URL and clean non-success semantics', async () => {
  for (const status of [200, 201, 206, 299]) {
    const r = bytes('{"spentMicros":17}', { status, headers: { 'content-type': 'text/plain', 'content-range': 'fixture' } });
    assert.equal(r.url, ''); assert.deepEqual(await readSoftStatus(async () => r), { spentMicros: 17 }); assert.equal(r.body.locked, false);
  }
  const r = bytes('not JSON', { status: 503 }), state = observe(r);
  assert.equal(await readSoftStatus(async () => r), null); assert.deepEqual([state.reads, state.cancels, state.unlocks], [0, 1, 1]);
});

test('wire, whole backing, read count and header limits own FIRST cancellation and unlock', async () => {
  for (const size of [16384, 16385]) {
    const r = bytes(' '.repeat(size - 2) + '{}'), state = observe(r);
    if (size === 16384) assert.deepEqual(await readSoftStatus(async () => r), {});
    else await assert.rejects(readSoftStatus(async () => r));
    assert.equal(state.cancels, size === 16384 ? 0 : 1); assert.equal(state.unlocks, 1); assert.equal(r.body.locked, false);
  }
  for (const count of [8192, 8193]) {
    let call = 0;
    const r = bytes('{}'), state = observe(r, { read: async (read, args) => {
      call++; if (call === 1) return read(...args);
      if (call < count) return { done: false, value: new Uint8Array(args[0].buffer, 0, 0) };
      return read(...args);
    } });
    if (count === 8192) await readSoftStatus(async () => r); else await assert.rejects(readSoftStatus(async () => r));
    assert.equal(state.reads, 8192); assert.equal(state.unlocks, 1); assert.equal(state.cancels, count === 8192 ? 0 : 1);
  }
  for (const mode of ['backing', 'headers', 'header-bytes', 'utf8']) {
    const r = bytes('{}', mode === 'headers' ? { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['x-' + i, 'x'])) }
      : mode === 'header-bytes' ? { headers: { x: 'x'.repeat(4096) } } : undefined);
    const state = observe(r, { read: mode === 'backing' ? async () => ({ done: false, value: new Uint8Array(new ArrayBuffer(16385), 0, 1) })
      : mode === 'utf8' ? async () => ({ done: false, value: new Uint8Array([255]) }) : undefined });
    await assert.rejects(readSoftStatus(async () => r)); assert.equal(state.cancels, 1); assert.equal(state.unlocks, 1);
  }
  for (const headers of [Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['x-' + i, 'x'])), { x: 'x'.repeat(4095) }]) {
    const r = bytes('{}', { headers }); assert.deepEqual(await readSoftStatus(async () => r), {}); assert.equal(r.body.locked, false);
  }
});

test('default reader never reads; rejected FIRST cancel must physically settle before failure', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const r = new Response(new ReadableStream({})), state = observe(r, { cancel: async () => { await gate.promise; throw { cause: 'unbounded caller graph is not retained' }; } });
  let done = false; const pending = readSoftStatus(async () => r); void pending.then(() => { done = true; }, () => { done = true; });
  await turn(); assert.equal(done, false); assert.equal(state.reads, 0); assert.equal(state.cancels, 1); assert.equal(state.unlocks, 0); assert.equal(r.body.locked, true);
  gate.resolve(); await assert.rejects(pending, { message: 'soft budget observation failed' }); assert.equal(state.unlocks, 1); assert.equal(r.body.locked, false);
});

test('a late fetch remains joined and an unknown original unlock keeps the facade pending', async () => {
  const gate = deferred(); let done = false;
  const pending = readSoftStatus(() => gate.promise); void pending.then(() => { done = true; });
  await turn(); assert.equal(done, false); gate.resolve(bytes('{"spentMicros":3}')); assert.deepEqual(await pending, { spentMicros: 3 });
  const r = bytes('{}'), state = observe(r, { unlock() { throw Error('still locked'); } });
  let settled = false; void readSoftStatus(async () => r).then(() => { settled = true; }, () => { settled = true; });
  await turn(); assert.equal(state.unlocks, 1); assert.equal(r.body.locked, true); assert.equal(settled, false);
  // Deliberately unresolved fault-injection owner; no runtime disposal as proof.
});

test('four legs join held physical cleanup despite a sibling failure; close does not cancel', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const r = bytes(' '.repeat(16385)), state = observe(r, { cancel: () => gate.promise }); let calls = 0;
  const env = { BUDGET_LEDGER: { idFromName: n => n, get: () => ({ fetch: async () => {
    const n = ++calls; if (n === 1) return r; if (n === 2) throw Error('sibling'); return bytes('{"spentMicros":0}');
  } }) } };
  const auth = { policyId: 'four', policy: { tenantId: 't', monthlyBudgetMicros: 100, dailyBudgetMicros: 100, weeklyBudgetMicros: 100 } };
  const b = softBudget(env, auth, 'llm.chat', { providerId: 'openai', monthlyBudgetMicros: 100 }, 'four');
  let settled = false; void b.check.then(() => { settled = true; });
  await turn(); b.close(); assert.equal(calls, 4); assert.equal(settled, false); assert.equal(state.cancels, 1); assert.equal(state.unlocks, 0);
  gate.resolve(); await b.check; assert.equal(state.unlocks, 1);
});

for (const mode of ['full', 'partial', 'non-success', 'null', 'unusable', 'below', 'fetch', 'parse', 'resource', 'cleanup']) test(`cached exhaustion: ${mode} has its frozen clear/retain effect`, async () => {
  const auth = { policyId: 'cache-' + mode, policy: { monthlyBudgetMicros: 10 } }, connection = { providerId: 'openai' };
  let reply = () => bytes('{"spentMicros":10}');
  const env = { CLAWROUTER_HOT_CACHE_MAX_AGE_SECONDS: '60', BUDGET_LEDGER: { idFromName: n => n, get: () => ({ fetch: () => reply() }) } };
  await softBudget(env, auth, 'llm.chat', connection, 'exhaust').check;
  assert.ok(softBudgetPreflight(env, auth, 'llm.chat', connection));
  reply = () => {
    if (mode === 'fetch') throw { cause: 'not retained' };
    if (mode === 'cleanup') { const r = bytes(' '.repeat(16385)); observe(r, { cancel: () => Promise.reject(Error('cancel')) }); return r; }
    return bytes(mode === 'full' ? '{"policyId":"p","windowKey":"w","limitMicros":10,"spentMicros":0,"remainingMicros":10}'
      : mode === 'partial' || mode === 'below' ? '{"spentMicros":0}' : mode === 'null' ? 'null' : mode === 'unusable' ? '{}' : mode === 'parse' ? '!'
        : mode === 'resource' ? ' '.repeat(16385) : 'ignored', mode === 'non-success' ? { status: 503 } : undefined);
  };
  await softBudget(env, auth, 'llm.chat', connection, 'observe').check;
  assert.equal(Boolean(softBudgetPreflight(env, auth, 'llm.chat', connection)), ['fetch', 'parse', 'resource', 'cleanup'].includes(mode));
});
