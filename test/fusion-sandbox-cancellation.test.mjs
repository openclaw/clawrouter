import assert from 'node:assert/strict';
import test from 'node:test';
import { command, sandbox, sandboxArgs } from '../scripts/fusion-workloads.mjs';

test('caller cancellation rejects before dispatch and retires its active subprocess', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(2)'], { signal: abort.signal }), { name: 'AbortError' });
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { timeout: 5000, signal: AbortSignal.timeout(30) }), { name: 'TimeoutError' });
});

test('sandbox creation never implicitly downloads an absent image', () => {
  assert.ok(sandboxArgs(`sha256:${'a'.repeat(64)}`).includes('--pull=never'));
});

test('failed bounded create cleans only its generated container name', async () => {
  const calls = [];
  await assert.rejects(sandbox(`sha256:${'a'.repeat(64)}`, async (_program, args) => {
    calls.push(args); throw new Error('command_timeout');
  }, { cleanupRun: async (_program, args, options) => {
    calls.push(args); assert.equal(options.allowFailure, true);
    return { code: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
  } }), /command_timeout/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], '--name');
  assert.match(calls[0][2], /^fusion-sandbox-[a-f0-9-]+$/);
  assert.deepEqual(calls[1], ['rm', '-f', calls[0][2]]);
});

test('failed cleanup retains the exact generated name for reconciliation', async () => {
  let name;
  await assert.rejects(sandbox(`sha256:${'a'.repeat(64)}`, async (_program, args) => {
    name = args[2]; throw new Error('command_timeout');
  }, { cleanupRun: async () => { throw new Error('command_timeout'); } }), error => error.message === `sandbox_cleanup_failed:${name}`);
});

test('only an exact missing-container response may excuse rejected cleanup', async () => {
  for (const absent of [true, false]) {
    let name;
    await assert.rejects(sandbox(`sha256:${'a'.repeat(64)}`, async (_program, args) => {
      name = args[2]; throw new Error('command_timeout');
    }, { cleanupRun: async () => ({ code: 1, stdout: Buffer.from(''), stderr: Buffer.from(absent
      ? `Error response from daemon: No such container: ${name}\n` : 'daemon unavailable') }) }),
    error => error.message === (absent ? 'command_timeout' : `sandbox_cleanup_failed:${name}`));
  }
});
