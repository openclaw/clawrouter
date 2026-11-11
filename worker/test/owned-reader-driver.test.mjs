import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnedReaderDriver, ProxyCompletion, inspectOwnedBytes, newOwnedBytes, ownedByteSubarray, ownedByteSlice, copyOwnedBytes, newOwnedDecoder, decodeOwnedBytes, encodeOwnedTextInto, newOwnedEncoder, enqueueOwnedBytes } from '../proxy-completion.ts';

// Mechanical driver witnesses complement the actual private Workerd route.
// This fixture receiver is never exported by the Worker or counted as an additional
// production subclass. It retains only bounded origin facts.
class FixtureReader extends OwnedReaderDriver {
  failures = []; unknown = false; captures = 0;
  constructor(role) { super(); this.role = role; }
  holdDriver() { this.unknown = true; }
  driverProtocolFailure() { return new Error('driver protocol'); }
  recordDriverFailure(kind, reason) { const fact = { kind, ordinal: this.failures.length, undefined: reason === undefined }; this.failures.push(fact); return fact; }
  propagatedDriverFailure() { return false; }
  captureDriverValue(value) {
    this.captures++;
    if (this.role === 'public') { this.readDone = !!value.done; this.captured = value.value; }
    else { this.captured = value.value; this.readDone = !!value.done; }
  }
  driverCleared() {}
  open(body, modify) { this.body = body; this.reader = body.getReader(); modify?.(this.reader); this.observeDriverClosed(false); }
  read() { return this.startDriverRead(); }
  stop() { return this.stopDriver(true); }
  stopUsage(reason) { return this.stopUsageDriver(true, reason); }
  finishUsage() { return this.stopUsageDriver(false); }
  stopNormalizer(reason) { return this.stopNormalizerDriver(reason); }
  stopNormalizerOperation(operation) { return this.stopNormalizerOperationDriver(operation); }
  finishNormalizer() { return this.finishNormalizerDriver(); }
  pullOnce(modify) { this.beginDriverPull(); const work = this.read().then(() => undefined); modify?.(work); return this.ownDriverPull(work); }
}
const gate = t => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  // Register unconditional release before dispatch/acquisition.
  t.signal.addEventListener('abort', resolve, { once: true }); t.after(resolve);
  return { promise, resolve };
};
const ticks = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const stream = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array([65])); c.enqueue(new Uint8Array([66])); c.close(); } });

for (const role of ['source', 'consumer', 'public']) test('fixed ' + role + ' handoff is void, ordered and ignores duplicate/stale callbacks', { timeout: 5000 }, async t => {
  const owner = new FixtureReader(role), parent = new ProxyCompletion(), order = [];
  let calls = 0, gets = 0, stale;
  parent.startPrivateLeaf(() => owner.retired); parent.seal();
  t.after(() => { stale = undefined; owner.stop(); });
  owner.open(stream(), reader => {
    const read = reader.read;
    Object.defineProperty(reader, 'read', { get() {
      gets++;
      return function (...args) {
        assert.equal(this, reader); assert.deepEqual(args, []); calls++;
        const poison = { get done() { assert.fail('stale done'); }, get value() { assert.fail('stale value'); } };
        if (stale) { const earlier = stale; stale = undefined; earlier(poison); }
        const original = Reflect.apply(read, this, args).then(value => ({
          get done() { order.push('d'); return value.done; }, get value() { order.push('v'); return value.value; },
        }));
        const then = original.then;
        Object.defineProperty(original, 'then', { value(yes, no) {
          return Reflect.apply(then, this, [value => { yes(value); yes(poison); no(undefined); stale = yes; }, no]);
        } });
        return original;
      };
    } });
  });
  assert.equal(await owner.pullOnce(), undefined); assert.deepEqual([...owner.captured], [65]);
  assert.equal(await owner.pullOnce(), undefined); assert.deepEqual([...owner.captured], [66]);
  assert.equal(calls, 2); assert.equal(gets, 2); assert.equal(owner.captures, 2);
  assert.equal(order.join(''), (role === 'public' ? 'dv' : 'vd').repeat(2));
  await owner.stop(); assert.deepEqual(owner.failures, []); assert.equal(owner.body, undefined);
  assert.deepEqual(await parent.completion, { failed: false, unused: false });
});

for (const order of ['before', 'after']) for (const fail of [false, true])
test('fixed returned unlock joins native-' + order + ' and rejection presence=' + fail, { timeout: 5000 }, async t => {
  const held = gate(t), owner = new FixtureReader('public'); let calls = 0, native = 0, settled = false;
  owner.open(stream(), reader => {
    const unlock = reader.releaseLock;
    Object.defineProperty(reader, 'releaseLock', { value(...args) {
      assert.equal(this, reader); assert.deepEqual(args, []); calls++;
      if (order === 'before') { Reflect.apply(unlock, this, args); native++; }
      return held.promise.then(() => {
        if (order === 'after') { Reflect.apply(unlock, this, args); native++; }
        if (fail) throw undefined;
      });
    } });
  });
  await owner.read(); const retirement = owner.stop(); retirement.then(() => { settled = true; });
  await ticks(); assert.equal(calls, 1); assert.equal(native, order === 'before' ? 1 : 0);
  assert.equal(settled, false); assert.notEqual(owner.reader, undefined);
  held.resolve(); await retirement; assert.equal(native, 1); assert.equal(calls, 1);
  assert.deepEqual(owner.failures.map(x => [x.kind, x.undefined]), fail ? [['unlock', true]] : []);
});

test('fixed independent closed joins after successful read without becoming a read failure', { timeout: 5000 }, async t => {
  const held = gate(t), owner = new FixtureReader('consumer'); let retired = false;
  owner.open(stream(), reader => Object.defineProperty(reader, 'closed', { get() { return held.promise.then(() => { throw undefined; }); } }));
  await owner.read(); assert.deepEqual([...owner.captured], [65]);
  const original = owner.stop(); original.then(() => { retired = true; });
  await ticks(); assert.equal(retired, false); assert.equal(owner.failures.length, 0);
  held.resolve(); await original;
  assert.deepEqual(owner.failures.map(x => [x.kind, x.undefined]), [['closed', true]]);
});

test('fixed sync callback then installation throw keeps UNKNOWN and observes late original without recapture', { timeout: 5000 }, async t => {
  const owner = new FixtureReader('consumer'), body = stream(); let rejectPresence = false, invoked = 0;
  const reader = body.getReader(), read = reader.read;
  const original = Reflect.apply(read, reader, []), value = await original;
  Object.defineProperty(original, 'then', { value(yes) { yes(value); throw undefined; } });
  Object.defineProperty(reader, 'read', { value() { invoked++; return original; } });
  owner.body = body; owner.reader = reader;
  t.after(() => { owner.stop(); });
  try { await owner.read(); } catch (failure) { rejectPresence = true; assert.equal(failure.undefined, true); }
  assert.equal(rejectPresence, true); assert.equal(invoked, 1); assert.equal(owner.captures, 1);
  let retired = false; owner.stop().then(() => { retired = true; }); await ticks();
  assert.equal(owner.unknown, true); assert.equal(retired, false);
  // The known native work is settled and the actual reader unlocked. UNKNOWN
  // remains deliberate; this witness never claims its lifetime receipt retired.
  assert.equal(body.locked, false);
});

test('fixed cancellation keeps a late fulfilled capture owned until all original tails join', { timeout: 5000 }, async t => {
  const held = gate(t), owner = new FixtureReader('consumer'); let retired = false, cancels = 0;
  owner.open(stream(), reader => {
    const read = reader.read, cancel = reader.cancel;
    Object.defineProperty(reader, 'read', { value(...args) { return Reflect.apply(read, this, args).then(async value => { await held.promise; return value; }); } });
    Object.defineProperty(reader, 'cancel', { value(...args) { cancels++; return Reflect.apply(cancel, this, args); } });
  });
  const reading = owner.read(), retirement = owner.stop(); retirement.then(() => { retired = true; });
  await ticks(); assert.equal(retired, false); assert.equal(cancels, 1); assert.equal(owner.captures, 0);
  held.resolve(); assert.equal(await reading, undefined); await retirement;
  assert.equal(owner.captures, 1); assert.equal(owner.captured, undefined); assert.equal(cancels, 1);
});

for (const role of ['source', 'consumer', 'public']) test('fixed ' + role + ' projects done truthiness without coercion hooks or stale packed writes', async t => {
  const owner = new FixtureReader(role), order = []; let coercions = 0;
  const done = { [Symbol.toPrimitive]() { coercions++; throw new Error('no coercion'); } };
  t.after(() => { owner.stop(); });
  owner.open(stream(), reader => {
    const read = reader.read;
    Object.defineProperty(reader, 'read', { value(...args) {
      return Reflect.apply(read, this, args).then(value => ({
        get done() { order.push('d'); owner.uncertain(); return done; },
        get value() { order.push('v'); return value.value; },
      }));
    } });
  });
  await owner.read();
  assert.equal(owner.readDone, true); assert.equal(owner.unknown, true);
  assert.equal(owner.driverFlags & 32, 32, 'the external getter must not lose reentrant flag writes');
  assert.equal(coercions, 0); assert.equal(order.join(''), role === 'public' ? 'dv' : 'vd');
  owner.stop(); await ticks();
});

test('fixed READ keeps its readiness nonce after prompt installation failure and accepts the late original once', async t => {
  const owner = new FixtureReader('consumer'), body = stream();
  const reader = body.getReader(), original = reader.read(), value = await original;
  let accepted;
  t.after(() => { accepted?.(value); owner.stop(); });
  Object.defineProperty(original, 'then', { value(yes) { accepted = yes; throw undefined; } });
  Object.defineProperty(reader, 'read', { value() { return original; } });
  owner.body = body; owner.reader = reader;
  const readiness = owner.read();
  await assert.rejects(readiness, failure => failure.kind === 'read' && failure.undefined);
  assert.equal(owner.reading, readiness); assert.equal(owner.driverCapturing, true);
  owner.stop(); accepted(value); accepted({ get value() { assert.fail('duplicate capture'); } });
  await ticks();
  assert.equal(owner.captures, 1); assert.equal(owner.reading, undefined);
  assert.equal(owner.unknown, true); assert.equal(body.locked, false);
});

// UNRUN_CODE_ONLY_HOSTED: accepting a callback consumes its right before any
// result getter can reenter. This does not retire externally retained handlers.
for (const role of ['source', 'consumer', 'public']) test('fixed ' + role + ' consumes FIRST before a reentrant result getter', async t => {
  const owner = new FixtureReader(role), order = [];
  let saved, getters = 0;
  const foreign = {
    get value() { assert.fail('foreign duplicate value'); },
    get done() { assert.fail('foreign duplicate done'); },
  };
  t.after(() => { saved = undefined; owner.stop(); });
  owner.open(stream(), reader => {
    const read = reader.read;
    Object.defineProperty(reader, 'read', { value(...args) {
      const original = Reflect.apply(read, this, args), then = original.then;
      Object.defineProperty(original, 'then', { value(yes, no) {
        saved = yes;
        return Reflect.apply(then, this, [part => yes({
          get value() { getters++; order.push('v'); saved(foreign); return part.value; },
          get done() { getters++; order.push('d'); saved(foreign); return part.done; },
        }), no]);
      } });
      return original;
    } });
  });
  await owner.read();
  assert.equal(owner.captures, 1); assert.equal(getters, 2);
  assert.equal(order.join(''), role === 'public' ? 'dv' : 'vd');
  await owner.stop();
  saved(foreign); await ticks();
  assert.equal(owner.captures, 1); assert.equal(getters, 2);
  assert.deepEqual(owner.failures, []); assert.equal(owner.body, undefined);
});

for (const count of [148, 512]) test(`fixed observer cells detach after ${count} reads while external handlers remain retained`, async t => {
  const owner = new FixtureReader('consumer'), retained = [];
  let sequence = 0, reads = 0, hostileReads = 0;
  const foreign = { get value() { hostileReads++; throw Error('inert value'); }, get done() { hostileReads++; throw Error('inert done'); } };
  const reason = { get message() { hostileReads++; throw Error('inert reason'); } };
  const replay = () => { for (const item of retained) { item.yes(foreign); item.no(reason); } };
  const intercept = (work, kind) => {
    const then = work.then;
    Object.defineProperty(work, 'then', { value(yes, no) {
      const cell = kind === 'read' ? owner.readObservation : owner.pullObservation;
      assert.equal(cell.owner, owner); assert.ok(cell.token instanceof Promise);
      assert.equal(cell.state, 0);
      retained.push({ yes, no, cell });
      void Reflect.apply(then, this, [yes, no]);
      return undefined;
    } });
  };
  t.after(() => { retained.length = 0; owner.stop(); });
  owner.open(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([sequence++ & 255])); } }, { highWaterMark: 0 }), reader => {
    const read = reader.read;
    reader.read = function (...args) {
      replay(); reads++;
      const original = Reflect.apply(read, this, args); intercept(original, 'read'); return original;
    };
  });
  // Intercepting read.then runs after the driver has created the cell. The
  // fixture deliberately retains both callbacks and the cell for inspection.
  for (let index = 0; index < count; index++) {
    await owner.pullOnce(work => intercept(work, 'pull'));
    await ticks();
    for (const { cell } of retained.slice(-2)) {
      assert.deepEqual(Object.keys(cell).sort(), ['kind', 'owner', 'state', 'token']);
      assert.equal(cell.owner, undefined); assert.equal(cell.token, undefined);
      assert.equal(cell.kind, 0); assert.equal(cell.state, 8);
    }
    assert.equal(owner.readObservation, undefined); assert.equal(owner.pullObservation, undefined);
  }
  assert.equal(retained.length, 2 * count); assert.equal(owner.captures, count);
  await owner.stop(); replay(); await ticks();
  assert.equal(reads, count); assert.equal(owner.captures, count); assert.equal(hostileReads, 0);
  assert.equal(owner.body, undefined); assert.deepEqual(owner.failures, []);
});

test('fixed cell stays live across synchronous FIRST then failed installation', async t => {
  const owner = new FixtureReader('consumer'), body = stream(), reader = body.getReader();
  const original = reader.read(), part = await original;
  let cell, saved;
  t.after(() => { saved = undefined; owner.stop(); });
  original.then = function (yes) {
    cell = owner.readObservation; saved = yes;
    yes(part);
    assert.equal(cell.owner, owner); assert.equal(cell.state, 1, 'installation has not returned');
    throw undefined;
  };
  reader.read = () => original; owner.body = body; owner.reader = reader;
  const ready = owner.read();
  await assert.rejects(ready, failure => failure.undefined === true);
  await ticks();
  assert.equal(cell.owner, owner); assert.equal(cell.token, ready);
  assert.equal(cell.state & 4, 4); assert.equal(owner.readObservation, cell);
  saved({ get value() { assert.fail('accepted callback must remain closed'); } });
  owner.stop(); await ticks();
  assert.equal(owner.unknown, true); assert.equal(cell.owner, owner);
  assert.equal(body.locked, false);
});


// Authored only: these exercise DATA primitives; the existing compiled-private
// route cases establish caller authority, original I/O and exact retirement.
test('private byte kernel ignores mutable set/views/species and preserves fixed native offsets', t => {
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const names = ['set', 'subarray', 'slice'], saved = names.map(name => Object.getOwnPropertyDescriptor(typed, name));
  const species = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
  let accesses = 0;
  const restore = () => {
    names.forEach((name, index) => Object.defineProperty(typed, name, saved[index]));
    if (species) Object.defineProperty(Uint8Array, Symbol.species, species); else delete Uint8Array[Symbol.species];
  };
  t.after(restore);
  const source = new Uint8Array([9, 65, 66, 67, 8]);
  try {
    for (const name of names) Object.defineProperty(typed, name, { configurable: true, get() { accesses++; throw Error('private byte escape'); } });
    Object.defineProperty(Uint8Array, Symbol.species, { configurable: true, get() { accesses++; throw Error('species escape'); } });
    const view = ownedByteSubarray(source, 1, 4), copy = ownedByteSlice(view), destination = newOwnedBytes(5);
    copyOwnedBytes(destination, copy, 1);
    assert.deepEqual([...destination], [0, 65, 66, 67, 0]);
    assert.deepEqual(inspectOwnedBytes(view), { buffer: source.buffer, backing: 5, offset: 1, length: 3 });
    const encoded = newOwnedBytes(4), result = encodeOwnedTextInto(newOwnedEncoder(), 'A\uFFFD', encoded);
    assert.deepEqual(result, { read: 2, written: 4 });
    assert.equal(decodeOwnedBytes(newOwnedDecoder(), encoded), 'A\uFFFD');
    assert.equal(accesses, 0);
  } finally { restore(); }
});

test('private byte proof ignores public backing shadows and rejects unsupported storage', () => {
  const bytes = new Uint8Array(new ArrayBuffer(16385), 1, 2), backing = bytes.buffer;
  let accesses = 0;
  Object.defineProperty(bytes, 'buffer', { get() { accesses++; return new ArrayBuffer(2); } });
  Object.defineProperty(bytes, 'byteLength', { get() { accesses++; return 0; } });
  Object.defineProperty(backing, 'byteLength', { get() { accesses++; return 2; } });
  assert.equal(inspectOwnedBytes(bytes).backing, 16385);
  assert.equal(inspectOwnedBytes(bytes).length, 2); assert.equal(accesses, 0);
  for (const value of [new DataView(new ArrayBuffer(2)), new Uint16Array(2), { length: 2, 0: 65 }, new Proxy(new Uint8Array(2), {})])
    assert.throws(() => inspectOwnedBytes(value));
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => inspectOwnedBytes(new Uint8Array(new SharedArrayBuffer(2))));
  if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable'))
    assert.throws(() => inspectOwnedBytes(new Uint8Array(new ArrayBuffer(2, { maxByteLength: 4 }))));
});

test('private output handoff proves native controller before exposing a snapshot', async t => {
  let controller, hooks = 0;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  t.after(async () => { try { controller.close(); } catch {} await stream.cancel().catch(() => {}); });
  const bytes = newOwnedBytes(1); bytes[0] = 65;
  Object.defineProperty(controller, 'enqueue', { configurable: true, get() { hooks++; return ReadableStreamDefaultController.prototype.enqueue; } });
  assert.throws(() => enqueueOwnedBytes(controller, bytes)); assert.equal(hooks, 0);
  delete controller.enqueue;
  const fake = Object.create(ReadableStreamDefaultController.prototype);
  assert.throws(() => enqueueOwnedBytes(fake, bytes));
  enqueueOwnedBytes(controller, bytes);
  const reader = stream.getReader();
  try { assert.deepEqual((await reader.read()).value, bytes); } finally { reader.releaseLock(); }
});

// UNRUN_CODE_ONLY_HOSTED: the generic normalizer's one-argument originals are
// independent of the existing zero-argument reader roles.
for (const cancelThrows of [false, true])
test('normalizer one-argument FIRSTcancel still attempts unlock; synchronous throw=' + cancelThrows, { timeout: 5000 }, async t => {
  const owner = new FixtureReader('public'), held = gate(t), trace = [];
  const reason = Object.freeze({ marker: 'opaque caller reason' });
  let retired = false, cancelCalls = 0, unlockCalls = 0;
  owner.open(stream(), reader => {
    const cancel = reader.cancel, unlock = reader.releaseLock;
    Object.defineProperty(reader, 'cancel', { get() {
      trace.push('cancel-get');
      return function (...args) {
        cancelCalls++; trace.push('cancel-call'); assert.equal(this, reader); assert.deepEqual(args, [reason]);
        if (cancelThrows) throw undefined;
        return Reflect.apply(cancel, this, args);
      };
    } });
    reader.releaseLock = function (...args) {
      unlockCalls++; trace.push('unlock'); assert.equal(this, reader); assert.deepEqual(args, []);
      Reflect.apply(unlock, this, args); return held.promise;
    };
  });
  const operation = { signal: { get reason() { trace.push('reason'); return reason; } } };
  try {
    const original = owner.stopNormalizerOperation(operation); original.then(() => { retired = true; });
    await ticks(); assert.equal(retired, false);
    assert.deepEqual(trace, ['cancel-get', 'reason', 'cancel-call', 'unlock']);
    assert.equal(cancelCalls, 1); assert.equal(unlockCalls, 1);
    held.resolve(); await original;
    assert.deepEqual(owner.failures.filter(value => value.kind === 'cancel').map(value => value.undefined), cancelThrows ? [true] : []);
  } finally { held.resolve(); await owner.stopNormalizer(reason); }
});

for (const result of [undefined, null, false, 0])
test('normalizer EOF observes nonvoid unlock and never invents FIRSTcancel: ' + String(result), { timeout: 5000 }, async t => {
  const owner = new FixtureReader('public'), held = gate(t); let cancels = 0, unlocks = 0, retired = false;
  owner.open(stream(), reader => {
    const unlock = reader.releaseLock;
    reader.cancel = () => { cancels++; throw Error('EOF cancel'); };
    reader.releaseLock = function (...args) { unlocks++; Reflect.apply(unlock, this, args); return result; };
    Object.defineProperty(reader, 'closed', { get() { return held.promise; } });
  });
  try {
    const original = owner.finishNormalizer(); original.then(() => { retired = true; });
    await ticks(); assert.equal(retired, false); assert.equal(cancels, 0); assert.equal(unlocks, 1);
    held.resolve(); await original; assert.equal(owner.failures.length, 0);
  } finally { held.resolve(); await owner.finishNormalizer(); }
});

test('normalizer returned unlock ignores its hostile observer return and joins independent closed', { timeout: 5000 }, async t => {
  const owner = new FixtureReader('public'), unlockGate = gate(t), closedGate = gate(t);
  let inspected = 0, installed = 0, retired = false;
  const foreign = Object.defineProperty({}, 'then', { get() { inspected++; throw Error('foreign observer return'); } });
  owner.open(stream(), reader => {
    const unlock = reader.releaseLock;
    reader.releaseLock = function (...args) {
      Reflect.apply(unlock, this, args);
      const original = unlockGate.promise, then = original.then;
      Object.defineProperty(original, 'then', { value(yes, no) {
        installed++; assert.equal(this, original); assert.equal(arguments.length, 2);
        void Reflect.apply(then, this, [yes, no]); return foreign;
      } });
      return original;
    };
    Object.defineProperty(reader, 'closed', { get() { return closedGate.promise; } });
  });
  try {
    const original = owner.stopNormalizer(undefined); original.then(() => { retired = true; });
    await ticks(); assert.equal(installed, 1); assert.equal(inspected, 0); assert.equal(retired, false);
    unlockGate.resolve(); await ticks(); assert.equal(retired, false);
    closedGate.resolve(); await original; assert.equal(inspected, 0);
  } finally { unlockGate.resolve(); closedGate.resolve(); await owner.stopNormalizer(undefined); }
});

for (const order of ['before', 'after'])
test('generic usage delays unlock until original read and FIRSTcancel join: ' + order, { timeout: 5000 }, async t => {
  const owner = new FixtureReader('public'), readGate = gate(t), cancelGate = gate(t), unlockGate = gate(t);
  let reads = 0, cancels = 0, unlocks = 0, nativeUnlocked = 0;
  const reason = Object.freeze({ marker: 'actual reason' });
  owner.open(stream(), reader => {
    const read = reader.read, cancel = reader.cancel, unlock = reader.releaseLock;
    reader.read = function (...args) { reads++; return Reflect.apply(read, this, args).then(async value => { await readGate.promise; return value; }); };
    reader.cancel = function (...args) { cancels++; assert.deepEqual(args, [reason]); return Reflect.apply(cancel, this, args).then(() => cancelGate.promise); };
    reader.releaseLock = function (...args) {
      unlocks++;
      if (order === 'before') { Reflect.apply(unlock, this, args); nativeUnlocked++; }
      return unlockGate.promise.then(() => { if (order === 'after') { Reflect.apply(unlock, this, args); nativeUnlocked++; } });
    };
  });
  let readWork;
  try {
    readWork = owner.read(); const physical = owner.stopUsage(reason);
    await ticks(); assert.equal(reads, 1); assert.equal(cancels, 1); assert.equal(unlocks, 0);
    readGate.resolve(); await readWork; await ticks(); assert.equal(unlocks, 0);
    cancelGate.resolve(); await ticks(); assert.equal(unlocks, 1); assert.equal(nativeUnlocked, order === 'before' ? 1 : 0);
    unlockGate.resolve(); await physical; assert.equal(nativeUnlocked, 1);
  } finally { readGate.resolve(); cancelGate.resolve(); unlockGate.resolve(); await readWork; await owner.stopUsage(reason); }
});
