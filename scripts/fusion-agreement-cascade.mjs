import assert from 'node:assert/strict';

const modelId = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 256;
async function bounded(signal, operation) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

// Caller-owned native verification and budget admission; no provider calls here.
export async function runAgreementCascade({ draftModel, peerModel = draftModel, fallbackModel,
  expectedTests, expectedComparisons, invokeAndVerify, compare, onStep = () => {},
  deadlineMs = 900000, signal: callerSignal }) {
  assert.ok([draftModel, peerModel, fallbackModel].every(modelId), 'invalid_agreement_models');
  assert.ok([expectedTests, expectedComparisons].every(n => Number.isSafeInteger(n) && n > 0), 'invalid_agreement_counts');
  assert.ok(typeof invokeAndVerify === 'function' && typeof compare === 'function' && typeof onStep === 'function', 'invalid_agreement_callback');
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 1800000, 'invalid_agreement_deadline');
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const started = performance.now(), checks = [], steps = [];
  let costMicros = 0, agreement = null;
  async function call(phase, model) {
    assert.ok(steps.length < 3, 'agreement_call_limit');
    const start = performance.now();
    const receipt = await bounded(signal, () => invokeAndVerify({ phase, model, signal }));
    assert.ok(receipt && Object.hasOwn(receipt, 'artifact') && receipt.artifact !== undefined, 'missing_agreement_artifact');
    assert.ok(Number.isSafeInteger(receipt.costMicros) && receipt.costMicros >= 0
      && Number.isSafeInteger(costMicros + receipt.costMicros), 'invalid_agreement_cost');
    if (receipt.artifact === null) assert.equal(receipt.tests, null, 'tests_without_agreement_artifact');
    else {
      assert.equal(receipt.tests?.valid, true, 'incomplete_agreement_native_verification');
      assert.equal(receipt.tests.assertions, expectedTests, 'agreement_native_count');
      assert.equal(typeof receipt.tests.passed, 'boolean', 'invalid_agreement_native_verdict');
      for (const counter of ['skipped', 'cancelled', 'todo']) {
        assert.ok(!(counter in receipt.tests) || receipt.tests[counter] === 0, 'incomplete_agreement_native_verification');
      }
    }
    costMicros += receipt.costMicros;
    const candidate = { artifact: structuredClone(receipt.artifact), passed: receipt.tests?.passed === true };
    checks.push(receipt);
    const step = { phase, model, costMicros: receipt.costMicros, nativePassed: candidate.passed, elapsedMs: performance.now() - start };
    steps.push(step);
    await bounded(signal, () => onStep({ ...step }));
    return candidate;
  }
  const finish = candidate => ({ passed: candidate.passed, artifact: candidate.artifact,
    checks, steps, agreement, costMicros, elapsedMs: performance.now() - started });
  const first = await call('draft', draftModel);
  if (first.passed) {
    const peer = await call('peer', peerModel);
    if (peer.passed) {
      const result = await bounded(signal, () => compare({ first: structuredClone(first.artifact), second: structuredClone(peer.artifact), signal }));
      assert.equal(result?.valid, true, 'incomplete_agreement_comparison');
      assert.equal(result.compared, expectedComparisons, 'agreement_comparison_count');
      assert.ok(Number.isSafeInteger(result.mismatches) && result.mismatches >= 0 && result.mismatches <= expectedComparisons,
        'invalid_agreement_mismatches');
      assert.equal(result.agreed, result.mismatches === 0, 'invalid_agreement_verdict');
      agreement = structuredClone(result);
      if (agreement.agreed) return finish(first);
    }
  }
  return finish(await call('fallback', fallbackModel));
}
