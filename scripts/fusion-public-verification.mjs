import assert from 'node:assert/strict';

// Reject failed public tests before compilation; acceptance still requires both.
export async function verifyPublicCandidate({ open, test, compile, expectedTests }) {
  assert.ok(Number.isSafeInteger(expectedTests) && expectedTests > 0, 'invalid_expected_tests');
  const start = performance.now(), opened = await open();
  try {
    const tests = await test(opened);
    const eligible = tests?.valid === true && tests.passed === true
      && tests.skipped === 0 && tests.tests === expectedTests;
    const compiler = eligible ? await compile(opened.box)
      : { passed: false, skipped: true, reason: 'public_tests_failed' };
    return { tests, compiler, runtime: opened.runtime, totalMs: performance.now() - start };
  } finally {
    await opened.box.close();
  }
}
