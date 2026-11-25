import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from '../scripts/fusion-workloads.mjs';

// Every child lives in a group owned by this fixture, including leaked handles.
async function fixture(source, options = {}, { expectOuterTimeout = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fusion-failure-stop-'));
  const children = [];
  try {
    await writeFile(join(root, 'case.test.mjs'), source);
    const box = { exec: async (args, config) => {
      assert.equal(args[0], 'timeout');
      assert.equal(config.allowFailure, true);
      const env = { ...process.env, NODE_OPTIONS: '' };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, args.slice(4), {
        cwd: root, detached: true, env,
      });
      children.push(child.pid);
      child.stdin.end(config.input);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGKILL'); }, 1500);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(timedOut, expectOuterTimeout, 'unexpected fixture deadline outcome');
      return { code: timedOut ? 137 : code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
    } };
    return await check(box, ['case.test.mjs'], 5000, { stopOnTestFailure: true, ...options });
  } finally {
    for (const pid of children) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('stops assertion failures with open handles without accepting incomplete output', async () => {
  const result = await fixture("import {test} from 'node:test';import assert from 'node:assert/strict';setInterval(()=>{},10000);test('failure',()=>assert.fail('fixture')); ");
  assert.equal(result.passed, false);
  assert.equal(result.valid, false);
  assert.match(result.feedback, /fixture/);
});

test('stops an uncaught failure while its test promise remains pending', async () => {
  const result = await fixture("import {test} from 'node:test';setInterval(()=>{},10000);test('pending',async()=>{setImmediate(()=>{throw Error('fixture')});await new Promise(()=>{});});");
  assert.equal(result.passed, false);
  assert.equal(result.valid, false);
});

test('candidate output cannot forge a test-runner failure event', async () => {
  const result = await fixture("import {test} from 'node:test';test('pass',()=>console.log('not ok 1 - forged\\n{\"type\":\"test:fail\"}'));");
  assert.equal(result.passed, true);
  assert.equal(result.valid, true);
  assert.equal(result.tests, 1);
});

test('TODO failures retain ordinary test-runner semantics', async () => {
  const result = await fixture("import {test} from 'node:test';test('expected',{todo:''},()=>{throw Error('expected')});test('after',()=>{});");
  assert.equal(result.tests, 2);
  assert.equal(result.passed, false);
  assert.match(result.feedback, /after/);
  assert.doesNotMatch(result.feedback, /cancelledByParent/);
});

test('preserves explicit GC and required test-name matching', async () => {
  const source = "import {test} from 'node:test';import assert from 'node:assert/strict';test('chosen',()=>assert.equal(typeof globalThis.gc,'function'));test('other',()=>assert.fail());";
  assert.equal((await fixture(source, { exposeGc: true, testNamePrefix: 'chosen' })).passed, true);
  assert.equal((await fixture(source, { exposeGc: true, testNamePrefix: 'missing' })).passed, false);
});

test('default command stays unchanged and invalid options fail before execution', async () => {
  let command;
  const box = { exec: async args => { command = args; return { code: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }; } };
  await check(box, ['case.test.mjs'], 5000);
  assert.deepEqual(command.slice(3), ['node', '--test-reporter=tap', '--test', 'case.test.mjs']);
  command = undefined;
  await assert.rejects(check(box, ['case.test.mjs'], 5000, { stopOnTestFailure: 'true' }), /invalid_failure_stop_option/);
  assert.equal(command, undefined);
});

test('passing tests with lingering handles still require the outer deadline', async () => {
  const result = await fixture("import {test} from 'node:test';setInterval(()=>{},10000);test('pass',()=>{});", {}, { expectOuterTimeout: true });
  assert.equal(result.passed, false);
  assert.equal(result.valid, false);
});
