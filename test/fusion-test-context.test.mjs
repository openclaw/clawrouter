import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTestContext } from '../scripts/fusion-test-context.mjs';

const string = value => ({ type: 'StringLiteral', value });
const imported = (source, specifiers = []) => ({ type: 'ImportDeclaration', source: string(source), specifiers });
const named = (name, local = name) => ({ type: 'ImportSpecifier', imported: { name }, local: { name: local } });
const url = value => ({ type: 'NewExpression', callee: { name: 'URL' }, arguments: [string(value), {
  type: 'MemberExpression', object: { type: 'MetaProperty', meta: { name: 'import' }, property: { name: 'meta' } }, property: { name: 'url' },
}] });
const read = (callee, value) => ({ type: 'CallExpression', callee, arguments: [url(value)] });
const collect = (body, options = {}) => collectTestContext({ tests: [{ path: 'test/a.test.mjs', content: 'source' }],
  parse: () => ({ program: { body } }), readSource: path => `content:${path}`, ...options });

test('collects static/dynamic imports and aliased file reads, excluding editable and test files', () => {
  const reads = [];
  const result = collect([imported('node:fs', [named('readFileSync', 'readFixture')]), imported('../src/a.ts'),
    imported('external-package'), imported('./a.test.mjs'),
    { type: 'CallExpression', callee: { type: 'Import' }, arguments: [string('../src/b.ts')] },
    { type: 'ImportExpression', source: string('../src/c.ts') },
    read({ type: 'Identifier', name: 'readFixture' }, '../fixtures/data.json'),
  ], { editPaths: ['src/a.ts'], readSource: path => { reads.push(path); return `content:${path}`; } });
  assert.deepEqual(reads, ['fixtures/data.json', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(result.omitted, [{ path: 'src/a.ts', reason: 'excluded' }, { path: 'test/a.test.mjs', reason: 'excluded' }]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.references.find(row => row.path === 'fixtures/data.json'), {
    path: 'fixtures/data.json', from: ['test/a.test.mjs'], kinds: ['resource'],
  });
});
test('supports namespace reads and ignores unrelated URL constructors, dynamic paths and escaped roots', () => {
  const result = collect([imported('node:fs/promises', [{ type: 'ImportNamespaceSpecifier', local: { name: 'fs' } }]),
    read({ type: 'MemberExpression', object: { name: 'fs' }, property: { name: 'readFile' } }, '../data/config.yaml'),
    url('../unread.json'), read({ type: 'Identifier', name: 'unknown' }, '../unread.json'),
    imported('../../outside.ts'), imported('../.git/config'), imported('../node_modules/pkg/index.js'),
    imported('../src/a.ts?raw'), { type: 'ImportExpression', source: { type: 'Identifier', name: 'dynamic' } },
  ]);
  assert.deepEqual(result.files.map(file => file.path), ['data/config.yaml']);
});
test('deduplicates references and bounds bytes and reads without truncating source', () => {
  let reads = 0;
  const body = ['a.ts', 'a.ts', 'b.ts', 'c.ts', 'd.bin'].map(path => imported('../src/' + path));
  const result = collect(body, { maxFiles: 1, maxBytes: 3, readSource: path => { reads++; return path.endsWith('a.ts') ? 'éé' : 'abc'; } });
  assert.equal(reads, 2); assert.deepEqual(result.files, [{ path: 'src/b.ts', content: 'abc' }]);
  assert.deepEqual(result.omitted, [{ path: 'src/a.ts', reason: 'byte_limit' }, { path: 'src/c.ts', reason: 'file_limit' },
    { path: 'src/d.bin', reason: 'unsupported_file' }]);
  assert.equal(result.bytes, 3);
});
test('preserves missing-source evidence and fails on malformed inputs or source read errors', () => {
  assert.deepEqual(collect([imported('../missing.ts')], { readSource: () => null }).omitted, [{ path: 'missing.ts', reason: 'unavailable' }]);
  assert.throws(() => collect([imported('../missing.ts')], { readSource: () => { throw Error('read failed'); } }), /read failed/);
  assert.throws(() => collect([], { maxBytes: 262145 }), /test_context_byte_limit/);
  assert.throws(() => collect([], { editPaths: ['../outside.ts'] }), /test_context_edit_paths/);
  assert.throws(() => collect([], { parse: () => null }), /test_context_ast/);
  assert.throws(() => collect([imported('../a.ts')], { readSource: () => Buffer.from('x') }), /test_context_source/);
});
