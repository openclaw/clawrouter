import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerifiedPool } from '../scripts/fusion-verified-pool.mjs';
const passed = { runtimePassed: true, compilerPassed: true };
const options = () => ({ models: ['small-a', 'small-b', 'small-c'],
  reserve: async () => ({ costCapsMicros: [10, 10, 10] }),
  invoke: async ({ index }) => ({ artifact: { index }, costMicros: index + 1 }), verify: async () => passed });

test('reserves once before concurrent dispatch, selects input order and charges unused candidates', async () => {
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers()), entered = [];
  const allStarted = Promise.withResolvers(); let reserved = false, verified = false;
  const result = runVerifiedPool({ ...options(), reserve: async ({ models }) => {
    assert.deepEqual(models, options().models); reserved = true; return { costCapsMicros: [10, 10, 10] };
  }, invoke: async ({ index }) => {
    assert.equal(reserved, true); assert.equal(verified, false); entered.push(index);
    if (entered.length === 3) allStarted.resolve();
    await gates[index].promise; return { artifact: { index }, costMicros: index + 1 };
  }, verify: async ({ artifact }) => { verified = true; artifact.index = 99; return passed; } });
  await allStarted.promise; gates[2].resolve(); gates[1].resolve(); gates[0].resolve();
  const actual = await result;
  assert.deepEqual(entered, [0, 1, 2]); assert.equal(actual.selectedIndex, 0);
  assert.deepEqual(actual.artifact, { index: 0 }); assert.equal(actual.costMicros, 6);
  assert.equal(actual.candidates.length, 3); assert.equal(actual.steps.length, 1);
});

test('failed checks cannot pass or select by final grades, and null artifacts are rejected', async () => {
  const seen = [];
  const actual = await runVerifiedPool({ ...options(), invoke: async ({ index }) => ({ artifact: index === 0 ? null : { index }, costMicros: 1 }),
    verify: async ({ index }) => { seen.push(index); return { runtimePassed: true, compilerPassed: index === 2 }; } });
  assert.deepEqual(seen, [1, 2]); assert.equal(actual.selectedIndex, 2); assert.equal(actual.costMicros, 3);
  const rejected = await runVerifiedPool({ ...options(), verify: async () => ({ runtimePassed: false, compilerPassed: true }) });
  assert.equal(rejected.passed, false); assert.equal(rejected.artifact, null); assert.equal(rejected.steps.length, 3);
});

test('reservation rejection or malformed aggregate permits never dispatches a candidate', async () => {
  let calls = 0;
  for (const reserve of [async () => { throw Error('budget denied'); }, async () => ({ costCapsMicros: [1] }), async () => ({ costCapsMicros: Array(3) }),
    async () => ({ costCapsMicros: [Number.MAX_SAFE_INTEGER, 1, 1] })]) {
    await assert.rejects(runVerifiedPool({ ...options(), reserve, invoke: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test('a generation error aborts peers and does not trigger verification or fallback', async () => {
  const ready = Promise.withResolvers(); let entered = 0, aborted = 0, verified = 0;
  await assert.rejects(runVerifiedPool({ ...options(), invoke: async ({ index, signal }) => {
    if (++entered === 3) ready.resolve(); await ready.promise;
    if (index === 1) throw Error('provider failed');
    await new Promise((_, reject) => {
      const fail = () => { aborted++; reject(signal.reason); };
      signal.addEventListener('abort', fail, { once: true }); if (signal.aborted) fail();
    });
  }, verify: async () => { verified++; return passed; } }), /provider failed/);
  assert.equal(entered, 3); assert.equal(aborted, 2); assert.equal(verified, 0);
});

test('caller cancellation bounds coordinator without treating unknown costs as a refund', async () => {
  const controller = new AbortController(), ready = Promise.withResolvers(); let calls = 0;
  const pending = runVerifiedPool({ ...options(), signal: controller.signal, invoke: async () => {
    if (++calls === 3) ready.resolve(); return new Promise(() => {});
  } });
  await ready.promise; controller.abort(Error('cancelled')); await assert.rejects(pending, /cancelled/);
  assert.equal(calls, 3);
});

test('over-cap generation and malformed verification receipts fail closed', async () => {
  await assert.rejects(runVerifiedPool({ ...options(), invoke: async () => ({ artifact: {}, costMicros: 11 }) }), /generation_receipt/);
  await assert.rejects(runVerifiedPool({ ...options(), verify: async () => ({ runtimePassed: true }) }), /verification_receipt/);
});

test('cancellation during preflight prevents fan-out and sparse model lists are invalid', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(); let calls = 0;
  const pending = runVerifiedPool({ ...options(), signal: controller.signal, reserve: async () => {
    entered.resolve(); return new Promise(() => {});
  }, invoke: async () => { calls++; } });
  await entered.promise; controller.abort(Error('preflight cancelled'));
  await assert.rejects(pending, /preflight cancelled/); assert.equal(calls, 0);
  await assert.rejects(runVerifiedPool({ ...options(), models: Array(3) }), /invalid_verified_pool/);
});
