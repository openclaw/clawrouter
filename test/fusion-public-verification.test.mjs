import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPublicCandidate } from '../scripts/fusion-public-verification.mjs';

const passed = { valid: true, passed: true, skipped: 0, tests: 3 };
function fixture(verdict = passed, compilation = { passed: true }) {
  const calls = [], box = { close: async () => { calls.push('close'); } };
  return { calls, options: { expectedTests: 3,
    open: async () => { calls.push('open'); return { box, runtime: 'pinned' }; },
    test: async opened => { assert.equal(opened.box, box); calls.push('test'); return verdict; },
    compile: async received => { assert.equal(received, box); calls.push('compile'); return compilation; } } };
}

test('every qualified public test and the compiler must pass before acceptance', async () => {
  for (const compiler of [{ passed: true }, { passed: false }]) {
    const f = fixture(passed, compiler), result = await verifyPublicCandidate(f.options);
    assert.deepEqual(f.calls, ['open', 'test', 'compile', 'close']);
    assert.equal(result.runtimePassed, true);
    assert.equal(result.compiler.passed, compiler.passed);
    assert.equal(result.runtime, 'pinned'); assert.ok(result.totalMs >= 0);
  }
});

test('failed, malformed, incomplete and skipped test runs cannot reach the compiler', async () => {
  for (const verdict of [null, {}, { ...passed, passed: false }, { ...passed, valid: false },
    { ...passed, passed: 1 }, { ...passed, tests: 2 }, { ...passed, tests: 4 },
    { ...passed, skipped: 1 }, { ...passed, tests: undefined }]) {
    const f = fixture(verdict), result = await verifyPublicCandidate(f.options);
    assert.deepEqual(f.calls, ['open', 'test', 'close']);
    assert.equal(result.tests, verdict);
    assert.equal(result.runtimePassed, false);
    assert.deepEqual(result.compiler, { passed: false, skipped: true, reason: 'public_tests_failed' });
  }
});

test('checker errors propagate after closing the owned sandbox', async () => {
  for (const stage of ['test', 'compile']) {
    const f = fixture(); f.options[stage] = async () => { f.calls.push(stage); throw Error(stage); };
    await assert.rejects(verifyPublicCandidate(f.options), new RegExp(stage));
    assert.deepEqual(f.calls, stage === 'test' ? ['open', 'test', 'close'] : ['open', 'test', 'compile', 'close']);
  }
});

test('invalid expected counts fail before opening a sandbox', async () => {
  for (const expectedTests of [0, -1, 1.5, undefined]) {
    const f = fixture(); await assert.rejects(verifyPublicCandidate({ ...f.options, expectedTests }), /invalid_expected_tests/);
    assert.deepEqual(f.calls, []);
  }
});

test('the actual cascade falls back after runtime rejection and compiles the accepted fallback', async () => {
  const { runVerifiedWorkflow } = await import('../scripts/fusion-verified-workflow.mjs');
  const calls = [];
  const result = await runVerifiedWorkflow({ strategy: 'cascade', models: { draft: 'small', repair: 'strong' },
    invoke: async ({ stage }) => { calls.push(stage); return { artifact: stage, costMicros: 1 }; },
    verify: async ({ artifact }) => {
      const checked = await verifyPublicCandidate({ expectedTests: 3,
        open: async () => ({ box: { close: async () => { calls.push(`close:${artifact}`); } } }),
        test: async () => ({ ...passed, passed: artifact !== 'draft' }),
        compile: async () => { calls.push(`compile:${artifact}`); return { passed: true }; } });
      return { runtimePassed: checked.runtimePassed, compilerPassed: checked.compiler.passed };
    } });
  assert.equal(result.passed, true); assert.equal(result.costMicros, 2);
  assert.deepEqual(calls, ['draft', 'close:draft', 'strong-fallback', 'compile:strong-fallback', 'close:strong-fallback']);
  assert.deepEqual(result.steps.map(s => [s.runtimePassed, s.compilerPassed]), [[false, false], [true, true]]);
});

test('an incomplete passing receipt cannot request a paid compiler repair', async () => {
  const { runVerifiedWorkflow } = await import('../scripts/fusion-verified-workflow.mjs');
  for (const rejected of [{ ...passed, tests: 2 }, { ...passed, skipped: 1 }, { ...passed, valid: false }]) {
    const stages = [];
    const result = await runVerifiedWorkflow({ models: { draft: 'small', repair: 'strong', compiler: 'compiler' },
      invoke: async ({ stage }) => { stages.push(stage); return { artifact: stage, costMicros: 1 }; },
      verify: async ({ artifact }) => {
        const f = fixture(artifact === 'draft' ? rejected : passed);
        const checked = await verifyPublicCandidate(f.options);
        return { runtimePassed: checked.runtimePassed, compilerPassed: checked.compiler.passed };
      } });
    assert.equal(result.passed, true);
    assert.deepEqual(stages, ['draft', 'semantic-repair']);
  }
});
