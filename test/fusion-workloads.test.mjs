import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { loadTasks, validateTask, validateEdits, sandboxArgs, sandbox, testResult, checkOracleVisible, qualificationSucceeded } from '../scripts/fusion-workloads.mjs';

const task = (await loadTasks())[0];
test('historical tasks have pinned distinct parents, source-only edits and development labels', async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 3);
  assert.equal(new Set(tasks.map(task => task.base)).size, tasks.length);
  for (const task of tasks) assert.equal(validateTask(task), task);
  for (const path of ['../test.js', '/tmp/escape.ts', 'worker/../test.js', 'worker//file.ts']) {
    assert.throws(() => validateTask({ ...task, editPaths: [path] }));
  }
  assert.throws(() => validateTask({ ...task, editPaths: ['worker/test/example.ts'] }));
  assert.throws(() => validateTask({ ...task, split: 'test' }));
});

test('agent edits cannot change graders, add executable paths or exceed file bounds', () => {
  assert.deepEqual(validateEdits(task, [{ path: task.editPaths[0], content: 'source' }]), [{ path: task.editPaths[0], content: 'source' }]);
  for (const edits of [[{ path: 'test/verifier.mjs', content: '' }], [{ path: task.editPaths[0], content: 'x'.repeat(262145) }],
    [{ path: task.editPaths[0], content: '' }, { path: task.editPaths[0], content: '' }]]) assert.throws(() => validateEdits(task, edits));
});

test('sandbox requires immutable image and excludes host mounts, credentials and network', () => {
  assert.throws(() => sandboxArgs('node:latest'));
  const args = sandboxArgs(`sha256:${'a'.repeat(64)}`);
  for (const value of ['--network=none', '--read-only', '--cap-drop=ALL', '--user=1000:1000', '--security-opt=no-new-privileges']) assert.ok(args.includes(value));
  assert.ok(!args.some(value => value === '-v' || value.startsWith('--mount') || value.startsWith('--env')));
});

test('failed sandbox setup removes only the container it created', async () => {
  const calls = [], id = 'b'.repeat(64);
  await assert.rejects(sandbox(`sha256:${'a'.repeat(64)}`, async (_command, args) => {
    calls.push(args);
    if (args[0] === 'create') return { stdout: Buffer.from(id) };
    if (args[0] === 'start') throw new Error('fixture startup failure');
    return {};
  }), /fixture startup failure/);
  assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
});

const tap = (pass, fail, skip = 0) => Buffer.from(`# tests ${pass + fail + skip}\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skip}\n`);
test('qualification rejects empty/malformed reports and distinguishes broken tests from passing ones', () => {
  assert.equal(testResult({ code: 0, stdout: tap(0, 0), stderr: Buffer.alloc(0) }).passed, false);
  assert.equal(testResult({ code: 0, stdout: tap(2, 0, 1), stderr: Buffer.alloc(0) }).passed, true);
  assert.equal(testResult({ code: 1, stdout: tap(2, 1), stderr: Buffer.alloc(0) }).valid, true);
  assert.equal(testResult({ code: 1, stdout: tap(2, 1), stderr: Buffer.alloc(0) }).passed, false);
  assert.equal(testResult({ code: 0, stdout: Buffer.from('success'), stderr: Buffer.alloc(0) }).valid, false);
});

test('failed-test fingerprints distinguish nested labels without retaining content', () => {
  const output = `# Subtest: private suite one\n    # Subtest: private failure\n    not ok 1 - private failure\nnot ok 1 - private suite one\n# Subtest: private suite two\n    # Subtest: private failure\n    not ok 1 - private failure\nnot ok 2 - private suite two\n`;
  const receipt = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(output), tap(0, 4)]), stderr: Buffer.from('private error details') });
  const fingerprints = receipt.failureFingerprints;
  assert.equal(fingerprints.kind, 'tap-label-path-sha256');
  assert.equal(fingerprints.digests.length, 4);
  assert.equal(new Set(fingerprints.digests).size, 4);
  assert.ok(fingerprints.digests.every(value => /^[a-f0-9]{64}$/.test(value)));
  assert.equal(fingerprints.truncated, false);
  assert.ok(!JSON.stringify(receipt).includes('private'));
  const repeated = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(output.replaceAll('\n', '\r\n')), tap(0, 4)]), stderr: Buffer.alloc(0) });
  assert.deepEqual(repeated.failureFingerprints, fingerprints);
});

test('failure fingerprints are bounded and do not change acceptance', () => {
  const lines = Array.from({ length: 129 }, (_, i) => `not ok ${i + 1} - failure ${i}`).join('\n') + '\n';
  const receipt = testResult({ code: 1, stdout: Buffer.concat([Buffer.from(lines), tap(0, 129)]), stderr: Buffer.alloc(0) });
  assert.equal(receipt.failureFingerprints.digests.length, 128);
  assert.equal(receipt.failureFingerprints.truncated, true);
  assert.equal(receipt.failures, 129);
  assert.equal(receipt.passed, false);
  const clean = testResult({ code: 0, stdout: tap(2, 0), stderr: Buffer.alloc(0) });
  assert.deepEqual(clean.failureFingerprints.digests, []);
  assert.equal(clean.passed, true);
});

test('real Node TAP failures produce stable fingerprints', () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawnSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '-e',
    "import {describe,it} from 'node:test'; import assert from 'node:assert/strict'; describe('fingerprint fixture',()=>{it('failed behavior',()=>assert.equal(1,2));});"],
  { timeout: 5000, env });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const receipt = testResult({ code: child.status, stdout: child.stdout, stderr: child.stderr });
  assert.equal(receipt.valid, true);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failureFingerprints.digests.length, 2);
  assert.ok(!JSON.stringify(receipt).includes('fingerprint fixture'));
});


test('behavior probes use bounded stdin in the task sandbox and retain no script in output', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const calls = [];
  const box = { exec: async (args, options) => { calls.push({args, options}); return { code: 1, stdout: Buffer.from('assertion failed'), stderr: Buffer.alloc(0) }; } };
  const source = 'throw new Error("regression");';
  assert.deepEqual(await probe(box, source, 1000), { passed: false, assertionFailed: false, feedback: 'assertion failed' });
  assert.deepEqual(calls[0].args, ['timeout', '--signal=KILL', '1s', 'node', '--input-type=module']);
  assert.equal(calls[0].options.input, source);
  assert.equal(calls[0].options.timeout, 3000);
  await assert.rejects(probe(box, 'x'.repeat(16001)), /invalid_probe/);
  assert.equal(calls.length, 1);
});

test('only a normal failing assertion qualifies a reproduction', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  for (const [code, stderr, expected] of [[1, 'AssertionError [ERR_ASSERTION]', true],
    [7, 'AssertionError [ERR_ASSERTION]', true], [7, 'TypeError', false],
    [1, 'SyntaxError', false], [137, 'ERR_ASSERTION', false], [0, 'ERR_ASSERTION', false]]) {
    const result = await probe({ exec: async () => ({ code, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) }) }, 'test');
    assert.equal(result.assertionFailed, expected);
  }
});

test('a real assertion after node:test setup qualifies a reproduction', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { beforeEach } from 'node:test'; import assert from 'node:assert/strict'; beforeEach(() => {}); assert.equal(false, true);"],
  { timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.ok([1, 7].includes(child.status));
  const result = await probe({ exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) }, 'test');
  assert.equal(result.assertionFailed, true);
  assert.equal(result.passed, false);
});

test('an assertion caught by node:test qualifies when its reporter writes to stdout', async () => {
  const { probe } = await import('../scripts/fusion-workloads.mjs');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import test from 'node:test'; import assert from 'node:assert/strict'; test('reproduction', () => assert.equal(503, 200));"],
  { timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stdout.toString(), /ERR_ASSERTION/);
  const result = await probe({ exec: async () => ({ code: child.status, stdout: child.stdout, stderr: child.stderr }) }, 'test');
  assert.equal(result.assertionFailed, true);
  assert.equal(result.passed, false);
});


test('transfer validation uses distinct pinned tasks without changing the original corpus', async () => {
  const original = await loadTasks();
  const validation = await loadTasks(new URL('../benchmarks/fusion/validation-workloads.json', import.meta.url));
  assert.equal(validation.length, 4);
  const known = new Set(original.flatMap(task => [task.id, task.oracle]));
  for (const task of validation) {
    assert.equal(validateTask(task), task);
    assert.equal(known.has(task.id), false);
    assert.equal(known.has(task.oracle), false);
  }
});

test('qualification rejects a known repair that conflicts with the unchanged visible tests', async () => {
  const fixture = { editPaths: ['worker/example.ts'], visibleTests: ['worker/test/example.test.mjs'] };
  let content = 'old', closed = false;
  const oracleVisible = await checkOracleVisible(fixture, 'image', [{ path: fixture.editPaths[0], content: 'new' }], {
    makeSandbox: async () => ({ close: async () => { closed = true; } }),
    write: async (_box, files) => { content = files[0].content; },
    test: async (_box, paths) => {
      assert.deepEqual(paths, fixture.visibleTests);
      assert.equal(content, 'new');
      return { valid: true, passed: false, tests: 1, failures: 1, feedback: 'private output' };
    },
  });
  assert.equal(closed, true); assert.equal('feedback' in oracleVisible, false);
  const evidence = { visible: { passed: true }, broken: { valid: true, passed: false }, oracle: { passed: true }, oracleVisible };
  assert.equal(qualificationSucceeded(evidence), false);
  assert.equal(qualificationSucceeded({ ...evidence, oracleVisible: { valid: true, passed: true } }), true);
  assert.equal(qualificationSucceeded({ ...evidence, oracleVisible: undefined }), false);
});

test('provided reproducer qualification requires an original assertion and a repaired pass', () => {
  const evidence = { visible: { passed: true }, oracleVisible: { valid: true, passed: true },
    broken: { valid: true, passed: false }, oracle: { passed: true } };
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true }, oracleReproduction: { passed: true } }), true);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true } }), false);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: false }, oracleReproduction: { passed: true } }), false);
  assert.equal(qualificationSucceeded({ ...evidence, reproduction: { assertionFailed: true }, oracleReproduction: { passed: false } }), false);
});

test('fresh corpus excludes repairs contradicted by their original visible tests', async () => {
  const tasks = await loadTasks(new URL('../benchmarks/fusion/fresh-workloads.json', import.meta.url));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => !['cerebras-worker-redirect-mode', 'minimax-regional-availability'].includes(task.id)));
});
