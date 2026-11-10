import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnedReaderDriver, ProxyCompletion } from '../proxy-completion.ts';

// Mechanical driver witnesses complement the actual private Workerd route.
// This fixture receiver is never exported by the Worker or counted as a fourth
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
    if (this.role === 'public') { this.readDone = value.done; this.captured = value.value; }
    else { this.captured = value.value; this.readDone = value.done; }
  }
  driverCleared() {}
  open(body, modify) { this.body = body; this.reader = body.getReader(); modify?.(this.reader); this.observeDriverClosed(false); }
  read() { return this.startDriverRead(); }
  stop() { return this.stopDriver(true); }
  pullOnce() { this.beginDriverPull(); return this.ownDriverPull(this.read().then(() => undefined)); }
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
