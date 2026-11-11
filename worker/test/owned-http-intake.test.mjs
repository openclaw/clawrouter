import { ownedStaticHeld } from '../../test/helpers/owned-static-custody-observer.mjs';
await import('./typescript-setup.mjs');
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { runInNewContext } from 'node:vm';
let observeIntakeCell;
let observeIntakeStep;
let observeConfigurationSlot;
let observeIntakeParse;
globalThis.__ownedIntakeParseFixture = (phase, value) => observeIntakeParse?.(phase, value);
globalThis.__ownedConfigurationSlotFixture = (preparation, slot) => observeConfigurationSlot?.(preparation, slot);
globalThis.__ownedIntakeCellFixture = cell => observeIntakeCell?.(cell);
globalThis.__ownedIntakeStepFixture = step => observeIntakeStep?.(step);
const intakeHook = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/worker/proxy.ts') && !url.endsWith('/worker/provider-templates.ts')) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  if (url.endsWith('/worker/provider-templates.ts')) {
    const anchor = 'configurationApply(configurationSet, privateConfigurations ??= new configurationMap(), [preparation, slot]);';
    assert.equal(source.split(anchor).length - 1, 1);
    return { ...result, source: source.replace(anchor, anchor + '\n  globalThis.__ownedConfigurationSlotFixture(preparation, slot);') };
  }
  const anchor = 'else this.closed = cell;\n    return cell;';
  assert.equal(source.split(anchor).length - 1, 1);
  let observed = source.replace(anchor, 'else this.closed = cell;\n    globalThis.__ownedIntakeCellFixture(cell); return cell;');
  for (const [needle, step] of [['method = copyOwnedBytes;', 'set'], ['method(destination, operand as Uint8Array);', 'copy']]) {
    assert.equal(observed.split(needle).length - 1, 1);
    observed = observed.replace(needle, needle + ' globalThis.__ownedIntakeStepFixture("' + step + '");');
  }
  const parse = 'parsed = ownedIntakeJsonParse(text); text = "";';
  assert.equal(observed.split(parse).length - 1, 1);
  observed = observed.replace(parse, 'globalThis.__ownedIntakeParseFixture("before", text); parsed = ownedIntakeJsonParse(text); globalThis.__ownedIntakeParseFixture("after", parsed); text = "";');
  return { ...result, source: observed };
} });
after(() => { intakeHook.deregister(); delete globalThis.__ownedIntakeCellFixture; delete globalThis.__ownedIntakeStepFixture; delete globalThis.__ownedConfigurationSlotFixture; delete globalThis.__ownedIntakeParseFixture; });
const { privateOwnedHttpChat } = await import('../index.ts');
const { proxyOwnedHttpChat } = await import('../proxy.ts');
const { bodyBudgetCharged } = await import('../body-budget.ts');
const { beginOwnedHttpRequest, finishOwnedHttpRequest, ownedHttpFailureMetadata } = await import('../http-identity-owner.ts');
const { acceptOwnedHttpControlVerification, proxyKeyVerification } = await import('../proxy-auth.ts');
const { isIdentityFailure } = await import('../identity-admission.ts');
const { PreparationAdmission, beginPrivateConfiguration, consumePrivateConfiguration } = await import('../provider-templates.ts');
import { accessBytesResponse } from './access-byte-fixture.mjs';

const bytesRequest = wire => new Request('https://router.example/v1/chat/completions', {
  method: 'POST', duplex: 'half', body: accessBytesResponse(wire).body,
});

test('HTTP control proof cannot be installed from a caller-supplied identity graph', async () => {
  const baseline = bodyBudgetCharged(), request = new Request('https://router.example/v1/chat/completions');
  const cap = beginOwnedHttpRequest(request, {}), before = bodyBudgetCharged();
  const identity = { authType: 'proxy_key', credentialId: 'fixture', principalId: null };
  let hasPrimary = false, primary;
  try {
    for (const candidate of [cap, Object.freeze({})]) {
      assert.throws(() => acceptOwnedHttpControlVerification(candidate, identity, 'fixture', null, 'ab'.repeat(32), undefined), isIdentityFailure);
      assert.equal(proxyKeyVerification(identity), undefined);
      assert.equal(bodyBudgetCharged(), before, 'forged proof denied before allocation');
    }
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = [];
  try { await finishOwnedHttpRequest(cap); } catch (error) { failures.push(error); }
  try { assert.equal(bodyBudgetCharged(), baseline); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures);
  if (hasPrimary) throw primary;
});

test('forged and mismatched intake capabilities start no claim, receipt or body access', async () => {
  const original = bytesRequest('{}'), supplied = bytesRequest('{}'), env = {};
  const cap = beginOwnedHttpRequest(original, env), before = bodyBudgetCharged(), shared = ownedStaticHeld();
  let bodyGets = 0, cells = 0, registrations = 0;
  Object.defineProperty(supplied, 'body', { get() { bodyGets++; throw Error('unvalidated body access'); } });
  observeIntakeCell = () => { cells++; };
  try {
    const context = { waitUntil() { registrations++; }, passThroughOnException() {} };
    for (const candidate of [Object.freeze({}), cap]) {
      await assert.rejects(proxyOwnedHttpChat(candidate, supplied, env, context), isIdentityFailure);
      assert.equal(bodyBudgetCharged(), before); assert.equal(ownedStaticHeld(), shared);
      assert.equal(bodyGets, 0); assert.equal(cells, 0); assert.equal(registrations, 0);
    }
  } finally { observeIntakeCell = undefined; await finishOwnedHttpRequest(cap); }
});

// Real compiled intake. Missing credentials terminate after parsing/selection;
// these witnesses do not need an authority, provider or a synthetic auth result.
async function intake(t, make, check, beforeResponse, checkCleanup) {
  const sharedBefore = ownedStaticHeld(), baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), releases = [];
  let done = false, cleanupPromise, hasPrimary = false, primary;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    roots.push(root); origins.set(promise, root); return root;
  };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (const release of releases) try { release(); } catch (error) { failures.push(error); }
    for (let index = 0; index < roots.length; index++) await roots[index].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.used) { root.used = true; failures.push(result.error); } }
    try { assert.equal(bodyBudgetCharged(), baseline + ownedStaticHeld() - sharedBefore); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!done) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    const request = make({ releases }), original = privateOwnedHttpChat.fetch(request, {}, { waitUntil: promise => { own(promise); }, passThroughOnException() {} });
    let body;
    const response = own(original);
    // Enroll a late body even if assertion/control work fails first.
    own(original.then(value => { body = own(value.text()); }, () => {}));
    if (beforeResponse) await beforeResponse({ original, baseline, releases });
    const value = await take(response);
    await check(value, await take(body), baseline);
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); done = true;
  if (checkCleanup && !hasPrimary) {
    try { checkCleanup(failures); }
    catch (validation) { throw new AggregateError([...failures, validation], 'intake cleanup validation preserves every origin'); }
  } else if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'owned intake fixture');
  if (hasPrimary) throw primary;
}

test('compiled intake funds small-wire large graphs BEFORE native JSON.parse', async t => {
  const count = 100000, wire = '{"model":"not-a-catalog-model","extra":[' + 'null,'.repeat(count - 1) + 'null]}';
  const original = JSON.parse; let calls = 0, charged = 0;
  observeIntakeParse = (phase, text) => { if (phase === 'before' && text === wire) { calls++; charged = bodyBudgetCharged(); } };
  t.after(() => { observeIntakeParse = undefined; });
  await intake(t, () => bytesRequest(wire), async (response, text, baseline) => {
    assert.equal(response.status, 401); assert.equal(calls, 1);
    // The array's cells and null occurrences alone exceed its <1 MiB wire.
    // This assertion observes the genuine allocation boundary, not a test plan.
    assert.ok(charged - baseline >= 16 * count + 2 * wire.length);
    assert.equal(original(text).error.code, 'invalid_proxy_key');
  });
});

test('compiled intake prefunds ORIGINAL native BYOB backings and copies short chunks without retaining oversized buffers', async t => {
  const wire = '{"model":"not-a-catalog-model","extra":null}', bytes = new TextEncoder().encode(wire), cut = 20;
  const reads = []; let stage = 0;
  await intake(t, () => new Request('https://router.example/v1/chat/completions', { method: 'POST', duplex: 'half', body: new ReadableStream({
    type: 'bytes', pull(controller) {
      const view = controller.byobRequest.view;
      reads.push({ backing: view.buffer.byteLength, charged: bodyBudgetCharged() });
      if (stage === 2) { controller.close(); controller.byobRequest.respond(0); return; }
      const source = stage++ === 0 ? bytes.subarray(0, cut) : bytes.subarray(cut);
      view.set(source); controller.byobRequest.respond(source.byteLength);
    },
  }, { highWaterMark: 0 }) }), async (response, _text, baseline) => {
    assert.equal(response.status, 401);
    assert.equal(reads.length, 3, 'both ORIGINAL chunks plus EOF');
    assert.ok(reads.every(row => row.backing === 16384 && row.charged - baseline >= 131072), 'WHOLE provided and returned backings admitted before every original read');
  });
});

test('native JSON grammar, deep unknown data, duplicate keys and own __proto__ survive intake', async t => {
  const wire = '{"model":"not-a-catalog-model","__proto__":{"kept":true},"escaped\\u006b":"\\ud800","extra":'
    + '['.repeat(1500) + 'null' + ']'.repeat(1500) + ',"repeat":0,"repeat":{"unknown":[null,false,7]}}';
  let observed;
  observeIntakeParse = (phase, value) => {
    if (phase === 'after') {
      let nested = value.extra, depth = 0;
      while (Array.isArray(nested) && nested.length === 1) { depth++; nested = nested[0]; }
      observed = { own: Object.hasOwn(value, '__proto__'), prototype: Object.getPrototypeOf(value) === Object.prototype,
        kept: value.__proto__.kept, escaped: value.escapedk === '\ud800', depth, leaf: nested,
        lastWins: value.repeat.unknown.length === 3 && value.repeat.unknown[0] === null && value.repeat.unknown[1] === false && value.repeat.unknown[2] === 7 };
    }
  };
  t.after(() => { observeIntakeParse = undefined; });
  await intake(t, () => bytesRequest(wire), async response => {
    assert.equal(response.status, 401);
    assert.deepEqual(observed, { own: true, prototype: true, kept: true, escaped: true, depth: 1500, leaf: null, lastWins: true });
  });
});

test('positive tiny intake reads retain a bounded prefix slab rather than read history', async t => {
  const wire = '{"model":"not-a-catalog-model","extra":"' + 'x'.repeat(5000) + '"}';
  const bytes = new TextEncoder().encode(wire), charges = new Map(); let offset = 0;
  await intake(t, () => new Request('https://router.example/v1/chat/completions', { method: 'POST', duplex: 'half', body: new ReadableStream({
    type: 'bytes', pull(controller) {
      if (offset === 1024 || offset === 4096) charges.set(offset, bodyBudgetCharged());
      if (offset === bytes.length) { controller.close(); controller.byobRequest.respond(0); return; }
      controller.byobRequest.view[0] = bytes[offset++]; controller.byobRequest.respond(1);
    },
  }, { highWaterMark: 0 }) }), async response => {
    assert.equal(response.status, 401); assert.equal(offset, bytes.length);
    assert.equal(charges.size, 2);
    assert.ok(charges.get(4096) - charges.get(1024) < 32768, 'text/graph growth remains funded without one retained owner/view per byte');
  });
});

for (const beforeCapture of [false, true]) test(`intake snapshots actual read bytes; mutation before capture=${beforeCapture}`, async t => {
  const wire = '{"model":"not-a-catalog-model","extra":"first"}', bytes = new TextEncoder().encode(wire);
  const cut = wire.indexOf('first') + 5, marker = wire.indexOf('first');
  let offset = 0, previous, parsed;
  observeIntakeParse = (phase, value) => { if (phase === 'after' && value?.model === 'not-a-catalog-model') parsed = value.extra; };
  t.after(() => { observeIntakeParse = undefined; });
  await intake(t, () => {
    const request = new Request('https://router.example/v1/chat/completions', { method: 'POST', duplex: 'half', body: new ReadableStream({
      type: 'bytes', pull(controller) {
        if (!beforeCapture && previous) { previous[marker] = 70; previous = undefined; }
        if (offset === bytes.length) { controller.close(); controller.byobRequest.respond(0); return; }
        const end = offset === 0 ? cut : bytes.length;
        controller.byobRequest.view.set(bytes.subarray(offset, end)); controller.byobRequest.respond(end - offset); offset = end;
      },
    }, { highWaterMark: 0 }) });
    const getReader = request.body.getReader;
    request.body.getReader = function (options) {
      const reader = Reflect.apply(getReader, this, [options]), read = reader.read;
      reader.read = function (view) {
        return Reflect.apply(read, this, [view]).then(result => {
          if (!result.done && result.value.byteLength === cut) {
            if (beforeCapture) result.value[marker] = 70; else previous = result.value;
          }
          return result;
        });
      };
      return reader;
    };
    return request;
  }, async response => {
    assert.equal(response.status, 401); assert.equal(parsed, beforeCapture ? 'First' : 'first');
  });
});


function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
for (const order of ['before', 'after', 'closed']) for (const kind of ['success', 'undefined', 'shared'])
test(`compiled intake joins actual ${order} unlock/closed originals: ${kind}`, async t => {
  const held = gate(), release = gate();
  const counts = { unlock: 0, unlocked: 0, settled: 0, closed: 0, reasonReads: 0 };
  const reason = kind === 'undefined' ? undefined : Object.freeze({
    get message() { counts.reasonReads++; throw Error('must not inspect cleanup reason'); },
    get stack() { counts.reasonReads++; throw Error('must not inspect cleanup reason'); },
  });
  await intake(t, ({ releases }) => {
    releases.push(() => release.resolve()); // Before dispatch, including setup/assertion failure.
    const request = bytesRequest('{"model":"not-a-catalog-model","extra":"accepted"}');
    const acquire = request.body.getReader;
    request.body.getReader = function (...args) {
      const reader = Reflect.apply(acquire, this, args), unlock = reader.releaseLock;
      if (order === 'closed') {
        const closed = reader.closed;
        const original = closed.then(async () => {
          counts.closed++; held.resolve(); await release.promise;
          counts.settled++; if (kind !== 'success') throw reason;
        });
        Object.defineProperty(reader, 'closed', { get() { return original; } });
      }
      reader.releaseLock = function (...args) {
        counts.unlock++;
        const native = () => { Reflect.apply(unlock, this, args); counts.unlocked++; };
        if (order === 'closed') { native(); return; }
        if (order === 'before') native();
        held.resolve();
        return release.promise.then(() => {
          if (order === 'after') native();
          counts.settled++; if (kind !== 'success') throw reason;
        });
      };
      return reader;
    };
    return request;
  }, async response => {
    assert.equal(response.status, kind === 'success' || order === 'closed' ? 401 : 500);
    assert.deepEqual(counts, { unlock: 1, unlocked: 1, settled: 1, closed: Number(order === 'closed'), reasonReads: 0 });
  }, async ({ original, baseline }) => {
    let finished = false;
    const observed = original.then(() => { finished = true; }, () => { finished = true; });
    await Promise.race([held.promise, observed.then(() => { throw Error('intake finished before original hold'); })]);
    assert.equal(finished, false, 'intake cleanup-before-return is preserved');
    assert.ok(bodyBudgetCharged() > baseline, 'pending original keeps its request debit');
    if (order !== 'closed') assert.equal(counts.unlocked, Number(order === 'before'));
    release.resolve(); await observed;
  }, failures => {
    if (kind === 'success') { assert.deepEqual(failures, []); return; }
    // Only our own final request aggregate is inspected in this fixture. Raw
    // foreign reasons never cross this diagnostic boundary.
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof AggregateError);
    const rows = failures[0].errors.map(ownedHttpFailureMetadata);
    assert.ok(rows.every(Boolean));
    assert.deepEqual(rows.map(row => row.origin), [order === 'closed' ? 'closed' : 'unlock']);
    assert.equal(rows[0].primaryIsUndefined, kind === 'undefined');
  });
});


// UNRUN_CODE_ONLY_HOSTED. The hook exposes actual cells only in this compiled
// fixture; the Worker exports no cell, diagnostic getter or caller strategy.
for (const minimum of [148, 512]) test(`compiled intake severs ${minimum} retained callback pairs without changing getter order`, async t => {
  const retained = [], wire = '{"model":"not-a-catalog-model","extra":"' + 'x'.repeat(minimum) + '"}';
  let current, order = '', reads = 0, touched = 0, coercions = 0;
  const foreign = { get value() { touched++; throw Error('foreign value'); }, get done() { touched++; throw Error('foreign done'); } };
  const truthy = { [Symbol.toPrimitive]() { coercions++; throw Error('done coercion'); } };
  const replay = () => { for (const row of retained) {
    assert.deepEqual(Object.keys(row.cell).sort(), ['flags', 'kind', 'owner', 'ready', 'resolve']);
    assert.equal(row.cell.flags, 8); assert.equal(row.cell.kind, 0);
    assert.equal(row.cell.owner, undefined); assert.equal(row.cell.ready, undefined); assert.equal(row.cell.resolve, undefined);
    row.yes(foreign); row.no(foreign);
  } };
  observeIntakeCell = cell => { if (cell.kind === 1) current = cell; };
  t.after(() => { observeIntakeCell = undefined; current = undefined; retained.length = 0; });
  await intake(t, () => {
    const request = bytesRequest(wire), acquire = request.body.getReader, nativeThen = Promise.prototype.then;
    request.body.getReader = function (...args) {
      const reader = Reflect.apply(acquire, this, args), read = reader.read;
      reader.read = function (view) {
        assert.equal(this, reader); assert.equal(arguments.length, 1); assert.equal(view.byteLength, 16384);
        replay(); reads++;
        const original = Reflect.apply(read, this, [view.subarray(0, 1)]);
        original.then = function (yes, no) {
          assert.equal(this, original); assert.equal(arguments.length, 2); assert.equal(current.kind, 1);
          retained.push({ cell: current, yes, no });
          void Reflect.apply(nativeThen, this, [part => yes({
            get done() { order += 'd'; yes(foreign); no(foreign); return part.done ? truthy : false; },
            get value() { order += 'v'; assert.equal(part.done, false); yes(foreign); return part.value; },
          }), no]);
          return undefined;
        };
        return original;
      };
      return reader;
    };
    return request;
  }, async response => {
    assert.equal(response.status, 401); assert.ok(reads > minimum);
    assert.equal(order, 'dvvv'.repeat(reads - 1) + 'd');
    replay(); assert.equal(touched, 0); assert.equal(coercions, 0);
  });
});

test('compiled intake preserves arbitrarily interspersed empty results without retained cell history', async t => {
  let reads = 0, empties = 0, previous;
  const wire = '{"model":"not-a-catalog-model"}';
  observeIntakeCell = cell => {
    if (cell.kind !== 1) return;
    if (previous) { assert.equal(previous.owner, undefined); assert.equal(previous.flags, 8); }
    previous = cell;
  };
  t.after(() => { observeIntakeCell = undefined; previous = undefined; });
  await intake(t, () => {
    const request = bytesRequest(wire), acquire = request.body.getReader;
    request.body.getReader = function (...args) {
      const reader = Reflect.apply(acquire, this, args), read = reader.read;
      reader.read = function (view) {
        reads++;
        if (reads % 65) { empties++; return Promise.resolve({ done: false, value: new Uint8Array(0) }); }
        return Reflect.apply(read, this, [view.subarray(0, 1)]);
      };
      return reader;
    };
    return request;
  }, async response => {
    assert.equal(response.status, 401); assert.ok(empties > 1024);
    assert.equal(previous.owner, undefined); assert.equal(previous.flags, 8);
  });
});

// Small admitted-operand witnesses: the largest backing here is16385 bytes.
// No large-backing counterexample is allocated or run as a fixture.
const operandCases = [
  'third-bytes', 'cross-realm', 'shadow-buffer', 'shadow-backing-length',
  'value1-oversized', 'value2-oversized', 'value3-oversized',
  'length-one-to-four', 'length-four-to-one', 'length-object',
  'array-like', 'data-view', 'other-typed-array', 'shared-buffer', 'resizable-buffer',
  'set-accessor', 'set-replacement', 'set-shadow', 'set-change-in-third-getter',
];
for (const name of operandCases) test('compiled intake admits the actual operand: ' + name, async t => {
  if (name === 'shared-buffer' && typeof SharedArrayBuffer === 'undefined') { t.skip('engine has no SharedArrayBuffer'); return; }
  if (name === 'resizable-buffer' && !Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')) { t.skip('legacy fixed-buffer engine'); return; }
  const valid = ['third-bytes', 'cross-realm', 'shadow-buffer', 'shadow-backing-length', 'set-accessor', 'set-replacement', 'set-shadow', 'set-change-in-third-getter'].includes(name);
  const oversized = name.endsWith('-oversized'), steps = [], parsed = [];
  const typed = Object.getPrototypeOf(Uint8Array.prototype), setDescriptor = Object.getOwnPropertyDescriptor(typed, 'set');
  const uint8SetDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
  let exposed = 0, customCopies = 0, coerced = 0, indexed = 0, got = 0, first = true;
  const nativeThen = Promise.prototype.then;
  const restore = () => {
    Object.defineProperty(typed, 'set', setDescriptor);
    if (uint8SetDescriptor) Object.defineProperty(Uint8Array.prototype, 'set', uint8SetDescriptor);
    else delete Uint8Array.prototype.set;
  };
  t.after(() => { restore(); observeIntakeStep = undefined; });
  observeIntakeStep = step => steps.push(step);
  observeIntakeParse = (phase, text) => { if (phase === 'before') parsed.push(text); };
  t.after(() => { observeIntakeParse = undefined; });
  let one = new Uint8Array([91, 93]), two = new Uint8Array([48, 48]), three = new Uint8Array([123, 125]);
  let projectedLength = 2, firstBuffer = one.buffer;
  if (oversized) {
    const view = new Uint8Array(new ArrayBuffer(16385), 0, 2); view.set([123, 125]);
    if (name === 'value1-oversized') { one = view; firstBuffer = new ArrayBuffer(2); }
    else if (name === 'value2-oversized') two = view;
    else three = view;
  }
  if (name === 'cross-realm') three = runInNewContext('new Uint8Array([123,125])');
  if (name === 'shadow-buffer') {
    Object.defineProperty(two, 'buffer', { get() { throw Error('VALUE2 shadow is not native proof'); } });
    Object.defineProperty(three, 'buffer', { get() { throw Error('VALUE3 shadow is not native proof'); } });
    Object.defineProperty(three, 'length', { get() { throw Error('VALUE3 shadow length is not native proof'); } });
  }
  if (name === 'shadow-backing-length') Object.defineProperty(three.buffer, 'byteLength', { get() { throw Error('backing shadow is not native proof'); } });
  if (name === 'value1-oversized') Object.defineProperty(one.buffer, 'byteLength', { value: 2 });
  if (name === 'length-one-to-four') { projectedLength = 1; three = new Uint8Array([49, 50, 51, 52]); }
  if (name === 'length-four-to-one') { projectedLength = 4; three = new Uint8Array([48]); }
  if (name === 'length-object') projectedLength = { [Symbol.toPrimitive]() { coerced++; throw Error('length coercion'); } };
  if (name === 'array-like') three = { length: 2, buffer: new ArrayBuffer(2), byteLength: 2,
    get 0() { indexed++; throw Error('array-like index'); }, get 1() { indexed++; throw Error('array-like index'); } };
  if (name === 'data-view') three = new DataView(new ArrayBuffer(2));
  if (name === 'other-typed-array') three = new Uint16Array(1);
  if (name === 'shared-buffer') three = new Uint8Array(new SharedArrayBuffer(2));
  if (name === 'resizable-buffer') three = new Uint8Array(new ArrayBuffer(2, { maxByteLength: 4 }));
  Object.defineProperty(one, 'buffer', { get() { steps.push('buffer1'); return firstBuffer; } });
  Object.defineProperty(two, 'byteLength', { get() { steps.push('length2'); return projectedLength; } });
  const changed = { configurable: true, get() { exposed++; return setDescriptor.value; } };
  const result = {
    get done() { steps.push('done'); return false; },
    get value() {
      got++; steps.push('value' + got);
      if (got === 3 && name === 'set-change-in-third-getter') Object.defineProperty(typed, 'set', changed);
      return got === 1 ? one : got === 2 ? two : three;
    },
  };
  await intake(t, ({ releases }) => {
    releases.push(restore);
    const request = bytesRequest('{}'), acquire = request.body.getReader;
    request.body.getReader = function (...args) {
      const reader = Reflect.apply(acquire, this, args), read = reader.read;
      reader.read = function (view) {
        const original = Reflect.apply(read, this, [view]);
        original.then = function (yes, no) {
          void Reflect.apply(nativeThen, this, [part => {
            if (!first || part.done) { yes(part); return; }
            first = false;
            if (name === 'set-accessor') Object.defineProperty(typed, 'set', changed);
            else if (name === 'set-shadow') Object.defineProperty(Uint8Array.prototype, 'set', changed);
            else if (name === 'set-replacement') Object.defineProperty(typed, 'set', { ...setDescriptor, value() { customCopies++; } });
            try { yes(result); } finally { restore(); }
          }, no]);
          return undefined;
        };
        return original;
      };
      return reader;
    };
    return request;
  }, async response => {
    assert.equal(response.status, 401, 'existing authentication-before-rethrow precedence');
    assert.equal(exposed, 0); assert.equal(customCopies, 0); assert.equal(coerced, 0); assert.equal(indexed, 0);
    assert.deepEqual(parsed, valid ? ['{}'] : []);
    assert.equal(steps.includes('copy'), valid);
    if (valid) assert.deepEqual(steps, ['done', 'value1', 'buffer1', 'value2', 'length2', 'set', 'value3', 'copy']);
    else if (name === 'value1-oversized') assert.deepEqual(steps, ['done', 'value1', 'buffer1']);
    else if (name === 'value2-oversized' || name === 'length-object') assert.deepEqual(steps, ['done', 'value1', 'buffer1', 'value2', 'length2']);
    else if (name.startsWith('set-')) assert.deepEqual(steps, ['done', 'value1', 'buffer1', 'value2', 'length2']);
    else assert.deepEqual(steps, ['done', 'value1', 'buffer1', 'value2', 'length2', 'set', 'value3']);
  }, undefined, failures => {
    if (valid || oversized) { assert.deepEqual(failures, []); return; }
    assert.equal(failures.length, 1); assert.ok(failures[0] instanceof AggregateError);
    const rows = failures[0].errors.map(ownedHttpFailureMetadata);
    assert.equal(rows.length, 1); assert.equal(rows[0]?.origin, 'read');
  });
});


// UNRUN_CODE_ONLY_HOSTED: actual initial-selection registration; no fabricated
// provider permit or alternate registry is installed by these fixtures.
test('private configuration refuses an unrelated preparation before funding or slot creation', async () => {
  const request = bytesRequest('{}'), env = {}, cap = beginOwnedHttpRequest(request, env);
  const before = bodyBudgetCharged(), shared = ownedStaticHeld(); let slots = 0;
  observeConfigurationSlot = () => { slots++; };
  try {
    for (const candidate of [Object.freeze({}), cap]) {
      assert.throws(() => beginPrivateConfiguration(candidate, new PreparationAdmission()), isIdentityFailure);
      assert.throws(() => beginPrivateConfiguration(candidate, new PreparationAdmission(), Object.freeze({})), isIdentityFailure);
    }
    assert.equal(slots, 0); assert.equal(bodyBudgetCharged(), before); assert.equal(ownedStaticHeld(), shared);
  } finally { observeConfigurationSlot = undefined; await finishOwnedHttpRequest(cap); }
});

test('private initial-selection nonce clears its parent and cannot match a later command', async t => {
  const observed = [];
  observeConfigurationSlot = (preparation, slot) => observed.push({ preparation, slot, nonce: slot.nonce });
  try {
    for (let index = 0; index < 2; index++) {
      await intake(t, () => bytesRequest('{"model":"not-a-catalog-model"}'), async (response, text) => {
        assert.equal(response.status, 401); assert.equal(JSON.parse(text).error.code, 'invalid_proxy_key');
      });
      const current = observed[index]; assert.ok(current);
      assert.equal(current.slot.http, undefined); assert.equal(current.slot.nonce, undefined); assert.equal(current.slot.error, undefined);
      assert.equal(consumePrivateConfiguration(current.preparation, current.nonce, Object.freeze({})), false);
    }
    assert.equal(observed.length, 2); assert.notEqual(observed[0].nonce, observed[1].nonce);
    assert.equal(consumePrivateConfiguration(observed[1].preparation, observed[0].nonce, Object.freeze({})), false);
  } finally { observeConfigurationSlot = undefined; }
});


for (const [factory, code, message, status, argument] of [
  ['privateGrantTransportFailure', 'grant_transport_unavailable', 'upstream authorization does not support this operation', 400],
  ['privateProviderConfigurationFailure', 'provider_request_invalid', 'provider request configuration is invalid', 503],
  ['privateMissingCredentialFailure', 'provider_not_configured', 'provider fixture has no usable upstream credential', 503, 'provider'],
  ['privateAwsCredentialFailure', 'provider_not_configured', 'AWS access key, secret key, and region are required', 503],
  ['privateTransportBodyFailure', 'provider_request_invalid', 'system instruction transforms require a JSON object body', 400],
  ['privateGrantTemplateFailure', 'grant_transport_unavailable', 'grant transport requires accountId', 400, 'name'],
]) test(`private current configuration constructor ${factory} keeps its exact once-only origin`, async t => {
  const commands = await import('../provider-templates.ts');
  let providerReads = 0, calls = 0;
  observeConfigurationSlot = (preparation, slot) => {
    calls++;
    const value = argument === 'provider' ? { get id() { providerReads++; return 'fixture'; } } : argument === 'name' ? 'accountId' : undefined;
    const error = commands[factory](preparation, value);
    assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.message, message);
    assert.equal(commands.matchesPrivateConfigurationError(preparation, error), true);
    assert.equal(commands.matchesPrivateConfigurationError(preparation, error), true, 'nested observation does not consume');
    assert.equal(commands.consumePrivateConfiguration(preparation, Object.freeze({}), error), false);
    assert.equal(commands.consumePrivateConfiguration(preparation, slot.nonce, error), true);
    assert.equal(commands.consumePrivateConfiguration(preparation, slot.nonce, error), false);
  };
  try { await intake(t, () => bytesRequest('{"model":"not-a-catalog-model"}'), async response => assert.equal(response.status, 401)); }
  finally { observeConfigurationSlot = undefined; }
  assert.equal(calls, 1); assert.equal(providerReads, argument === 'provider' ? 1 : 0);
});

for (const reason of ['lookalike', 'undefined', 'opaque'])
test(`private Env getter ${reason} is normalized only at its source boundary`, async t => {
  const commands = await import('../provider-templates.ts');
  const { HttpError } = await import('../utils.ts');
  let getterCalls = 0, inspected = 0;
  const opaque = {};
  for (const field of ['message', 'code', 'status', 'cause', 'stack']) Object.defineProperty(opaque, field, { get() { inspected++; throw Error('opaque reason inspected'); } });
  const thrown = reason === 'lookalike' ? new HttpError(402, 'budget_exhausted', 'forged') : reason === 'opaque' ? opaque : undefined;
  observeConfigurationSlot = (preparation, slot) => {
    const env = { get CONFIG() { getterCalls++; throw thrown; } };
    let failure;
    try { preparation.read(env, 'CONFIG'); } catch (error) { failure = error; }
    assert.equal(failure.status, 503); assert.equal(failure.code, 'provider_request_invalid');
    assert.equal(failure.message, 'provider request configuration is invalid');
    assert.equal(commands.consumePrivateConfiguration(preparation, slot.nonce, failure), true);
  };
  try { await intake(t, () => bytesRequest('{"model":"not-a-catalog-model"}'), async response => assert.equal(response.status, 401)); }
  finally { observeConfigurationSlot = undefined; }
  assert.equal(getterCalls, 1); assert.equal(inspected, 0);
});

// The fixture observes the captured constructor site; replacing the public
// JSON.parse method must neither receive private text nor inject a body graph.
test('private intake uses the trusted native constructor after prospective admission', async t => {
  const native = JSON.parse, wire = '{"model":"not-a-catalog-model","extra":true}';
  let exposed = 0, parsed = 0;
  observeIntakeParse = (phase, value) => { if (phase === 'after') { parsed++; assert.equal(value.extra, true); } };
  t.mock.method(JSON, 'parse', function (text, reviver) {
    if (text === wire) { exposed++; throw Error('private text escaped'); }
    return Reflect.apply(native, this, [text, reviver]);
  });
  t.after(() => { observeIntakeParse = undefined; });
  await intake(t, () => bytesRequest(wire), async response => assert.equal(response.status, 401));
  assert.equal(exposed, 0); assert.equal(parsed, 1);
});
