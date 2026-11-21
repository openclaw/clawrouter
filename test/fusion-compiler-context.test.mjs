import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompilerRepairContext, applyCompilerRepairs } from '../scripts/fusion-compiler-context.mjs';

const files = () => [{ path: 'src/a.ts', content: 'const a: string = 1;\n' }, { path: 'src/b.ts', content: 'const b = 2;\n' }];
const diagnostics = "src/a.ts(1,7): error TS2322: Type 'number' is not assignable to type 'string'.\n";

test('compiler context contains only diagnosed files and copied explicit references', () => {
  const input = files(), refs = [{ path: 'src/types.ts', content: 'export type Value = string;' }];
  const context = createCompilerRepairContext({ files: input, diagnostics, referenceFiles: refs });
  assert.deepEqual(context.editableFiles, [input[0]]); assert.deepEqual(context.referenceFiles, refs);
  input[0].content = 'changed'; refs[0].content = 'changed';
  assert.equal(context.editableFiles[0].content, 'const a: string = 1;\n');
  assert.equal(context.referenceFiles[0].content, 'export type Value = string;');
  assert.throws(() => { context.editableFiles[0].content = 'changed'; }, TypeError);
});

test('compiler context normalizes relative Windows paths and preserves multiline diagnostics', () => {
  const text = diagnostics.replace('src/a.ts', 'src\\a.ts') + '  Additional type information.\r\n';
  const context = createCompilerRepairContext({ files: files(), diagnostics: text });
  assert.equal(context.editableFiles[0].path, 'src/a.ts'); assert.equal(context.diagnostics, text);
});

test('unlocated, undeclared, out-of-range and malformed diagnostics fail closed', () => {
  for (const text of ['', '  only a continuation', 'error TS2322: no source location',
    diagnostics.replace('src/a.ts', 'src/missing.ts'), diagnostics.replace('src/a.ts', '/src/a.ts'),
    diagnostics.replace('(1,7)', '(99,7)'), diagnostics.replace('(1,7)', '(0,7)'),
    diagnostics.replace('(1,7)', '(1,9999)'),
    diagnostics.replace('(1,7)', '(1,9007199254740992)'), 'x'.repeat(12 * 1024 + 1)]) {
    assert.throws(() => createCompilerRepairContext({ files: files(), diagnostics: text }));
  }
});

test('compiler columns use UTF-16 positions and allow the end of a CRLF line', () => {
  const input = [{ path: 'src/a.ts', content: '😀\r\n' }];
  assert.equal(createCompilerRepairContext({ files: input, diagnostics: 'src/a.ts(1,3): error TS1005: Missing token.' }).editableFiles.length, 1);
  assert.throws(() => createCompilerRepairContext({ files: input, diagnostics: 'src/a.ts(1,4): error TS1005: Missing token.' }));
});

test('source bounds reject duplicate normalized paths, traversal and oversized data', () => {
  for (const input of [[...files(), { path: 'src\\a.ts', content: '' }],
    [{ path: '../a.ts', content: '' }], [{ path: 'C:\\src\\a.ts', content: '' }],
    [{ path: 'src/a.ts', content: 'x'.repeat(256 * 1024 + 1) }]]) {
    assert.throws(() => createCompilerRepairContext({ files: input, diagnostics }));
  }
  assert.throws(() => createCompilerRepairContext({ files: files(), diagnostics, referenceFiles: [files()[0]] }));
});

test('repair merge preserves every unrelated file and refuses stale snapshots', () => {
  const original = files(), context = createCompilerRepairContext({ files: original, diagnostics });
  const replacements = [{ path: 'src/a.ts', content: "const a: string = '1';\n" }];
  assert.deepEqual(applyCompilerRepairs({ context, files: original, replacements }), [replacements[0], original[1]]);
  assert.deepEqual(original, files());
  original[0].content = 'changed while generating';
  assert.throws(() => applyCompilerRepairs({ context, files: original, replacements }), /stale_compiler_repair/);
});

test('repair merge rejects additions, unrelated edits and duplicate or empty output', () => {
  const original = files(), context = createCompilerRepairContext({ files: original, diagnostics });
  for (const replacements of [[], [original[1]], [{ path: 'src/new.ts', content: '' }], [original[0], original[0]]]) {
    assert.throws(() => applyCompilerRepairs({ context, files: original, replacements }));
  }
});

test('merged source must stay within the total bound even when each replacement fits', () => {
  const input = Array.from({ length: 4 }, (_, i) => ({ path: `src/large${i}.ts`, content: 'x'.repeat(256 * 1024) }));
  input.push({ path: 'src/a.ts', content: '' });
  const context = createCompilerRepairContext({ files: input, diagnostics: 'src/a.ts(1,1): error TS1005: Missing token.' });
  assert.throws(() => applyCompilerRepairs({ context, files: input, replacements: [{ path: 'src/a.ts', content: 'x' }] }), /invalid_compiler_source_files/);
  assert.equal(input[4].content, '');
});
