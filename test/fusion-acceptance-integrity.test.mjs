import assert from 'node:assert/strict';
import test from 'node:test';
import { check, checkAcceptance, readSource, sandbox, writeFiles } from '../scripts/fusion-workloads.mjs';

const tap = Buffer.from('1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n');
const hashes = JSON.stringify(['a'.repeat(64)]);
const response = stdout => ({ code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

function fixture({ after = hashes, fail = false } = {}) {
  let snapshots = 0, runs = 0;
  return {
    exec: async (_args) => _args[2].includes('createHash')
      ? response(++snapshots === 3 ? after : hashes) : response(''),
    execUnprivileged: async () => {
      if (++runs === 1) return response('protected');
      if (fail) throw Error('test execution failed');
      return response(tap);
    },
    snapshots: () => snapshots,
  };
}

test('final acceptance rejects invalid inputs before any execution', async () => {
  const box = { execUnprivileged: () => assert.fail('must not execute') };
  for (const paths of [null, [], ['../test.mjs'], ['worker/../test.mjs']])
    await assert.rejects(checkAcceptance(box, paths), /invalid_acceptance_check/);
  await assert.rejects(checkAcceptance(box, ['test/a.mjs'], null), /invalid_acceptance_check/);
  await assert.rejects(checkAcceptance({}, ['test/a.mjs']), /invalid_acceptance_check/);
});

test('a passing report still requires unchanged acceptance bytes', async () => {
  const box = fixture();
  assert.equal((await checkAcceptance(box, ['test/a.mjs'])).passed, true);
  assert.equal(box.snapshots(), 3);
  await assert.rejects(checkAcceptance(fixture({ after: JSON.stringify(['b'.repeat(64)]) }), ['test/a.mjs']), /acceptance_integrity_changed/);
});

test('test execution errors still verify integrity before returning', async () => {
  const box = fixture({ fail: true });
  await assert.rejects(checkAcceptance(box, ['test/a.mjs']), /test execution failed/);
  assert.equal(box.snapshots(), 3);
});

test('candidate imports cannot rewrite verifier helpers during final acceptance', {
  skip: !process.env.FUSION_NATIVE_IMAGE,
}, async () => {
  const source = 'worker/fusion-integrity-source.mjs';
  const helper = 'worker/test/fusion-integrity-helper.mjs';
  const testPath = 'worker/test/fusion-integrity.test.mjs';
  const attacker = `import fs from 'node:fs';
try { fs.writeFileSync(new URL('./test/fusion-integrity-helper.mjs',import.meta.url),'export const expected = 0;\\n'); } catch {}
export const actual = 0;\n`;
  const testCode = `import test from 'node:test';import assert from 'node:assert/strict';
const {actual}=await import('../fusion-integrity-source.mjs');const {expected}=await import('./fusion-integrity-helper.mjs');
test('canonical expectation',()=>assert.equal(actual,expected));\n`;
  for (const [candidate, protectedRun, passed] of [[attacker, false, true], [attacker, true, false], ['export const actual = 42;\n', true, true]]) {
    const box = await sandbox(process.env.FUSION_NATIVE_IMAGE);
    try {
      const files = [{ path: source, content: candidate }, { path: helper, content: 'export const expected = 42;\n' },
        { path: testPath, content: testCode }];
      await box.exec(['node', '-e', `const fs=require('node:fs'),p=require('node:path');for(const name of JSON.parse(process.argv[1])){const target=p.resolve('/work',name);fs.mkdirSync(p.dirname(target),{recursive:true});fs.writeFileSync(target,'');}`, JSON.stringify(files.map(f => f.path))]);
      await writeFiles(box, files);
      const result = protectedRun ? await checkAcceptance(box, [testPath], [helper]) : await check(box, [testPath]);
      assert.equal(result.valid, true); assert.equal(result.tests, 1); assert.equal(result.passed, passed);
      const [after] = await readSource(box, [helper]);
      assert.equal(after.content, protectedRun ? 'export const expected = 42;\n' : 'export const expected = 0;\n');
    } finally { await box.close(); }
  }
});
