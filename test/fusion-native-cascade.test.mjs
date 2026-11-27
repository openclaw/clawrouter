import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeCascade } from '../scripts/fusion-native-cascade.mjs';
import { testResult } from '../scripts/fusion-workloads.mjs';

const config = { draftModel: 'provider/cheap', fallbackModel: 'provider/strong', expectedTests: 3 };
const receipt = passed => ({ artifact: { patch: 'source' }, costMicros: 7,
  tests: { valid: true, passed, assertions: 3 } });

test('opt-in fallback repair uses the latest strong artifact and public feedback in either mode', async () => {
  for (const fallbackMode of ['fresh', 'repair']) {
    const calls = [];
    const strong = { ...receipt(false), artifact: { patch: 'strong' }, publicFeedback: 'strong failure', privateFinal: 'hidden' };
    const result = await runNativeCascade({ ...config, fallbackMode, fallbackAttempts: 2,
      invokeAndVerify: async request => {
        calls.push(request);
        if (request.phase === 'initial') return { ...receipt(false), publicFeedback: 'draft failure' };
        if (request.phase === 'fallback') return strong;
        assert.equal(request.phase, 'fallback-repair');
        assert.deepEqual(request.draft, strong.artifact); assert.notEqual(request.draft, strong.artifact);
        assert.equal(request.feedback, 'strong failure');
        assert.ok(!JSON.stringify(request).includes('hidden'));
        request.draft.patch = 'mutated';
        return receipt(true);
      } });
    assert.equal(strong.artifact.patch, 'strong');
    assert.equal(result.passed, true); assert.equal(result.costMicros, 21); assert.equal(result.checks.length, 3);
    assert.deepEqual(calls.map(c => [c.phase, c.model]), [['initial', config.draftModel],
      ['fallback', config.fallbackModel], ['fallback-repair', config.fallbackModel]]);
  }
});

test('fallback repair stops at success or its three-call ceiling and preserves missing feedback', async () => {
  for (const successfulCall of [1, 2, 3, 4]) {
    let calls = 0;
    const result = await runNativeCascade({ ...config, fallbackMode: 'repair', fallbackAttempts: 2,
      invokeAndVerify: async request => {
        calls++;
        if (calls === 1) return { ...receipt(calls === successfulCall), publicFeedback: 'old draft feedback' };
        if (calls === 3) { assert.equal(request.feedback, null); assert.equal(request.draft, null); }
        return calls === 2 && successfulCall > 2 ? { artifact: null, tests: null, costMicros: 7 }
          : receipt(calls === successfulCall);
      } });
    assert.equal(calls, Math.min(successfulCall, 3));
    assert.equal(result.passed, successfulCall <= 3); assert.equal(result.costMicros, 7 * calls);
  }
});

test('second-fallback opt-in preserves feedback, native validation and cancellation boundaries', async () => {
  for (const defect of ['count', 'invalid', 'feedback', 'cancel']) {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(runNativeCascade({ ...config, fallbackAttempts: 2, signal: controller.signal,
      invokeAndVerify: async () => {
        if (++calls === 1) return receipt(false);
        const row = receipt(false);
        if (defect === 'count') row.tests.assertions--;
        if (defect === 'invalid') row.tests.valid = false;
        if (defect === 'feedback') row.publicFeedback = 'é'.repeat(6001);
        if (defect === 'cancel') controller.abort(Error('cancelled'));
        return row;
      } }));
    assert.equal(calls, 2);
  }
  let calls = 0;
  for (const fallbackAttempts of [0, 3, 1.5, '2']) await assert.rejects(runNativeCascade({ ...config, fallbackAttempts,
    invokeAndVerify: async () => { calls++; return receipt(false); } }), /invalid_verified_workflow/);
  assert.equal(calls, 0);
});

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
  let feedbackReads = 0;
  class NativeReceipt {
    constructor() { Object.assign(this, receipt(false), { privateFinal: 'must not reach fallback' }); }
    get publicFeedback() { feedbackReads++; return 'public case failed'; }
  }
  const initial = new NativeReceipt();
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
  assert.equal(feedbackReads, 1);
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


test('a parsed passing TAP receipt with skipped tests is incomplete', async () => {
  const parsed = testResult({ code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(
    '# tests 3\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n') });
  assert.equal(parsed.valid, true); assert.equal(parsed.passed, true);
  let calls = 0;
  await assert.rejects(runNativeCascade({ ...config, invokeAndVerify: async () => {
    calls++; return { ...receipt(true), tests: { ...parsed, assertions: parsed.tests } };
  } }), /incomplete_native_verification/);
  assert.equal(calls, 1);
});

test('incomplete counters stop every native phase without another model call', async () => {
  for (const rejectedCall of [1, 2, 3]) for (const key of ['skipped', 'cancelled', 'todo']) {
    for (const value of [1, -1, 0.5, NaN, '0', null, undefined]) {
      let calls = 0;
      await assert.rejects(runNativeCascade({ ...config, fallbackAttempts: 2,
        invokeAndVerify: async () => {
          const r = receipt(++calls === rejectedCall);
          if (calls === rejectedCall) r.tests[key] = value;
          return r;
        } }), /incomplete_native_verification/);
      assert.equal(calls, rejectedCall);
    }
  }
});

test('explicit zero native counters preserve parser prototypes', async () => {
  class Counters { get skipped() { return 0; } get cancelled() { return 0; } get todo() { return 0; } }
  const saved = receipt(true); saved.tests = Object.assign(new Counters(), saved.tests);
  const result = await runNativeCascade({ ...config, invokeAndVerify: async () => saved });
  assert.equal(result.passed, true); assert.equal(result.checks[0], saved);
});
