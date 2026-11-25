import assert from 'node:assert/strict';
import test from 'node:test';
import { compactCandidateContext } from '../scripts/fusion-candidate-context.mjs';

const file = content => ({ path: 'worker/example.ts', content });
function reconstruct(original, context) {
  if (Array.isArray(context)) return context;
  const files = structuredClone(original);
  for (const edit of context.edits) {
    const target = files.find(f => f.path === edit.path), start = edit.offsetUtf16;
    assert.equal(target.content.slice(start, start + edit.search.length), edit.search);
    target.content = target.content.slice(0, start) + edit.replace + target.content.slice(start + edit.search.length);
  }
  return files;
}

test('diagnostic edits reconstruct exact insertions, deletions, Unicode and line endings', () => {
  const pad = '// unchanged 🦊\r\n'.repeat(50);
  for (const [a, b] of [['one', 'two'], ['', 'added'], ['removed', ''], ['🦊', '🦉'], ['x\r\ny', 'y\nx']]) {
    const before = [file(pad + a + pad)], after = [file(pad + b + pad)];
    const context = compactCandidateContext(before, after);
    assert.equal(context.format, 'original-relative-edits-v1');
    assert.deepEqual(reconstruct(before, context), after);
    assert.ok(Buffer.byteLength(JSON.stringify(context)) < Buffer.byteLength(JSON.stringify(after)));
    assert.equal(before[0].content, pad + a + pad);
    assert.equal(after[0].content, pad + b + pad);
  }
});

test('large source fits the same request budget when compacted before admission', () => {
  const original = [file('// ' + 'a'.repeat(100000) + '\nexport const value = 1;\n')];
  const candidate = [file(original[0].content.replace('value = 1', 'value = 2'))];
  const body = value => ({ original, candidate: value });
  const limit = 190000;
  assert.ok(Buffer.byteLength(JSON.stringify(body(candidate))) > limit);
  const compact = compactCandidateContext(original, candidate);
  assert.ok(Buffer.byteLength(JSON.stringify(body(compact))) < limit);
  assert.deepEqual(reconstruct(original, compact), candidate);
});

test('unchanged files need no diagnostic edits', () => {
  const original = [file('x'.repeat(1000)), { path: 'shared/other.ts', content: 'y'.repeat(1000) }];
  const context = compactCandidateContext(original, original);
  assert.deepEqual(context.edits, []);
  assert.deepEqual(reconstruct(original, context), original);
});

test('full-file fallback avoids expansion and returns independent data', () => {
  const candidate = [file('b')];
  const context = compactCandidateContext([file('a')], candidate);
  assert.deepEqual(context, candidate);
  context[0].content = 'changed';
  assert.equal(candidate[0].content, 'b');
  assert.equal(compactCandidateContext([], null), null);
});

test('diagnostics reject duplicate, missing and unexpected files', () => {
  for (const candidate of [[], [file('a'), file('b')], [{ path: 'shared/other.ts', content: 'b' }],
    [{ path: 'worker/example.ts', content: null }]]) {
    assert.throws(() => compactCandidateContext([file('a')], candidate));
  }
  assert.throws(() => compactCandidateContext([file('a'), file('b')], [file('a')]));
});
