import assert from 'node:assert/strict';
import { runVerifiedWorkflow } from './fusion-verified-workflow.mjs';

// The caller owns model admission, accounting and isolated native execution.
export async function runNativeCascade({ draftModel, fallbackModel, expectedTests, invokeAndVerify,
  signal, deadlineMs, onStep, fallbackMode = 'fresh' }) {
  assert.ok(Number.isSafeInteger(expectedTests) && expectedTests > 0, 'invalid_expected_tests');
  assert.equal(typeof invokeAndVerify, 'function', 'invalid_native_adapter');
  assert.ok(['fresh', 'repair'].includes(fallbackMode), 'invalid_native_fallback_mode');
  const checks = [];
  let publicFeedback = null;
  const result = await runVerifiedWorkflow({ strategy: 'cascade', fallbackMode,
    models: { draft: draftModel, repair: fallbackModel }, signal, deadlineMs, onStep,
    invoke: async ({ stage, model, signal: callSignal, draft }) => {
      const phase = stage === 'draft' ? 'initial' : 'fallback';
      const context = phase === 'fallback' && fallbackMode === 'repair'
        ? { draft, feedback: publicFeedback } : {};
      const receipt = await invokeAndVerify({ phase, model, signal: callSignal, ...context });
      assert.ok(receipt && Object.hasOwn(receipt, 'artifact'), 'missing_native_artifact');
      if (receipt.artifact === null) {
        assert.equal(receipt.tests, null, 'tests_without_native_artifact');
      } else {
        assert.equal(receipt.tests?.valid, true, 'incomplete_native_verification');
        assert.equal(receipt.tests.assertions, expectedTests, 'native_verification_count');
        assert.equal(typeof receipt.tests.passed, 'boolean', 'invalid_native_verdict');
      }
      if (phase === 'initial' && fallbackMode === 'repair' && receipt.tests?.passed !== true) {
        const feedback = receipt.publicFeedback;
        assert.ok(feedback === undefined || typeof feedback === 'string'
          && Buffer.byteLength(feedback) <= 12000, 'invalid_native_public_feedback');
        publicFeedback = feedback ?? null;
      }
      // Native test parsers may return class instances. Keep the receipt intact;
      // runVerifiedWorkflow separately clones candidate artifacts for isolation.
      checks.push(receipt);
      return { artifact: receipt.artifact, costMicros: receipt.costMicros };
    },
    verify: async () => {
      const passed = checks.at(-1).tests.passed;
      // One native suite is the complete gate; this is not a second compiler run.
      return { runtimePassed: passed, compilerPassed: passed };
    },
  });
  return { ...result, checks };
}
