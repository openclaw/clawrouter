import assert from 'node:assert/strict';
import test from 'node:test';
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

test('fresh corpus excludes repairs contradicted by their original visible tests', async () => {
  const tasks = await loadTasks(new URL('../benchmarks/fusion/fresh-workloads.json', import.meta.url));
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => !['cerebras-worker-redirect-mode', 'minimax-regional-availability'].includes(task.id)));
});
