import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { selectSourceContext } from '../scripts/fusion-test-context.mjs';

const string = value => ({ type: 'StringLiteral', value });
const program = body => ({ type: 'Program', body });
const entry = (path, name) => ({ path, content: `source for ${path}`, ...(name ? { name } : {}) });
const sources = [{ path: 'src/handler.ts', content: 'editable source' }];

test('supporting context retains direct modules, declarations, fixtures and test helpers without mutation', () => {
  const context = ['src/direct.ts', 'src/exported/index.ts', 'src/dynamic.mjs', 'src/unrelated.ts',
    'fixtures/wire.json', 'fixtures/provider.yaml', 'fixtures/expected.txt', 'src/ambient.d.ts', 'test/helpers.mjs'].map(path => entry(path));
  context.push(entry('src/types.ts', 'Request'));
  const before = structuredClone({ sources, context });
  const parse = (content, path) => {
    assert.equal(content, sources[0].content); assert.equal(path, sources[0].path);
    return { program: program([
      { type: 'ImportDeclaration', source: string('./direct.js') },
      { type: 'ExportAllDeclaration', source: string('./exported') },
      { type: 'CallExpression', callee: { type: 'Import' }, arguments: [string('./dynamic.mjs')] },
    ]) };
  };
  const result = selectSourceContext({ sources, context, parse });
  assert.deepEqual(result.files, context.filter(e => e.path !== 'src/unrelated.ts'));
  assert.deepEqual(result.omitted, [{ path: 'src/unrelated.ts', bytes: Buffer.byteLength(context[3].content),
    reason: 'not_direct_source_dependency', sha256: createHash('sha256').update(context[3].content).digest('hex') }]);
  assert.equal(result.bytes, result.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0));
  assert.equal(result.originalBytes, context.reduce((n, f) => n + Buffer.byteLength(f.content), 0));
  assert.equal(result.complete, false); assert.equal(result.preserveReason, null);
  assert.equal(result.files[0], context[0]);
  assert.deepEqual({ sources, context }, before);
});

test('ESTree imports and extensionless directory indexes retain their supporting module', () => {
  const context = [entry('src/dependency/index.tsx'), entry('src/other.ts')];
  const result = selectSourceContext({ sources, context, parse: () => program([
    { type: 'ImportExpression', source: { type: 'Literal', value: './dependency' } },
  ]) });
  assert.deepEqual(result.files, [context[0]]);
  assert.deepEqual(selectSourceContext({ sources, context: result.files, parse: () => program([
    { type: 'ImportDeclaration', source: string('./dependency') },
  ]) }).files, result.files);
});

for (const [node, reason] of [
  [{ type: 'ImportExpression', source: { type: 'Identifier', name: 'path' } }, 'dynamic_import'],
  [{ type: 'CallExpression', callee: { type: 'Import' }, arguments: [{ type: 'Identifier', name: 'path' }] }, 'dynamic_import'],
  [{ type: 'ImportDeclaration', source: string('@workspace/handler') }, 'unresolved_import'],
]) test(`unresolved module resolution preserves all supporting context: ${reason}`, () => {
  const context = [entry('src/otherwise-omitted.ts')];
  const result = selectSourceContext({ sources, context, parse: () => program([node]) });
  assert.deepEqual(result.files, context); assert.deepEqual(result.omitted, []);
  assert.equal(result.preserveReason, reason); assert.equal(result.complete, false);
});

test('builtins need no supporting file; shared or cyclic parser nodes do not loop', () => {
  const node = { type: 'ImportDeclaration', source: string('node:fs') };
  const ast = program([node, node]); ast.self = ast;
  const result = selectSourceContext({ sources, context: [entry('src/other.ts')], parse: () => ast });
  assert.equal(result.files.length, 0); assert.equal(result.omitted.length, 1);
  assert.equal(result.preserveReason, null);
});

test('invalid input, oversized context and outside-repository imports fail before selection', () => {
  const parse = () => program([]), context = [entry('src/other.ts')];
  for (const changed of [[], [...sources, ...sources], [{ path: '../outside.ts', content: '' }],
    [{ path: 'src/large.ts', content: 'x'.repeat(262145) }]]) {
    assert.throws(() => selectSourceContext({ sources: changed, context, parse }), /source_context_/);
  }
  for (const changed of [[entry('node_modules/hidden.ts')], [{ ...context[0], name: '' }], Array(257).fill(context[0])]) {
    assert.throws(() => selectSourceContext({ sources, context: changed, parse }), /source_context_/);
  }
  assert.throws(() => selectSourceContext({ sources, context, parse: () => ({}) }), /source_context_ast/);
  assert.throws(() => selectSourceContext({ sources, context, parse: () => program([
    { type: 'ImportDeclaration', source: string('../../outside.ts') },
  ]) }), /source_context_import_path/);
  assert.throws(() => selectSourceContext({ sources, context: Array.from({ length: 17 }, (_, i) => ({
    path: `src/context-${i}.ts`, content: 'x'.repeat(262144),
  })), parse }), /source_context_byte_limit/);
});

test('parser failures propagate without a partial result', () => {
  const failure = new Error('parser failed');
  assert.throws(() => selectSourceContext({ sources, context: [], parse: () => { throw failure; } }), error => error === failure);
});
