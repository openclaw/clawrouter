import assert from 'node:assert/strict';
import { posix } from 'node:path';

const pathIsRelative = path => typeof path === 'string' && path.length <= 1024
  && /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(path)
  && !path.split('/').some(part => ['.', '..', '.git', 'node_modules'].includes(part));
const sourceExtension = /\.(?:[cm]?js|jsx|tsx?|json|jsonc|ya?ml|txt|md)$/;
const literal = node => node?.type === 'StringLiteral' ? node.value
  : node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const importMetaUrl = node => node?.type === 'MemberExpression' && !node.computed && node.property?.name === 'url'
  && node.object?.type === 'MetaProperty' && node.object.meta?.name === 'import' && node.object.property?.name === 'meta';

// The caller owns parsing and pinned reads. Test and dependency code is not executed.
export function collectTestContext({ tests, editPaths = [], parse, readSource, maxFiles = 16, maxBytes = 131072 }) {
  assert.ok(Array.isArray(tests) && tests.length > 0 && tests.length <= 32, 'test_context_tests');
  assert.ok(Array.isArray(editPaths) && editPaths.every(pathIsRelative), 'test_context_edit_paths');
  assert.ok(typeof parse === 'function' && typeof readSource === 'function', 'test_context_callbacks');
  assert.ok(Number.isSafeInteger(maxFiles) && maxFiles > 0 && maxFiles <= 32, 'test_context_file_limit');
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 262144, 'test_context_byte_limit');
  const testPaths = new Set(), references = new Map(); let nodes = 0;
  for (const test of tests) {
    assert.ok(test && pathIsRelative(test.path) && !testPaths.has(test.path)
      && typeof test.content === 'string' && Buffer.byteLength(test.content) <= 262144, 'test_context_test');
    testPaths.add(test.path);
  }
  const excluded = new Set([...testPaths, ...editPaths]);
  for (const test of tests) {
    const ast = parse(test.content, test.path), program = ast?.program ?? ast;
    assert.ok(Array.isArray(program?.body), 'test_context_ast');
    const readers = new Set(), namespaces = new Set();
    for (const node of program.body) {
      if (node.type !== 'ImportDeclaration' || !['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(literal(node.source))) continue;
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === 'ImportSpecifier' && ['readFile', 'readFileSync'].includes(specifier.imported?.name ?? literal(specifier.imported))) readers.add(specifier.local?.name);
        if (['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(specifier.type)) namespaces.add(specifier.local?.name);
      }
    }
    const add = (specifier, kind) => {
      if (typeof specifier !== 'string' || !specifier || specifier.startsWith('/') || specifier.includes('\\')) return;
      if (kind === 'import' && !/^(?:\.\/|\.\.\/)/.test(specifier)) return;
      const path = posix.normalize(posix.join(posix.dirname(test.path), specifier));
      if (!pathIsRelative(path)) return;
      if (!references.has(path)) references.set(path, { path, from: new Set(), kinds: new Set() });
      assert.ok(references.size <= 256, 'test_context_reference_limit');
      const reference = references.get(path); reference.from.add(test.path); reference.kinds.add(kind);
    };
    const seen = new WeakSet(), stack = [program];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node); assert.ok(++nodes <= 250000, 'test_context_node_limit');
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) add(literal(node.source), 'import');
      if (node.type === 'CallExpression') {
        if (node.callee?.type === 'Import') add(literal(node.arguments?.[0]), 'import');
        const callee = node.callee;
        const reader = callee?.type === 'Identifier' && readers.has(callee.name)
          || callee?.type === 'MemberExpression' && !callee.computed && namespaces.has(callee.object?.name)
            && ['readFile', 'readFileSync'].includes(callee.property?.name);
        const url = node.arguments?.[0];
        if (reader && url?.type === 'NewExpression' && url.callee?.name === 'URL' && url.arguments?.length === 2
          && importMetaUrl(url.arguments[1])) add(literal(url.arguments[0]), 'resource');
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child === 'object') {
            stack.push(child); assert.ok(stack.length <= 250000, 'test_context_node_limit');
          }
        }
        else if (value && typeof value === 'object') stack.push(value);
      }
    }
  }
  const files = [], omitted = []; let bytes = 0;
  const ordered = [...references.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const { path } of ordered) {
    if (excluded.has(path)) { omitted.push({ path, reason: 'excluded' }); continue; }
    if (!sourceExtension.test(path)) { omitted.push({ path, reason: 'unsupported_file' }); continue; }
    if (files.length >= maxFiles) { omitted.push({ path, reason: 'file_limit' }); continue; }
    const content = readSource(path);
    assert.ok(content === null || typeof content === 'string', 'test_context_source');
    if (content === null) { omitted.push({ path, reason: 'unavailable' }); continue; }
    const size = Buffer.byteLength(content);
    if (bytes + size > maxBytes) { omitted.push({ path, reason: 'byte_limit' }); continue; }
    files.push({ path, content }); bytes += size;
  }
  return { files, omitted, bytes, references: ordered.map(row => ({ path: row.path,
    from: [...row.from].sort(), kinds: [...row.kinds].sort() })), complete: false };
}
