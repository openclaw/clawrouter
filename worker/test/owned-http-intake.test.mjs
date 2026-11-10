import './typescript-setup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateOwnedHttpChat } from '../index.ts';
import { bodyBudgetCharged } from '../body-budget.ts';

// Real compiled intake. Missing credentials terminate after parsing/selection;
// these witnesses do not need an authority, provider or a synthetic auth result.
async function intake(t, make, check) {
  const baseline = bodyBudgetCharged(), roots = [], origins = new WeakMap();
  let done = false, cleanupPromise, hasPrimary = false, primary;
  const own = promise => {
    if (origins.has(promise)) return origins.get(promise);
    const root = { used: false, outcome: promise.then(value => ({ failed: false, value }), error => ({ failed: true, error })) };
    roots.push(root); origins.set(promise, root); return root;
  };
  const take = async root => { const result = await root.outcome; root.used = true; if (result.failed) throw result.error; return result.value; };
  const cleanup = () => cleanupPromise ??= (async () => {
    const failures = [];
    for (let index = 0; index < roots.length; index++) await roots[index].outcome;
    for (const root of roots) { const result = await root.outcome; if (result.failed && !root.used) { root.used = true; failures.push(result.error); } }
    try { assert.equal(bodyBudgetCharged(), baseline); } catch (error) { failures.push(error); }
    return failures;
  })();
  t.after(async () => { if (!done) { const failures = await cleanup(); if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures); } });
  try {
    const request = make(), original = privateOwnedHttpChat.fetch(request, {}, { waitUntil: promise => { own(promise); }, passThroughOnException() {} });
    let body;
    const response = own(original);
    // Enroll a late body even if assertion/control work fails first.
    own(original.then(value => { body = own(value.text()); }, () => {}));
    const value = await take(response);
    await check(value, await take(body), baseline);
  } catch (error) { hasPrimary = true; primary = error; }
  const failures = await cleanup(); done = true;
  if (failures.length) throw new AggregateError(hasPrimary ? [primary, ...failures] : failures, 'owned intake fixture');
  if (hasPrimary) throw primary;
}

test('compiled intake funds small-wire large graphs BEFORE native JSON.parse', async t => {
  const count = 100000, wire = '{"model":"not-a-catalog-model","extra":[' + 'null,'.repeat(count - 1) + 'null]}';
  const original = JSON.parse; let calls = 0, charged = 0;
  t.mock.method(JSON, 'parse', function (text, reviver) {
    if (text === wire) { calls++; charged = bodyBudgetCharged(); }
    return Reflect.apply(original, this, [text, reviver]);
  });
  await intake(t, () => new Request('https://router.example/v1/chat/completions', { method: 'POST', body: wire }), async (response, text, baseline) => {
    assert.equal(response.status, 401); assert.equal(calls, 1);
    // The array's cells and null occurrences alone exceed its <1 MiB wire.
    // This assertion observes the genuine allocation boundary, not a test plan.
    assert.ok(charged - baseline >= 16 * count + 2 * wire.length);
    assert.equal(original(text).error.code, 'invalid_proxy_key');
  });
});

test('compiled intake retains WHOLE distinct input backings until their consumers clear', async t => {
  const wire = '{"model":"not-a-catalog-model","extra":null}', bytes = new TextEncoder().encode(wire), cut = 20;
  let peak = 0, stage = 0;
  await intake(t, () => new Request('https://router.example/v1/chat/completions', { method: 'POST', duplex: 'half', body: new ReadableStream({
    pull(controller) {
      peak = Math.max(peak, bodyBudgetCharged());
      if (stage === 2) { controller.close(); return; }
      const source = stage++ === 0 ? bytes.subarray(0, cut) : bytes.subarray(cut), backing = new Uint8Array(300 * 1024);
      backing.set(source); controller.enqueue(backing.subarray(0, source.length));
    },
  }, { highWaterMark: 0 }) }), async (response, _text, baseline) => {
    assert.equal(response.status, 401);
    assert.ok(peak - baseline >= 600 * 1024, 'two distinct original backings, not two tiny view lengths');
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
  await intake(t, () => new Request('https://router.example/v1/chat/completions', { method: 'POST', body: wire }), async response => {
    assert.equal(response.status, 401);
    assert.deepEqual(observed, { own: true, prototype: true, kept: true, escaped: true, depth: 1500, leaf: null, lastWins: true });
  });
});
