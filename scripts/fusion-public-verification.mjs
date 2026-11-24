import assert from 'node:assert/strict';

// Reject failed public tests before compilation; acceptance still requires both.
export async function verifyPublicCandidate({ open, precheck, test, compile, expectedTests }) {
  assert.ok(Number.isSafeInteger(expectedTests) && expectedTests > 0, 'invalid_expected_tests');
  assert.ok(precheck === undefined || typeof precheck === 'function', 'invalid_precheck');
  const start = performance.now(), opened = await open();
  try {
    const preliminary = precheck === undefined ? undefined : await precheck(opened);
    if (precheck !== undefined && preliminary?.passed !== true) {
      return { precheck: preliminary,
        tests: { valid: false, passed: false, skipped: true, reason: 'precheck_failed' },
        runtimePassed: false, compiler: { passed: false, skipped: true, reason: 'precheck_failed' },
        runtime: opened.runtime, totalMs: performance.now() - start };
    }
    const tests = await test(opened);
    const eligible = tests?.valid === true && tests.passed === true
      && tests.skipped === 0 && tests.tests === expectedTests;
    const compiler = eligible ? await compile(opened.box)
      : { passed: false, skipped: true, reason: 'public_tests_failed' };
    return { ...(precheck === undefined ? {} : { precheck: preliminary }),
      tests, runtimePassed: eligible, compiler, runtime: opened.runtime, totalMs: performance.now() - start };
  } finally {
    await opened.box.close();
  }
}
