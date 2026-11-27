import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeCascade } from '../scripts/fusion-native-cascade.mjs';

const config = { draftModel: 'provider/cheap', fallbackModel: 'provider/strong', expectedTests: 3 };
const receipt = passed => ({ artifact: { patch: 'source' }, costMicros: 7,
  tests: { valid: true, passed, assertions: 3 } });

test('verified native draft stops without dispatching fallback', async () => {
  const calls = [], steps = [];
  const result = await runNativeCascade({ ...config, onStep: step => steps.push(step),
    invokeAndVerify: async request => { calls.push(request); return receipt(true); } });
  assert.equal(result.passed, true); assert.equal(result.costMicros, 7);
  assert.deepEqual(calls.map(c => [c.phase, c.model]), [['initial', config.draftModel]]);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.deepEqual(steps, result.steps); assert.equal(Object.hasOwn(steps[0], 'artifact'), false);
});

test('valid native failure gets one fresh fallback and retains both costs', async () => {
  const requests = [];
  const result = await runNativeCascade({ ...config, invokeAndVerify: async request => {
    requests.push(request); return receipt(request.phase === 'fallback');
  } });
  assert.equal(result.passed, true); assert.equal(result.costMicros, 14);
  assert.deepEqual(requests.map(c => [c.phase, c.model]), [['initial', config.draftModel], ['fallback', config.fallbackModel]]);
  assert.ok(requests.every(request => !Object.hasOwn(request, 'artifact') && !Object.hasOwn(request, 'feedback')));
});

test('repair fallback receives an isolated draft and only explicit public feedback', async () => {
  const initial = { ...receipt(false), publicFeedback: 'public case failed', privateFinal: 'must not reach fallback' };
  initial.tests.diagnostics = 'also not copied';
  let calls = 0;
  const result = await runNativeCascade({ ...config, fallbackMode: 'repair', invokeAndVerify: async request => {
    if (++calls === 1) {
      assert.equal(Object.hasOwn(request, 'draft'), false);
      assert.equal(Object.hasOwn(request, 'feedback'), false);
      return initial;
    }
    assert.equal(request.phase, 'fallback'); assert.equal(request.model, config.fallbackModel);
    assert.deepEqual(request.draft, initial.artifact); assert.notEqual(request.draft, initial.artifact);
    assert.equal(request.feedback, 'public case failed');
    assert.ok(!JSON.stringify(request).includes('must not reach fallback'));
    assert.ok(!JSON.stringify(request).includes('also not copied'));
    request.draft.patch = 'mutated';
    return receipt(true);
  } });
  assert.equal(initial.artifact.patch, 'source'); assert.equal(calls, 2);
  assert.equal(result.passed, true); assert.equal(result.costMicros, 14);
});

test('repair fallback handles unusable drafts and terminates after a failed repair', async () => {
  let calls = 0;
  const result = await runNativeCascade({ ...config, fallbackMode: 'repair', invokeAndVerify: async request => {
    if (++calls === 1) return { artifact: null, tests: null, costMicros: 5, publicFeedback: 'invalid edit' };
    assert.equal(request.draft, null); assert.equal(request.feedback, 'invalid edit');
    return receipt(false);
  } });
  assert.equal(calls, 2); assert.equal(result.passed, false); assert.equal(result.costMicros, 12);
});

test('unusable drafts without explicit feedback pass null instead of a workflow diagnostic', async () => {
  let calls = 0;
  const result = await runNativeCascade({ ...config, fallbackMode: 'repair', invokeAndVerify: async request => {
    if (++calls === 1) return { artifact: null, tests: null, costMicros: 5 };
    assert.equal(request.draft, null); assert.equal(request.feedback, null);
    return receipt(true);
  } });
  assert.equal(result.passed, true); assert.equal(calls, 2); assert.equal(result.costMicros, 12);
});

test('repair feedback is optional and rejects non-string or oversized values before fallback', async () => {
  for (const value of [undefined, '', 'é'.repeat(6000), 'é'.repeat(6001), {}, null]) {
    let calls = 0;
    const run = runNativeCascade({ ...config, fallbackMode: 'repair', invokeAndVerify: async request => {
      if (++calls === 1) return { ...receipt(false), publicFeedback: value };
      assert.equal(request.feedback, value ?? null); return receipt(true);
    } });
    if (value === undefined || typeof value === 'string' && Buffer.byteLength(value) <= 12000) {
      assert.equal((await run).passed, true); assert.equal(calls, 2);
    } else {
      await assert.rejects(run, /invalid_native_public_feedback/); assert.equal(calls, 1);
    }
  }
});

test('repair mode preserves native count, cancellation and configuration gates', async () => {
  for (const tests of [{ valid: false, passed: false, assertions: 3 },
    { valid: true, passed: false, assertions: 2 }]) {
    let calls = 0;
    await assert.rejects(runNativeCascade({ ...config, fallbackMode: 'repair', invokeAndVerify: async () => {
      calls++; return { ...receipt(false), tests, publicFeedback: 'repair me' };
    } }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const invokeAndVerify = async () => { calls++; return receipt(false); };
  await assert.rejects(runNativeCascade({ ...config, fallbackMode: 'unknown', invokeAndVerify }), /invalid_native_fallback_mode/);
  await assert.rejects(runNativeCascade({ ...config, fallbackMode: 'repair',
    signal: AbortSignal.abort(Error('cancelled')), invokeAndVerify }), /cancelled/);
  assert.equal(calls, 0);
});

test('unusable artifact stays explicit and failed fallback terminates', async () => {
  let calls = 0;
  const result = await runNativeCascade({ ...config, invokeAndVerify: async () => ++calls === 1
    ? { artifact: null, tests: null, costMicros: 5 } : receipt(false) });
  assert.equal(result.passed, false); assert.equal(result.costMicros, 12); assert.equal(calls, 2);
});

test('native receipt prototypes survive while accepted artifacts remain isolated', async () => {
  class FinalPlan { constructor() { this.end = 3; } }
  const saved = receipt(true); saved.tests.plan = new FinalPlan();
  const result = await runNativeCascade({ ...config, invokeAndVerify: async () => saved });
  assert.deepEqual(result.checks, [saved]); assert.equal(result.checks[0].tests.plan instanceof FinalPlan, true);
  result.artifact.patch = 'changed'; assert.equal(saved.artifact.patch, 'source');
});

test('invalid or incomplete native checks stop without authorizing another call', async () => {
  for (const change of [r => { r.tests.valid = false; }, r => { r.tests.assertions = 2; },
    r => { r.tests.passed = 'true'; }, r => { delete r.artifact; }, r => { r.costMicros = -1; },
    r => { r.artifact = null; }]) {
    let calls = 0;
    await assert.rejects(runNativeCascade({ ...config, invokeAndVerify: async () => {
      calls++; const r = receipt(false); change(r); return r;
    } }));
    assert.equal(calls, 1);
  }
});

test('configuration errors, callback errors and cancellation never dispatch fallback', async () => {
  let calls = 0;
  const invokeAndVerify = async () => { calls++; throw Error('provider_stopped'); };
  await assert.rejects(runNativeCascade({ ...config, expectedTests: 0, invokeAndVerify }), /invalid_expected_tests/);
  assert.equal(calls, 0);
  await assert.rejects(runNativeCascade({ ...config, invokeAndVerify }), /provider_stopped/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  await assert.rejects(runNativeCascade({ ...config, signal: controller.signal, invokeAndVerify: async () => {
    calls++; controller.abort(Error('cancelled')); return receipt(false);
  } }), /cancelled/);
  assert.equal(calls, 2);
});
