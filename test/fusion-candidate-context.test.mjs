import assert from 'node:assert/strict';
import test from 'node:test';
import { compactCandidateContext } from '../scripts/fusion-candidate-context.mjs';
const file = content => ({ path: 'lib/example.js', content });
function reconstruct(original, context) {
  if (Array.isArray(context)) return context;
  const files = structuredClone(original);
  for (const edit of context.edits) {
    const file = files.find(f => f.path === edit.path), start = edit.offsetUtf16;
    assert.equal(file.content.slice(start, start + edit.search.length), edit.search);
    file.content = file.content.slice(0, start) + edit.replace + file.content.slice(start + edit.search.length);
  }
  return files;
}
test('compact candidate context reconstructs exact insertions, deletions and unicode changes', () => {
  const pad = 'const unchanged = 123;\r\n'.repeat(50);
  for (const [a, b] of [['one', 'two'], ['', 'added'], ['removed', ''], ['🦊', '🦉'], ['x\r\ny', 'y\nx']]) {
    const before = [file(pad + a + pad)], after = [file(pad + b + pad)];
    const context = compactCandidateContext(before, after);
    assert.equal(context.format, 'original-relative-edits-v1');
    assert.deepEqual(reconstruct(before, context), after);
    assert.ok(Buffer.byteLength(JSON.stringify(context)) < Buffer.byteLength(JSON.stringify(after)));
    assert.equal(before[0].content, pad + a + pad);
  }
});
test('unchanged multi-file candidates omit all repeated source and retain exact reconstruction', () => {
  const before = [file('x'.repeat(1000)), { path: 'lib/other.js', content: 'y'.repeat(1000) }];
  const context = compactCandidateContext(before, before);
  assert.deepEqual(context.edits, []); assert.deepEqual(reconstruct(before, context), before);
});
test('full-file fallback avoids expansion and invalid paths fail closed', () => {
  const candidate = [file('b')];
  assert.deepEqual(compactCandidateContext([file('a')], candidate), candidate);
  assert.notEqual(compactCandidateContext([file('a')], candidate), candidate);
  assert.equal(compactCandidateContext([], null), null);
  assert.throws(() => compactCandidateContext([file('a')], []), /candidate_path_mismatch/);
  assert.throws(() => compactCandidateContext([file('a')], [file('b'), file('c')]), /invalid_candidate_file/);
});
