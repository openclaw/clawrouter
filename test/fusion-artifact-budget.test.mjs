import assert from 'node:assert/strict';
import test from 'node:test';
import { hash, validateEdits } from '../scripts/fusion-workloads.mjs';
import { applyAnchoredEdits } from '../scripts/fusion-anchored-edits.mjs';
import { fileArtifactSchema, normalizeReplacements, parseFileArtifact, replacementPaths } from '../scripts/fusion-file-artifact.mjs';

const task = { sourcePathPolicy: 'node-library-v1', editPaths: ['lib/example.js'] };
const files = content => [{ path: task.editPaths[0], content }];

test('default replacement byte limit remains 64 KiB', () => {
  assert.deepEqual(normalizeReplacements(task, files('x'.repeat(65536))), files('x'.repeat(65536)));
  assert.throws(() => normalizeReplacements(task, files('x'.repeat(65537))), /replacement_bytes/);
});

test('caller byte budget admits a reconstructed large source after a compact edit', () => {
  const original = files('// unchanged\n'.repeat(7000) + 'export const value = 1;\n');
  const caller = { ...task, maxReplacementBytes: 131072 };
  const edited = applyAnchoredEdits(caller, original, { [task.editPaths[0]]: hash(original[0].content) }, [
    { path: task.editPaths[0], startLine: 7001, search: 'export const value = 1;', replace: 'export const value = 2;' },
  ]);
  assert.ok(Buffer.byteLength(edited[0].content) > 65536);
  assert.throws(() => normalizeReplacements(task, edited), /replacement_bytes/);
  assert.deepEqual(validateEdits(caller, normalizeReplacements(caller, edited)), edited);
  assert.ok(original[0].content.endsWith('value = 1;\n'));
});

test('byte budget counts UTF-8 across every file independent of input order', () => {
  const caller = { ...task, editPaths: ['lib/a.js', 'lib/b.js'], maxReplacementBytes: 7 };
  const input = [{ path: 'lib/b.js', content: 'abc' }, { path: 'lib/a.js', content: '🦊' }];
  assert.deepEqual(normalizeReplacements(caller, input), [...input].reverse());
  assert.throws(() => normalizeReplacements({ ...caller, maxReplacementBytes: 6 }, input), /replacement_bytes/);
});

test('caller byte budget is bounded and validated before schema generation', () => {
  for (const limit of [null, 0, -1, 0.5, '131072', NaN, Infinity, 262145]) {
    const caller = { ...task, maxReplacementBytes: limit };
    assert.throws(() => replacementPaths(caller), /invalid_replacement_byte_limit/);
    assert.throws(() => fileArtifactSchema(caller), /invalid_replacement_byte_limit/);
    assert.throws(() => normalizeReplacements(caller, files('')), /invalid_replacement_byte_limit/);
  }
  assert.deepEqual(normalizeReplacements({ ...task, maxReplacementBytes: 262144 }, files('x'.repeat(262144))), files('x'.repeat(262144)));
  assert.throws(() => normalizeReplacements({ ...task, maxReplacementBytes: 262144 }, files('x'.repeat(262145))), /replacement_bytes/);
});

test('artifact output cannot raise the caller byte budget', () => {
  const output = { files: files('x'.repeat(65537)), maxReplacementBytes: 131072 };
  assert.throws(() => parseFileArtifact(task, output));
  assert.throws(() => parseFileArtifact(task, { files: [{ ...files('')[0], maxReplacementBytes: 131072 }] }));
  assert.throws(() => parseFileArtifact(task, { files: output.files }), /replacement_bytes/);
});
