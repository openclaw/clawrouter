import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { freezeNodeTestClock } from '../scripts/fusion-fixed-clock.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const source = offset => `import { test } from 'node:test';
import assert from 'node:assert/strict';
const originalNow = Date.now;
test('revalidation', async () => {
  const staleAt = Date.now() ${offset};
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(Date.now() > staleAt);
});
test('clock restored', () => assert.equal(Date.now, originalNow));
`;
const prepare = content => freezeNodeTestClock({ path: 'test/cache.js', content }, { title: 'revalidation', sourceSha256: hash(content) });
const execute = content => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test-reporter=tap', '--input-type=module', '-'], { input: content, encoding: 'utf8', env });
};

test('a fixed clock exposes the same-millisecond defect and retains the corrected boundary', () => {
  const wrong = source('+ 0'), right = source('- 1');
  assert.equal(execute(wrong).status, 0);
  const rejected = execute(prepare(wrong).file.content);
  assert.equal(rejected.status, 1); assert.match(rejected.stdout, /not ok 1 - revalidation/);
  assert.match(rejected.stdout, /ok 2 - clock restored/);
  assert.equal(execute(prepare(right).file.content).status, 0);
});

test('fixture preparation binds exact source bytes and leaves the original untouched', () => {
  const content = source('- 1'), file = { path: 'test/cache.js', content };
  const result = freezeNodeTestClock(file, { title: 'revalidation', sourceSha256: hash(content) });
  assert.equal(file.content, content); assert.notEqual(result.file.content, content);
  assert.equal(result.evidence.sourceSha256, hash(content));
  assert.equal(result.evidence.fixtureSha256, hash(result.file.content));
  assert.throws(() => freezeNodeTestClock(file, { title: 'revalidation', sourceSha256: '0'.repeat(64) }), /source_mismatch/);
});

test('callback-like text inside a test title remains unchanged', () => {
  const title = 'supports async () callbacks';
  const content = source('- 1').replace("'revalidation'", JSON.stringify(title));
  const fixed = freezeNodeTestClock({ path: 'test/cache.js', content }, { title, sourceSha256: hash(content) });
  assert.ok(fixed.file.content.includes(`test(${JSON.stringify(title)}, async (__fusionClockTest) => {`));
  assert.equal(execute(fixed.file.content).status, 0);
});

test('same-line bodies and expression prefixes stay separate from the injected call', () => {
  for (const body of ['assert.ok(true);', '(function () { assert.ok(true); })();']) {
    const content = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('revalidation', async () => { ${body} });\n`;
    assert.equal(execute(prepare(content).file.content).status, 0);
  }
});

test('ambiguous registrations and existing callback parameters are rejected', () => {
  const original = source('- 1');
  assert.throws(() => prepare(original + original), /requires_one_supported_test/);
  assert.throws(() => prepare(original.replace('async ()', 'async (context)')), /requires_one_supported_test/);
  assert.throws(() => prepare(original.replace("test('revalidation'", "test('different'")), /requires_one_supported_test/);
  assert.throws(() => prepare(original + '\nconst __fusionFixedNow = 0;'), /identifier_collision/);
});
