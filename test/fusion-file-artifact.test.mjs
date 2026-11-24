import assert from 'node:assert/strict';
import test from 'node:test';
import { fileArtifactSchema, parseFileArtifact } from '../scripts/fusion-file-artifact.mjs';
import { runVerifiedWorkflow } from '../scripts/fusion-verified-workflow.mjs';

const task = { editPaths: ['worker/a.ts', 'worker/b.ts'] };
const files = [{ path: 'worker/a.ts', content: 'export const a = 1;' }, { path: 'worker/b.ts', content: 'export const b = 2;' }];

test('artifacts require every exact source path and normalize order without aliases', () => {
  const artifact = parseFileArtifact(task, { files: [...files].reverse() });
  assert.deepEqual(artifact, { files });
  artifact.files[0].content = 'changed';
  assert.equal(files[0].content, 'export const a = 1;');
  const schema = fileArtifactSchema(task).properties.files;
  assert.equal(schema.minItems, 2); assert.equal(schema.maxItems, 2);
  assert.deepEqual(schema.items.properties.path.enum, task.editPaths);
  schema.items.properties.path.enum.push('worker/c.ts');
  assert.equal(task.editPaths.length, 2);
});

test('partial, duplicate, extra, malformed and oversized artifacts fail closed', () => {
  for (const value of [null, [], {}, { files, accepted: true }, { files: files.slice(0, 1) },
    { files: [files[0], files[0]] }, { files: [...files, { path: 'worker/c.ts', content: '' }] },
    { files: [files[0], { path: '../worker/b.ts', content: '' }] },
    { files: [files[0], { ...files[1], content: null }] },
    { files: [files[0], { ...files[1], executable: true }] },
    { files: files.map(f => ({ ...f, content: 'x'.repeat(40000) })) }]) {
    assert.throws(() => parseFileArtifact(task, value));
  }
  // The limit measures UTF-8 bytes, not UTF-16 code units.
  assert.throws(() => parseFileArtifact(task, { files: files.map(f => ({ ...f, content: '界'.repeat(12000) })) }), /replacement_bytes/);
});

test('unsafe declarations and test-file conventions cannot widen the editable surface', () => {
  for (const path of ['../worker/a.ts', '/worker/a.ts', 'worker/../a.ts', 'worker//a.ts',
    'worker/test/a.ts', 'worker/tests/a.ts', 'worker/__tests__/a.ts', 'worker/a.test.ts', 'worker/a.spec.ts',
    'worker/a.SPEC.ts', 'docs/a.ts', 'worker/a.json']) {
    assert.throws(() => fileArtifactSchema({ editPaths: [path] }), /replacement_path/);
  }
  for (const editPaths of [[], ['worker/a.ts', 'worker/a.ts'], Array.from({ length: 5 }, (_, i) => `worker/a${i}.ts`)]) {
    assert.throws(() => fileArtifactSchema({ editPaths }), /replacement_paths/);
  }
});

test('the workflow charges a rejected partial draft and verifies all fallback files', async () => {
  let calls = 0, checks = 0;
  const result = await runVerifiedWorkflow({ strategy: 'cascade', deadlineMs: 1000,
    models: { draft: 'tiny', repair: 'strong' },
    invoke: async ({ stage }) => {
      calls++; let artifact = null;
      try { artifact = parseFileArtifact(task, { files: stage === 'draft' ? files.slice(0, 1) : files }); } catch { /* Rejected output is still charged. */ }
      return { artifact, costMicros: 3 };
    },
    verify: async ({ artifact }) => {
      checks++; assert.deepEqual(artifact.files, files);
      return { runtimePassed: true, compilerPassed: true };
    },
  });
  assert.equal(result.passed, true); assert.equal(result.costMicros, 6);
  assert.equal(calls, 2); assert.equal(checks, 1); assert.deepEqual(result.artifact.files, files);
});


test('Node library source paths require explicit policy without weakening exclusions', () => {
  for (const path of ['lib/client.js', 'lib/nested/client.mjs', 'lib/client.cjs']) {
    assert.throws(() => fileArtifactSchema({ editPaths: [path] }), /invalid_replacement_path/);
    const task = { sourcePathPolicy: 'node-library-v1', editPaths: [path] };
    const files = [{ path, content: 'module.exports = {};' }];
    assert.deepEqual(parseFileArtifact(task, { files }), { files });
    assert.deepEqual(fileArtifactSchema(task).properties.files.items.properties.path.enum, [path]);
  }
  for (const sourcePathPolicy of ['unknown', '']) {
    assert.throws(() => fileArtifactSchema({ sourcePathPolicy, editPaths: ['worker/a.ts'] }), /invalid_source_path_policy/);
  }
  for (const path of ['lib/../a.js', 'lib//a.js', 'lib/tests/a.js', 'lib/Test/a.js',
    'lib/__tests__/a.js', 'lib/a.test.js', 'lib/a.SPEC.js', 'lib/a.json', 'lib/a.ts',
    '/lib/a.js', 'src/a.js', 'lib\\a.js']) {
    assert.throws(() => fileArtifactSchema({ sourcePathPolicy: 'node-library-v1', editPaths: [path] }), /invalid_replacement_path/);
  }
  assert.doesNotThrow(() => fileArtifactSchema({ sourcePathPolicy: 'worker-v1', editPaths: ['worker/a.ts'] }));
});
