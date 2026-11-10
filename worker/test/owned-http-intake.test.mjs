import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateOwnedHttpChat } from '../index.ts';
import { bodyBudgetCharged } from '../body-budget.ts';
import { beginOwnedHttpRequest, finishOwnedHttpRequest, ownedHttpFailureMetadata } from '../http-identity-owner.ts';
import { acceptOwnedHttpControlVerification, proxyKeyVerification } from '../proxy-auth.ts';
import { isIdentityFailure } from '../identity-admission.ts';
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

// Real compiled intake. Missing credentials terminate after parsing/selection;
// these witnesses do not need an authority, provider or a synthetic auth result.
async function intake(t, make, check, beforeResponse, checkCleanup) {
  const baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap(), releases = [];
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
    try { assert.equal(bodyBudgetCharged(), baseline); } catch (error) { failures.push(error); }
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
  t.mock.method(JSON, 'parse', function (text, reviver) {
    if (text === wire) { calls++; charged = bodyBudgetCharged(); }
    return Reflect.apply(original, this, [text, reviver]);
  });
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
  const original = JSON.parse; let observed;
  t.mock.method(JSON, 'parse', function (text, reviver) {
    const value = Reflect.apply(original, this, [text, reviver]);
    if (text === wire) {
      let nested = value.extra, depth = 0;
      while (Array.isArray(nested) && nested.length === 1) { depth++; nested = nested[0]; }
      observed = { own: Object.hasOwn(value, '__proto__'), prototype: Object.getPrototypeOf(value) === Object.prototype,
        kept: value.__proto__.kept, escaped: value.escapedk === '\ud800', depth, leaf: nested,
        lastWins: value.repeat.unknown.length === 3 && value.repeat.unknown[0] === null && value.repeat.unknown[1] === false && value.repeat.unknown[2] === 7 };
    }
    return value;
  });
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
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', function (text, reviver) {
    const value = Reflect.apply(originalParse, this, [text, reviver]);
    if (value?.model === 'not-a-catalog-model') parsed = value.extra;
    return value;
  });
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
