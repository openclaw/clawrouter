import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTasks, validateTask, validateEdits, sandboxArgs, sandbox, testResult } from '../scripts/fusion-workloads.mjs';

const task = (await loadTasks())[0];
test('historical tasks have pinned distinct parents, source-only edits and development labels', async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 4);
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
