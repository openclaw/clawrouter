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
