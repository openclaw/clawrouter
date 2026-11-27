import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgreementCascade } from '../scripts/fusion-agreement-cascade.mjs';

const options = { draftModel: 'one/small', peerModel: 'two/small', fallbackModel: 'three/strong',
  expectedTests: 3, expectedComparisons: 4 };
const receipt = (artifact, passed = true) => ({ artifact, costMicros: 7, tests: { valid: true, passed, assertions: 3 } });
const agreement = mismatches => ({ valid: true, compared: 4, mismatches, agreed: mismatches === 0 });

test('independent native passes and complete agreement accept the first draft with both costs', async () => {
  const calls = [], steps = [];
  const result = await runAgreementCascade({ ...options, onStep: step => steps.push(step),
    invokeAndVerify: async request => { calls.push(request); return receipt({ value: request.phase }); },
    compare: async ({ first, second }) => {
      assert.deepEqual(first, { value: 'draft' }); assert.deepEqual(second, { value: 'peer' }); return agreement(0);
    } });
  assert.deepEqual(calls.map(c => [c.phase, c.model]), [['draft', 'one/small'], ['peer', 'two/small']]);
  assert.equal(result.costMicros, 14); assert.equal(result.passed, true); assert.deepEqual(result.artifact, { value: 'draft' });
  assert.deepEqual(result.steps, steps); assert.ok(steps.every(s => !Object.hasOwn(s, 'artifact')));
});

test('a public-passing but divergent draft triggers a fresh verified fallback', async () => {
  for (const fallbackPassed of [true, false]) {
    const calls = [];
    const result = await runAgreementCascade({ ...options,
      invokeAndVerify: async request => {
        calls.push(request); assert.deepEqual(Object.keys(request).sort(), ['model', 'phase', 'signal']);
        return receipt(request.phase, request.phase === 'fallback' ? fallbackPassed : true);
      }, compare: async () => agreement(1) });
    assert.deepEqual(calls.map(c => c.phase), ['draft', 'peer', 'fallback']);
    assert.equal(result.artifact, 'fallback'); assert.equal(result.passed, fallbackPassed); assert.equal(result.costMicros, 21);
  }
});

test('native failures skip needless peers or comparisons and preserve null artifacts', async () => {
  for (const failed of ['draft', 'peer']) for (const missing of [false, true]) {
    const calls = [];
    const result = await runAgreementCascade({ ...options,
      invokeAndVerify: async ({ phase }) => {
        calls.push(phase);
        return phase === failed && missing ? { artifact: null, tests: null, costMicros: 5 } : receipt(phase, phase !== failed);
      }, compare: async () => { assert.fail('comparison must not run'); } });
    assert.deepEqual(calls, failed === 'draft' ? ['draft', 'fallback'] : ['draft', 'peer', 'fallback']);
    assert.equal(result.passed, true); assert.equal(result.agreement, null);
    assert.equal(result.costMicros, calls.length * 7 - (missing ? 2 : 0));
  }
});

test('comparison receives independent clones and cannot change the returned draft', async () => {
  const shared = { value: 'original' };
  const result = await runAgreementCascade({ ...options,
    invokeAndVerify: async () => receipt(shared), compare: async ({ first, second }) => {
      first.value = 'changed'; assert.equal(second.value, 'original'); return agreement(0);
    } });
  assert.deepEqual(result.artifact, shared); assert.equal(shared.value, 'original');
});

test('unknown or contradictory comparison results stop without fallback', async () => {
  for (const value of [null, {}, { ...agreement(0), valid: false }, { ...agreement(0), compared: 0 },
    { ...agreement(0), compared: 3 }, { ...agreement(0), mismatches: -1 }, { ...agreement(0), mismatches: 5 },
    { ...agreement(0), mismatches: 0.5 }, { ...agreement(0), agreed: 'true' }, { ...agreement(0), mismatches: 1 }]) {
    let calls = 0;
    await assert.rejects(runAgreementCascade({ ...options,
      invokeAndVerify: async () => { calls++; return receipt('draft'); }, compare: async () => value }));
    assert.equal(calls, 2);
  }
});

test('invalid native receipts, costs and callbacks cannot trigger another call', async () => {
  for (const change of [r => { r.tests.valid = false; }, r => { r.tests.assertions = 2; },
    r => { r.tests.passed = 1; }, r => { r.costMicros = -1; }, r => { r.artifact = null; }, r => { delete r.artifact; }]) {
    let calls = 0;
    await assert.rejects(runAgreementCascade({ ...options,
      invokeAndVerify: async () => { calls++; const r = receipt('draft'); change(r); return r; }, compare: async () => agreement(0) }));
    assert.equal(calls, 1);
  }
  for (const change of [{ compare: null }, { draftModel: '' }, { peerModel: 1 }, { fallbackModel: '' },
    { expectedComparisons: 0 }, { expectedTests: 1.5 }, { deadlineMs: -1 }]) {
    let calls = 0;
    await assert.rejects(runAgreementCascade({ ...options, compare: async () => agreement(0),
      invokeAndVerify: async () => { calls++; return receipt('draft'); }, ...change }));
    assert.equal(calls, 0);
  }
});

test('errors, cancellation and deadline end the workflow without a fallback', async () => {
  for (const stage of ['invoke', 'compare', 'step']) {
    let calls = 0;
    await assert.rejects(runAgreementCascade({ ...options,
      invokeAndVerify: async () => { calls++; if (stage === 'invoke') throw Error('broken'); return receipt('draft'); },
      onStep: async () => { if (stage === 'step') throw Error('broken'); },
      compare: async () => { throw Error('broken'); } }), /broken/);
    assert.equal(calls, stage === 'compare' ? 2 : 1);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runAgreementCascade({ ...options, signal: controller.signal,
    invokeAndVerify: async () => { calls++; return receipt('draft'); },
    compare: async () => { controller.abort(Error('cancelled')); return agreement(0); } }), /cancelled/);
  assert.equal(calls, 2);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(runAgreementCascade({ ...options, deadlineMs: 5,
      invokeAndVerify: () => new Promise(() => {}), compare: async () => agreement(0) }), { name: 'TimeoutError' });
  } finally { clearTimeout(keepAlive); }
});
